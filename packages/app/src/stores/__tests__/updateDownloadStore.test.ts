import { describe, expect, it } from 'vitest'
import { AuroraError, createAppTranslator, translateError, type ErrorInfo } from '@aurora/shared'
import { normalizeFailure } from '@/stores/updateDownloadStore'

/**
 * 更新链路的错误归一：三条异构来源（主进程事件 message、Android 原生 error 文本、
 * JS 异常）都要收敛成**结构化载荷**，由显示端按当前语言渲染。
 *
 * 这里守的是两件容易回归的事：
 *   1. 原生侧回传的中文短句（状态词）不许直接透出上屏，否则英文界面冒中文；
 *   2. 认不出来的技术原文不许炸到界面上，只进 detail。
 */

const t = createAppTranslator('zh-CN')
const tEn = createAppTranslator('en')

/** 载荷 → 可渲染的异常（组件里 error 取自 store，再交给 translateError 渲染） */
function asError(info: ErrorInfo): AuroraError {
  return new AuroraError(info.code, info.params, info.detail)
}

describe('normalizeFailure', () => {
  it('空原因落到通用下载失败句', () => {
    expect(normalizeFailure(undefined).code).toBe('update.error.downloadFailed')
    expect(normalizeFailure('').code).toBe('update.error.downloadFailed')
    expect(normalizeFailure('   ').code).toBe('update.error.downloadFailed')
  })

  it('原生回传的「已取消」是状态不是文案：转成码，两种语言各自渲染', () => {
    expect(normalizeFailure('已取消').code).toBe('update.error.canceled')
    expect(normalizeFailure('Canceled').code).toBe('update.error.canceled')
    expect(translateError(asError(normalizeFailure('已取消')), t)).toBe('已取消')
    expect(translateError(asError(normalizeFailure('已取消')), tEn)).toBe('Canceled')
  })

  it('HTTP 状态码按网络错误归类，状态码进 detail 供诊断', () => {
    const inaccessible = normalizeFailure('HTTP 502')
    expect(inaccessible.code).toBe('errors.network.unreachable')
    expect(inaccessible.detail).toBe('HTTP 502')
    expect(translateError(asError(inaccessible), tEn)).toMatch(/Network unreachable/i)

    const timedOut = normalizeFailure('HTTP 504')
    expect(timedOut.code).toBe('errors.network.timeout')
    expect(translateError(asError(timedOut), t)).toMatch(/超时/)
  })

  it('AuroraError 的码被原样保留（不重复包一层兜底）', () => {
    const encoded = new Error('AURORA_ERR:{"code":"update.error.notSupported"}')
    expect(normalizeFailure(encoded).code).toBe('update.error.notSupported')
    expect(translateError(encoded, tEn)).toBe('This build does not support in-app updates')
  })

  it('认不出的技术原文只进 detail，上屏走兜底句而不是原文', () => {
    const raw = new Error('checksum mismatch: expected abc, got def')
    const info = normalizeFailure(raw)
    expect(info.code).toBe('update.error.downloadFailed')
    expect(info.detail).toContain('checksum mismatch')
    expect(translateError(asError(info), tEn)).toBe('Download failed, please try again later')
  })
})
