/**
 * searchLxSource 多平台并发化的行为回归。
 *
 * 旧实现逐平台 `await`：同一脚本声明 3 个平台时耗时按平台数累加
 * （单平台超时 20s，见 DEFAULT_CALL_TIMEOUT_MS），而平台之间没有依赖关系。
 * 改成 mapWithConcurrency 后必须钉住两件事：
 *   1. **结果顺序不变**：仍严格按 inspection.platforms 的声明顺序拼接
 *      （下游 coverMatch / 播放取址都按来源顺序消费，顺序漂移会表现为「结果乱序」）；
 *   2. **取数确实重叠**：三平台都慢时总耗时接近「最慢的一个」而不是「三者之和」。
 *
 * 用真实的洛雪脚本桩（宿主 request 打桩），走完整的 boot → call 路径。
 */
import { describe, expect, it, afterEach } from 'vitest'
import { clearLxSourceCache, searchLxSource, setLxHostDeps, type LxHostDeps } from '../lxHost'
import { expectCode, rejectionOf } from './i18nAssert'

afterEach(() => {
  setLxHostDeps(null)
  clearLxSourceCache()
})

/**
 * 三平台桩脚本：kw / mg / tx 各有 search，每次调用先等 `delay` 毫秒再返回。
 * 返回值里带上平台名，便于断言结果的来源与顺序。
 */
function multiPlatformScript(delay: number, opts: { failOn?: string; metaOf?: string } = {}): string {
  const failBranch = opts.failOn
    ? `if (arg.source === '${opts.failOn}') return Promise.reject(new Error('该平台上游挂了'))`
    : ''
  return `
var lx = globalThis.lx
lx.on(lx.EVENT_NAMES.request, function (arg) {
  if (arg.action !== 'search' && arg.action !== 'musicSearch') {
    return Promise.reject(new Error('不支持的动作: ' + arg.action))
  }
  ${failBranch}
  return new Promise(function (resolve) {
    setTimeout(function () {
      resolve({ list: [
        { name: '曲目-' + arg.source, singer: '歌手', albumName: '专辑', songmid: 'mid-' + arg.source, interval: 200 }
      ] })
    }, ${delay})
  })
})
lx.send(lx.EVENT_NAMES.inited, {
  sources: {
    kw: { name: '酷我', type: 'music', actions: ['search', 'musicUrl'], qualitys: ['128k'] },
    mg: { name: '咪咕', type: 'music', actions: ['musicSearch'], qualitys: ['128k'] },
    tx: { name: 'QQ', type: 'music', actions: ['search'], qualitys: ['flac'] },
    // 无搜索能力的平台：只声明 musicUrl，不该参与调度
    wy: { name: '网易云', type: 'music', actions: ['musicUrl'], qualitys: ['320k'] },
  },
})
`
}

/** 记录请求的假宿主：脚本走 setTimeout 自答，不经网络 */
function installDeps(): void {
  const deps: LxHostDeps = {
    env: 'desktop',
    request(_url, _options, callback) {
      setTimeout(() => callback(new Error('本用例不该发网络请求'), null), 0)
      return () => {}
    },
  }
  setLxHostDeps(deps)
}

const source = (script: string) =>
  ({ id: 'lx-multi', name: '多平台源', kind: 'lx', sourceUrl: 'http://stub.test/s.js', enabled: true, script }) as never

