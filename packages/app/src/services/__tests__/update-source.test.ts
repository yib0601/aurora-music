import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  fetchFastest,
  isAllowedDownloadUrl,
  isGithubUrl,
  isManifestUrl,
  isProxyUrl,
  manifestAssetUrl,
  manifestCandidates,
  releasesApiCandidates,
  withGithubProxies,
} from '@/services/update-source'

afterEach(() => {
  vi.unstubAllGlobals()
})

const ASSET = 'https://github.com/yib0601/aurora-music/releases/download/v0.5.7/Aurora-Music-0.5.7-android.apk'
const API = 'https://api.github.com/repos/yib0601/aurora-music/releases/latest'

describe('境内清单源候选', () => {
  it('指向 npmmirror 的 update.json', () => {
    const [url] = manifestCandidates()
    expect(url).toBe('https://registry.npmmirror.com/aurora-music-release/latest/files/update.json')
    expect(isManifestUrl(url)).toBe(true)
  })

  it('安装包地址使用具体版本号（latest 别名不能拼文件路径）', () => {
    expect(manifestAssetUrl('aurora-music-release', '0.5.7', 'a.apk')).toBe(
      'https://registry.npmmirror.com/aurora-music-release/0.5.7/files/a.apk'
    )
  })
})

describe('候选展开', () => {
  it('GitHub 资产展开为「官方 + 各加速前缀」', () => {
    const list = withGithubProxies(ASSET)
    expect(list[0]).toBe(ASSET)
    expect(list).toContain(`https://gh-proxy.com/${ASSET}`)
    expect(list).toContain(`https://ghfast.top/${ASSET}`)
    expect(list).toContain(`https://ghproxy.net/${ASSET}`)
  })

  it('境内清单源地址原样返回，不做二次包裹', () => {
    const own = manifestAssetUrl('aurora-music-release', '0.5.7', 'a.apk')
    expect(withGithubProxies(own)).toEqual([own])
  })
})

describe('检查更新候选', () => {
  it('API 候选只含支持 api.github.com 的前缀', () => {
    const list = releasesApiCandidates(API)
    expect(list[0]).toBe(API)
    expect(list).toContain(`https://gh-proxy.com/${API}`)
    // ghfast.top / ghproxy.net 对 api.github.com 恒 403，不能混进检查更新链路
    expect(list.some((u) => u.includes('ghfast.top'))).toBe(false)
    expect(list.some((u) => u.includes('ghproxy.net'))).toBe(false)
  })
})

describe('下载白名单', () => {
  it('放行 GitHub 官方与白名单加速域名', () => {
    expect(isGithubUrl(ASSET)).toBe(true)
    expect(isAllowedDownloadUrl('https://objects.githubusercontent.com/x.apk')).toBe(true)
    expect(isProxyUrl('https://gh-proxy.com/' + ASSET)).toBe(true)
    expect(isAllowedDownloadUrl('https://ghproxy.net/' + ASSET)).toBe(true)
  })

  it('放行境内清单源', () => {
    expect(isAllowedDownloadUrl(manifestAssetUrl('aurora-music-release', '0.5.7', 'a.apk'))).toBe(true)
  })

  it('拒绝任意域名与降级协议', () => {
    expect(isAllowedDownloadUrl('https://evil.example.com/x.apk')).toBe(false)
    expect(isAllowedDownloadUrl('http://github.com/x.apk')).toBe(false)
    expect(isAllowedDownloadUrl('not-a-url')).toBe(false)
  })
})

describe('fetchFastest 并发竞速', () => {
  it('慢候选先发起时，快候选胜出（不串行等待）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('slow')) {
          await new Promise((r) => setTimeout(r, 300))
          return new Response('slow')
        }
        return new Response('fast')
      })
    )
    const value = await fetchFastest(
      ['https://a.test/slow', 'https://b.test/fast'],
      (res) => res.text(),
      { timeoutMs: 2000 }
    )
    expect(value).toBe('fast')
  })

  it('部分候选失败不影响其余候选', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('bad')) return new Response('boom', { status: 500 })
        return new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } })
      })
    )
    const value = await fetchFastest(['https://a.test/bad', 'https://b.test/good'], (res) => res.json(), {
      timeoutMs: 2000,
    })
    expect(value).toEqual({ ok: true })
  })

  it('全部失败时抛出带状态码的错误', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })))
    await expect(
      fetchFastest(['https://a.test/1', 'https://a.test/2'], (res) => res.json(), { timeoutMs: 2000 })
    ).rejects.toThrow('HTTP 500')
  })

  it('响应体解析失败不算成功（HTML 错误页不能冒充 JSON）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('html')) return new Response('<html>403</html>')
        return new Response('{"version":"0.5.8"}')
      })
    )
    const value = await fetchFastest(['https://a.test/html', 'https://b.test/json'], (res) => res.json(), {
      timeoutMs: 2000,
    })
    expect(value).toEqual({ version: '0.5.8' })
  })
})
