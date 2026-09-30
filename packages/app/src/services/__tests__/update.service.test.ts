import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { checkForUpdate } from '@/services/update.service'

/**
 * 检查更新的双通道编排：清单源（境内）与 GitHub 官方并发发起，取版本更高的结论；
 * 任一成功且都无更高版本 → 已是最新；两条都失败才报错。
 */

const MANIFEST_URL = 'https://registry.npmmirror.com/aurora-music-release/latest/files/update.json'
const GITHUB_URL = 'https://api.github.com/repos/yib0601/aurora-music/releases/latest'

type Handler = (url: string) => Response | Promise<Response>

/** 按通道分配响应；抛异常表示该通道网络不可用 */
function stubChannels(opts: { manifest?: Handler; github?: Handler }) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('registry.npmmirror.com')) {
        if (!opts.manifest) throw new TypeError('fetch failed')
        return opts.manifest(url)
      }
      // api.github.com 及其加速前缀
      if (!opts.github) throw new TypeError('fetch failed')
      return opts.github(url)
    })
  )
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function manifestBody(version: string) {
  return {
    version,
    notes: '- 本次更新的说明',
    assets: [
      {
        kind: 'apk',
        name: `Aurora-Music-${version}-android.apk`,
        url: `https://registry.npmmirror.com/aurora-music-release/${version}/files/Aurora-Music-${version}-android.apk`,
        size: 13683601,
        sha256: 'a'.repeat(64),
      },
    ],
  }
}

function githubBody(tag: string) {
  return {
    tag_name: `v${tag}`,
    body: 'GitHub 通道说明',
    html_url: `https://github.com/yib0601/aurora-music/releases/tag/v${tag}`,
    assets: [
      {
        name: `Aurora-Music-${tag}-android.apk`,
        browser_download_url: `https://github.com/yib0601/aurora-music/releases/download/v${tag}/Aurora-Music-${tag}-android.apk`,
        size: 13683601,
      },
    ],
  }
}

beforeEach(() => {
  // 装成 Android WebView：node 环境下没有 window.Capacitor，isMobile() 会判 false，
  // assetPreferenceOrder 随之返回空数组而挑不出安装包，用例就测不到 asset 匹配。
  vi.stubGlobal('window', { Capacitor: { getPlatform: () => 'android' } })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('checkForUpdate 双通道编排', () => {
  it('两条通道都有新版时取版本更高的那个', async () => {
    stubChannels({
      manifest: () => json(manifestBody('0.5.8')),
      github: () => json(githubBody('0.5.9')),
    })
    const info = await checkForUpdate()
    expect(info?.version).toBe('0.5.9')
    expect(info?.channel).toBe('github')
  })

  it('GitHub 通道不可达时仍能靠清单源拿到更新', async () => {
    stubChannels({
      manifest: () => json(manifestBody('0.5.8')),
      // 不提供 github handler → 两个 GitHub 候选都抛网络错误
    })
    const info = await checkForUpdate()
    expect(info?.version).toBe('0.5.8')
    expect(info?.channel).toBe('manifest')
    // 安装包地址应落在境内 CDN，不再回落到 GitHub
    expect(info?.assetUrls[0]).toContain('registry.npmmirror.com')
    expect(info?.assetKind).toBe('apk')
    expect(info?.assetSize).toBe(13683601)
    expect(info?.assetDigest).toBe(`sha256:${'a'.repeat(64)}`)
  })

  it('清单源结论滞后时以 GitHub 的更高版本为准', async () => {
    stubChannels({
      manifest: () => json(manifestBody('0.5.8')),
      github: () => json(githubBody('0.5.10')),
    })
    const info = await checkForUpdate()
    expect(info?.version).toBe('0.5.10')
  })

  it('两条通道都报告无新版本时判为已是最新，不报错', async () => {
    stubChannels({
      manifest: () => json(manifestBody('0.0.0')),
      github: () => json(githubBody('0.0.0')),
    })
    await expect(checkForUpdate()).resolves.toBeNull()
  })

  it('清单源 404 时静默降级到 GitHub，不因它失败而报错', async () => {
    stubChannels({
      manifest: () => new Response('Not Found', { status: 404 }),
      github: () => json(githubBody('0.5.9')),
    })
    const info = await checkForUpdate()
    expect(info?.version).toBe('0.5.9')
    expect(info?.channel).toBe('github')
  })

  it('两条通道全灭才抛错，且抛出带状态码的原因', async () => {
    stubChannels({
      manifest: () => new Response('boom', { status: 502 }),
      github: () => new Response('rate limited', { status: 403 }),
    })
    await expect(checkForUpdate()).rejects.toThrow(/HTTP (502|403)/)
  })
})
