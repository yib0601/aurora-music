import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAppTranslator, toErrorInfo, translateError } from '@aurora/shared'
import {
  fetchFastest,
  isAllowedDownloadUrl,
  isGithubUrl,
  isProxyUrl,
  releasesApiCandidates,
  withGithubProxies,
} from '@/services/update-source'

afterEach(() => {
  vi.unstubAllGlobals()
})

/** 显示端渲染函数：与组件里 useT() 的键集收窄版是同一套内核，这里直接取内核实例 */
const t = createAppTranslator('zh-CN')
const tEn = createAppTranslator('en')

const ASSET = 'https://github.com/yib0601/aurora-music/releases/download/v0.5.7/Aurora-Music-0.5.7-android.apk'
const API = 'https://api.github.com/repos/yib0601/aurora-music/releases/latest'

describe('候选展开', () => {
  it('GitHub 资产展开为「官方 + 可用加速前缀」', () => {
    const list = withGithubProxies(ASSET)
    expect(list[0]).toBe(ASSET)
    expect(list).toContain(`https://gh-proxy.com/${ASSET}`)
    expect(list).toContain(`https://ghfast.top/${ASSET}`)
  })

  it('剔除实测不可用的前缀', () => {
    const list = withGithubProxies(ASSET)
    // ghproxy.net 实测仅 33KB/s（150s 未下完）、ghproxy.cn 返回 HTML 错误页伪装 200
    expect(list.some((u) => u.includes('ghproxy.net'))).toBe(false)
    expect(list.some((u) => u.includes('ghproxy.cn'))).toBe(false)
  })

  it('非 GitHub 地址原样返回，不做二次包裹', () => {
    const other = 'https://example.com/file.apk'
    expect(withGithubProxies(other)).toEqual([other])
  })
})

describe('检查更新候选', () => {
  it('只包含能透传 api.github.com 的前缀', () => {
    const list = releasesApiCandidates(API)
    expect(list[0]).toBe(API)
    expect(list).toContain(`https://gh-proxy.com/${API}`)
    // ghfast.top 对 api.github.com 恒 403，不能混进检查更新链路白等一轮超时
    expect(list.some((u) => u.includes('ghfast.top'))).toBe(false)
  })
})

describe('下载白名单', () => {
  it('放行 GitHub 官方与白名单加速域名', () => {
    expect(isGithubUrl(ASSET)).toBe(true)
    expect(isAllowedDownloadUrl('https://objects.githubusercontent.com/x.apk')).toBe(true)
    expect(isProxyUrl('https://gh-proxy.com/' + ASSET)).toBe(true)
    expect(isAllowedDownloadUrl('https://ghfast.top/' + ASSET)).toBe(true)
  })

  it('拒绝任意域名与降级协议', () => {
    expect(isAllowedDownloadUrl('https://evil.example.com/x.apk')).toBe(false)
    expect(isAllowedDownloadUrl('https://cdn.jsdelivr.net/npm/pkg@1.0.0/a.apk')).toBe(false)
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

  it('失败原因是结构化错误：码 + detail 里的状态码，显示端按语言渲染', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('rate limited', { status: 403 })))
    // 抛出点不再拼中文，只给码与 detail；文案由显示端按当前语言渲染
    const err = await fetchFastest(['https://a.test/1'], (res) => res.json(), { timeoutMs: 2000 }).catch(
      (e: unknown) => e
    )
    const info = toErrorInfo(err)
    expect(info.code).toBe('errors.network.unreachable')
    expect(info.detail).toBe('HTTP 403')
    expect(translateError(err, t)).toMatch(/网络不可达/)
    expect(translateError(err, tEn)).toMatch(/Network unreachable/i)
  })

  it('取消与空候选各有专属错误码，不再抛裸 Error', async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    const canceled = await fetchFastest(['https://a.test/1'], (res) => res.json(), {
      timeoutMs: 2000,
      signal: ctrl.signal,
    }).catch((e: unknown) => e)
    expect(toErrorInfo(canceled).code).toBe('update.error.canceled')
    expect(translateError(canceled, t)).toBe('已取消')

    const empty = await fetchFastest([], (res) => res.json(), { timeoutMs: 2000 }).catch((e: unknown) => e)
    expect(toErrorInfo(empty).code).toBe('update.error.offline')
    expect(translateError(empty, t)).toBe('网络不可用')
  })

  it('HTML 错误页不能冒充 JSON（镜像站伪装 200 的场景）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('html')) return new Response('<html>403</html>')
        return new Response('{"tag_name":"v0.5.8"}')
      })
    )
    const value = await fetchFastest(['https://a.test/html', 'https://b.test/json'], (res) => res.json(), {
      timeoutMs: 2000,
    })
    expect(value).toEqual({ tag_name: 'v0.5.8' })
  })
})
