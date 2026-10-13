import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fetchWithTimeout } from '../fetchWithTimeout'
import { searchLyricsSource } from '../lyricsSource'
import { resolvePlaylistUrl } from '../playlistResolver'
import { searchMusicSource } from '../musicSource'
import { fetchToplistGroups } from '../musicHall'
import { fetchLxScript } from '../lxHost'
import { listWebdavDir } from '../webdav'
import type { LyricsSourceConfig, OnlineSourceConfig } from '../types'
import { expectCode, rejectionOf } from './i18nAssert'

/**
 * 调用点层的「上游送完响应头就停住 body」验收。
 *
 * 为什么单独一层：`fetchWithTimeout` 自己的用例证明的是「原语会超时」，
 * 而用户实际看到的是**调用点**抛出的文案。读体超时若不在这里分流，
 * 上屏的就是 `AURORA_ERR:{"code":"errors.network.timeout"...}` 这串编码载荷
 * ——没有源名、没有语境，等于把人机界面的错误退化成调试串。
 * 本文件把「超时必须带着源名与语境上屏」逐点钉住。
 *
 * 全部走真实 HTTP 服务器：本组要证的行为发生在 socket 与超时预算的交互上，
 * 打桩 fetch 会让「底层到底有没有被 abort」失去意义。
 * 用 http.Server 而非裸 net.Server：裸 TCP 不处理 keep-alive，第二个用例起
 * 就会在响应头阶段假超时（实测踩过）。
 */

let server: http.Server
let port = 0

/**
 * 「必须有结论」护栏：给被测 promise 套一个内容级截止。
 *
 * 为什么不靠 vitest 的 per-test 超时：那只会报 `Test timed out`，看不出是**哪一处**
 * 没返回、也看不出它是「挂死」还是「慢」。更糟的是实测过——去掉读体预算的变体下，
 * 一个挂死的用例会拖到上限，而 `firstSuccess` 是裸 promise（无 settle 上限），
 * 同进程后续用例会被一起拖住，报告最后只剩一片超时，真因被淹没。
 * 这里自己 race 一个上限，失败信息直接点名「该调用点没有收敛」。
 */
async function expectSettles<T>(label: string, p: Promise<T>, withinMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} 在 ${withinMs}ms 内没有收敛（疑似挂死，而不是变慢）`)),
          withinMs
        )
      }),
    ])
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    req.socket.on('error', () => {})
    // 排空请求体（PROPFIND 带 body）：不读会让 node 认为请求未被消费
    req.resume()
    // 所有路径统一行为：送出响应头与 Content-Length，只写一半 body 且永不 end
    res.writeHead(200, {
      'content-type':
        req.url === '/music' || req.url === '/lyrics' || req.url === '/hall'
          ? 'application/json'
          : 'application/xml',
      'content-length': '4096',
      // 强制每条请求独立连接：否则 undici 的连接池会复用「上一个用例里被 abort 掉」的
      // 连接，表现为与读体超时无关的 `fetch failed`（实测踩过，两处用例假失败）
      connection: 'close',
    })
    res.write('{"partial":')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
})

afterAll(async () => {
  server.closeAllConnections?.()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

const base = () => `http://127.0.0.1:${port}`

describe('上游发完响应头停住 body：调用点上屏的是带源名的结构化错误', () => {
  it('歌词源：读体超时映射为 core.error.lyricsTimeout（带源名与时长）', async () => {
    const source: LyricsSourceConfig = {
      id: 'ly-1',
      name: '我的歌词源',
      sourceUrl: `${base()}/lyrics?t={track}&a={artist}`,
      enabled: true,
    }
    // 自证构造有效：上游确实会送出响应头（否则测的是连接失败，不是读体卡住）
    const head = await fetchWithTimeout(`${base()}/lyrics`, {}, 15000)
    expect(head.ok).toBe(true)
    expect(head.headers.get('content-length')).toBe('4096')

    const err = await rejectionOf(
      expectSettles('歌词源调用点', searchLyricsSource(source, '七里香', '周杰伦'), 15000)
    )
    // 读体超时与响应头超时必须是同一条文案（用户不必区分阶段）
    expectCode(err, 'core.error.lyricsTimeout', { name: '我的歌词源', ms: 8000 })
    expect((err as Error).message).not.toMatch(/aborted/i)
  }, 20000)

  it('歌单解析：读体超时映射为 core.error.playlistTimeout（带源名）', async () => {
    const source: OnlineSourceConfig = {
      id: 'pl-1',
      name: '我的音源',
      sourceUrl: '',
      // 歌单端点走接口模板形态的 playlistUrl（服务地址形态由协议派生，见 playlistEndpointOf）
      playlistUrl: `${base()}/playlist?url={url}`,
      enabled: true,
    }
    const err = await rejectionOf(
      expectSettles(
        '歌单解析调用点',
        resolvePlaylistUrl(source, 'https://y.qq.com/n/ryqq/playlist/7344515327'),
        20000
      )
    )
    expectCode(err, 'core.error.playlistTimeout', { name: '我的音源', ms: 15000 })
  }, 20000)

  it('在线搜索：读体超时映射为 core.error.sourceTimeout（带源名）', async () => {
    const source: OnlineSourceConfig = {
      id: 'src-1',
      name: '我的音源',
      sourceUrl: `${base()}/music?q={query}`,
      enabled: true,
    }
    const err = await rejectionOf(
      expectSettles('在线搜索调用点', searchMusicSource(source, '青花瓷'), 15000)
    )
    expectCode(err, 'core.error.sourceTimeout', { name: '我的音源', ms: 10000 })
  }, 20000)

  it('在线音乐读取（musicHall）：读体超时与「不是 JSON」必须分流，报超时', async () => {
    const source = { id: 'h-1', name: '我的音源', sourceUrl: base() }
    const err = await rejectionOf(
      expectSettles('musicHall 调用点', fetchToplistGroups(source as never), 15000)
    )
    // 关键分流：卡住是网络问题，不该让用户去查音源配置
    expectCode(err, 'core.error.hallTimeout', { name: '我的音源', ms: 10000 })
  }, 20000)

  it('洛雪脚本下载：读体超时映射为 core.error.lxScriptTimeout（不再裸抛英文 AbortError）', async () => {
    const err = await rejectionOf(
      expectSettles('洛雪脚本下载调用点', fetchLxScript(`${base()}/script.js`, 800), 5000)
    )
    expectCode(err, 'core.error.lxScriptTimeout', { ms: 800 })
    expect((err as Error).message).not.toMatch(/aborted/i)
  }, 20000)

  it('WebDAV 目录列举：读体超时映射为 core.error.webdavConnect（带存储名，而非编码串）', async () => {
    const cfg = {
      id: 'w-1',
      name: '我的 NAS',
      kind: 'webdav' as const,
      baseUrl: base(),
      username: 'bob',
      password: 'p@ss word',
      rootPath: '/Music',
    }
    const err = await rejectionOf(
      expectSettles('WebDAV 列举调用点', listWebdavDir(cfg as never, '', 600), 5000)
    )
    // reason 是归一后的技术原文（TimeoutError 的 detail），正是要上屏给用户看的那一份
    expectCode(err, 'core.error.webdavConnect', { name: '我的 NAS', reason: 'timeout after 600ms' })
  }, 20000)
})