import { describe, expect, it } from 'vitest'
import { auroraProbeToResult, lxInspectionToProbe, unavailableProbe } from '../sourceProbe'

describe('lxInspectionToProbe（脚本源探测 → 原生结果）', () => {
  it('平台能力翻译成能力行：中文名优先、搜索动作判定可检索、音质档位数带上', () => {
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
      { key: 'kw', label: '酷我', searchable: false, qualityCount: 2 },
      { key: 'mg', label: '咪咕', searchable: true, qualityCount: 1 },
      { key: 'xx', label: '自报平台', searchable: false, qualityCount: 0 },
    ])
  })

  it('失败结论：ok=false + 源自报原因，能力表为空', () => {
    const out = lxInspectionToProbe({
      ok: false,
      platforms: {},
      error: '脚本未完成初始化（未收到 inited）',
    })
    expect(out.ok).toBe(false)
    expect(out.capabilities).toEqual([])
    expect(out.error).toContain('未完成初始化')
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
