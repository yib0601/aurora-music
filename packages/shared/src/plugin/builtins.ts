/**
 * 内置插件的注册点。
 *
 * ## 为什么单独一个文件、且是**惰性**注册
 *
 * 注册是模块求值期的副作用，必须有人触发。但如果把它写成 `builtins.ts` 顶层的
 * `ensureBuiltinsRegistered()`，就会撞上循环 import：
 *
 *   `musicSource` → `executor` → `builtins` → `auroraPlugin` → `musicSource`
 *
 * 此时 `auroraPlugin` 的模块体还没执行完，`auroraPlugin` 绑定是 `undefined`，
 * 注册时直接抛「invalid plugin id: undefined」——整个包在 import 阶段就崩。
 *
 * 所以注册必须在**方法被调用时**发生（那时所有模块都已求值完毕）：
 * `executor.ts` 的每个入口都先调 `ensureBuiltinsRegistered()`。
 *
 * 注意：插件实现里对既有模块的引用同样只能出现在方法体内，不能提到模块顶层，
 * 否则环上的求值顺序问题会以另一种形式复现。
 */

import { registerPlugin } from './registry'
import { isolatePluginStep } from './health'
import { resolveRequirements, describeMissingCapabilities } from './hostCapabilities'
import { auroraPlugin } from './auroraPlugin'
import { lxPlugin } from './lxPlugin'
import { qishuiPlugin } from './qishuiPlugin'
import { lrclibPlugin } from './lrclibPlugin'

/**
 * 内置插件清单（按注册顺序，UI 列出的顺序即此顺序）。
 *
 * 这是**getter 数组**：模块求值期不读取插件对象，避免在环未闭合时解引用。
 */
export function builtinPlugins() {
  // 顺序即 UI 列出的顺序：音源类在前，歌词类在后。
  // `lrclibPlugin` 是**歌词域**（domain: 'lyrics'）—— 它不参与搜索/取址，
  // 只在所有用户源落空时兜底。把它放最后，是因为用户找歌词源时会先看上面那些。
  return [auroraPlugin, lxPlugin, qishuiPlugin, lrclibPlugin]
}

let registered = false

/**
 * 因缺宿主能力而**降级**的内置插件（id → 缺什么的可读清单）。
 *
 * ## 为什么缺失时仍然注册，而不是踢出去
 *
 * 两个原因，都来自既有测试与语义：
 *
 * 1. **"宿主缺能力"与"插件不存在"是两件事**。`lxPlugin.preflight` 已经负责回答
 *    "这条源此刻能不能跑"，并给出可读原因（`core.error.lxHostNotReady`）。若在这里
 *    就把 lx 从注册表删掉，调用方看到的是"没有这个插件"，而真实原因是
 *    "这个端没有脚本宿主" —— 后者的可诊断性明显更高。
 * 2. **测试与降级路径依赖"注册但不可用"**。`musicSourceLx` / `lxVerifier` 里
 *    有一批用例专门验证"宿主未注册时跳过 lx 源并告警"；把插件整个摘掉会让这些
 *    路径变成"插件不存在"，跳过逻辑就没被测到了。
 *
 * 所以这里只**记账**，由 UI 与诊断消费（设置页据此标注"当前平台缺少 X"），
 * 运行期的"能不能跑"仍由 `preflight` 判定。两个判定回答的是不同问题，不能合并。
 */
const degraded = new Map<string, string[]>()

/** 当前平台上能力不完整的内置插件（拷贝：调用方改不该动内部状态） */
export function degradedBuiltins(): Array<{ id: string; missing: string[] }> {
  return [...degraded.entries()].map(([id, missing]) => ({ id, missing: [...missing] }))
}

/**
 * 注册内置插件（幂等）。
 *
 * 由 `executor.ts` 的每个入口在调用前触发；`plugin/index.ts` 的出口也调一次兜底。
 * 重复调用无副作用：`registerPlugin` 对同 id 是「替换实现并保留位置」。
 *
 * ## 逐条隔离，一条失败不影响其余
 *
 * 这是启动链路上的第一处插件副作用，也是最容易"整个应用起不来"的地方：
 * `registerPlugin` 对非法 id 会抛错，而内置实现只要有一版引入求值期异常，
 * 抛出的错误就会沿调度链冒出去。这里改成逐条包住 —— 坏的那条进失败清单
 * （UI 之后会告知用户），其余照常注册，`registered` 依然置位
 * （否则每次执行都重试同一个失败，日志会被刷满）。
 *
 * ## 依赖判定只记账，不拦注册
 *
 * 见 `degraded` 的注释：能力缺失是**降级**而不是**缺失**，运行期由插件的
 * `preflight` 给出可读结论。`registered` 置位后不重算 `degraded` —— 宿主能力是
 * 启动期装配、运行期不变的；若要支持运行期补装，需另加重算入口而不是让它静默过期。
 */
export function ensureBuiltinsRegistered(): void {
  if (registered) return
  for (const plugin of builtinPlugins()) {
    const avail = resolveRequirements(plugin?.requires ?? [])
    if (!avail.ok) {
      degraded.set(String(plugin?.id ?? ''), describeMissingCapabilities(avail.missing))
    }
    isolatePluginStep('builtin', plugin?.id, () => registerPlugin(plugin))
  }
  registered = true
}

/** **仅供单测**：清掉「已注册」标记，让下一次 ensure 重新填充（配合 clearPluginsForTest） */
export function resetBuiltinsRegistrationForTest(): void {
  registered = false
  degraded.clear()
}
