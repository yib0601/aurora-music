/**
 * 宿主能力注册表单测。
 *
 * 这层的价值全在**判定**上：能力缺失时插件该不该注册。所以用例集中在
 * 「必需缺失 → 不通过」「可选缺失 → 通过但值不可见」「版本不匹配 → 不通过」
 * 这三条语义，以及"清单字段 → 依赖"的推导没有第二份真源。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  HOST_CAPABILITY_VERSION,
  clearHostCapabilitiesForTest,
  describeMissingCapabilities,
  getHostCapability,
  listHostCapabilities,
  registerHostCapability,
  requirementsOfManifest,
  resolveRequirements,
  unregisterHostCapability,
  type CapabilityRequirement,
} from '../hostCapabilities'

beforeEach(() => {
  // 清空后会自动装回默认能力（http.fetch / log），这是模块的不变量
  clearHostCapabilitiesForTest()
})

afterEach(() => {
  clearHostCapabilitiesForTest()
})

describe('注册与查表', () => {
  it('默认能力在模块求值后即可用（否则启动早期会把所有插件判成不可用）', () => {
    expect(getHostCapability('http.fetch')).toBeTruthy()
    expect(getHostCapability('log')).toBeTruthy()
    // 平台相关的能力不该有默认值：缺了就是缺了，必须让判定如实反映
    expect(getHostCapability('script.host')).toBeUndefined()
    expect(getHostCapability('credential')).toBeUndefined()
  })

  it('同 id 重复注册是替换实现且保留位置（热替换语义）', () => {
    const before = listHostCapabilities().map((c) => c.id)
    const first = () => 'v1'
    const second = () => 'v2'
    registerHostCapability('http.fetch', 1, first)
    registerHostCapability('http.fetch', 1, second)
    const after = listHostCapabilities().map((c) => c.id)
    // 位置不变：UI 每次刷新的顺序不该抖动
    expect(after).toEqual(before)
    expect(getHostCapability<() => string>('http.fetch')?.impl()).toBe('v2')
  })

  it('非法 id / 非法版本在注册期就拒绝（它们参与相等判定，错值会让匹配永远失败）', () => {
    expect(() => registerHostCapability('' as never, 1, null)).toThrow()
    expect(() => registerHostCapability('http.fetch', 0, null)).toThrow()
    expect(() => registerHostCapability('http.fetch', 1.5, null)).toThrow()
  })
})

describe('resolveRequirements：可用性判定', () => {
  it('全部满足 → ok，且能取到实现', () => {
    const impl = () => 'ok'
    registerHostCapability('script.host', 1, impl)
    const req: CapabilityRequirement[] = [
      { id: 'http.fetch', version: 1 },
      { id: 'script.host', version: 1 },
    ]
    const avail = resolveRequirements(req)
    expect(avail.ok).toBe(true)
    if (avail.ok) expect(avail.resolved.get('script.host')).toBe(impl)
  })

  it('必需能力缺失 → 不通过，并给出缺口（这是"浏览器没有脚本宿主"的正常路径）', () => {
    const avail = resolveRequirements([{ id: 'script.host', version: 1 }])
    expect(avail.ok).toBe(false)
    if (!avail.ok) {
      expect(avail.missing).toHaveLength(1)
      expect(avail.missing[0].reason).toBe('missing')
      expect(avail.missing[0].requirement.id).toBe('script.host')
    }
  })

  it('可选能力缺失 → **通过**，且该能力不出现在 resolved 里', () => {
    const avail = resolveRequirements([
      { id: 'http.fetch', version: 1 },
      { id: 'credential', version: 1, optional: true },
    ])
    expect(avail.ok).toBe(true)
    if (avail.ok) {
      // 缺失的可选能力必须是 undefined，不能伪装成"有但是空值"
      expect(avail.resolved.has('credential')).toBe(false)
      expect(avail.resolved.get('credential')).toBeUndefined()
    }
  })

  it('版本不匹配 → 不通过，即使标了 optional（按 v1 用法喂 v2 实现比"没有"更危险）', () => {
    registerHostCapability('script.host', 2, {})
    const avail = resolveRequirements([{ id: 'script.host', version: 1, optional: true }])
    expect(avail.ok).toBe(false)
    if (!avail.ok) {
      expect(avail.missing[0].reason).toBe('version-mismatch')
      expect(avail.missing[0].actualVersion).toBe(2)
    }
  })

  it('空依赖清单 → 通过（纯计算型插件确实不需要宿主能力）', () => {
    expect(resolveRequirements([]).ok).toBe(true)
  })

  it('畸形条目被跳过而不是抛错（插件对象可能来自磁盘）', () => {
    const avail = resolveRequirements([null as never, {} as never])
    expect(avail.ok).toBe(true)
  })

  it('缺口描述可读：能区分「未提供」与「版本对不上」', () => {
    registerHostCapability('script.host', 3, {})
    const avail = resolveRequirements([
      { id: 'credential', version: 1 },
      { id: 'script.host', version: 1 },
    ])
    expect(avail.ok).toBe(false)
    if (!avail.ok) {
      const lines = describeMissingCapabilities(avail.missing)
      expect(lines.some((l) => l.includes('credential') && l.includes('未提供'))).toBe(true)
      expect(lines.some((l) => l.includes('script.host') && l.includes('宿主提供 @3'))).toBe(true)
    }
  })
})

describe('requirementsOfManifest：唯一的推导入口', () => {
  it('network → http.fetch', () => {
    const ids = requirementsOfManifest({ permissions: ['network'] }).map((r) => r.id)
    expect(ids).toContain('http.fetch')
  })

  it('credential → credential', () => {
    const ids = requirementsOfManifest({ permissions: ['credential'] }).map((r) => r.id)
    expect(ids).toContain('credential')
  })

  it('有脚本块 → script.host（B 档的核心依赖）', () => {
    const ids = requirementsOfManifest({ permissions: ['network'], hasScript: true }).map((r) => r.id)
    expect(ids).toContain('script.host')
  })

  it('net.allowlist 无条件必需（每次出网都该被白名单强制）', () => {
    expect(requirementsOfManifest({}).map((r) => r.id)).toContain('net.allowlist')
    expect(requirementsOfManifest({ permissions: ['network'] }).map((r) => r.id)).toContain(
      'net.allowlist'
    )
  })

  it('去重：同一能力不重复声明', () => {
    const reqs = requirementsOfManifest({ permissions: ['network', 'network'], hasScript: true })
    const ids = reqs.map((r) => r.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('推导出的版本与集中定义的版本一致（避免两处魔法数字漂移）', () => {
    const reqs = requirementsOfManifest({ permissions: ['network', 'credential'], hasScript: true })
    for (const req of reqs) {
      expect(req.version).toBe(HOST_CAPABILITY_VERSION[req.id])
    }
  })
})

describe('unregisterHostCapability', () => {
  it('撤销后判定立刻反映缺失（端切换 / 降级场景）', () => {
    registerHostCapability('script.host', 1, {})
    expect(resolveRequirements([{ id: 'script.host', version: 1 }]).ok).toBe(true)
    expect(unregisterHostCapability('script.host')).toBe(true)
    expect(resolveRequirements([{ id: 'script.host', version: 1 }]).ok).toBe(false)
  })
})
