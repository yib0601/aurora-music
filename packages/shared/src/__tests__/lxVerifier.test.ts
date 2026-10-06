/**
 * 洛雪链路独立黑盒验收（**对抗性验证，独立构造，不复用实现者的测试思路**）
 *
 * 与实现者自测的区别：
 *   - 断言面向**外部可观测行为**（返回值、落盘 JSON、真实 HTTP、进程是否挂死），不 mock 宿主本身；
 *   - 死循环可中断性用**子进程 + 超时 kill** 证明，而不是"看起来没卡"；
 *   - 真实直链走 huibq 真实脚本 + Node 版 request 实现，并实拉一次 Range 请求。
 *
 * 运行：cd packages/shared && npx vitest run src/__tests__/lxVerifier.test.ts
 */
import { describe, it, expect, afterEach } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import LZString from 'lz-string'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  clearLxSourceCache,
  inspectLxSource,
  searchLxSource,
  setLxHostDeps,
  type LxHostDeps,
  type LxRequestFn,
} from '../lxHost'
import {
  resolveLxTrack,
  searchLxSourceForAggregate,
  setLxScriptProvider,
} from '../lxResolver'
import { searchOnlineTracks, clearSearchCache } from '../musicSource'
import type { OnlineSourceConfig } from '../types'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC_DIR = '/tmp/lx-music-source'
const readScript = (rel: string) => fs.readFileSync(path.join(SRC_DIR, rel), 'utf8')
/**
 * 子进程用入口：**沙箱化的 lxHost 真实源码**（esbuild 打包，符号遮蔽与 evaluate 接线
 * 与 issues 完全一致），而不是 dist —— 后者是 CommonJS 产物，Node 里以 ESM 解析会因
 * 无扩展名相对导入而加载失败（与本次验证对象无关）。
 */
const LXRUN_ENTRY = path.join(HERE, 'lxVerifierChildrun.mjs')
const ESBUILD = '/home/yibin/Code/aurora-music/node_modules/.pnpm/esbuild@0.21.5/node_modules/esbuild/bin/esbuild'

function lxHostBundleSource(): string {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'lxbundle-'))
  const outFile = path.join(out, 'lxHost.mjs')
  const r = spawnSync(ESBUILD, [path.join(HERE, '..', 'lxHost.ts'), '--bundle', '--format=esm', '--platform=node', `--outfile=${outFile}`, '--log-level=error'], {
    encoding: 'utf8',
  })
  if (r.status !== 0) throw new Error('esbuild 打包 lxHost 失败: ' + (r.stderr || r.stdout))
  return outFile
}

afterEach(() => {
  setLxHostDeps(null)
  setLxScriptProvider(null)
  clearLxSourceCache()
  clearSearchCache()
})

// ─── 公共构件 ─────────────────────────────────────────────────────

/** 记录调用的假 request：默认不落网络，回调立即给错，避免未处理拒绝 */
function countingRequest(): { request: LxRequestFn; urls: () => string[] } {
  const calls: string[] = []
  const request = ((url: string, _o: unknown, cb: (e: unknown, r: unknown) => void) => {
    calls.push(url)
    setTimeout(() => cb(new Error('验证器：该路径不应发起请求'), null), 0)
    return () => {}
  }) as unknown as LxRequestFn
  return { request, urls: () => calls }
}

/** 契约版执行器（与桌面端 createVmEvaluator 同构），同时记录调用现场 */
function recordingEvaluator(): {
  evaluate: NonNullable<LxHostDeps['evaluate']>
  calls: { script: string; sandbox: Record<string, unknown>; timeoutMs: number }[]
} {
  const calls: { script: string; sandbox: Record<string, unknown>; timeoutMs: number }[] = []
  const evaluate = (script: string, sandbox: Record<string, unknown>, timeoutMs: number): unknown => {
    calls.push({ script, sandbox, timeoutMs })
    const context = vm.createContext(sandbox, { name: 'lx-verifier', codeGeneration: { strings: true, wasm: false } })
    return vm.runInContext(`(function(){\n${script}\n})()`, context, { timeout: timeoutMs || 10000, filename: 'lx-verifier.js' })
  }
  return { evaluate, calls }
}

