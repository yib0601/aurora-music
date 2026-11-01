/**
 * 已安装插件 → 注册表（运行期）。
 *
 * ## 为什么注册进**同一个**注册表
 *
 * 内置插件与已安装插件的差别只在「实现从哪来」：一个来自仓库里的 TS 模块，
 * 一个来自磁盘上的清单。**执行路径必须完全一致** —— 上层（执行器、平台层、设置页）
 * 只认 `getPlugin(id)`，不该出现「这个插件是装来的，要走另一条路」的分支。
 * 那正是本仓库花了两轮改造消除的形态判定。
 *
 * ## 为什么注册要能被**撤销**
 *
 * 卸载插件时若不撤销注册，`getPlugin()` 仍能取到实现：用户会看到「插件已删除，
 * 但音源还在工作」，重启后才消失。所以卸载必须同时做两件事：
 * 删磁盘文件 + `unregisterPlugin(id)`。
 *
 * 注册表本身没有单独的 unregister（`registry.ts` 只提供测试用的 clear），
 * 这里补一个**仅允许撤销已安装插件**的入口：内置插件被误删会让整个功能静默消失，
 * 必须挡住。
 */

import type { SourcePlugin } from './types'
import { getPlugin, registerPlugin, unregisterPlugin } from './registry'
import { ensureBuiltinsRegistered, builtinPlugins } from './builtins'
import { isolatePluginStep } from './health'
import type { InstalledPlugin, PluginManifest } from './manifest/types'
import { buildSourcePlugin } from './manifest/source'
import { createGuardedFetch } from './manifest/host'
import { PLUGIN_ID_PATTERN } from './manifest/types'

/** 已安装插件 id → 清单（注册表里的实现由清单构造，撤销时需要知道哪些是"装来的"） */
const INSTALLED = new Map<string, PluginManifest>()

/**
 * 已安装插件的 B 档脚本正文（插件 id → 源码）。
 *
 * 为什么存在这里而不是靠插件自己去读文件：`PluginContext` 里**没有文件系统**
 * （见契约注释 —— 插件只能发 HTTP）。脚本正文必须由宿主侧读好、登记在这里，
 * 执行取址时再由宿主塞进源配置的 `script` 字段。
 *
 * 为什么不每次现读磁盘：取址是播放热路径（每首歌一次），而扫描时的成本是
 * 一次目录遍历 + 每个插件一次小文件读 —— 一次换后续全部。
 */
const SCRIPT_BODIES = new Map<string, string>()

/** 取某已安装插件的脚本正文；没有返回 undefined（不抛错：没有脚本是合法状态） */
export function scriptBodyFor(pluginId: string): string | undefined {
  return SCRIPT_BODIES.get(pluginId)
}

/**
 * 内置插件 id 集合。
 *
 * 会**顺带确保内置插件已注册**：本模块的每个入口都要回答"这个 id 是不是内置的"，
 * 而答案同时依赖内置清单（`builtinPlugins()`）与注册表状态。若只读清单不注册，
 * 调用方随后 `getPlugin('aurora')` 会拿到 undefined —— 表现是"装上插件后官方音源消失"，
 * 排查起来毫无线索（另一个入口又可能已经触发过注册，于是现象还随调用顺序变化）。
 */
function builtinIds(): Set<string> {
  ensureBuiltinsRegistered()
  return new Set(builtinPlugins().map((plugin) => plugin.id))
}

/**
 * 一个 id 现在能否被安装。
 *
 * 拒绝理由只有三种，都必须是**安装期**的错（不能等到注册时才炸）：
 * 1. 与内置插件撞名 —— 内置插件的实现是编译进应用的，同 id 装进来会覆盖它，
 *    而"覆盖一个内置插件"不是用户能理解的语义（他还以为自己在用官方实现）；
 * 2. 已经装了同 id 的插件 —— 重装应当走"更新"路径，而不是悄悄换掉；
 * 3. id 形状非法（清单校验已经挡过，这里是对**已落盘**记录的二次防线）。
 */
export function canInstall(
  manifest: Pick<PluginManifest, 'id'>
): { ok: true } | { ok: false; code: 'builtin' | 'duplicate' } {
  const id = typeof manifest?.id === 'string' ? manifest.id : ''
  if (builtinIds().has(id)) return { ok: false, code: 'builtin' }
  if (INSTALLED.has(id)) return { ok: false, code: 'duplicate' }
  return { ok: true }
}

