/**
 * 设置页「测试」对脚本源的回归：探测必须先按链接把脚本**拉下来**。
 *
 * 回归来源：音源插件化（b7f95e7）把探测收进 `plugin/lxPlugin.ts` 后，`probe` 只做
 * `inspectLxSource(config)`；而设置页表单按设计只传 `sourceUrl`、不传 `script`
 * （脚本源码不落库，运行时现拉，见 `packages/app/src/components/common/LxSourceProbe.tsx`
 * 与 `pluginConfigCards.tsx` 的保存分支）。于是桌面端对任何 lx 链接点「测试」都必然
 * 得到 `core.error.lxScriptEmpty`（界面文案「脚本加载失败：脚本内容为空」），
 * 即使这条链接本身能正常下载 —— 用户看到的现象就是「我直接访问地址是好的」。
 *
 * 本文件第 1 条用例在修复前失败（脚本从未被拉取），修复后通过；其余用例锁住
 * 「有内联源码就不重复下载」「下载失败要报真实原因而不是空内容」这两条边界。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { lxPlugin } from '../lxPlugin'
import {
  clearLxSourceCache,
  setLxHostDeps,
  setLxScriptFetch,
  type FetchLike,
} from '../../lxHost'
import { expectCode } from '../../__tests__/i18nAssert'
import type { OnlineSourceConfig } from '../../types'
import type { PluginContext } from '../types'

/** 最小洛雪格式桩脚本：自报两个平台（kw 可搜、mg 只取址），不发起任何网络请求 */
const STUB_SCRIPT = `
var lx = globalThis.lx
lx.on(lx.EVENT_NAMES.request, function (arg) {
  return Promise.reject(new Error('桩脚本不提供该动作: ' + arg.action))
})
lx.send(lx.EVENT_NAMES.inited, {
  sources: {
    kw: { name: '酷我', type: 'music', actions: ['musicUrl', 'search'], qualitys: ['128k', '320k'] },
    mg: { name: '咪咕', type: 'music', actions: ['musicUrl'], qualitys: ['128k'] },
  },
})
`

/** 设置页表单实际提交的形态：只有链接，没有源码 */
function formSource(over: Partial<OnlineSourceConfig> = {}): OnlineSourceConfig {
  return {
    id: 'lx-probe-regression',
    name: '长青SVIP音源',
    kind: 'lx',
    sourceUrl: 'https://gh-proxy.org/raw.githubusercontent.com/pdone/lx-music-source/main/changqing/latest.js',
    enabled: true,
    ...over,
  } as OnlineSourceConfig
}

/** 假脚本拉取：记录被请求的链接，按给定文本/状态码作答 */
function fakeFetch(body = STUB_SCRIPT, status = 200): { fetch: FetchLike; urls: string[] } {
  const urls: string[] = []
  const fetch = (async (input: unknown) => {
    urls.push(String(input))
    return new Response(status === 200 ? body : 'upstream error', { status })
  }) as unknown as FetchLike
  return { fetch, urls }
}

/** 探测不碰网络之外的东西：ctx 给空对象，宿主走模块级注册（与桌面主进程一致） */
const EMPTY_CTX = {} as PluginContext

afterEach(() => {
  setLxHostDeps(null)
  setLxScriptFetch(null)
  clearLxSourceCache()
})

describe('lxPlugin.probe（设置页「测试」）', () => {
  it('只有脚本链接时按链接现拉源码，再问能力', async () => {
    const { fetch, urls } = fakeFetch()
    setLxScriptFetch(fetch)

    const result = await lxPlugin.probe!(formSource(), EMPTY_CTX)

    // 修复前：脚本从未被拉取，返回 ok:false + core.error.lxScriptEmpty
    expect(urls).toEqual([formSource().sourceUrl])
    expect(result.ok).toBe(true)
    expect(result.kind).toBe('lx')
    expect(result.error).toBeUndefined()
    const kw = result.capabilities.find((cap) => cap.key === 'kw')
    const mg = result.capabilities.find((cap) => cap.key === 'mg')
    expect(kw?.searchable).toBe(true)
    expect(kw?.qualityCount).toBe(2)
    expect(mg?.searchable).toBe(false)
  })

  it('已有内联源码（移动端适配层先拉好）时不再重复下载', async () => {
    const { fetch, urls } = fakeFetch()
    setLxScriptFetch(fetch)

    const result = await lxPlugin.probe!(
      formSource({ script: STUB_SCRIPT } as Partial<OnlineSourceConfig>),
      EMPTY_CTX
    )

    expect(urls).toEqual([])
    expect(result.ok).toBe(true)
  })

  it('下载失败报真实原因（HTTP 状态），而不是「脚本内容为空」', async () => {
    const { fetch } = fakeFetch('', 404)
    setLxScriptFetch(fetch)

    const result = await lxPlugin.probe!(formSource(), EMPTY_CTX)

    expect(result.ok).toBe(false)
    expect(result.kind).toBe('lx')
    expectCode(result.error, 'core.error.lxScriptDownload', { status: 404 })
  })

  it('既无源码也无链接时给结构化的「未附带源码」，不判成脚本空内容', async () => {
    const { fetch, urls } = fakeFetch()
    setLxScriptFetch(fetch)

    const result = await lxPlugin.probe!(formSource({ sourceUrl: '' }), EMPTY_CTX)

    expect(urls).toEqual([])
    expect(result.ok).toBe(false)
    expectCode(result.error, 'core.error.lxSourceNoScript', { name: '长青SVIP音源' })
  })
})