describe('searchLxSource：多平台并发', () => {
  it('结果按平台声明顺序拼接，与串行版逐字一致', async () => {
    installDeps()
    const out = await searchLxSource(source(multiPlatformScript(0)), '词', null)
    // wy 没有搜索能力，不参与；其余按 kw → mg → tx 的声明顺序
    expect(out.map((r) => r.title)).toEqual(['曲目-kw', '曲目-mg', '曲目-tx'])
    expect(out.map((r) => r.trackRef?.platform)).toEqual(['kw', 'mg', 'tx'])
    expect(out.map((r) => r.source)).toEqual(['lx-multi', 'lx-multi', 'lx-multi'])
    // 脚本源条目永远不带直链
    expect(out.every((r) => r.audioUrl === '')).toBe(true)
  })

  it('完成顺序被刻意反转时，结果仍严格按声明顺序（证伪「按完成序 push」）', async () => {
    // 独立验证者指出：上一用例里三个平台耗时相同（delay 都为 0），完成顺序恰好等于
    // 声明顺序，因此**无法区分**「按声明顺序组装」与「按完成顺序 push」两种实现。
    // 这里把完成顺序完全倒过来：kw 最慢、tx 最快，完成序 = tx → mg → kw。
    installDeps()
    const script = `
var lx = globalThis.lx
lx.on(lx.EVENT_NAMES.request, function (arg) {
  var delays = { kw: 150, mg: 80, tx: 0 }
  return new Promise(function (resolve) {
    setTimeout(function () {
      resolve({ list: [{ name: '曲目-' + arg.source, singer: '手', songmid: 'm-' + arg.source, interval: 200 }] })
    }, delays[arg.source] || 0)
  })
})
lx.send(lx.EVENT_NAMES.inited, {
  sources: {
    kw: { name: '酷我', type: 'music', actions: ['search'], qualitys: ['128k'] },
    mg: { name: '咪咕', type: 'music', actions: ['search'], qualitys: ['128k'] },
    tx: { name: 'QQ', type: 'music', actions: ['search'], qualitys: ['128k'] },
  },
})
`
    const out = await searchLxSource(source(script), '词', null)
    // 若实现是「谁先回谁先 push」，这里会是 tx → mg → kw
    expect(out.map((r) => r.trackRef?.platform)).toEqual(['kw', 'mg', 'tx'])
  })

  it('三平台各慢 120ms 时总耗时接近一个平台的耗时，而不是三者之和', async () => {
    installDeps()
    const t0 = Date.now()
    const out = await searchLxSource(source(multiPlatformScript(120)), '词', null)
    const elapsed = Date.now() - t0
    expect(out).toHaveLength(3)
    // 串行需 ≥360ms；并发下只等最慢的一个（120ms）+ 调度余量
    expect(elapsed).toBeLessThan(320)
  })

  it('单平台失败不影响其它平台，且顺序里跳过它', async () => {
    installDeps()
    const out = await searchLxSource(source(multiPlatformScript(0, { failOn: 'mg' })), '词', null)
    expect(out.map((r) => r.title)).toEqual(['曲目-kw', '曲目-tx'])
  })

  it('全部平台失败且原因同码时上抛该码（不概括成「搜索失败」）', async () => {
    installDeps()
    // failOn 同时命中三个平台的写法：脚本对任何 source 都拒绝
    const script = `
var lx = globalThis.lx
lx.on(lx.EVENT_NAMES.request, function () {
  return Promise.reject(new Error('上游全挂'))
})
lx.send(lx.EVENT_NAMES.inited, {
  sources: {
    kw: { name: '酷我', type: 'music', actions: ['search'], qualitys: ['128k'] },
    mg: { name: '咪咕', type: 'music', actions: ['search'], qualitys: ['128k'] },
  },
})
`
    const err = await rejectionOf(searchLxSource(source(script), '词', null))
    // errors.raw（脚本自由文本）是三个平台唯一的共同码，原样上抛
    expectCode(err, 'errors.raw', { message: '上游全挂' })
  })

  it('空查询直接返回空数组，不启动脚本', async () => {
    installDeps()
    const out = await searchLxSource(source(multiPlatformScript(0)), '   ', null)
    expect(out).toEqual([])
  })

  it('limit 对每个平台的结果各自生效', async () => {
    installDeps()
    const script = `
var lx = globalThis.lx
lx.on(lx.EVENT_NAMES.request, function (arg) {
  var list = []
  for (var i = 0; i < 10; i++) list.push({ name: '曲目' + i, singer: '手', songmid: 'm' + i, interval: 100 })
  return Promise.resolve({ list: list })
})
lx.send(lx.EVENT_NAMES.inited, {
  sources: {
    kw: { name: '酷我', type: 'music', actions: ['search'], qualitys: ['128k'] },
    mg: { name: '咪咕', type: 'music', actions: ['search'], qualitys: ['128k'] },
  },
})
`
    const out = await searchLxSource(source(script), '词', null, { limit: 3 })
    expect(out).toHaveLength(6)
    expect(out.filter((r) => r.trackRef?.platform === 'kw')).toHaveLength(3)
    expect(out.filter((r) => r.trackRef?.platform === 'mg')).toHaveLength(3)
  })
})