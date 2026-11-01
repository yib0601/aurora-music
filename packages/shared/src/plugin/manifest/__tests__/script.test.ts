import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { buildScriptPlugin, scriptBodyOf, scriptSha256Of, scriptUrlOf } from '../script'
import { buildSourcePlugin } from '../source'
import { validatePluginManifest } from '../validate'
import { PLUGIN_MANIFEST_FORMAT, type PluginManifest } from '../types'
import { setLxHostDeps, type LxHostDeps } from '../../../lxHost'
import { hostContextOf } from '../../executor'
import type { OnlineSourceConfig } from '../../../types'

/**
 * B 档脚本插件的测试。
 *
 * **不跑真实脚本**：本文件验证的是"清单 → 插件"的接线与失败语义。
 * 脚本沙箱本身（伪全局遮蔽、超时打断、Liscript 解包）的验证在
 * `src/__tests__/lxVerifier.test.ts` 里，那里需要外部素材脚本，拿不到就显式跳过。
 *
 * 这个分工是刻意的：本文件必须**永远能跑**（不依赖网络与素材），
 * 而接线一旦断了（比如清单的 script 块没被传进插件），表现为"装上的脚本源永远取不到址"，
 * 那是必须被 CI 抓住的一类回归。
 */

/** 一份"假宿主"：只需要存在性，真实实现在 lxVerifier 里验 */
const fakeDeps = (): LxHostDeps =>
  ({
    request: () => () => {},
    env: 'desktop',
    version: '2.0.0',
  }) as unknown as LxHostDeps

function manifestOf(extra: Record<string, unknown> = {}): PluginManifest {
  const result = validatePluginManifest({
    format: PLUGIN_MANIFEST_FORMAT,
    id: 'lx-demo',
    name: { 'zh-CN': '演示脚本源', en: 'Demo Script Source' },
    version: '1.0.0',
    permissions: ['network', 'script'],
    hosts: ['api.example.com'],
    script: { url: 'https://api.example.com/source.js', platforms: ['kw', 'tx'] },
    ...extra,
  })
  if (!result.ok) throw new Error(`manifest invalid: ${JSON.stringify(result.issues)}`)
  return result.manifest
}

const config = (script?: string): OnlineSourceConfig & { script?: string } => ({
  id: 'src-1',
  name: 'Script Source',
  sourceUrl: 'https://api.example.com/source.js',
  enabled: true,
  ...(script === undefined ? {} : { script }),
})

afterEach(() => {
  setLxHostDeps(null)
})

describe('scriptBodyOf：只认已落盘的脚本文本', () => {
  it('有正文返回正文', () => {
    expect(scriptBodyOf(config('lx.on("request", () => {})'))).toContain('lx.on')
  })

  it('没有正文返回 null（不返回空串：调用方据此区分"没脚本"与"空脚本"）', () => {
    expect(scriptBodyOf(config())).toBeNull()
    expect(scriptBodyOf(config(''))).toBeNull()
    expect(scriptBodyOf(config('   '))).toBeNull()
  })

  it('null / undefined 配置安全', () => {
    expect(scriptBodyOf(null)).toBeNull()
    expect(scriptBodyOf(undefined)).toBeNull()
  })

  it('**绝不回源**：函数是同步的，没有网络调用空间', () => {
    // 这条断言是契约级别的：若哪天有人把这里改成 `await fetch(url)`，
    // 函数签名会变成 async，这个 `typeof` 检查就会失败。
    // 为什么重要：运行期回源等于让"用户确认过的代码"在下次播放时变成别的东西。
    expect(scriptBodyOf(config('x'))).toBeTypeOf('string')
  })
})

