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
import { auroraPlugin } from './auroraPlugin'
import { lxPlugin } from './lxPlugin'
import { qishuiPlugin } from './qishuiPlugin'

/**
 * 内置插件清单（按注册顺序，UI 列出的顺序即此顺序）。
 *
 * 这是**getter 数组**：模块求值期不读取插件对象，避免在环未闭合时解引用。
 */
export function builtinPlugins() {
  return [auroraPlugin, lxPlugin, qishuiPlugin]
}

let registered = false

/**
 * 注册内置插件（幂等）。
 *
 * 由 `executor.ts` 的每个入口在调用前触发；`plugin/index.ts` 的出口也调一次兜底。
 * 重复调用无副作用：`registerPlugin` 对同 id 是「替换实现并保留位置」。
 */
export function ensureBuiltinsRegistered(): void {
  if (registered) return
  for (const plugin of builtinPlugins()) registerPlugin(plugin)
  registered = true
}

/** **仅供单测**：清掉「已注册」标记，让下一次 ensure 重新填充（配合 clearPluginsForTest） */
export function resetBuiltinsRegistrationForTest(): void {
  registered = false
}
