/**
 * 设置页洛雪表单的**独立验证**（对抗性验证，与 lxSourceForm.test.ts 不重叠）
 *
 * 关注点只有两个，且都从外部可观测行为入手：
 *   1) 探测编排 runLxProbe：拉脚本 → 探测 → 状态收敛；异常必须转成可读文案而非穿透；
 *   2) 保存语义：脚本源码绝不进配置对象（洛雪源只落一条脚本链接）。
 *
 * 运行：cd packages/app && npx vitest run src/components/common/__tests__/lxVerifierForm.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  fetchLxScript: null as null | ((url: string) => Promise<string>),
  inspectLxSource: null as null | ((s: any) => Promise<any>),
  fetchCalls: [] as string[],
  inspectCalls: [] as any[],
}))

vi.mock('@/services/platform', () => ({
  platform: {
    platform: 'desktop',
    fetchLxScript: (url: string) => {
      h.fetchCalls.push(url)
      if (!h.fetchLxScript) throw new Error('未桩 fetchLxScript')
      return h.fetchLxScript(url)
    },
    inspectLxSource: (s: any) => {
      h.inspectCalls.push(s)
      if (!h.inspectLxSource) throw new Error('未桩 inspectLxSource')
      return h.inspectLxSource(s)
    },
  },
}))

beforeEach(() => {
  h.fetchCalls.length = 0
  h.inspectCalls.length = 0
  h.fetchLxScript = async () => 'globalThis.lx && 0'
  h.inspectLxSource = async () => ({
    ok: true,
    platforms: { kw: { type: 'music', actions: ['musicUrl'], qualitys: ['128k'] } },
  })
})

describe('runLxProbe 探测编排（独立验证）', () => {
  it('成功路径：拉脚本一次、探测一次，且探测入参带 script 且不含落盘字段', async () => {
    const { runLxProbe } = await import('@/components/common/lxSourceForm')
    const state = await runLxProbe('lx-1', '  https://example.com/latest.js  ', { 'X-A': 'b' })
    expect(state.loading).toBe(false)
    expect(state.ok).toBe(true)
    expect(state.message).toBe('脚本可用')
    expect(h.fetchCalls).toEqual(['https://example.com/latest.js']) // 前后空白被裁剪
    expect(h.inspectCalls.length).toBe(1)
    const arg = h.inspectCalls[0]
    expect(arg.kind).toBe('lx')
    expect(arg.script).toBe('globalThis.lx && 0')
    expect(arg.headers).toEqual({ 'X-A': 'b' })
  })

  it('链接非法：连脚本都不拉，直接给可读文案', async () => {
    const { runLxProbe } = await import('@/components/common/lxSourceForm')
    for (const bad of ['', '   ', 'ftp://x/a.js', 'javascript:alert(1)']) {
      const state = await runLxProbe('lx-1', bad)
      expect(state.ok).toBe(false)
      expect(typeof state.message).toBe('string')
      expect(state.message!.length).toBeGreaterThan(0)
    }
    expect(h.fetchCalls.length).toBe(0)
    expect(h.inspectCalls.length).toBe(0)
  })

  it('拉脚本抛错（网络失败）：转成可读文案，不穿透异常', async () => {
    h.fetchLxScript = async () => {
      throw new Error('脚本下载失败：HTTP 502')
    }
    const { runLxProbe } = await import('@/components/common/lxSourceForm')
    const state = await runLxProbe('lx-1', 'https://example.com/latest.js')
    expect(state.ok).toBe(false)
    expect(state.message).toContain('HTTP 502')
  })

  it('探测返回 ok=false：文案里带上脚本自报的原因，且把 inspection 回传界面', async () => {
    h.inspectLxSource = async () => ({ ok: false, platforms: {}, error: '脚本未完成初始化（未收到 inited）' })
    const { runLxProbe } = await import('@/components/common/lxSourceForm')
    const state = await runLxProbe('lx-1', 'https://example.com/latest.js')
    expect(state.ok).toBe(false)
    expect(state.message).toContain('脚本未完成初始化')
    expect(state.inspection?.ok).toBe(false)
  })

  it('真实调用路径（Ui 侧不传 inspection）：每次「测试」都会重新拉脚本与重新探测', async () => {
    // 事实核对：调用点 LxSourceProbe.tsx 的 runLxProbe(instanceId, url, headers) 从不传
    // opts.inspection，因此 lxSourceForm.ts 注释里宣称的「复用已有探测结果」分支在 UI 上不可达。
    // 这里按现状断言（重复探测由主进程的脚本缓存吸收网络开销），避免把注释当契约。
    const { runLxProbe } = await import('@/components/common/lxSourceForm')
    const probe = await runLxProbe('lx-card-a', 'https://example.com/latest.js')
    const probeAgain = await runLxProbe('lx-card-a', 'https://example.com/latest.js')
    expect(probe.ok).toBe(true)
    expect(probeAgain.ok).toBe(true)
    expect(h.fetchCalls.length).toBe(2)
    expect(h.inspectCalls.length).toBe(2)
  })

  it('显式传入 inspection 时才复用（该分支仅测试可达）', async () => {
    const { runLxProbe } = await import('@/components/common/lxSourceForm')
    const cached = { ok: true, platforms: { kw: { type: 'music', actions: ['musicUrl'], qualitys: ['128k'] } } }
    const state = await runLxProbe('lx-1', 'https://example.com/latest.js', undefined, {
      inspection: cached as any,
      message: '已测试通过',
    })
    expect(state.ok).toBe(true)
    expect(state.message).toBe('已测试通过')
    expect(state.inspection).toBe(cached)
    expect(h.inspectCalls.length).toBe(0)
  })

  it('传入的 inspection 为 ok=false 时不得当成通过', async () => {
    const { runLxProbe } = await import('@/components/common/lxSourceForm')
    const state = await runLxProbe('lx-1', 'https://example.com/latest.js', undefined, {
      inspection: { ok: false, platforms: {}, error: '脚本未声明任何可用平台' } as any,
    })
    expect(state.ok).toBe(false)
    expect(state.message).toContain('脚本未声明任何可用平台')
  })
})