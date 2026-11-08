import { afterEach, describe, expect, it } from 'vitest'
import { fetchWithTimeout, setCustomFetch } from '../fetchWithTimeout'
import { fetchLxScript, setLxScriptFetch } from '../lxHost'
import { expectCode, rejectionOf } from './i18nAssert'

/**
 * 脚本拉取实现注入（setLxScriptFetch）的契约。
 *
 * 为什么需要这一层：桌面端必须用 Electron 的 net.fetch 取洛雪脚本，否则 Node 的
 * undici 直连不读系统代理，用户配了代理时 raw.githubusercontent.com 会一路直连到
 * 20s 超时（用户侧看到的就是 core.error.lxScriptTimeout）。注入点又挂在 shared 的
 * 模块级状态上 —— 一旦「注入了但没被用」「用了但没复原」，后续所有拉取都会串味，
 * 而且这类问题在真机上只表现为「有时候慢」，很难复现。这里用桩实现把它钉死。
 */

/** 每个用例后复原两处模块级注入，避免测试之间互相污染 */
const realFetch = globalThis.fetch

afterEach(() => {
  setLxScriptFetch(null)
  setCustomFetch(null)
  globalThis.fetch = realFetch
})

/** 假域名：不得出现真实 URL / key（仓库公开） */
const SCRIPT_URL = 'https://source.invalid/lx/source.js'
const SCRIPT_BODY = '/* fake lx script body */'

describe('fetchLxScript：注入的底层实现', () => {
  it('使用注入的实现，并原样返回它的响应体', async () => {
    const calls: unknown[] = []
    setLxScriptFetch(async (input) => {
      calls.push(input)
      return new Response(SCRIPT_BODY, { status: 200 })
    })

    await expect(fetchLxScript(SCRIPT_URL, 1000)).resolves.toBe(SCRIPT_BODY)
    expect(calls).toEqual([SCRIPT_URL])
  })

  it('把脚本拉取用的 UA 头交给注入实现', async () => {
    let seen: RequestInit | undefined
    setLxScriptFetch(async (_input, init) => {
      seen = init
      return new Response(SCRIPT_BODY, { status: 200 })
    })

    await fetchLxScript(SCRIPT_URL, 1000)

    const headers = (seen?.headers ?? {}) as Record<string, string>
    // 只断言前缀：UA 的具体版本会随脚本更新，钉死整串会让无关改动判红
    expect(headers['User-Agent']).toMatch(/^Mozilla\/5\.0/)
    expect(headers.Accept).toBe('*/*')
  })

  it('注入实现不响应中止信号时，超时仍映射成 lxScriptTimeout', async () => {
    // 模拟 Chromium 网络栈卡在代理上：请求永不 settle，也不看 AbortSignal
    setLxScriptFetch(() => new Promise<Response>(() => {}))

    const err = await rejectionOf(fetchLxScript(SCRIPT_URL, 30))
    expectCode(err, 'core.error.lxScriptTimeout', { ms: 30 })
  })

  it('setLxScriptFetch(null) 之后回落到全局 fetch', async () => {
    setLxScriptFetch(() => Promise.reject(new Error('清除后不应再被调用')))
    setLxScriptFetch(null)

    let called = 0
    globalThis.fetch = (async () => {
      called += 1
      return new Response(SCRIPT_BODY, { status: 200 })
    }) as typeof fetch

    await expect(fetchLxScript(SCRIPT_URL, 1000)).resolves.toBe(SCRIPT_BODY)
    expect(called).toBe(1)
  })
})

describe('fetchWithTimeout：实现优先级', () => {
  it('显式 impl 优先于 setCustomFetch 注入的进程级实现', async () => {
    const used: string[] = []
    setCustomFetch(async () => {
      used.push('custom')
      return new Response('custom', { status: 200 })
    })

    const resp = await fetchWithTimeout(SCRIPT_URL, {}, 1000, async () => {
      used.push('impl')
      return new Response('impl', { status: 200 })
    })

    await expect(resp.text()).resolves.toBe('impl')
    expect(used).toEqual(['impl'])
  })

  it('未传 impl 时行为不变：仍是 setCustomFetch 注入的实现', async () => {
    const used: string[] = []
    setCustomFetch(async () => {
      used.push('custom')
      return new Response('custom', { status: 200 })
    })

    const resp = await fetchWithTimeout(SCRIPT_URL, {}, 1000)
    await expect(resp.text()).resolves.toBe('custom')
    expect(used).toEqual(['custom'])
  })
})
