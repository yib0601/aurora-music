/**
 * 设置页脚本源表单的**独立验证**（对抗性验证，与 lxSourceForm.test.ts 不重叠）
 *
 * 关注点只有两个，且都从外部可观测行为入手：
 *   1) 探测编排 runLxProbe：交给平台通用入口 → 状态收敛；异常必须转成可读文案而非穿透；
 *   2) 界面纪律：脚本源码不进配置、也不经界面流转 —— 拉取与执行全在平台适配器内部完成。
 *
 * 运行：cd packages/app && npx vitest run src/components/common/__tests__/lxVerifierForm.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  probe: null as null | ((input: any) => Promise<any>),
  probeCalls: [] as any[],
}))

vi.mock('@/services/platform', () => ({
  platform: {
    platform: 'desktop',
    probeSource: (input: any) => {
      h.probeCalls.push(input)
      if (!h.probe) throw new Error('未桩 probeSource')
      return h.probe(input)
    },
  },
}))

beforeEach(() => {
  h.probeCalls.length = 0
  h.probe = async () => ({
    ok: true,
    kind: 'lx',
    message: '脚本可用',
    capabilities: [{ key: 'kw', label: '酷我', searchable: false, qualityCount: 1 }],
  })
})

describe('runLxProbe 探测编排（独立验证）', () => {
  it('成功路径：探测入参只带链接与请求头，脚本源码不经界面流转', async () => {
    const { runLxProbe } = await import('@/components/common/lxSourceForm')
    const state = await runLxProbe('lx-1', '  https://example.com/latest.js  ', { 'X-A': 'b' })
    expect(state.loading).toBe(false)
    expect(state.ok).toBe(true)
    expect(state.message).toBe('脚本可用')
    expect(h.probeCalls.length).toBe(1)
    const arg = h.probeCalls[0]
    expect(arg.kind).toBe('lx')
    expect(arg.sourceUrl).toBe('https://example.com/latest.js') // 前后空白被裁剪
    expect(arg.headers).toEqual({ 'X-A': 'b' })
    // 界面层拿不到脚本源码，也没有这个字段可传：拉取 + 执行由平台适配器负责
    expect('script' in arg).toBe(false)
  })

  it('链接非法：连平台都不调，直接给可读文案', async () => {
    const { runLxProbe } = await import('@/components/common/lxSourceForm')
    for (const bad of ['', '   ', 'ftp://x/a.js', 'javascript:alert(1)']) {
      const state = await runLxProbe('lx-1', bad)
      expect(state.ok).toBe(false)
      expect(typeof state.message).toBe('string')
      expect(state.message!.length).toBeGreaterThan(0)
    }
    expect(h.probeCalls.length).toBe(0)
  })

  it('平台探测抛错（脚本下载失败）：转成可读文案，不穿透异常', async () => {
    h.probe = async () => {
      throw new Error('脚本下载失败：HTTP 502')
    }
    const { runLxProbe } = await import('@/components/common/lxSourceForm')
    const state = await runLxProbe('lx-1', 'https://example.com/latest.js')
    expect(state.ok).toBe(false)
    expect(state.message).toContain('HTTP 502')
  })

  it('探测返回 ok=false：文案里带上源自报的原因，且把结论回传界面', async () => {
    h.probe = async () => ({
      ok: false,
      kind: 'lx',
      capabilities: [],
      error: '脚本未完成初始化（未收到 inited）',
    })
    const { runLxProbe } = await import('@/components/common/lxSourceForm')
    const state = await runLxProbe('lx-1', 'https://example.com/latest.js')
    expect(state.ok).toBe(false)
    expect(state.message).toContain('脚本未完成初始化')
    expect(state.result?.ok).toBe(false)
  })

  it('真实调用路径（界面不传结论）：每次「测试」都会重新探测', async () => {
    // 事实核对：调用点 LxSourceProbe.tsx 的 runLxProbe(instanceId, url, headers) 从不传
    // opts.result，因此「复用已有探测结论」分支在 UI 上不可达。这里按现状断言
    // （重复探测由平台侧的脚本缓存吸收网络开销），避免把注释当契约。
    const { runLxProbe } = await import('@/components/common/lxSourceForm')
    const first = await runLxProbe('lx-card-a', 'https://example.com/latest.js')
    const second = await runLxProbe('lx-card-a', 'https://example.com/latest.js')
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    expect(h.probeCalls.length).toBe(2)
  })

  it('显式传入结论时才复用（该分支仅测试可达）', async () => {
    const { runLxProbe } = await import('@/components/common/lxSourceForm')
    const cached = { ok: true, kind: 'lx', capabilities: [] }
    const state = await runLxProbe('lx-1', 'https://example.com/latest.js', undefined, {
      result: cached as any,
      message: '已测试通过',
    })
    expect(state.ok).toBe(true)
    expect(state.message).toBe('已测试通过')
    expect(state.result).toBe(cached)
    expect(h.probeCalls.length).toBe(0)
  })

  it('传入的结论为 ok=false 时不得当成通过', async () => {
    const { runLxProbe } = await import('@/components/common/lxSourceForm')
    const state = await runLxProbe('lx-1', 'https://example.com/latest.js', undefined, {
      result: { ok: false, kind: 'lx', capabilities: [], error: '脚本未声明任何可用平台' } as any,
    })
    expect(state.ok).toBe(false)
    expect(state.message).toContain('脚本未声明任何可用平台')
  })
})
