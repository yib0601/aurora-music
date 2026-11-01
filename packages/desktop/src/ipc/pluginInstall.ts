/**
 * 插件的安装 / 卸载 / 目录（主进程 IPC）。
 *
 * ## 与 `pluginHost.ts` 的分工
 *
 * - `pluginHost.ts`：**执行**已注册插件的能力（搜索 / 取址 / 登录）
 * - 本文件：**管理**插件集合（列出 / 安装 / 卸载）
 *
 * 拆开而不是塞进同一个文件，是因为两者的信任边界不同：执行通道的入参是插件 id +
 * 业务数据（不可信但形状有限），管理通道的入参里含**文件路径与 URL**，
 * 且会改动磁盘。混在一处时"哪个 handler 需要路径校验"变得不容易看清。
 *
 * ## 三条硬约束
 *
 * 1. **安装期就完成全部校验**：清单结构、id 冲突、权限、主机白名单。
 *    装进去以后再报错等于把一份半成品留在磁盘上。
 * 2. **渲染层永远拿不到内容非法/被篡改的插件**：扫描时哈希不符的目录直接跳过并进
 *    `broken`（理由见 `pluginStore.ts` 的哈希注释）。
 * 3. **一次只装一个**：安装是"下载/读文件 → 校验 → 写盘 → 注册"的串行流程，
 *    没有并发安装的语义。用一个简单的进行中标记挡住重入，避免用户在按钮上连点
 *    生成两份清单目录。
 */