/** 最小洛雪格式桩脚本：声明 search + musicUrl，均可控 */
function stubScript(opts: { id?: string; search?: 'list' | 'hang' | 'none'; musicUrlThrows?: boolean; probe?: string } = {}) {
  const searchBody =
    opts.search === 'hang'
      ? 'return new Promise(function () {})'
      : opts.search === 'none'
        ? "return Promise.reject(new Error('不支持 search'))"
        : "return Promise.resolve({ list: [{ name: '起风了', singer: '买辣椒也用券', albumName: '测试专辑', songmid: '91084746', id: 'kw1' }] })"
  const urls = opts.musicUrlThrows
    ? "return Promise.reject(new Error('脚本内部抛错：上游 502'))"
    : "return Promise.resolve('http://stub.test/' + (arg.info.musicInfo.songmid || 'x') + '.mp3')"
  return `
${opts.probe ? `globalThis.__probe = ${JSON.stringify(opts.probe)}` : ''}
var lx = globalThis.lx
lx.on(lx.EVENT_NAMES.request, function (arg) {
  if (arg.action === 'search') { ${searchBody} }
  if (arg.action === 'musicUrl') { ${urls} }
  return Promise.reject(new Error('不支持的动作: ' + arg.action))
})
lx.send(lx.EVENT_NAMES.inited, {
  sources: {
    kw: { name: '酷我', type: 'music', actions: ['musicUrl', ${opts.search === 'none' ? '' : "'search',"}], qualitys: ['128k', '320k'] },
    mg: { name: '咪咕', type: 'music', actions: ['musicUrl'], qualitys: ['128k'] },
  },
})
`
}

function lxSource(script: string, over: Partial<OnlineSourceConfig> = {}): OnlineSourceConfig {
  return {
    id: 'lx-verifier-1',
    name: '验证桩源',
    kind: 'lx',
    sourceUrl: 'http://stub.test/script.js',
    enabled: true,
    ...over,
    ...(script ? { script } : {}),
  } as OnlineSourceConfig
}

/**
 * 从混淆脚本里提取 lz-string 压缩载荷（独立实现，不依赖宿主的 unpackLiscript）。
 * 做法与逆向一致：先按字面量切出候选串，再逐个试三种解码口径，取解出可读码最长的那份。
 */
function extractLiscriptPayload(script: string): string | null {
  const candidates = new Set<string>()
  for (const m of script.matchAll(/'([^'\\]{64,})'/g)) candidates.add(m[1])
  for (const m of script.matchAll(/"([^"\\]{64,})"/g)) candidates.add(m[1])
  let best: { payload: string; code: string } | null = null
  for (const c of candidates) {
    const decoders = [LZString.decompressFromBase64, LZString.decompressFromUTF16, LZString.decompressFromEncodedURIComponent, LZString.decompress]
    for (const d of decoders) {
      let code: string | null | undefined
      try {
        code = d(c)
      } catch {
        continue
      }
      if (code && code.length > 1000 && !best) best = { payload: c, code }
    }
  }
  return best?.payload ?? null
}

