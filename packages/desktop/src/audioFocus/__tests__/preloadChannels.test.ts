/**
 * preload 音频焦点通道名与 `types.ts` 的一致性门禁。
 *
 * 为什么需要「读源码做字符串比对」的测试：沙箱 preload **不能** require 相对路径模块
 * （见 preload.ts 顶部说明），通道名只能在那边抄一份字面量。类型层面
 * `packages/app` 是从 `(window as any).electronAPI` 取的 `any`，编译器压根不会替我们比对，
 * 所以一旦两边漂移（改一个忘一个），表现是「设置页开关点了没反应」或
 * 「播放态永远不上报」，而且不报错、不进日志 —— 只能靠这条门禁拦住。
 *
 * 写法参照 `src/logging/__tests__/preloadChannels.test.ts`（那组通道同样只能写死字面量）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { AUDIO_FOCUS_CHANNELS } from '../types'

/** preload.ts 的绝对路径（本文件位于 src/audioFocus/__tests__/） */
const PRELOAD_PATH = path.resolve(__dirname, '../../preload.ts')
/** 主进程源码根与渲染层源码根，用于「别处不许再出现裸通道字面量」的全局检查 */
const DESKTOP_SRC = path.resolve(__dirname, '../..')
const APP_SRC = path.resolve(__dirname, '../../../../app/src')

const read = (file: string) => fs.readFileSync(file, 'utf8')

/** 取某份源码里出现的所有 'audio-focus:xxx' 字面量 */
function audioFocusLiterals(source: string): string[] {
  return [...source.matchAll(/'(audio-focus:[^']*)'/g)].map((match) => match[1])
}

/** 递归列出目录下的 .ts / .tsx（跳过 node_modules 与产物目录） */
function listSourceFiles(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      listSourceFiles(full, out)
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(full)
    }
  }
  return out
}

describe('preload 音频焦点通道名', () => {
  it('与 types.ts 的 AUDIO_FOCUS_CHANNELS 逐值一致', () => {
    const literals = audioFocusLiterals(read(PRELOAD_PATH)).sort()
    expect(literals).toEqual([...Object.values(AUDIO_FOCUS_CHANNELS)].sort())
  })

  it('方向正确：开关走 invoke（要回执），播放态走 send（单向上报）', () => {
    const source = read(PRELOAD_PATH)
    expect(source).toContain(`ipcRenderer.invoke('${AUDIO_FOCUS_CHANNELS.enable}'`)
    expect(source).toContain(`ipcRenderer.send('${AUDIO_FOCUS_CHANNELS.ours}'`)
  })

  it('主进程其它源码不硬编码通道字面量（只能经 AUDIO_FOCUS_CHANNELS 引用）', () => {
    const offenders: string[] = []
    for (const file of listSourceFiles(DESKTOP_SRC)) {
      if (file === path.join(DESKTOP_SRC, 'preload.ts')) continue
      if (file.includes(`${path.sep}__tests__${path.sep}`)) continue
      if (file.endsWith(path.join('audioFocus', 'types.ts'))) continue
      if (audioFocusLiterals(read(file)).length > 0) {
        offenders.push(path.relative(DESKTOP_SRC, file))
      }
    }
    expect(offenders).toEqual([])
  })

  it('渲染层不直接使用 audio-focus 通道（必须经 platform/preload）', () => {
    const offenders: string[] = []
    for (const file of listSourceFiles(APP_SRC)) {
      if (file.includes(`${path.sep}__tests__${path.sep}`)) continue
      if (audioFocusLiterals(read(file)).length > 0) {
        offenders.push(path.relative(APP_SRC, file))
      }
    }
    expect(offenders).toEqual([])
  })
})