import { ipcMain, dialog, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import {
  auroraError,
  buildPluginCatalog,
  installManifestIntoRuntime,
  mountInstalled,
  notePluginFailure,
  pluginStartupReport,
  removeManifestFromRuntime,
  canInstall,
  hexToBytes,
  verifyManifestSignature,
} from '@aurora/shared'
import type {
  PluginCatalogEntry,
  PluginInstallRecord,
  PluginInstallResult,
  PluginStartupReport,
} from '@aurora/shared'
import { getMainLocale, mainErrorText, mainTranslate } from '../i18n'
import { effectiveTrustedKeys } from './pluginTrust'
import {
  downloadManifest,
  downloadScriptBody,
  installedPluginsRoot,
  parseManifestBytes,
  readManifestBytes,
  removeInstalledPlugin,
  scanInstalledPlugins,
  sha256OfBytes,
  writeInstalledPlugin,
} from './pluginStore'

/**
 * Ed25519 验签（主进程用 node:crypto，不依赖 WebCrypto 的 Ed25519 支持）。
 *
 * 公钥来源是**信任表**而不是清单：让签名自己证明自己毫无意义。
 * raw 32 字节公钥要拼上 SPKI DER 前缀才能被 node:crypto 接受。
 */
function verifyEd25519(sigHex: string, publicKeyHex: string, message: string): boolean {
  const keyBytes = hexToBytes(publicKeyHex)
  if (!keyBytes || keyBytes.length !== 32) return false
  const sigBytes = hexToBytes(sigHex)
  if (!sigBytes || sigBytes.length !== 64) return false
  // SPKI DER 的固定前缀（OID 1.3.101.112 = Ed25519）+ raw key
  const prefix = Buffer.from('302a300506032b6570032100', 'hex')
  const key = crypto.createPublicKey({
    key: Buffer.concat([prefix, Buffer.from(keyBytes)]),
    format: 'der',
    type: 'spki',
  })
  return crypto.verify(null, Buffer.from(message, 'utf8'), key, Buffer.from(sigBytes))
}

/** 当前界面语言：主进程有唯一来源（渲染层推过来的语言），不要在这里另存一份 */
function currentLocale(): string {
  return getMainLocale()
}

/**
 * 最近一次启动挂载的结果。
 *
 * 存在模块级是为了让 `plugin:startup` 通道能回答"本次启动时插件怎么了"：
 * 渲染层在启动后主动拉一次（而不是主进程 push），因为它可能在报告生成**之后**才
 * 挂载好监听器 —— 一次性的 push 会静默丢掉那条提示。
 */
let startupReport: PluginStartupReport | null = null

/** 本次启动的插件报告；没有启动过（单测直接驱动流程函数）时现算一份 */
export function lastPluginStartupReport(): PluginStartupReport {
  return startupReport ?? pluginStartupReport()
}

/**
 * 启动时挂载磁盘上的全部已安装插件。
 *
 * 在 `createWindow()` **之前**调用（见 main.ts）：渲染层首帧就会问插件目录，
 * 迟了会出现"刚装的插件不存在"再自己冒出来。
 *
 * 逐条容错（`mountInstalled` 的职责）：一个坏文件不该让其余插件一起消失。
 * 坏条目在这里只记日志 —— 用户要看的可读原因由 `plugin:catalog` 通道的
 * `broken` 列表提供（那时能按当前语言渲染），启动期没有语言上下文。
 *
 * ## 本函数**绝不抛错**
 *
 * 它在 `app.whenReady()` 的同步段里跑，抛出去就是窗口建不出来。前面几层已经
 * 逐条包住了（`mountInstalled` / `ensureBuiltinsRegistered` / 存储插件注册），
 * 这里再兜一层是刻意的冗余：插件是外部输入，任何一处漏掉的 throw 都该停在这条
 * 边界上，而不是变成"应用打不开"。失败原因由 `plugin:startup` 通道交给渲染层提示。
 */
export function mountInstalledPlugins(): PluginStartupReport {
  const report = collectStartupReport()
  startupReport = report
  return report
}

function collectStartupReport(): PluginStartupReport {
  let scan: ReturnType<typeof scanInstalledPlugins>
  try {
    scan = scanInstalledPlugins()
  } catch (err) {
    // 扫盘本身失败（权限 / 磁盘异常）：不该阻止应用启动，其余功能照常可用
    console.error('[plugin] 扫描插件目录失败:', err)
    return pluginStartupReport({ mounted: [], broken: 0 })
  }

  let mounted: string[] = []
  try {
    const result = mountInstalled(scan)
    mounted = result.mounted
    if (result.mounted.length > 0) {
      console.log(`[plugin] 已挂载 ${result.mounted.length} 个已安装插件:`, result.mounted.join(', '))
    }
    for (const item of result.skipped) {
      console.warn(`[plugin] 已跳过插件 ${item.id}: ${item.reason}`)
    }
  } catch (err) {
    // 批量挂载整体失败（`mountInstalled` 内部已逐条隔离，走到这里说明是它自己出了问题）：
    // 已安装插件全部不可用，但内置插件与本地播放不受影响，应用照常启动。
    notePluginFailure('installed', '', err)
    console.error('[plugin] 挂载已安装插件失败:', err)
  }

  if (scan.broken.length > 0) {
    // 不打断启动：坏文件在插件管理页里会逐条列出可读原因
    console.warn(`[plugin] ${scan.broken.length} 个插件文件无法加载:`)
    for (const item of scan.broken) console.warn('  -', item.path, item.message || '')
  }

  return pluginStartupReport({ mounted, broken: scan.broken.length })
}

/** 安装进行中标记（防连点重入） */
let installing = false

/**
 * 扫描 + 组装目录。
 *
 * 每次调用都重新扫盘：安装/卸载之后 UI 立刻要看到新状态，缓存会让它看到旧的。
 * 扫盘成本是一次 `readdir` + 每个插件两次小文件读，与"插件通常只有个位数"匹配。
 */
export function listCatalogEntries(locale = currentLocale()): {
  entries: PluginCatalogEntry[]
  broken: Array<{ path: string; message?: string }>
} {
  const scan = scanInstalledPlugins()
  return {
    entries: buildPluginCatalog(scan.plugins, locale),
    broken: scan.broken.map((item) => ({ path: item.path, message: item.message })),
  }
}

/**
 * 执行一次安装：规整 → 校验 → 写盘 → 注册。
 *
 * 抽成导出的纯流程函数（不碰 IPC）是为了让单测能直接驱动它，
 * 不必构造 Electron 的事件对象。
 */
export async function performInstall(input: {
  bytes: Buffer
  origin: string
  expectedSha256?: string
  locale?: string
}): Promise<PluginInstallResult> {
  const sha256 = sha256OfBytes(input.bytes)

  // 调用方（如清单里自带的哈希 / CLI 参数）给的哈希必须先匹配：
  // 这是"用户确认过的是这一份内容"的唯一凭证
  if (input.expectedSha256 && input.expectedSha256.toLowerCase() !== sha256) {
    return {
      ok: false,
      message: 'AURORA_PLUGIN_HASH_MISMATCH_REQUESTED',
      issues: [],
    }
  }

  const parsed = parseManifestBytes(input.bytes, input.origin)
  if (!parsed.ok) {
    return { ok: false, message: parsed.message, issues: parsed.issues }
  }
  const manifest = parsed.manifest

  // 与内置/已安装冲突：安装期挡下（不能依赖注册期的"替换实现"语义）
  const allowed = canInstall(manifest)
  if (!allowed.ok) {
    return {
      ok: false,
      // 两种冲突给不同的码，UI 才能说清"这是内置的"还是"你已经装过一个同名的"
      message: allowed.code === 'builtin' ? 'AURORA_PLUGIN_BUILTIN_ID' : 'AURORA_PLUGIN_DUPLICATE_ID',
      issues: [{ path: 'id', code: 'duplicate', value: manifest.id }],
    }
  }

  // ─── 签名校验（Ed25519） ────────────────────────────────────
  //
  // 语义分档（见 shared 的 signature.ts）：未签名放行；签名者不在信任表放行但标注；
  // **签名存在且校验失败必须拒绝** —— 那说明下载到的内容不是发布者签的那份
  // （中间人替换 / 托管被入侵）。
  if (manifest.signature) {
    const verdict = await verifyManifestSignature(manifest, {
      // 用**生效的**信任表（内置 ∪ 用户在设置页导入的），而不是编译期常量：
      // 否则自建托管的人在设置里导入了自己的公钥也不会生效
      trustedKeys: effectiveTrustedKeys(),
      verify: verifyEd25519,
    })
    if (verdict.status === 'invalid') {
      return { ok: false, message: 'AURORA_PLUGIN_SIGNATURE_INVALID', issues: [] }
    }
  }

  // ─── B 档：先把脚本拉下来再落盘 ──────────────────────────────
  //
  // 顺序很重要：脚本拉取失败就**整次安装失败**，不留下半成品。
  // 反过来（先写清单再拉脚本）会留下一个"装上了但永远取不到址"的源，
  // 用户看到的是播放时静默失败，而真实原因是安装没完成。
  let scriptBody: string | null = null
  if (manifest.script) {
    try {
      const fetched = await downloadScriptBody(manifest.script.url, manifest.script.headers)
      // 清单里预先声明了哈希 → 强制比对（"用户确认过的是这一份代码"）
      const declared = manifest.script.sha256?.toLowerCase()
      if (declared && declared !== fetched.sha256) {
        return {
          ok: false,
          message: 'AURORA_PLUGIN_SCRIPT_HASH_MISMATCH_REQUESTED',
          issues: [],
        }
      }
      scriptBody = fetched.text
    } catch (err) {
      return { ok: false, message: mainErrorText(err), issues: [] }
    }
  }

  const record: PluginInstallRecord = {
    id: manifest.id,
    version: manifest.version,
    sha256,
    installedAt: Date.now(),
    origin: input.origin,
  }

  writeInstalledPlugin(manifest, input.bytes, record, scriptBody)
  // 注册进运行期（音源注册表 + 已安装登记 + 脚本正文）：不重启就能用
  mountInstalled({
    plugins: [
      {
        manifest,
        record,
        path: '',
        // 刚拉到的脚本正文随安装一起进运行期，否则用户装完要重启才能取址
        ...(scriptBody === null ? {} : { scriptBody }),
      },
    ],
    broken: [],
  })
  installManifestIntoRuntime(manifest)

  const { entries } = listCatalogEntries(input.locale)
  return {
    ok: true,
    entry: entries.find((entry) => entry.id === manifest.id && entry.provenance === 'installed'),
  }
}

/** 卸载：先摘运行期实现，再删磁盘目录 */
export function performUninstall(pluginId: string, locale?: string): PluginInstallResult {
  // 顺序很重要：先撤销注册再删文件。反过来若删文件失败，用户会看到
  // "文件还在但插件已经不可用"——那是可恢复的（重装即可）；而先删文件后撤销注册若
  // 撤销失败，会出现"插件已删除但音源还在工作"，用户重启前完全无从理解。
  const removed = removeManifestFromRuntime(pluginId)
  if (!removed) {
    return { ok: false, message: 'AURORA_PLUGIN_NOT_INSTALLED', issues: [] }
  }
  removeInstalledPlugin(pluginId)
  void locale
  return { ok: true }
}

export function registerPluginInstallIpc(): void {
  /**
   * 本次启动的插件加载报告。
   *
   * 为什么要一条通道而不是启动时 push：渲染层可能在报告生成之后才装好监听器
   * （窗口创建、React 挂载都晚于挂载插件），一次性的 push 会静默丢掉提示。
   * 它只回答"启动时插件怎么了"，不影响任何能力调用。
   */
  ipcMain.handle('plugin:startup', () => lastPluginStartupReport())

  /** 列出插件目录（内置 + 已安装 + 坏掉的文件） */
  ipcMain.handle('plugin:catalog', (_event, locale?: unknown) => {
    return listCatalogEntries(typeof locale === 'string' && locale ? locale : currentLocale())
  })

  /** 打开系统文件选择框，返回用户选中的清单路径（取消返回 null） */
  ipcMain.handle('plugin:pickManifest', async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog({
      title: mainTranslate()('sources.plugins.pickTitle'),
      properties: ['openFile'],
      filters: [
        { name: 'Plugin manifest', extensions: ['json'] },
        { name: mainTranslate()('sources.plugins.allFiles'), extensions: ['*'] },
      ],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  /** 从本地文件安装 */
  ipcMain.handle(
    'plugin:installFromFile',
    async (_event, filePath: unknown, locale?: unknown): Promise<PluginInstallResult> => {
      if (installing) {
        return { ok: false, message: 'AURORA_PLUGIN_BUSY', issues: [] }
      }
      if (typeof filePath !== 'string' || !filePath.trim()) {
        throw auroraError('desktop.error.plugin.manifestNotFound')
      }
      installing = true
      try {
        const bytes = readManifestBytes(filePath)
        return await performInstall({
          bytes,
          origin: filePath,
          locale: typeof locale === 'string' ? locale : undefined,
        })
      } catch (err) {
        return { ok: false, message: mainErrorText(err), issues: [] }
      } finally {
        installing = false
      }
    }
  )

  /** 从 URL 安装 */
  ipcMain.handle(
    'plugin:installFromUrl',
    async (_event, url: unknown, expectedSha256?: unknown, locale?: unknown): Promise<PluginInstallResult> => {
      if (installing) {
        return { ok: false, message: 'AURORA_PLUGIN_BUSY', issues: [] }
      }
      if (typeof url !== 'string' || !url.trim()) {
        throw auroraError('desktop.error.plugin.badUrl', { url: String(url ?? '') })
      }
      installing = true
      try {
        const bytes = await downloadManifest(url)
        return await performInstall({
          bytes,
          origin: url,
          expectedSha256: typeof expectedSha256 === 'string' ? expectedSha256 : undefined,
          locale: typeof locale === 'string' ? locale : undefined,
        })
      } catch (err) {
        return { ok: false, message: mainErrorText(err), issues: [] }
      } finally {
        installing = false
      }
    }
  )

  /** 卸载 */
  ipcMain.handle('plugin:uninstall', async (_event, pluginId: unknown, locale?: unknown) => {
    if (typeof pluginId !== 'string' || !pluginId) {
      throw auroraError('desktop.error.plugin.invalidId', { id: String(pluginId ?? '') })
    }
    try {
      return performUninstall(pluginId, typeof locale === 'string' ? locale : undefined)
    } catch (err) {
      return { ok: false, message: mainErrorText(err), issues: [] }
    }
  })

  /** 在文件管理器里打开插件目录（排障用：用户能看到装了什么） */
  ipcMain.handle('plugin:openDir', async () => {
    const root = installedPluginsRoot()
    // 目录不存在时先建出来：openPath 对不存在的路径静默失败，用户会以为按钮坏了
    fs.mkdirSync(root, { recursive: true })
    await shell.openPath(root)
    return { ok: true }
  })

  /** 删除一个坏掉的插件目录（扫描时报上来的 broken 条目） */
  ipcMain.handle('plugin:removeBroken', async (_event, dirPath: unknown) => {
    if (typeof dirPath !== 'string' || !dirPath) {
      return { ok: false, message: 'AURORA_PLUGIN_INVALID_PATH' }
    }
    // 只允许删插件根目录**内部**的路径：这是路径校验的落点
    const root = path.resolve(installedPluginsRoot())
    const target = path.resolve(dirPath)
    if (target !== root && !target.startsWith(root + path.sep)) {
      return { ok: false, message: 'AURORA_PLUGIN_PATH_OUTSIDE_ROOT' }
    }
    if (target === root) return { ok: false, message: 'AURORA_PLUGIN_PATH_OUTSIDE_ROOT' }
    fs.rmSync(target, { recursive: true, force: true })
    return { ok: true }
  })
}