/** 起一个假的 aurora 音源服务，返回固定结果 */
async function startAuroraFixture(): Promise<{ url: string; hits: string[]; close: () => Promise<void> }> {
  const hits: string[] = []
  const server = http.createServer((req, res) => {
    hits.push(req.url || '')
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.end(
      JSON.stringify({
        results: [
          {
            id: 'au-1',
            title: '起风了',
            artist: '买辣椒也用券',
            album: '测试专辑',
            audioUrl: 'http://127.0.0.1:9/aurora-128.mp3',
            url_128: 'http://127.0.0.1:9/aurora-128.mp3',
          },
        ],
      })
    )
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as any).port
  return {
    url: `http://127.0.0.1:${port}`,
    hits,
    close: () => new Promise<void>((r) => server.close(() => r())),
  }
}

// ═══════════════════════════════════════════════════════════════════
// A. evaluate 契约真实性（本轮新增的关键接线）
// ═══════════════════════════════════════════════════════════════════

describe('A. evaluate 契约', () => {
  it('A1 注入执行器后：正常脚本可探测，且执行器确实被调用、sandbox 自洽', async () => {
    const { evaluate, calls } = recordingEvaluator()
    const out = await inspectLxSource(lxSource(stubScript({ probe: 'via-vm' })) as any, {
      request: countingRequest().request,
      evaluate,
      scriptTimeoutMs: 3000,
    })
    expect(out.ok).toBe(true)
    expect(Object.keys(out.platforms).sort()).toEqual(['kw', 'mg'])
    expect(calls.length).toBeGreaterThan(0)
    const sandbox = calls[0].sandbox
    // 自洽性：globalThis / window / self 都指向 sandbox 自身，且伪全局平铺
    expect(sandbox.globalThis).toBe(sandbox)
    expect(sandbox.window).toBe(sandbox)
    expect(sandbox.self).toBe(sandbox)
    expect((sandbox.globalThis as any).lx).toBe(sandbox.lx)
    expect((sandbox as any).__probe).toBe('via-vm')
    // 传入的 script 是「函数体」：执行器必须自己包函数才能跑（这里包了）
    expect(calls[0].script).toContain('use strict')
    expect(calls[0].script).toContain('return globalThis.__lx_exports__')
  })

  it('A2 注入执行器后：同步死循环脚本被超时打断，返回可读错误且进程存活', async () => {
    const { evaluate, calls } = recordingEvaluator()
    const started = Date.now()
    const out = await inspectLxSource(lxSource('while (true) {}') as any, {
      request: countingRequest().request,
      evaluate,
      scriptTimeoutMs: 400,
    })
    const elapsed = Date.now() - started
    expect(calls[0].timeoutMs).toBe(400)
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/timed out|超时/i)
    expect(elapsed).toBeLessThan(3000)
  })

  it('A3 未注入执行器：同一份死循环脚本在子进程中挂死（超时被 kill 证明）', () => {
    const bundle = lxHostBundleSource()
    const r = spawnSync(process.execPath, [LXRUN_ENTRY, bundle, 'hang'], { timeout: 6000, encoding: 'utf8' })
    expect(r.stdout).toContain('child-enter')
    // 被 spawnSync 的超时强杀：进程在同步死循环里永远回不来
    expect(r.signal).toBe('SIGTERM')
    expect(r.stdout).not.toContain('child-returned')
  }, 30000)

  it('A4 注入执行器时脚本内探针写到 sandbox，未注入时写不到（证明两条路径不同、接线真实）', async () => {
    const script = stubScript({ probe: 'marker' })
    const { evaluate, calls } = recordingEvaluator()
    await inspectLxSource(lxSource(script) as any, { request: countingRequest().request, evaluate, scriptTimeoutMs: 2000 })
    expect((calls[0].sandbox as any).__probe).toBe('marker')

    // 不注入 evaluate：脚本写的是 new Function 的参数对象，验证器拿不到 → 证明走的不是 vm 路径
    const out2 = await inspectLxSource(lxSource(script) as any, {
      request: countingRequest().request,
      scriptTimeoutMs: 2000,
    })
    expect(out2.ok).toBe(true) // 回落路径仍可用（回归）
    expect((globalThis as any).__probe).toBeUndefined() // 也写不到真实全局
  })

  it('A5 自造 Liscript 包装脚本：自解压路径在「注入执行器」与「不注入」两条路径上行为必须一致', async () => {
    // 独立构造 Liscript 包装形态：脚本体只负责把压缩源码写进 globalThis.liscript
    const INNER = `
/* verifier-unpacked-body */
var lx = globalThis.lx
globalThis.__unpacked = 'yes'
lx.on(lx.EVENT_NAMES.request, function () { return Promise.resolve('http://inner.test/a.mp3') })
lx.send(lx.EVENT_NAMES.inited, {
  sources: { kw: { name: '解包后酷我', type: 'music', actions: ['musicUrl'], qualitys: ['128k'] } },
})
`
    const payload = LZString.compressToBase64(INNER)
    expect(LZString.decompressFromBase64(payload)).toBe(INNER) // 载荷与解码口径自检
    const bootstrap = `
globalThis.liscript = {
  script: ${JSON.stringify(payload)},
  rawScript: ${JSON.stringify(payload)},
  name: 'liscript 包装测试源',
  version: '1.0.0',
  description: '验证器自造',
  author: 'verifier',
}
`

    // 路径一：不注入 evaluate（移动端 / 回落 new Function）
    const plain = await inspectLxSource(lxSource(bootstrap, { name: '包装源' }) as any, {
      request: countingRequest().request,
      scriptTimeoutMs: 5000,
    })
    expect(plain.packed).toBe(true)
    expect(plain.ok).toBe(true)
    expect(plain.name).toBe('liscript 包装测试源')
    expect(Object.keys(plain.platforms)).toEqual(['kw'])

    // 路径二：注入契约版执行器（桌面端真实配置：createVmEvaluator）
    const { evaluate, calls } = recordingEvaluator()
    const viaVm = await inspectLxSource(lxSource(bootstrap, { name: '包装源' }) as any, {
      request: countingRequest().request,
      evaluate,
      scriptTimeoutMs: 5000,
    })

    // 两条路径的外部行为必须一致：脚本源码相同，解包结果就该相同
    expect(
      { packed: viaVm.packed, ok: viaVm.ok, name: viaVm.name, platforms: Object.keys(viaVm.platforms), error: viaVm.error },
      '注入 evaluate 后 Liscript 解包失效：宿主把解包数据放在 fakeGlobal 上，而脚本写的是执行器沙箱对象（浅拷贝），unpackLiscript 读不到'
    ).toEqual({ packed: plain.packed, ok: plain.ok, name: plain.name, platforms: Object.keys(plain.platforms), error: undefined })

    // 解包成功后应当有两次执行：引导段 + 解包出的脚本体
    expect(calls.length).toBe(2)
    expect(calls[1].script).toContain('verifier-unpacked-body')
    expect((calls[1].sandbox as any).__unpacked).toBe('yes')
    expect((globalThis as any).__unpacked).toBeUndefined()
  }, 30000)

  it('A5b 素材事实核对：/tmp/lx-music-source 下的六音并不是 Liscript 包装脚本', () => {
    const sixyin = readScript('sixyin/latest.js')
    // 事实：脚本里不存在 liscript 标识 / lz-string 解压逻辑，也没有可作为载荷的长字符串常量
    expect(sixyin).not.toMatch(/liscript/i)
    expect(sixyin).not.toMatch(/LZString|decompressFrom/i)
    expect(extractLiscriptPayload(sixyin)).toBeNull()
    // 它只是 obfuscator 风格混淆 + 站点校验；任务书里「六音是 Liscript 包装」的前提不成立。
    // 因此「Liscript 解包路径」用 A5 的自造包装脚本验证，六音只作为「混淆脚本可被执行器跑通」的样本。
    expect(sixyin.length).toBeGreaterThan(1e5)
  })

  it('A5c 六音混淆脚本经注入执行器运行时：确实交给执行器，失败原因是脚本自身站点校验', async () => {
    const sixyin = readScript('sixyin/latest.js')
    const { evaluate, calls } = recordingEvaluator()
    const out = await inspectLxSource(lxSource(sixyin, { name: '六音' }) as any, {
      request: countingRequest().request,
      evaluate,
      scriptTimeoutMs: 8000,
    })
    expect(calls.length).toBe(1)
    expect(calls[0].script).toContain(sixyin.slice(1000, 1060)) // 原文交给执行器（不是 new Function 路径）
    expect(out.packed).toBe(false)
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/sixyin|校验|加载音源信息失败/i)
  }, 30000)

  it('A6 callTimeoutMs 生效：脚本 search 永不 resolve 时按可读超时失败，不挂进程', async () => {
    const started = Date.now()
    await expect(
      searchLxSource(lxSource(stubScript({ search: 'hang' })) as any, '测试', {
        request: countingRequest().request,
        callTimeoutMs: 300,
      })
    ).rejects.toThrow(/超时/)
    expect(Date.now() - started).toBeLessThan(3000)
  })

  it('A7 scriptTimeoutMs 默认 10000；callTimeoutMs 默认 20000（子进程计时器观测）', async () => {
    const { evaluate, calls } = recordingEvaluator()
    await inspectLxSource(lxSource(stubScript()) as any, { request: countingRequest().request, evaluate })
    expect(calls[0].timeoutMs).toBe(10000)

    // 默认 call 超时无法用 20s 真等，改用子进程劫持 setTimeout 观测实际使用的毫秒数
    const bundle = lxHostBundleSource()
    const r = spawnSync(process.execPath, [LXRUN_ENTRY, bundle, 'timer'], { timeout: 8000, encoding: 'utf8' })
    expect(r.stdout, r.stderr || '').toContain('child-enter')
    expect(r.stdout).toContain('TIMER=20000')
  }, 30000)
})

