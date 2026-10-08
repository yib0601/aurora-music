import { describe, expect, it } from 'vitest'
import { messageOf } from '@/stores/musicHallStore'

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
 */
describe('messageOf（在线音乐错误文案归一）', () => {
  it('保留执行器给出的中文结论', () => {
    expect(messageOf(new Error('音源「QQ_Music」请求超时（15000ms）'))).toBe('音源「QQ_Music」请求超时（15000ms）')
  })

  it('剥掉 IPC 前缀，只留执行器的中文结论', () => {
    const err = new Error("Error invoking remote method 'hall:recommend': Error: 音源「QQ_Music」返回 HTTP 502")
    expect(messageOf(err)).toBe('音源「QQ_Music」返回 HTTP 502')
  })

  it('底层英文 AbortError 翻成中文超时提示', () => {
    const err = new Error(
      "Error invoking remote method 'hall:recommend': AbortError: The operation was aborted."
    )
    const msg = messageOf(err)
    expect(msg).not.toMatch(/aborted/i)
    expect(msg).toMatch(/请求超时/)
  })

  it('不带 IPC 前缀的裸 AbortError（移动端渲染层直调）同样翻译', () => {
    const err = new Error('The operation was aborted.')
    err.name = 'AbortError'
    expect(messageOf(err)).toMatch(/请求超时/)
  })

  it('网络层英文错误不裸露（TypeError: Failed to fetch）', () => {
    const err = new Error("Error invoking remote method 'hall:toplists': TypeError: Failed to fetch")
    expect(messageOf(err)).toMatch(/网络不可达|连接失败/)
  })

  it('空消息回落到「加载失败」', () => {
    expect(messageOf(new Error(''))).toBe('加载失败')
  })

  it('非 Error 输入按字符串处理', () => {
    expect(messageOf('boom')).toBe('boom')
  })
})