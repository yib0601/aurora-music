import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { searchLyrics } from '../lyricsSource'
import { setCustomFetch } from '../fetchWithTimeout'
import type { LyricsSourceConfig } from '../types'

/**
 * 修复的**目的**验收：并发聚合链路不再永久 pending。
 *
 * 为什么单独立这一组：`fetchWithTimeout` 自己的用例证明的是「原语会超时」，
 * 调用点用例证明的是「文案带源名」。但用户最初看到的现象是**界面永久转圈**——
 * 那发生在聚合层：`firstSuccess` 的收场条件是「所有档进入终态」，
 * 只要有一档永不 settle（上游送完响应头停住 body），整体就永不 resolve。
 * 只有端到端跑一次「停滞上游 + 可用上游」的聚合，才能证明这条链路真的会收敛。
 *
 * 反向对照（关键）：把读体预算去掉（还原旧行为）后，「全部档都停滞」那条用例会挂到
 * vitest 超时上限（实测 25007ms）—— 这正是修复前用户遇到的情形。而「停滞档排首位」
 * 那条在旧行为下**仍然通过**：它靠的是对冲调度，不是读体超时。两条各证一件事，不要混着读。
 *
 * ⚠️ `searchLyrics` 会**无条件追加**两个内置 LRCLIB 源（lrclib.net）。测试绝不能
 * 真的去访问它：既违反「测试不依赖真实网络」的项目约定，也会让断言失真
 * （实测：不拦内置源时，「全部档都停滞」用例会因真实 LRCLIB 返回歌词而拿到非 null，
 * 掩盖被测行为）。所以这里统一把 lrclib.net 拦到本地：返回空结果数组（=无歌词），
 * 使内置源快速落空，被测行为只由本地真实 socket 决定。
 */

const realFetch = globalThis.fetch
let stalled: http.Server
let good: http.Server
let stalledPort = 0
let goodPort = 0

/** 假的内置源响应：快速返回「没有歌词」，不发任何真实网络请求 */
const EMPTY_LYRICS_JSON = '[]'

beforeAll(async () => {
  // 停滞上游：送出响应头与 Content-Length，只写一半 body 且永不 end
  stalled = http.createServer((req, res) => {
    req.socket.on('error', () => {})
    req.resume()
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': '4096' })
    res.write('{"partial":')
  })
  await new Promise<void>((resolve) => stalled.listen(0, '127.0.0.1', resolve))
  stalledPort = (stalled.address() as AddressInfo).port

  // 可用上游：正常完整的 LRCLIB 形状响应
  good = http.createServer((req, res) => {
    req.socket.on('error', () => {})
    req.resume()
    const body = JSON.stringify([
      { trackName: '七里香', artistName: '周杰伦', syncedLyrics: '[00:01.00]窗外的麻雀' },
    ])
    res.writeHead(200, {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(body)),
    })
    res.end(body)
  })
  await new Promise<void>((resolve) => good.listen(0, '127.0.0.1', resolve))
  goodPort = (good.address() as AddressInfo).port
})

afterAll(async () => {
  for (const s of [stalled, good]) {
    s.closeAllConnections?.()
    await new Promise<void>((resolve) => s.close(() => resolve()))
  }
})

beforeEach(() => {
  setCustomFetch((input, init) => {
    const url = String(input)
    // 内置 LRCLIB 一律拦成「无歌词」，绝不出网
    if (url.includes('lrclib.net')) {
      return Promise.resolve(
        new Response(EMPTY_LYRICS_JSON, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      )
    }
    // 其余（本机测试服务器）仍走真实 fetch —— 这样才能证明「底层 socket 真的被断」
    return realFetch(input, init)
  })
})

afterEach(() => setCustomFetch(null))

const src = (id: string, name: string, port: number): LyricsSourceConfig => ({
  id,
  name,
  sourceUrl: `http://127.0.0.1:${port}/api/search?track_name={track}&artist_name={artist}`,
  enabled: true,
})

describe('歌词聚合：停滞上游不再让整条链路永久挂起', () => {
  it('停滞档排在首位时，后档仍能在有限时间内胜出（这是**对冲**的功劳，与读体超时无关）', async () => {
    const started = Date.now()
    const result = await searchLyrics('七里香', '周杰伦', undefined, undefined, {
      sources: [src('stalled-1', '停滞源', stalledPort), src('good-1', '可用源', goodPort)],
    })
    const elapsed = Date.now() - started

    // 关键断言：真的拿到了结果，而不是永远等下去
    expect(result).not.toBeNull()
    expect(result?.lrc).toContain('窗外的麻雀')
    expect(result?.name).toBe('七里香')
    // 对冲窗口 600ms + 后档响应，远小于 8s 的单源超时预算
    expect(elapsed).toBeLessThan(8000)

    // ⚠️ 反向验证发现的事实（写下来免得后人误读）：把读体预算整个去掉后，
    // 本用例**依然通过**（实测 621ms）。因为停滞档排在首位时，对冲窗口一到就会
    // 启动后档、后档立刻带回结果，根本走不到读体超时那一步。
    // 所以这条证明的是**对冲调度**修好了一类既有挂死（旧串行版会一直等首位停滞档），
    // 它**不**证明读体超时的价值 —— 后者由下面那条「全部档都停滞」的用例证明
    // （去掉读体预算后实测挂到 25007ms 上限）。测试描述必须与实际证明范围一致。
  }, 20000)

  it('全部档都停滞时，在单源超时预算量级内收敛为 null（而不是永远 pending）', async () => {
    const started = Date.now()
    const result = await searchLyrics('七里香', '周杰伦', undefined, undefined, {
      sources: [src('stalled-a', '停滞A', stalledPort), src('stalled-b', '停滞B', stalledPort)],
    })
    const elapsed = Date.now() - started

    // 没有可用的歌词源时返回 null 是正常结论（调用方展示无歌词），前提是**能返回**
    expect(result).toBeNull()
    // 单源预算 8s；两档并行对冲，不该按档数累加成 16s
    expect(elapsed).toBeLessThan(12000)
  }, 25000)

  it('自证：拦掉内置源后，本组不存在任何真实外网请求（否则上面的断言会失真）', async () => {
    // 这条用来钉住上面的 beforeEach 拦截确实生效：不拦的话内置 LRCLIB 会返回歌词，
    // 「全部档都停滞」会拿到非 null，被测行为就被掩盖了
    const result = await searchLyrics('七里香', '周杰伦', undefined, undefined, { sources: [] })
    expect(result).toBeNull()
  }, 15000)
})