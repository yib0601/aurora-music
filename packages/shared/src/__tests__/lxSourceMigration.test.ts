import { migrateOnlineSources } from '../sourceMigration'
import { parseSourceInput } from '../auroraPreset'
import type { OnlineSourceConfig } from '../types'

/**
 * 洛雪脚本源（kind='lx'）的迁移语义：
 * sourceUrl 是脚本链接，不是 aurora 端点地址——迁移必须整体绕开端点解析与派生，
 * 也不允许产出 endpoints / playlistUrl（脚本源没有这两个概念）。
 */

/** 真实形态的脚本链接（对应 README 里说明的「洛雪音源脚本」） */
const LX_URL = 'https://raw.githubusercontent.com/pdone/lx-music-source/main/huibq/latest.js'

const LX_SOURCE = {
  id: 'lx-1',
  name: '我的洛雪源',
  kind: 'lx',
  sourceUrl: LX_URL,
  headers: { 'X-Test': 'lx' },
  enabled: true,
}

/** 老形态输入：v10 之前的「服务地址 + 密钥 + 已拼好的端点」 */
const LEGACY_AURORA = {
  id: 'src-1',
  name: '我的音源',
  apiUrl: 'https://music.example.com/aurora?query={query}&quality={quality}&key=K1',
  preset: 'aurora',
  baseUrl: 'https://music.example.com',
  apiKey: 'K1',
  enabled: true,
}

describe('migrateOnlineSources（洛雪脚本源）', () => {
  it('kind="lx"：保留五个业务字段，不产生 endpoints / playlistUrl', () => {
    const out = migrateOnlineSources([LX_SOURCE])
    expect(out).toEqual([
      {
        id: 'lx-1',
        name: '我的洛雪源',
        kind: 'lx',
        sourceUrl: LX_URL,
        headers: { 'X-Test': 'lx' },
        enabled: true,
      },
    ])
    expect(out[0]).not.toHaveProperty('endpoints')
    expect(out[0]).not.toHaveProperty('playlistUrl')
    // 老字段全部不残留
    expect(out[0]).not.toHaveProperty('apiUrl')
    expect(out[0]).not.toHaveProperty('preset')
    expect(out[0]).not.toHaveProperty('baseUrl')
    expect(out[0]).not.toHaveProperty('apiKey')
  })

  it('脚本链接不含占位符时不会被当成服务地址去派生 aurora 端点', () => {
    // 前提对照：单看链接，parseSourceInput 会把它判成「服务地址」（裸链接形态）
    expect(parseSourceInput(LX_URL)?.kind).toBe('service')
    const [s] = migrateOnlineSources([{ ...LX_SOURCE, sourceUrl: LX_URL }])
    // 但 kind='lx' 分支优先短路：不落库任何端点、也不派生歌单解析地址
    expect(s.kind).toBe('lx')
    expect(s.sourceUrl).toBe(LX_URL)
    expect(s.endpoints).toBeUndefined()
    expect(s.playlistUrl).toBeUndefined()
  })

  it('脚本链接含 {query} 占位符时也不被当成接口模板', () => {
    const templated = 'https://cdn.example.com/lx/{query}-source.js'
    // 前提对照：单看链接，它满足「含占位符 → 接口模板」的判定
    expect(parseSourceInput(templated)?.kind).toBe('endpoint')
    const [s] = migrateOnlineSources([
      { id: 'lx-2', name: '带占位符的脚本链接', kind: 'lx', sourceUrl: templated, enabled: true },
    ])
    expect(s.kind).toBe('lx')
    expect(s.sourceUrl).toBe(templated) // 原样保留，不做任何占位符解析
    expect(s.endpoints).toBeUndefined()
    expect(s.playlistUrl).toBeUndefined()
  })

  it('停用状态与缺省字段：enabled=false 保留，缺 id/name 补默认值', () => {
    const out = migrateOnlineSources([
      { kind: 'lx', sourceUrl: LX_URL, enabled: false },
      { id: '', name: '', kind: 'lx', sourceUrl: LX_URL, enabled: true },
    ])
    expect(out[0].id).toMatch(/^src-/)
    expect(out[0].name).toBe('洛雪音源')
    expect(out[0].enabled).toBe(false)
    expect(out[1].id).toMatch(/^src-/)
    expect(out[1].name).toBe('洛雪音源')
    expect(out[1].enabled).toBe(true)
  })

  it('迁移幂等：重复迁移不丢字段、不改变形态', () => {
    const once = migrateOnlineSources([LX_SOURCE])
    expect(migrateOnlineSources(once)).toEqual(once)
  })

  it('与 aurora 源混排时各走各的分支，顺序不变', () => {
    const out = migrateOnlineSources([LX_SOURCE, LEGACY_AURORA])
    expect(out).toHaveLength(2)
    expect(out[0].kind).toBe('lx')
    expect(out[0].sourceUrl).toBe(LX_URL)
    expect(out[1].kind).toBeUndefined() // aurora 源不写 kind
    expect(out[1].sourceUrl).toBe('https://music.example.com?key=K1')
  })
})

describe('migrateOnlineSources（aurora 路径回归）', () => {
  it('kind 缺省的老配置仍走原路径：服务地址收敛成一条 sourceUrl，端点不落库', () => {
    const [s] = migrateOnlineSources([LEGACY_AURORA])
    expect(s).toEqual({
      id: 'src-1',
      name: '我的音源',
      sourceUrl: 'https://music.example.com?key=K1',
      enabled: true,
    })
    expect(s.kind).toBeUndefined()
  })

  // 迁移的输出形态对 aurora 源一律不写 kind（缺省即 aurora，语义等价）；
  // 显式写了 kind:'aurora' 也一并抹平，结果与缺省完全一致。
  it('显式 kind="aurora" 与缺省等价（输出不带 kind，语义仍是 aurora）', () => {
    const withKind = migrateOnlineSources([{ ...LEGACY_AURORA, kind: 'aurora' }])
    expect(withKind).toEqual(migrateOnlineSources([LEGACY_AURORA]))
    expect(withKind[0].sourceUrl).toBe('https://music.example.com?key=K1')
    expect(withKind[0].kind).toBeUndefined()
    expect(withKind[0].endpoints).toBeUndefined()
  })

  it('接口模板形态的歌单地址仍单独保留（更高优先级的 aurora 语义未被 lx 分支影响）', () => {
    const [s] = migrateOnlineSources([
      {
        id: 'src-2',
        name: '第三方',
        apiUrl: 'https://api.example.com/search?q={query}',
        playlistUrl: 'https://api.example.com/resolve?url={url}',
        enabled: true,
      },
    ])
    expect((s as OnlineSourceConfig).sourceUrl).toBe('https://api.example.com/search?q={query}')
    expect(s.playlistUrl).toBe('https://api.example.com/resolve?url={url}')
  })

  it('kind 为未知值时按 aurora 处理（不误判成洛雪源）', () => {
    const [s] = migrateOnlineSources([{ ...LEGACY_AURORA, kind: 'lx-old' }])
    expect(s.kind).toBeUndefined()
    expect(s.sourceUrl).toBe('https://music.example.com?key=K1')
  })
})