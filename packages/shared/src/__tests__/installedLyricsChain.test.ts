/**
 * 已安装**纯歌词插件**真的能取到歌词的端到端验收。
 *
 * ## 为什么需要这一组（而不是只测各个零件）
 *
 * 这条链路由三个零件拼成，每一个单独看都"实现了"，但整条链路曾经完全不通：
 *
 *   1. `buildSourcePlugin` 对纯歌词清单返回 null → 插件不进注册表；
 *   2. 就算注册了，歌词聚合只遍历**源配置**（`onlineSources`），而纯歌词插件
 *      没有任何源配置行 → 永远没人问它；
 *   3. 就算被问到，清单的 `format: 'lrc'` 没传到执行器，且它的请求不过清单
 *      `hosts` 白名单 —— 前者让 LRC 站点必然落空，后者让安装确认框里列出的
 *      域名形同虚设。
 *
 * 三处都在**不同层**修，所以必须有一条用例从 `searchLyrics`（真入口）打进去，
 * 用真 socket 断言"上游真的被请求了、且返回的歌词被用上了"。零件级用例各自通过
 * 却整体不通，正是这类改造最容易留下的坑。
 *
 * ## 为什么用真实 HTTP 服务器
 *
 * 要证的是「请求有没有发出去、发到了哪」。打桩 `fetch` 只能证明"代码走到了某一行"，
 * 而这一组要防的恰恰是"代码没走到"。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { searchLyrics, searchLyricsSource, BUILTIN_LYRICS_SOURCE } from '../lyricsSource'
import { setCustomFetch } from '../fetchWithTimeout'
import { clearPluginAvailabilityForTest, setPluginEnabled } from '../plugin/availability'
import { clearInstalledForTest, registerInstalledPlugin } from '../plugin/installed'
import { installedLyricsSources } from '../plugin/installedLyricsProvider'
import { clearPluginsForTest } from '../plugin/registry'
import { resetBuiltinsRegistrationForTest } from '../plugin/builtins'
import { validatePluginManifest } from '../plugin/manifest/validate'
import { PLUGIN_MANIFEST_FORMAT, type PluginManifest } from '../plugin/manifest/types'
import { expectCode, rejectionOf } from './i18nAssert'

let server: http.Server
let port = 0
/** 记录上游被请求过哪些路径（断言"真的发出去了"而不是"代码以为发出去了"） */
const requests: string[] = []

