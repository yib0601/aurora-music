import { describe, expect, it } from 'vitest'
import { createAppTranslator } from '@aurora/shared'
import { messageOf } from '@/stores/musicHallStore'
import { useLocaleStore } from '@/stores/localeStore'

/**
 * 桌面端在线音乐的错误文案链路：
 *   主进程执行器抛错 → IPC 回传 → preload 的 ipcRenderer.invoke reject。
 *
 * Electron 会把错误重建成 `Error`，message 前拼一句
 * "Error invoking remote method '<channel>': "，**name 一律退化成 Error**。
 * 实测（探针 Electron，2026-10-08）：
 *   主进程 throw DOMException('The operation was aborted.', 'AbortError')
 *   → 渲染层收到 { name: 'Error', message: "Error invoking remote method 'probe:throwAbort': AbortError: The operation was aborted." }
 * 于是「英文 AbortError 直接上屏」这条路径只能靠 message 里的状态词拦。
 *
 * 改造后：这些规则都在 `@aurora/shared` 的 i18n/errors.ts（toErrorInfo + translateError），
 * app 侧的 messageOf 只是接线。因此本用例同时守住两件事：
 *   1. 可观察行为不变（剥前缀 / AbortError→超时 / Failed to fetch→不可达 / 空→兜底 / 非 Error 当字符串）；
 *   2. 文案随语言走——注入 `createAppTranslator('en')` 必须得到英文，
 *      默认参数（读 locale store 快照）也必须跟着切，而不是永远中文。
 */
const zh = createAppTranslator('zh-CN')
const en = createAppTranslator('en')

describe('messageOf（在线音乐错误文案归一）', () => {
  it('保留执行器给出的原文（未识别为已知底层异常时不改写）', () => {
    expect(messageOf(new Error('音源「QQ_Music」请求超时（15000ms）'), zh)).toBe('音源「QQ_Music」请求超时（15000ms）')
  })

  it('剥掉 IPC 前缀，只留执行器的结论', () => {
    const err = new Error("Error invoking remote method 'hall:recommend': Error: 音源「QQ_Music」返回 HTTP 502")
    expect(messageOf(err, zh)).toBe('音源「QQ_Music」返回 HTTP 502')
  })

  it('底层英文 AbortError 翻成中文超时提示', () => {
    const err = new Error(
      "Error invoking remote method 'hall:recommend': AbortError: The operation was aborted."
    )
    const msg = messageOf(err, zh)
    expect(msg).not.toMatch(/aborted/i)
    expect(msg).toMatch(/请求超时/)
  })

  it('不带 IPC 前缀的裸 AbortError（移动端渲染层直调）同样翻译', () => {
    const err = new Error('The operation was aborted.')
    err.name = 'AbortError'
    expect(messageOf(err, zh)).toMatch(/请求超时/)
  })

  it('网络层英文错误不裸露（TypeError: Failed to fetch）', () => {
    const err = new Error("Error invoking remote method 'hall:toplists': TypeError: Failed to fetch")
    expect(messageOf(err, zh)).toMatch(/网络不可达/)
  })

  it('空消息回落到通用失败文案', () => {
    // 兜底句由字典定（errors.unknown），不再在 app 侧写死一句中文
    expect(messageOf(new Error(''), zh)).toBe(zh('errors.unknown'))
    expect(messageOf(new Error(''), zh)).toBe('操作失败')
  })

  it('非 Error 输入按字符串处理', () => {
    expect(messageOf('boom', zh)).toBe('boom')
  })

  it('英文界面下同一批错误出英文文案', () => {
    expect(messageOf(new Error("Error invoking remote method 'hall:recommend': AbortError: The operation was aborted."), en)).toMatch(
      /timed out/i
    )
    expect(messageOf(new Error("Error invoking remote method 'hall:toplists': TypeError: Failed to fetch"), en)).toMatch(
      /Network unreachable/i
    )
    expect(messageOf(new Error(''), en)).toBe(en('errors.unknown'))
    expect(messageOf(new Error(''), en)).toBe('Operation failed')
  })

  it('未识别的历史中文错误在英文界面下仍原样透出（宁可显示原文也不抹平信息量）', () => {
    const err = new Error("Error invoking remote method 'hall:recommend': Error: 音源「QQ_Music」返回 HTTP 502")
    expect(messageOf(err, en)).toBe('音源「QQ_Music」返回 HTTP 502')
  })

  it('不传翻译函数时跟随 locale store（默认参数读的是实时快照，不是模块级求值）', () => {
    const before = useLocaleStore.getState().language
    useLocaleStore.setState({ language: 'en' })
    try {
      const msg = messageOf(new Error('The operation was aborted.'))
      expect(msg).toMatch(/timed out/i)
      expect(msg).not.toMatch(/请求超时/)
    } finally {
      useLocaleStore.setState({ language: before })
    }
    expect(messageOf(new Error('The operation was aborted.'))).toMatch(/请求超时/)
  })
})