// ═══════════════════════════════════════════════════════════════════
// B. 聚合搜索对两类脚本的行为差异
// ═══════════════════════════════════════════════════════════════════

describe('B. 聚合搜索行为', () => {
  it('B1 自带 search 的桩脚本：条目 audioUrl 为空串 + 带 lx 定位，且同轮 aurora 结果不受影响', async () => {
    const fixture = await startAuroraFixture()
    try {
      setLxHostDeps({ request: countingRequest().request })
      const out = await searchOnlineTracks('起风了', {
        sources: [
          lxSource(stubScript({ search: 'list' })) as any,
          { id: 'au', name: 'Aurora', sourceUrl: fixture.url, enabled: true },
        ],
      })
      const lxItems = out.filter((r) => r.source === 'lx-verifier-1')
      const auItems = out.filter((r) => r.source === 'au')
      expect(auItems.length).toBe(1)
      expect(lxItems.length).toBe(1)
      expect(lxItems[0].audioUrl).toBe('')
      expect(lxItems[0].lx?.sourceId).toBe('lx-verifier-1')
      expect(lxItems[0].lx?.platform).toBe('kw')
      expect(lxItems[0].lx?.meta.songmid).toBe('91084746')
    } finally {
      await fixture.close()
    }
  })

  it('B2 只有 musicUrl 的真实脚本（huibq）：不产出条目，但不得把整轮判失败', async () => {
    const fixture = await startAuroraFixture()
    try {
      const huibq = readScript('huibq/latest.js')
      setLxHostDeps({ request: countingRequest().request })
      const out = await searchOnlineTracks('起风了', {
        sources: [
          lxSource(huibq, { id: 'huibq', name: 'Huibq' }) as any,
          { id: 'au', name: 'Aurora', sourceUrl: fixture.url, enabled: true },
        ],
      })
      expect(out.filter((r) => r.source === 'huibq').length).toBe(0)
      expect(out.filter((r) => r.source === 'au').length).toBe(1)
    } finally {
      await fixture.close()
    }
  })

  it('B3 宿主未注册：lx 源被跳过并 warn，不抛错、不影响 aurora 源', async () => {
    const fixture = await startAuroraFixture()
    const warns: unknown[][] = []
    const spy = (...a: unknown[]) => void warns.push(a)
    const orig = console.warn
    console.warn = spy as any
    try {
      setLxHostDeps(null)
      const out = await searchOnlineTracks('起风了', {
        sources: [
          lxSource(stubScript({ search: 'list' })) as any,
          { id: 'au', name: 'Aurora', sourceUrl: fixture.url, enabled: true },
        ],
      })
      expect(out.filter((r) => r.source === 'au').length).toBe(1)
      expect(out.filter((r) => r.source === 'lx-verifier-1').length).toBe(0)
      expect(warns.some((w) => String(w[0]).includes('跳过洛雪音源'))).toBe(true)
    } finally {
      console.warn = orig
      await fixture.close()
    }
  })

  it('B4 lx 源脚本源码不可得（无内联、无供应器）：跳过 + warn，不抛错', async () => {
    const fixture = await startAuroraFixture()
    const warns: unknown[][] = []
    const spy = (...a: unknown[]) => void warns.push(a)
    const orig = console.warn
    console.warn = spy as any
    try {
      setLxHostDeps({ request: countingRequest().request })
      setLxScriptProvider(null)
      const source = { id: 'lx-noscript', name: '无脚本源', kind: 'lx', sourceUrl: 'http://x/y.js', enabled: true } as OnlineSourceConfig
      const out = await searchOnlineTracks('起风了', {
        sources: [source, { id: 'au', name: 'Aurora', sourceUrl: fixture.url, enabled: true }],
      })
      expect(out.filter((r) => r.source === 'au').length).toBe(1)
      expect(out.filter((r) => r.source === 'lx-noscript').length).toBe(0)
      expect(warns.some((w) => String(w[0]).includes('脚本源码不可得'))).toBe(true)
      // 单源入口直接抛可读错误（由聚合层按单源失败处理）
      await expect(searchLxSourceForAggregate(source, '起风了')).rejects.toThrow(/脚本源码不可得/)
    } finally {
      console.warn = orig
      await fixture.close()
    }
  })
})