/** 上游桩：按路径决定返回什么，覆盖 JSON 与裸 LRC 两种形态 */
function respond(res: http.ServerResponse, path: string): void {
  if (path.startsWith('/lrc')) {
    const body = '[00:01.00]LRC 直出歌词\n[00:05.00]第二行'
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(body)
    return
  }
  if (path.startsWith('/json')) {
    const body = JSON.stringify([
      { trackName: '歌', artistName: '手', syncedLyrics: '[00:02.00]JSON 歌词' },
    ])
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(body)
    return
  }
  res.writeHead(404)
  res.end()
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    req.socket.on('error', () => {})
    requests.push(req.url || '')
    respond(res, req.url || '')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

beforeEach(() => {
  requests.length = 0
  clearPluginsForTest()
  clearInstalledForTest()
  resetBuiltinsRegistrationForTest()
  clearPluginAvailabilityForTest()
  // 内置 LRCLIB 会真连公网：本组要断言"命中的是插件那条源"，所以把它关掉
  setPluginEnabled('builtin-lyrics-lrclib', false)
})

afterEach(() => {
  clearPluginAvailabilityForTest()
  clearInstalledForTest()
})

/** 构造一份纯歌词清单（无 source 块），走过真实校验器 */
function lyricsOnlyManifest(
  id: string,
  lyricsPath: string,
  extra: Record<string, unknown> = {}
): PluginManifest {
  const result = validatePluginManifest({
    format: PLUGIN_MANIFEST_FORMAT,
    id,
    name: `Lyrics ${id}`,
    version: '1.0.0',
    permissions: ['network'],
    hosts: [`127.0.0.1:${port}`],
    lyrics: {
      url: `http://127.0.0.1:${port}${lyricsPath}?track={track}&artist={artist}`,
    },
    ...extra,
  })
  if (!result.ok) throw new Error(`invalid manifest: ${JSON.stringify(result.issues)}`)
  return result.manifest
}

describe('纯歌词插件：真入口 → 真上游', () => {
  it('注册后 searchLyrics 真的会去请求它（这是"装上了却永远不生效"的防回归）', async () => {
    registerInstalledPlugin(lyricsOnlyManifest('lyr-json', '/json'))
    const out = await searchLyrics('歌', '手', undefined, 200)
    // 上游确实被请求了 —— 只断言返回值的话，未来若换成别的兜底也能"通过"
    expect(requests.some((url) => url.startsWith('/json'))).toBe(true)
    expect(out?.lrc).toBe('[00:02.00]JSON 歌词')
  })

  it('format: lrc 的清单按裸文本解析（否则会因"不是 JSON"落空）', async () => {
    registerInstalledPlugin(
      lyricsOnlyManifest('lyr-lrc', '/lrc', {
        lyrics: {
          url: `http://127.0.0.1:${port}/lrc?track={track}&artist={artist}`,
          format: 'lrc',
        },
      })
    )
    const out = await searchLyrics('歌', '手', undefined, 200)
    expect(requests.some((url) => url.startsWith('/lrc'))).toBe(true)
    expect(out?.lrc).toContain('LRC 直出歌词')
  })

  it('停用插件后不再请求它（启停是插件级门禁，聚合层必须认）', async () => {
    registerInstalledPlugin(lyricsOnlyManifest('lyr-json', '/json'))
    setPluginEnabled('lyr-json', false)
    const out = await searchLyrics('歌', '手', undefined, 200)
    expect(requests.filter((url) => url.startsWith('/json'))).toEqual([])
    expect(out).toBeNull()
  })

  it('卸载后不再请求它（不会出现"已卸载但歌词还在取"）', async () => {
    registerInstalledPlugin(lyricsOnlyManifest('lyr-json', '/json'))
    const { unregisterInstalledPlugin } = await import('../plugin/installed')
    unregisterInstalledPlugin('lyr-json')
    const out = await searchLyrics('歌', '手', undefined, 200)
    expect(requests).toEqual([])
    expect(out).toBeNull()
  })
})

describe('纯歌词插件：清单 hosts 白名单必须真的生效', () => {
  it('打到清单没声明的主机：请求一个都不发，且错误码是「被白名单拦下」而不是「请求失败」', async () => {
    const result = validatePluginManifest({
      format: PLUGIN_MANIFEST_FORMAT,
      id: 'lyr-outside',
      name: 'Outside',
      version: '1.0.0',
      permissions: ['network'],
      hosts: ['lyrics.example.com'],
      lyrics: { url: `http://127.0.0.1:${port}/json?track={track}` },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    registerInstalledPlugin(result.manifest)

    // 直接打单源，才能断言**错误码**：经 `searchLyrics` 聚合会被逐源 catch 吞成 null
    const err = await rejectionOf(searchLyricsSource(installedLyricsSources()[0], '歌', '手'))
    expectCode(err, 'core.error.lyricsHostNotAllowed', {
      name: 'lyr-outside',
      // reason 给的是被拦下的主机（含端口），用户据此知道是哪个域名没声明
      reason: `127.0.0.1:${port}`,
    })
    // 关键：请求**一个都没发出去**（白名单在发请求之前判定，fail-closed）
    expect(requests).toEqual([])
  })

  it('清单声明了该主机时正常放行（上一条的反向对照，避免"全拦"也能通过）', async () => {
    registerInstalledPlugin(lyricsOnlyManifest('lyr-json', '/json'))
    const out = await searchLyrics('歌', '手', undefined, 200)
    expect(requests.some((url) => url.startsWith('/json'))).toBe(true)
    expect(out?.lrc).toBe('[00:02.00]JSON 歌词')
  })

  it('白名单不误伤内置源（它们不是第三方清单，不该受清单规则约束）', async () => {
    // 内置 LRCLIB 的 id 没有 plugin: 前缀 —— 判定必须直接放行
    expect(BUILTIN_LYRICS_SOURCE.id.startsWith('plugin:')).toBe(false)
    // 用桩验证：真连 lrclib.net 违反「测试不依赖真实网络」的约定
    setCustomFetch(async () => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }))
    try {
      await expect(searchLyricsSource(BUILTIN_LYRICS_SOURCE, 't', 'a')).resolves.toBeNull()
    } finally {
      setCustomFetch(null)
    }
  })
})
