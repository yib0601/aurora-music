/**
 * preload 通道名与 shared 的 `LOG_IPC` 一致性门禁。
 *
 * 为什么需要这么一个「读源文件做字符串比对」的测试：沙箱 preload **不能**
 * require `@aurora/shared`（详见 preload.ts 顶部说明），通道名只能在那边
 * 抄一份字面量。类型断言 `satisfies typeof import('@aurora/shared').LOG_IPC`
 * 已经能在编译期挡住绝大多数漂移，但它有一个回退方式：有人为了「先跑通」
 * 把断言放宽成 `Record<string, string>`，编译器就不吭声了。
 * 这条测试直接拿源码里的对象与常量对比，把那个回退口堵上。
 */

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { LOG_IPC } from '@aurora/shared'

/** preload.ts 的绝对路径（本文件位于 src/logging/__tests__/） */
const PRELOAD_PATH = path.resolve(__dirname, '../../preload.ts')

/** 从源码里取出 `const LOG_CHANNELS = { ... } as const satisfies …` 的键值对 */
function readPreloadChannels(): Record<string, string> {
  const source = fs.readFileSync(PRELOAD_PATH, 'utf8')
  const match = /const LOG_CHANNELS = \{([\s\S]*?)\} as const/.exec(source)
  if (!match) throw new Error('preload.ts 里找不到 LOG_CHANNELS 对象')

  const channels: Record<string, string> = {}
  for (const entry of match[1].matchAll(/(\w+)\s*:\s*'([^']*)'/g)) {
    channels[entry[1]] = entry[2]
  }
  return channels
}

describe('preload 日志通道名', () => {
  it('与 shared 的 LOG_IPC 逐键逐值一致', () => {
    // 顺序无关（对象），但键集与值必须完全相同
    expect(readPreloadChannels()).toEqual({ ...LOG_IPC })
  })

  it('没有遗漏任何通道（拿 LOG_IPC 的键来反查）', () => {
    const channels = readPreloadChannels()
    for (const key of Object.keys(LOG_IPC)) {
      expect(channels).toHaveProperty(key)
    }
    // 反向：preload 里也不该多出 shared 不认识的通道
    for (const key of Object.keys(channels)) {
      expect(LOG_IPC).toHaveProperty(key)
    }
  })

  it('preload 不出现运行期的 shared import（否则沙箱里启动即失败）', () => {
    const source = fs.readFileSync(PRELOAD_PATH, 'utf8')
    // 注释里用反引号提到包名是允许的（文件顶部整段都在解释原因），先把注释剥掉
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

    // 按整条 import 语句取（多行写法 `import type {\n ...\n} from '@aurora/shared'`
    // 按行判会漏掉，而漏掉恰恰会把「运行期 import」放过去 —— 这个门禁就白设了）。
    // 用负向前瞻 `(?!\bimport\b)` 限制在**同一条** import 语句内：
    // `[^;]*?` 这类写法在无分号风格下会从文件第一条 import（electron）一路吃到
    // shared，把合法的 type import 误判成运行期 import（本测试第一版就踩了这个）。
    const importStatements = [...code.matchAll(/import\b(?:(?!\bimport\b)[^;])*?from\s*'@aurora\/shared'/g)]
    expect(importStatements.length).toBeGreaterThan(0)
    for (const statement of importStatements) {
      // 只允许 `import type ...`：它会被完全擦除，不产生 require
      expect(statement[0]).toMatch(/^\s*import\s+type\b/)
    }

    // 裸 import（`import '@aurora/shared'`）同样会产生 require，单独挡一道
    expect(code).not.toMatch(/^\s*import\s+'@aurora\/shared'/m)
  })
})