// ═══════════════════════════════════════════════════════════════════
// C. 取址降级路径：全部返回可读原因，不抛错、不发请求
// ═══════════════════════════════════════════════════════════════════

describe('C. 取址降级路径', () => {
  const okRef = { sourceId: 'lx-verifier-1', platform: 'kw', meta: { songmid: '91084746' } }

  it('C1 缺定位信息 → {url:null, reason}', async () => {
    const out = await resolveLxTrack({ lx: undefined as any })
    expect(out.url).toBeNull()
    expect((out as any).reason).toContain('缺少洛雪取址定位信息')
  })

  it('C2 源不存在 → 可读原因', async () => {
    const out = await resolveLxTrack({ lx: okRef, sources: [] })
    expect(out.url).toBeNull()
    expect((out as any).reason).toContain('未找到洛雪音源配置')
  })

  it('C3 源非 lx → 可读原因', async () => {
    const out = await resolveLxTrack({
      lx: okRef,
      onlineSource: { id: 'lx-verifier-1', name: 'Aurora', sourceUrl: 'http://a', enabled: true } as OnlineSourceConfig,
    })
    expect(out.url).toBeNull()
    expect((out as any).reason).toContain('不是洛雪脚本源')
  })

  it('C4 源停用 → 可读原因', async () => {
    const out = await resolveLxTrack({ lx: okRef, onlineSource: lxSource(stubScript(), { enabled: false }) })
    expect(out.url).toBeNull()
    expect((out as any).reason).toContain('已停用')
  })

  it('C5 脚本源码不可得 → 可读原因', async () => {
    setLxScriptProvider(null)
    const out = await resolveLxTrack({
      lx: okRef,
      onlineSource: { id: 'lx-verifier-1', name: '无脚本源', kind: 'lx', sourceUrl: 'http://x/y.js', enabled: true },
    })
    expect(out.url).toBeNull()
    expect((out as any).reason).toContain('脚本源码不可得')
  })

  it('C6 宿主未注册 → 可读原因', async () => {
    setLxHostDeps(null)
    const out = await resolveLxTrack({ lx: okRef, onlineSource: lxSource(stubScript()) })
    expect(out.url).toBeNull()
    expect((out as any).reason).toContain('宿主未初始化')
  })

  it('C7 必要字段缺失 → 可读原因且**零请求**（假 request 计数证明）', async () => {
    const counter = countingRequest()
    const out = await resolveLxTrack({
      lx: { sourceId: 'lx-verifier-1', platform: 'kw', meta: {} },
      onlineSource: lxSource(stubScript()),
      meta: {},
      quality: '128',
      deps: { request: counter.request },
    })
    expect(out.url).toBeNull()
    expect((out as any).reason).toContain('缺少必要字段')
    expect((out as any).reason).toContain('酷我')
    expect(counter.urls().length).toBe(0)
  })

  it('C8 脚本自身抛错 → 转成可读失败，不穿透异常', async () => {
    const out = await resolveLxTrack({
      lx: okRef,
      onlineSource: lxSource(stubScript({ musicUrlThrows: true })),
      deps: { request: countingRequest().request },
      quality: '128',
    })
    expect(out.url).toBeNull()
    expect((out as any).reason).toContain('脚本内部抛错')
  })

  it('C9 脚本不支持该平台 → 可读原因', async () => {
    const out = await resolveLxTrack({
      lx: { sourceId: 'lx-verifier-1', platform: 'qsvip', meta: { songmid: '1' } },
      onlineSource: lxSource(stubScript()),
      deps: { request: countingRequest().request },
    })
    expect(out.url).toBeNull()
    expect((out as any).reason).toContain('不支持平台')
  })

  it('C10 脚本返回非 http 地址 → 判失败而非误用', async () => {
    const script = stubScript().replace("return Promise.resolve('http://stub.test/' + (arg.info.musicInfo.songmid || 'x') + '.mp3')", "return Promise.resolve('file:///etc/passwd')")
    const out = await resolveLxTrack({
      lx: okRef,
      onlineSource: lxSource(script),
      deps: { request: countingRequest().request },
    })
    expect(out.url).toBeNull()
  })
})