/**
 * 注册一个已安装插件（幂等）。
 *
 * 只做**能做的部分**：把清单翻译成 `SourcePlugin` 并登记。歌词声明不在这里注册 ——
 * 歌词没有独立注册表，它由平台层的歌词搜索在运行时把「已安装歌词插件」拼进候选列表
 * （见 `lyricsCandidatesOf`），因为歌词聚合层收的是 `LyricsSourceConfig` 形状而非插件对象。
 *
 * 返回是否注册成功：清单里没有音源域声明（纯歌词插件）时返回 `false`，
 * 那是**正常情况**而不是错误 —— 调用方据此知道"这个插件不进音源列表"。
 */
export function registerInstalledPlugin(manifest: PluginManifest): boolean {
  // 先构造、后登记：`buildSourcePlugin` 是唯一会抛错的一步（清单形状被手改过、
  // 脚本块字段缺失等）。若先 `INSTALLED.set` 再构造，抛错之后这条记录会留在
  // 已安装表里而实现根本没注册 —— 用户看到的是"装了但用不了"，且重装会被
  // `canInstall` 判成 `duplicate`，只能手动删目录才恢复。
  const plugin = buildSourcePlugin(manifest)
  INSTALLED.set(manifest.id, manifest)
  // 清单 → 插件。三种来源都收在这一处：
  //   1. 声明式端点（A 档）
  //   2. 受限脚本（B 档）
  //   3. 两者并存（脚本补声明式没声明的能力）
  // 所以这里不需要按 `manifest.script` 分支 —— `buildSourcePlugin` 已经处理。
  //
  // 纯歌词插件（没有音源域声明）在这里返回 false：那是**正常情况**，
  // 它照样进 `INSTALLED`（卸载与重装判定依赖它），只是不进音源注册表。
  if (!plugin) return false
  ensureBuiltinsRegistered()
  registerPlugin(plugin)
  return true
}

/**
 * 撤销一个已安装插件。
 *
 * 内置插件**不允许**撤销：返回 `false` 且什么都不做。调用方（卸载流程）据此报错，
 * 而不是假装成功（用户会看到按钮点了没反应，比明确报错更糟）。
 */
export function unregisterInstalledPlugin(pluginId: string): boolean {
  if (!INSTALLED.has(pluginId)) return false
  INSTALLED.delete(pluginId)
  // 脚本正文也要摘掉：留着会让"已卸载但脚本还在内存里跑"成为可能
  SCRIPT_BODIES.delete(pluginId)
  // 内置插件不可能走到这里（`INSTALLED` 只装已安装清单），所以直接删是安全的
  return unregisterPlugin(pluginId) || true
}

/** 某插件是否是"装来的"（供 UI 与卸载入口判定） */
export function isInstalledPlugin(pluginId: string): boolean {
  return INSTALLED.has(pluginId)
}

/** 全部已安装插件的清单（按安装顺序） */
export function installedManifests(): PluginManifest[] {
  return [...INSTALLED.values()]
}

/**
 * 挂载磁盘上的一份安装结果（启动时调用）。
 *
 * 与 `registerInstalledPlugin` 的差别：这里是**批量 + 容错**。单个清单有问题时
 * 跳过它并记录，**不**让整个插件目录加载失败 —— 否则一个坏文件会让用户的所有插件
 * 一起消失（见 `InstalledPluginScan` 的注释）。
 *
 * ## 为什么每次注册都包一层 `isolatePluginStep`
 *
 * 上面的"跳过"只覆盖了**我们预见到**的不合格清单（id 形状、内置撞名、重复）。
 * 但 `buildSourcePlugin` 要读清单里的几十个字段，任何一处手改过的内容都可能让它
 * 抛错；而本函数在**启动路径上**（`main.ts` 建窗之前），一次抛错就是应用起不来。
 * 所以真正"这条插件坏了"的兜底在这里：抛错的那条进失败清单，其余照常挂载。
 */