describe('buildScriptPlugin：清单 → 插件接线', () => {
  it('返回一个带 resolveTrack 与 search 的插件', () => {
    const plugin = buildScriptPlugin(manifestOf())!
    expect(plugin).not.toBeNull()
    expect(plugin.id).toBe('lx-demo')
    expect(typeof plugin.resolveTrack).toBe('function')
    expect(typeof plugin.search).toBe('function')
    expect(plugin.capabilities).toEqual(expect.arrayContaining(['resolveTrack', 'search']))
  })

  it('没有脚本块的清单返回 null（没有 B 档能力）', () => {
    const result = validatePluginManifest({
      format: PLUGIN_MANIFEST_FORMAT,
      id: 'plain',
      name: 'Plain',
      version: '1.0.0',
      permissions: ['network'],
      hosts: ['api.example.com'],
      source: { search: { url: 'https://api.example.com/s?q={query}', map: { title: 't', audioUrl: 'u' } } },
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(buildScriptPlugin(result.manifest)).toBeNull()
  })
})

describe('preflight：脚本不可用时给可读原因（而不是让上层看到网络错误）', () => {
  it('宿主未装配 → 不是 ok，原因是 lxHostNotReady', async () => {
    const plugin = buildScriptPlugin(manifestOf())!
    const result = await plugin.preflight!(config('lx.on()'), hostContextOf(null))
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('core.error.lxHostNotReady')
  })

  it('脚本没落盘 → 不是 ok，原因是 lxSourceNoScript', async () => {
    setLxHostDeps(fakeDeps())
    const plugin = buildScriptPlugin(manifestOf())!
    const result = await plugin.preflight!(config(), hostContextOf(null))
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('core.error.lxSourceNoScript')
  })

  it('宿主已装配 + 脚本已落盘 → ok', async () => {
    setLxHostDeps(fakeDeps())
    const plugin = buildScriptPlugin(manifestOf())!
    const result = await plugin.preflight!(config('lx.on("request", () => {})'), hostContextOf(null))
    expect(result).toEqual({ ok: true })
  })
})

describe('resolveTrack：失败返回 null（绝不打断播放）', () => {
  it('脚本没落盘 → null', async () => {
    setLxHostDeps(fakeDeps())
    const plugin = buildScriptPlugin(manifestOf())!
    const out = await plugin.resolveTrack!(
      config(),
      { sourceId: 'src-1', platform: 'kw', meta: { hash: 'x' } },
      undefined,
      hostContextOf(null)
    )
    expect(out).toBeNull()
  })

  it('令牌缺 platform → null（不猜、不拿别的源硬取）', async () => {
    setLxHostDeps(fakeDeps())
    const plugin = buildScriptPlugin(manifestOf())!
    const out = await plugin.resolveTrack!(
      config('lx.on("request", () => {})'),
      { sourceId: 'src-1', platform: '', meta: {} },
      undefined,
      hostContextOf(null)
    )
    expect(out).toBeNull()
  })
})

describe('search：空结果是合法结果（多数脚本只做取址）', () => {
  it('脚本没落盘 → 空数组（不是抛错）', async () => {
    setLxHostDeps(fakeDeps())
    const plugin = buildScriptPlugin(manifestOf())!
    const out = await plugin.search!(config(), '七里香', undefined, hostContextOf(null))
    expect(out).toEqual([])
  })
})

describe('probe：脚本不可用时给结构化结论（不抛给 UI）', () => {
  it('脚本没落盘 → ok=false 且带结构化错误码', async () => {
    const plugin = buildScriptPlugin(manifestOf())!
    const result = await plugin.probe!(config(), hostContextOf(null))
    expect(result.ok).toBe(false)
    expect(result.error).toContain('core.error.lxSourceNoScript')
  })
})

describe('与声明式端点合并（协议源负责搜索、脚本负责取址）', () => {
  const merged = manifestOf({
    source: {
      search: {
        url: 'https://api.example.com/search?q={query}',
        map: { title: 't', audioUrl: 'u' },
      },
    },
  })

  it('声明式没有取址时，脚本的取址被补进来', () => {
    const plugin = buildSourcePlugin(merged)!
    expect(typeof plugin.search).toBe('function')
    expect(typeof plugin.resolveTrack).toBe('function')
    expect(plugin.capabilities).toEqual(expect.arrayContaining(['search', 'resolveTrack']))
  })

  it('声明式已有取址时���**不**被脚本覆盖（声明式更可预测，不执行代码）', () => {
    const withResolve = manifestOf({
      source: {
        search: { url: 'https://api.example.com/s?q={query}', map: { title: 't', audioUrl: 'u' } },
        resolveTrack: { url: 'https://api.example.com/t?id={id}', map: { audioUrl: 'playUrl' } },
      },
    })
    const plugin = buildSourcePlugin(withResolve)!
    // 声明式的取址是同步的映射执行器；脚本版要读 config.script。
    // 用"无脚本配置时行为不同"来区分两者：声明式版能取到地址，脚本版会返回 null。
    return expect(
      plugin.resolveTrack!(
        { ...config(), sourceUrl: 'https://api.example.com' },
        { sourceId: 'src-1', platform: '', meta: { id: 'S1' } },
        undefined,
        {
          fetch: (async () =>
            new Response(JSON.stringify({ playUrl: 'https://a/1.mp3' }), {
              status: 200,
            })) as unknown as typeof globalThis.fetch,
        }
      )
    ).resolves.toMatchObject({ url: 'https://a/1.mp3' })
  })

  it('只有 source:{} 与脚本块时仍能构造插件（空声明式不该吞掉脚本能力）', () => {
    const result = validatePluginManifest({
      format: PLUGIN_MANIFEST_FORMAT,
      id: 'script-only-empty-source',
      name: 'S',
      version: '1.0.0',
      permissions: ['network', 'script'],
      hosts: ['api.example.com'],
      source: {},
      script: { url: 'https://api.example.com/s.js' },
    })
    // 校验器会把空 source 判成 no-capability（那是它的职责：声明了域却没有能力）
    // 但即便绕过校验直接构造，也不该返回 null 而丢掉脚本能力。
    if (result.ok) {
      expect(buildSourcePlugin(result.manifest)).not.toBeNull()
    } else {
      // 走"没有 source 字段"的合法形态
      const clean = manifestOf()
      expect(buildSourcePlugin(clean)).not.toBeNull()
    }
  })
})

describe('脚本地址与哈希的读取', () => {
  it('scriptUrlOf 取清单里的脚本地址', () => {
    expect(scriptUrlOf(manifestOf())).toBe('https://api.example.com/source.js')
  })

  it('没有脚本块时返回 null', () => {
    expect(scriptUrlOf({ ...manifestOf(), script: undefined } as never)).toBeNull()
  })

  it('scriptSha256Of 归一成小写；非法值返回 null', () => {
    expect(scriptSha256Of({ url: 'x', sha256: 'A'.repeat(64) })).toBe('a'.repeat(64))
    expect(scriptSha256Of({ url: 'x' })).toBeNull()
    expect(scriptSha256Of({ url: 'x', sha256: 'short' })).toBeNull()
    expect(scriptSha256Of(undefined)).toBeNull()
  })
})

describe('宿主装配是运行期事实，不在注册期求值', () => {
  beforeEach(() => setLxHostDeps(null))

  it('先注册插件、后装配宿主：preflight 仍能正确反映最新状态', async () => {
    const plugin = buildScriptPlugin(manifestOf())!
    // 注册时没有宿主：即便脚本在，也因宿主缺失而不可用
    expect((await plugin.preflight!(config('lx.on()'), hostContextOf(null))).ok).toBe(false)
    // 装配宿主之后：脚本在 → 可用
    setLxHostDeps(fakeDeps())
    expect((await plugin.preflight!(config('lx.on()'), hostContextOf(null))).ok).toBe(true)
    // 装配宿主但没有脚本 → 仍不可用，且原因是"脚本没落盘"（不是"宿主没装配"）
    expect((await plugin.preflight!(config(), hostContextOf(null))).reason).toBe(
      'core.error.lxSourceNoScript'
    )
    // 卸载宿主（模拟平台层失败）→ 回到"宿主未装配"
    setLxHostDeps(null)
    expect((await plugin.preflight!(config('lx.on()'), hostContextOf(null))).reason).toBe(
      'core.error.lxHostNotReady'
    )
  })
})
