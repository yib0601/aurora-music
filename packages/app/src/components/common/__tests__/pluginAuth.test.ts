import { describe, it, expect } from 'vitest'
import {
  authStateText,
  authStateTone,
  pluginsNeedingAuth,
  renderAuthError,
  renderProbeResult,
} from '../pluginAuth'
import type { PluginAuthState } from '@aurora/shared'
import type { PluginMetaInfo } from '@/services/platform'

/**
 * 登录面板的纯逻辑。重点覆盖两条容易出错的口径：
 * 1. `valid === undefined`（未校验）**不得**显示成「已失效」——否则用户会被误导去重新登录；
 * 2. 需要登录的插件按**能力**筛选，不按 id 硬编码。
 */

const meta = (id: string, capabilities: string[]): PluginMetaInfo => ({
  id,
  displayNameKey: 'core.platform.qishui',
  version: '1.0.0',
  capabilities,
  hasCredential: false,
})

describe('需要登录的插件筛选', () => {
  it('按能力筛选，不按 id 硬编码', () => {
    const list = [
      meta('aurora', ['probe', 'search']),
      meta('qishui', ['playlistTracks', 'auth']),
      meta('future', ['auth']),
    ]
    expect(pluginsNeedingAuth(list).map((p) => p.id)).toEqual(['qishui', 'future'])
  })

  it('没有 auth 能力的插件不出现', () => {
    expect(pluginsNeedingAuth([meta('aurora', ['search'])])).toEqual([])
  })

  /**
   * 停用的插件不列进登录区：它不参与执行，登录状态没有任何意义，
   * 而"能登录"这个入口本身会让用户以为插件还在工作。
   */
  it('已停用的插件不出现（即使有 auth 能力）', () => {
    const list = [
      { ...meta('qishui', ['auth']), enabled: false },
      { ...meta('future', ['auth']), enabled: true },
    ]
    expect(pluginsNeedingAuth(list).map((p) => p.id)).toEqual(['future'])
  })

  it('enabled 缺失（老 preload 不带该字段）按启用处理，行为与改造前一致', () => {
    const legacy = meta('qishui', ['auth'])
    expect('enabled' in legacy).toBe(false)
    expect(pluginsNeedingAuth([legacy]).map((p) => p.id)).toEqual(['qishui'])
  })
})

describe('登录态文案', () => {
  it('未登录', () => {
    expect(authStateText(null)).toContain('未登录')
    expect(authStateText({ loggedIn: false })).toContain('未登录')
  })

  it('已登录但未校验（valid undefined）显示「已登录」，不显示「已失效」', () => {
    const state: PluginAuthState = { loggedIn: true, valid: undefined }
    const text = authStateText(state)
    expect(text).toContain('已登录')
    // 关键：未校验 ≠ 失效。把它当失效会让用户白重登一次
    expect(text).not.toContain('失效')
  })

  it('明确失效时如实提示', () => {
    const state: PluginAuthState = { loggedIn: true, valid: false }
    expect(authStateText(state)).toContain('失效')
  })
})

describe('登录态配色', () => {
  it('未登录是中性色', () => {
    expect(authStateTone(null)).toBe('idle')
  })

  it('已登录是成功色，失效是警示色', () => {
    expect(authStateTone({ loggedIn: true, valid: true })).toBe('ok')
    expect(authStateTone({ loggedIn: true, valid: undefined })).toBe('ok')
    expect(authStateTone({ loggedIn: true, valid: false })).toBe('warn')
  })
})

describe('错误与探测结果渲染', () => {
  it('结构化错误按当前语言渲染（不是原样吐出编码串）', () => {
    const text = renderAuthError('AURORA_ERR:{"code":"core.error.qishuiSessionIdInvalid"}')
    expect(text).not.toContain('AURORA_ERR')
    expect(text.length).toBeGreaterThan(0)
  })

  it('自由文本原样透出（不吞技术细节）', () => {
    expect(renderAuthError(new Error('boom'))).toBe('boom')
  })

  it('探测结果为 null 时给空串（不渲染 undefined）', () => {
    expect(renderProbeResult(null)).toBe('')
  })

  it('探测失败时优先用 error 字段', () => {
    const text = renderProbeResult({
      ok: false,
      kind: 'aurora',
      capabilities: [],
      error: 'AURORA_ERR:{"code":"core.error.qishuiLoginRequired"}',
    })
    expect(text).not.toContain('AURORA_ERR')
  })
})
