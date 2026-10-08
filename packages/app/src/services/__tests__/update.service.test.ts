import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAppTranslator, toErrorInfo, translateError } from '@aurora/shared'
import { checkForUpdate } from '@/services/update.service'

/**
 * 检查更新的行为：请求 GitHub Releases API（直连与加速前缀并发竞速），
 * 挑出匹配当前平台的安装包，并给出可直接下载的候选地址列表。
 *
 * 另覆盖多语言改造后的契约：失败抛结构化错误（码 + detail，不拼中文），
 * 安装包标签给出的是**文案键**而不是译文。
 */

/** 显示端渲染函数（与组件里 useT() 同一个内核） */
const t = createAppTranslator('zh-CN')
const tEn = createAppTranslator('en')

const GITHUB_URL = 'https://api.github.com/repos/yib0601/aurora-music/releases/latest'

type Handler = (url: string) => Response | Promise<Response>

/** 所有候选走同一个 handler；抛异常表示网络不可用 */
function stubGithub(handler?: Handler) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      if (!handler) throw new TypeError('fetch failed')
      return handler(String(input))
    })
  )
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function githubBody(tag: string, withApk = true) {
  return {
    tag_name: `v${tag}`,
    body: '更新说明',
    html_url: `https://github.com/yib0601/aurora-music/releases/tag/v${tag}`,
    assets: withApk
      ? [
          {
            name: `Aurora-Music-${tag}-android.apk`,
            browser_download_url: `https://github.com/yib0601/aurora-music/releases/download/v${tag}/Aurora-Music-${tag}-android.apk`,
            size: 13682159,
            digest: `sha256:${'a'.repeat(64)}`,
          },
        ]
      : [],
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

describe('checkForUpdate', () => {
  it('有新版本时给出安装包与降级候选列表', async () => {
    stubGithub(() => json(githubBody('0.5.8')))
    const info = await checkForUpdate()
    expect(info?.version).toBe('0.5.8')
    expect(info?.assetKind).toBe('apk')
    expect(info?.assetSize).toBe(13682159)
    expect(info?.assetDigest).toBe(`sha256:${'a'.repeat(64)}`)
    // 候选：GitHub 官方在前，加速前缀在后，供下载时按序降级
    expect(info?.assetUrls[0]).toContain('github.com/yib0601/aurora-music/releases/download')
    expect(info?.assetUrls.some((u) => u.startsWith('https://gh-proxy.com/'))).toBe(true)
  })

  it('无新版本时返回 null，不报错', async () => {
    stubGithub(() => json(githubBody('0.0.0')))
    await expect(checkForUpdate()).resolves.toBeNull()
  })

  it('直连失败时靠加速前缀仍能拿到结论', async () => {
    stubGithub((url) => {
      if (url.startsWith('https://gh-proxy.com/')) return json(githubBody('0.5.9'))
      throw new TypeError('fetch failed')
    })
    const info = await checkForUpdate()
    expect(info?.version).toBe('0.5.9')
  })

  it('全部候选失败时抛出带状态码的原因', async () => {
    stubGithub(() => new Response('rate limited', { status: 403 }))
    await expect(checkForUpdate()).rejects.toThrow('HTTP 403')
  })

  it('失败是结构化错误：码 + 状态码进 detail，文案按语言在显示端渲染', async () => {
    stubGithub(() => new Response('rate limited', { status: 403 }))
    const err = await checkForUpdate().catch((e: unknown) => e)
    const info = toErrorInfo(err)
    expect(info.code).toBe('errors.network.unreachable')
    expect(info.detail).toBe('HTTP 403')
    // 同一份错误在两种语言下渲染成各自语言的文案（抛出点不含任何中文字面量）
    expect(translateError(err, t)).toMatch(/网络不可达/)
    expect(translateError(err, tEn)).toMatch(/Network unreachable/i)
  })

  it('安装包标签与提示给的是文案键（渲染期才翻译），命令行原文保持语言无关', async () => {
    stubGithub(() => json(githubBody('0.5.8')))
    const info = await checkForUpdate()
    // 存键不存译文：横幅是长期驻留元素，切语言要跟着变
    expect(info?.assetLabel).toBe('update.asset.apk')
    expect(t(info!.assetLabel!)).toBe('APK')
    expect(tEn(info!.assetLabel!)).toBe('APK')
    // APK 没有覆盖安装提示（仅系统包管理器安装的 rpm/deb 才有）
    expect(info?.installHint).toBeNull()
    expect(info?.installCommand).toBeNull()
  })

  it('release 里没有匹配当前平台的安装包时，assetUrls 为空而不报错', async () => {
    stubGithub(() => json(githubBody('0.5.8', false)))
    const info = await checkForUpdate()
    expect(info?.version).toBe('0.5.8')
    expect(info?.assetUrls).toEqual([])
    expect(info?.assetKind).toBeNull()
  })
})