// ═══════════════════════════════════════════════════════════════════
// D. 真实脚本真直链（唯一联网项）
// ═══════════════════════════════════════════════════════════════════

/** Node 版请求实现（与桌面端 createNodeLxRequest 同语义，此处不能 import electron 侧文件） */
function createNodeRequest(): LxRequestFn {
  return ((url: string, options: any, callback: any) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 20000)
    const method = String(options?.method || 'GET').toUpperCase()
    fetch(url, { method, headers: options?.headers || {}, signal: controller.signal })
      .then(async (resp) => {
        const raw = await resp.text()
        let body: unknown = raw
        try {
          body = JSON.parse(raw)
        } catch {
          /* 保留文本 */
        }
        clearTimeout(timer)
        callback(null, {
          statusCode: resp.status,
          statusMessage: resp.statusText,
          headers: Object.fromEntries(resp.headers.entries()),
          raw,
          body,
          bytes: Buffer.byteLength(raw, 'utf8'),
        })
      })
      .catch((err) => {
        clearTimeout(timer)
        callback(err, null)
      })
    return () => controller.abort()
  }) as unknown as LxRequestFn
}

describe('D. 真实脚本真直链（联网）', () => {
  it('D1 huibq 脚本取酷我直链并实拉 Range 0-1023：HTTP 200/206 且 content-type 为 audio/*', async () => {
    const huibq = readScript('huibq/latest.js')
    const { evaluate } = recordingEvaluator()
    setLxHostDeps({ request: createNodeRequest(), evaluate, scriptTimeoutMs: 10000, callTimeoutMs: 20000 })
    const source = lxSource(huibq, { id: 'huibq', name: 'Huibq_lxmusic源' })

    const out = await resolveLxTrack({
      lx: { sourceId: 'huibq', platform: 'kw', meta: { songmid: '91084746', hash: '91084746' } },
      onlineSource: source,
      quality: '128',
    })
    // 上游不可达时如实失败（由测试框架报错），不伪造通过
    expect({ url: out.url, reason: (out as any).reason }).toEqual(
      expect.objectContaining({ url: expect.stringMatching(/^https?:\/\//) })
    )
    const url = (out as any).url as string
    const resp = await fetch(url, { headers: { Range: 'bytes=0-1023' } })
    expect([200, 206]).toContain(resp.status)
    const ctype = String(resp.headers.get('content-type') || '')
    const bytes = new Uint8Array(await resp.arrayBuffer())
    expect(ctype.toLowerCase()).toMatch(/^audio\//)
    expect(bytes.length).toBeGreaterThan(0)
    expect(bytes.length).toBeLessThanOrEqual(1024 * 4)
  }, 60000)
})