export function mountInstalled(
  scan: { plugins: readonly InstalledPlugin[]; broken: readonly unknown[] }
): { mounted: string[]; skipped: Array<{ id: string; reason: 'builtin' | 'duplicate' | 'invalid' | 'error' }> } {
  const mounted: string[] = []
  const skipped: Array<{ id: string; reason: 'builtin' | 'duplicate' | 'invalid' | 'error' }> = []
  for (const item of scan.plugins) {
    const manifest = item?.manifest
    // id 形状必须在这里再判一次：`registerInstalledPlugin` 依赖已校验过的清单，
    // 而磁盘内容可能被人手改过（校验器在安装期跑过，但那是"写时"，这里是"读时"）。
    // 空 id 会被 `INSTALLED.set('')` 收进来，随后 `unregisterPlugin('')` 又静默失败 ——
    // 那条记录就永远摘不掉了。
    if (!manifest || typeof manifest.id !== 'string' || !PLUGIN_ID_PATTERN.test(manifest.id)) {
      skipped.push({ id: String((manifest as { id?: string })?.id ?? ''), reason: 'invalid' })
      continue
    }
    const allowed = canInstall(manifest)
    if (!allowed.ok) {
      skipped.push({ id: manifest.id, reason: allowed.code })
      continue
    }
    // B 档脚本正文随清单一起挂到运行期（`ScriptBody` 登记表），
    // 由 `scriptBodyFor` 供宿主读取 —— 插件执行上下文没有文件系统。
    if (typeof item.scriptBody === 'string' && item.scriptBody.trim()) {
      SCRIPT_BODIES.set(manifest.id, item.scriptBody)
    }
    const done = isolatePluginStep('installed', manifest.id, () => {
      registerInstalledPlugin(manifest)
      return true
    })
    if (done) {
      mounted.push(manifest.id)
    } else {
      // 构造/注册抛错：登记表里已经留下失败记录（UI 据此提示用户），
      // 这里保证它不出现在 mounted 里 —— 否则调用方会以为它可用。
      skipped.push({ id: manifest.id, reason: 'error' })
    }
  }
  return { mounted, skipped }
}

/**
 * 给某插件取一个**受主机白名单约束的 fetch**。
 *
 * 只对已安装插件有意义：内置插件的请求目标由我们审过，不需要运行期白名单。
 * 未安装的 id 返回 undefined（调用方回落全局 fetch）。
 *
 * ## `configuredUrl` 必须由调用方传
 *
 * `configured-origin` 形态下放行的是**用户填的那一个 origin**，它只存在于
 * `config.sourceUrl` 里 —— 清单与注册表都拿不到。不传的后果是 `originOf('')`
 * 返回空串，而 `allowlistAllows` 对空 origin 是 fail-closed，**该插件所有请求
 * 都被拒**（表现为"装上了但搜不到任何东西"，且日志里只有一行越界错误）。
 *
 * 所以这个参数是必需语义、可空类型：调用方拿不到 `config` 时（如登录态通道）
 * 传 undefined 是**明确没有地址**，不是忘了传。
 */
export function guardedFetchOf(
  pluginId: string,
  configuredUrl?: string
): typeof globalThis.fetch | undefined {
  const manifest = INSTALLED.get(pluginId)
  if (!manifest) return undefined
  return createGuardedFetch(manifest, globalThis.fetch, { configuredUrl })
}

/** 某插件是否已在音源注册表里（诊断用：注册失败时 UI 能说明"这个插件没有音源能力"） */
export function pluginRegistered(pluginId: string): boolean {
  return Boolean(getPlugin(pluginId))
}

/** **仅供单测**：清空已安装登记（配合 `clearPluginsForTest`） */
export function clearInstalledForTest(): void {
  INSTALLED.clear()
  SCRIPT_BODIES.clear()
}

/**
 * 安装流程的运行期落点（磁盘写完、校验通过后调用）。
 *
 * 单独包一层而不是让调用方直接 `registerInstalledPlugin`，是因为这里要做
 * **最后一道一致性检查**：清单必须已在磁盘落盘（调用方负责），且 id 未与内置冲突。
 * 装到一半失败时，磁盘上的目录由调用方回滚 —— 本函数只负责内存状态。
 *
 * 与 `unregisterInstalledPlugin` 的命名成对：一个"装上"，一个"摘下"。
 */
export function installManifestIntoRuntime(manifest: PluginManifest): boolean {
  const allowed = canInstall(manifest)
  if (!allowed.ok) return false
  return registerInstalledPlugin(manifest)
}

/**
 * 卸载流程的运行期落点。
 *
 * 语义与 `unregisterInstalledPlugin` 相同，同样成对命名让调用点读起来对称
 * （`installManifestIntoRuntime` / `removeManifestFromRuntime`）。
 * 未安装的 id 返回 `false`。
 */
export function removeManifestFromRuntime(pluginId: string): boolean {
  return unregisterInstalledPlugin(pluginId)
}
