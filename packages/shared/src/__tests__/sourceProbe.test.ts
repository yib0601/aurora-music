import { describe, expect, it } from 'vitest'
import { auroraProbeToResult, lxInspectionToProbe, unavailableProbe } from '../sourceProbe'
import { en, lookupMessage, zhCN } from '../i18n'
import { expectCode } from './i18nAssert'

describe('lxInspectionToProbe（脚本源探测 → 原生结果）', () => {
  it('平台能力翻译成能力行：已知平台给文案键、搜索动作判定可检索、音质档位数带上', () => {
    const out = lxInspectionToProbe({
      ok: true,
      platforms: {
        kw: { actions: ['musicUrl'], qualitys: ['128k', '320k'] },
        mg: { actions: ['musicUrl', 'musicSearch'], qualitys: ['128k'] },
        xx: { name: '自报平台', actions: [], qualitys: [] },
      },
    })
    expect(out.kind).toBe('lx')
    expect(out.ok).toBe(true)
    expect(out.capabilities).toEqual([
      // 已知平台：值是文案键（渲染期 t() 取值），不是中文名
      { key: 'kw', label: 'core.platform.kw', searchable: false, qualityCount: 2 },
      { key: 'mg', label: 'core.platform.mg', searchable: true, qualityCount: 1 },
      // 脚本自报的第三方名称原样透出（翻译器查不到键会返回原串，天然兜底）
      { key: 'xx', label: '自报平台', searchable: false, qualityCount: 0 },
    ])
    // 键必须在两种语言里都有文案 —— 只断言「值是键」会漏掉「键写错」的情况
    expect(lookupMessage(zhCN as never, out.capabilities[0].label)).toBe('酷我')
    expect(lookupMessage(en as never, out.capabilities[0].label)).toBe('Kuwo')
    expect(lookupMessage(zhCN as never, out.capabilities[1].label)).toBe('咪咕')
    expectCode(out.message, 'core.probe.lxOk')
  })

  it('失败结论：ok=false + 源自报原因，能力表为空', () => {
    const out = lxInspectionToProbe({
      ok: false,
      platforms: {},
      error: '脚本未完成初始化（未收到 inited）',
    })
    expect(out.ok).toBe(false)
    expect(out.capabilities).toEqual([])
    // 探测层给的是自由文本（第三方脚本原文）：原样透出，不吞信息
    expect(out.error).toBe('脚本未完成初始化（未收到 inited）')
  })

  it('失败但探测层没给原因时：给「未声明任何可用平台」的码，而不是空串', () => {
    const out = lxInspectionToProbe({ ok: false, platforms: {} })
    expect(out.capabilities).toEqual([])
    expectCode(out.error, 'core.error.lxNoPlatforms')
  })

  it('脚本自报元信息进入 scriptInfo（含 liscript 包装标记）', () => {
    const out = lxInspectionToProbe({
      ok: true,
      platforms: { kw: { actions: ['musicUrl'], qualitys: [] } },
      name: '六音',
      version: '1.2.1',
      author: 'pdone',
      packed: true,
    })
    expect(out.scriptInfo).toEqual({
      name: '六音',
      version: '1.2.1',
      description: undefined,
      author: 'pdone',
      homepage: undefined,
      packed: true,
    })
  })
})

describe('auroraProbeToResult（服务源探测 → 原生结果）', () => {
  it('端点翻译成能力行：只有 search 可检索，顺序固定', () => {
    const out = auroraProbeToResult({
      ok: true,
      message: '连接正常',
      selfDescribed: true,
      endpoints: {
        toplists: '/aurora/toplists',
        search: '/aurora?query={query}',
        playlist: '/aurora/playlist?url={url}',
      },
    })
    expect(out.kind).toBe('aurora')
    expect(out.capabilities.map((c) => c.key)).toEqual(['search', 'playlist', 'toplists'])
    expect(out.capabilities.find((c) => c.key === 'search')?.searchable).toBe(true)
    expect(out.capabilities.find((c) => c.key === 'toplists')?.searchable).toBe(false)
    expect(out.endpoints?.search).toBe('/aurora?query={query}')
  })

  it('失败结论：ok=false 且 error 带上服务端文案', () => {
    const out = auroraProbeToResult({
      ok: false,
      message: '连接失败：地址不可达或端口不正确',
      selfDescribed: false,
    })
    expect(out.ok).toBe(false)
    expect(out.error).toContain('连接失败')
    expect(out.capabilities).toEqual([])
  })

  it('失败且探测层没给文案时：给通用「源不可用」的码', () => {
    const out = auroraProbeToResult({ ok: false, message: '', selfDescribed: false })
    expectCode(out.error, 'core.error.sourceUnavailable')
  })

  it('端点能力行给文案键（渲染期取值），顺序固定', () => {
    const out = auroraProbeToResult({
      ok: true,
      message: 'ok',
      selfDescribed: true,
      endpoints: { search: '/aurora?query={query}', toplists: '/aurora/toplists' },
    })
    expect(out.capabilities.map((c) => c.label)).toEqual([
      'core.probe.endpoint.search',
      'core.probe.endpoint.toplists',
    ])
    expect(lookupMessage(zhCN as never, 'core.probe.endpoint.search')).toBe('在线搜索')
    expect(lookupMessage(en as never, 'core.probe.endpoint.search')).toBe('Online search')
  })
})

describe('unavailableProbe', () => {
  it('环境不支持时给同一份空能力结论', () => {
    expect(unavailableProbe('lx', '浏览器环境不支持脚本音源')).toEqual({
      ok: false,
      kind: 'lx',
      capabilities: [],
      error: '浏览器环境不支持脚本音源',
    })
  })
})
