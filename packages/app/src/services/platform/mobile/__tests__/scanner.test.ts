/**
 * 移动端扫描 `scanFolder` 并发化后的**行为等价性**回归。
 *
 * 旧实现是 `for (const file of files) await processFile(...)`：每文件一个单位耗时
 * （读 blob + 解析标签 + 写封面 + 写库），桌面端同功能是 8 并发、Web 端 4 并发，
 * 唯独移动端串行。改成「串行查重 → 并发解析（4）→ 串行入库」后，
 * 这里要钉住的**不是「变快了」**（那属于性能，不该靠单测断言），而是改造最容易打破的四件事：
 *   1. 返回的曲目集合与**顺序**不变（UI 依赖它做渐进式刷新）；
 *   2. `onTrack` 仍对每一条结果触发且顺序与文件顺序一致（旧实现顺序即完成序，
 *      新实现刻意把通知压回串行段，避免并发完成序把列表抖乱）；
 *   3. 已入库的曲目**不重复写库**（旧行为：getTrackByPath 命中即直接返回，从不 insert）；
 *   4. 单条写入失败不中断整轮扫描。
 *
 * 为什么要打桩而不跑真机：并发行为的判定需要精确控制每个文件的解析耗时
 * （哪个先完成、峰值在途数），真机上无法确定性重放；而 Capacitor Filesystem /
 * SQLite / music-metadata 在 node 下都能以内存实现等价替身。真机只用于确认主干可用。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Track } from '@/types'

/** 内存文件系统 + 可编程的解析耗时，供并发行为断言 */
const state = vi.hoisted(() => ({
  files: [] as string[],
  /** 每个文件的 blob 读取耗时（毫秒）；未列出的按 0 */
  readDelay: new Map<string, number>(),
  /** 已写入数据库的 path（按插入顺序） */
  inserted: [] as string[],
  /** 已在库中的 path：getTrackByPath 命中即复用 */
  existing: new Set<string>(),
  /** 让指定 path 的 insertTrack 抛错 */
  insertFails: new Set<string>(),
  /** 让指定 path 的 getTrackByPath 抛错（模拟读库失败） */
  lookupFails: new Set<string>(),
  /** 让指定文件名的 parseBlob 抛错 */
  failParse: new Set<string>(),
  /** 自带内嵌封面的文件名集合 */
  hasCover: new Set<string>(),
  /** 封面写入/取 uri 的耗时（毫秒），按文件名 */
  coverDelay: (name: string): number => 0,
  /** 每个文件的解析完成序号（供用例自证「谁先解析完」的构造前提） */
  parseDoneSeq: new Map<string, number>(),
  /** 完成序号计数器 */
  doneCounter: 0,
  /** 文件名 → 专辑名（缺省统一为「专辑」） */
  albumOf: (name: string): string => '专辑',
  /** 已写入的封面文件路径（用于断言封面确实落盘） */
  coverWrites: [] as string[],
  /** 让指定文件名的封面落盘抛错（模拟 Capacitor 写失败） */
  coverWriteFails: new Set<string>(),
  /**
   * 封面数据的「来源文件名」标记：`base64(数据) → 源文件名`。
   *
   * 封面落盘的文件名是 `<trackId><ext>`，与源文件名无关，无法直接对应；
   * 而并发下「谁正在解析」也无法用单一变量跟踪。因此让 parseBlob 替身给每个文件的
   * 封面数据编一个可辨识的字节内容，writeFile 再反查该内容属于哪个文件 ——
   * 这样即使在并发交错中也判定得准。
   */
  coverDataOwner: new Map<string, string>(),
  /** 并发峰值与当前在途数（由 fetch 的 blob 读取统计） */
  liveReads: 0,
  peakReads: 0,
  /** 每个文件被解析的次数（重复解析说明缓存/去重失效） */
  parseCount: new Map<string, number>(),
}))

vi.mock('@capacitor/filesystem', () => ({
  Directory: { Data: 'DATA', ExternalStorage: 'EXT' },
  Filesystem: {
    async readdir({ path }: { path: string }) {
      const prefix = path.endsWith('/') ? path : `${path}/`
      const names = new Set<string>()
      for (const file of state.files) {
        if (!file.startsWith(prefix)) continue
        const rest = file.slice(prefix.length)
        if (!rest || rest.includes('/')) continue
        names.add(rest)
      }
      return { files: [...names].map((name) => ({ name, type: 'file' as const })) }
    },
    async mkdir() {},
    async getUri({ path }: { path: string }) {
      const name = (path.split('/').pop() || '').replace(/^[0-9a-f-]+/, '')
      return { uri: `file:///data/user/0/com.aurora.music/files/${path}` }
    },
    async writeFile({ path, data }: { path: string; data: string }) {
      state.coverWrites.push(path)
      // 用封面数据内容反查源文件名：并发交错下也能准确判定是谁在落封面
      const owner = state.coverDataOwner.get(String(data))
      if (owner && state.coverWriteFails.has(owner)) throw new Error('writeFile 失败')
      return { uri: `file://cover/${path}` }
    },
  },
}))

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    convertFileSrc: (p: string) => `https://localhost/_capacitor_file_${p.replace(/^file:\/\//, '')}`,
  },
}))

/**
 * music-metadata-browser 替身：`parseBlob` 里 await 一段与文件名绑定的延迟，
 * 从而让「哪个文件先解析完」完全可控 —— 这是断言并发顺序的唯一手段。
 */
vi.mock('music-metadata-browser', () => ({
  parseBlob: async (blob: { __name?: string }) => {
    const name = blob?.__name || ''
    state.parseCount.set(name, (state.parseCount.get(name) || 0) + 1)
    const ms = state.readDelay.get(name) || 0
    state.liveReads += 1
    state.peakReads = Math.max(state.peakReads, state.liveReads)
    if (ms) await new Promise((r) => setTimeout(r, ms))
    state.liveReads -= 1
    if (state.failParse.has(name)) throw new Error('标签损坏')
    // 可控的内嵌封面：用于验证专辑封面借用的并发等价性
    const coverMs = state.coverDelay(name)
    if (state.hasCover.has(name) && coverMs) await new Promise((r) => setTimeout(r, coverMs))
    // 记录每个文件的解析**完成序号**，供用例自证「快慢方向」的构造前提
    state.parseDoneSeq.set(name, state.doneCounter++)
    // 每个文件的封面数据编一个可辨识的内容，供 writeFile 反查来源文件
    let picture: { data: Uint8Array; format: string }[] | undefined
    if (state.hasCover.has(name)) {
      const data = new Uint8Array([1, 2, 3, name.length, name.charCodeAt(0) % 251])
      const b64 = Buffer.from(data).toString('base64')
      state.coverDataOwner.set(b64, name)
      picture = [{ data, format: 'image/jpeg' }]
    }
    return {
      common: {
        title: `标题-${name}`,
        artist: '歌手',
        album: state.albumOf(name),
        track: {},
        picture,
      },
      format: { duration: 100 },
    }
  },
}))

// fetch 走 stubGlobal（scanner 里直接调用全局 fetch，不经模块导入）
function installFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      const raw = String(input)
      const decoded = decodeURIComponent(raw.replace(/^.*_capacitor_file_/, ''))
      const name = decoded.split('/').pop() || decoded
      return {
        ok: true,
        __name: name,
        async blob() {
          return { __name: name }
        },
      }
    })
  )
}

/** MobileDatabase 替身：只实现 scanFolder 用到的方法，记录写库调用 */
const dbDouble = {
  async getTrackByPath(path: string) {
    if (state.lookupFails.has(path)) throw new Error('DB 读取失败')
    if (!state.existing.has(path)) return null
    return { id: `existing-${path}`, path, title: `旧-${path}`, artist: '旧', album: '旧', addedAt: 1, playCount: 0, liked: false }
  },
  async insertTrack(track: { path: string }) {
    if (state.insertFails.has(track.path)) throw new Error('insert 失败')
    state.inserted.push(track.path)
  },
  async deleteTracksWithMissingFiles() {
    return 0
  },
} as never

type ScannerModule = typeof import('../scanner')

/**
 * 机制性护栏：在**唯一模块加载入口**上校验封面用例的构造没踩静默陷阱。
 *
 * 为什么放在这里而不是逐用例显式调用：显式调用依赖作者记得写，忘一次就静默失效
 * （已实测：忘调 + 误用 coverDelay 时，错法实现照样全绿）。`loadScanner` 是这组用例
 * 唯一的加载入口，放在这里等于机制性强制；且它站在 `import('../scanner')` 之前，
 * 不会被 scanFolder 自身的 try/catch 吞掉（放进 mock 内抛错就会被吞，已实测无效）。
 *
 * 拦截两类坑，两类都会让用例「全绿但什么都没验证到」：
 *   A. 对**无内嵌封面**的文件设了 `coverDelay` —— 该延迟有 `hasCover` 门槛，不会生效；
 *   B. 用 `coverDelay` 去控制**解析快慢**（哪怕作用在有封面的文件上、延迟确实生效）
 *      —— 快慢方向由文件与封面归属共同决定，极易与实际意图相反。
 * 因此解析耗时一律只认 `readDelay`。
 */
function guardCoverFixture(): void {
  for (const f of state.files) {
    const base = f.split('/').pop() || f
    if (state.coverDelay(base) !== 0) {
      throw new Error(
        `夹具用法错误：coverDelay(${base}) 非零。该延迟只表达「封面落盘耗时」且带 hasCover 门槛，` +
          `用它控制解析快慢会让用例静默失去区分力。控制解析耗时请用 state.readDelay。`
      )
    }
  }
}

async function loadScanner(): Promise<ScannerModule> {
  guardCoverFixture()
  vi.resetModules()
  return await import('../scanner')
}

const ROOT = 'Music'
const fileOf = (name: string) => `${ROOT}/${name}`

beforeEach(() => {
  vi.unstubAllGlobals()
  state.files = []
  state.readDelay = new Map()
  state.inserted = []
  state.existing = new Set()
  state.insertFails = new Set()
  state.lookupFails = new Set()
  state.failParse = new Set()
  state.hasCover = new Set()
  state.coverDelay = () => 0
  state.parseDoneSeq = new Map()
  state.doneCounter = 0
  state.albumOf = () => '专辑'
  state.coverWrites = []
  state.coverWriteFails = new Set()
  state.coverDataOwner = new Map()
  state.liveReads = 0
  state.peakReads = 0
  state.parseCount = new Map()
  // scanner 读 `window.Capacitor.convertFileSrc` 拼流式读取地址：node 环境没有 window，
  // 这里补一个最小原生容器（与 mobileCapabilities.test.ts 同一套做法）。
  // 生产上 Capacitor 容器必然提供它，因此这是夹具问题而非实现问题。
  ;(globalThis as unknown as { window: unknown }).window = {
    Capacitor: {
      convertFileSrc: (p: string) =>
        `https://localhost/_capacitor_file_${p.replace(/^file:\/\//, '')}`,
    },
  }
  installFetch()
})

describe('移动端 scanFolder：并发化后的行为等价性', () => {
  it('返回的曲目集合与顺序等于文件顺序，onTrack 逐条按同序触发', async () => {
    // 文件按名称倒序给出，且**耗时故意让后面的先解析完**：
    // 若通知顺序跟着并发完成序走，onTrack 的顺序就会与原文件顺序不一致
    state.files = ['Music/c.mp3', 'Music/b.mp3', 'Music/a.mp3']
    state.readDelay = new Map([['a.mp3', 60], ['b.mp3', 30], ['c.mp3', 0]])

    const scanner = await loadScanner()
    const notified: string[] = []
    const out = await scanner.scanFolder(ROOT, dbDouble, (t) => notified.push(t.title))

    expect(out.map((t) => t.path)).toEqual(['Music/c.mp3', 'Music/b.mp3', 'Music/a.mp3'])
    expect(out.map((t) => t.title)).toEqual(['标题-c.mp3', '标题-b.mp3', '标题-a.mp3'])
    // 通知顺序必须与返回顺序一致（渐进式刷新的呈现序）
    expect(notified).toEqual(['标题-c.mp3', '标题-b.mp3', '标题-a.mp3'])
    // 写库顺序同样按文件顺序
    expect(state.inserted).toEqual(['Music/c.mp3', 'Music/b.mp3', 'Music/a.mp3'])
  })

  it('解析确实并发：多文件时峰值在途数 > 1', async () => {
    state.files = ['Music/a.mp3', 'Music/b.mp3', 'Music/c.mp3', 'Music/d.mp3']
    // 四个都挂 40ms：串行下峰值恒为 1
    for (const n of ['a', 'b', 'c', 'd']) state.readDelay.set(`${n}.mp3`, 40)

    const scanner = await loadScanner()
    await scanner.scanFolder(ROOT, dbDouble)

    expect(state.peakReads).toBeGreaterThan(1)
    // 上限 4：不该把全部文件一次铺开（用更多文件验证封顶）
  })

  it('并发上限为 4：8 个慢文件时峰值不超过 4', async () => {
    state.files = Array.from({ length: 8 }, (_, i) => `Music/f${i}.mp3`)
    for (let i = 0; i < 8; i++) state.readDelay.set(`f${i}.mp3`, 30)

    const scanner = await loadScanner()
    const out = await scanner.scanFolder(ROOT, dbDouble)

    expect(out).toHaveLength(8)
    expect(state.peakReads).toBeLessThanOrEqual(4)
  })

  it('已入库的曲目直接复用，不重新解析、不重复写库', async () => {
    state.files = ['Music/old.mp3', 'Music/new.mp3']
    state.existing.add('Music/old.mp3')

    const scanner = await loadScanner()
    const out = await scanner.scanFolder(ROOT, dbDouble)

    // 命中的复用旧记录（标题带「旧-」前缀）
    expect(out.map((t) => t.title)).toEqual(['旧-Music/old.mp3', '标题-new.mp3'])
    // 只有新文件被解析与入库
    expect(state.parseCount.has('old.mp3')).toBe(false)
    expect(state.inserted).toEqual(['Music/new.mp3'])
  })

  it('全部文件都已入库时不解析任何文件、不写库，仍返回全部记录', async () => {
    state.files = ['Music/x.mp3', 'Music/y.mp3']
    state.existing.add('Music/x.mp3')
    state.existing.add('Music/y.mp3')

    const scanner = await loadScanner()
    const out = await scanner.scanFolder(ROOT, dbDouble)

    expect(out).toHaveLength(2)
    expect(state.parseCount.size).toBe(0)
    expect(state.inserted).toEqual([])
  })

  it('单条写库失败只丢该条，不中断整轮、不影响其余条目', async () => {
    state.files = ['Music/a.mp3', 'Music/b.mp3', 'Music/c.mp3']
    state.insertFails.add('Music/b.mp3')

    const scanner = await loadScanner()
    const notified: string[] = []
    const out = await scanner.scanFolder(ROOT, dbDouble, (t) => notified.push(t.path))

    expect(out.map((t) => t.path)).toEqual(['Music/a.mp3', 'Music/c.mp3'])
    expect(notified).toEqual(['Music/a.mp3', 'Music/c.mp3'])
  })

  it('单条解析失败（parseBlob 抛错）只跳过该条，其余照常入库并保序', async () => {
    state.files = ['Music/ok1.mp3', 'Music/bad.mp3', 'Music/ok2.mp3']
    state.failParse.add('bad.mp3')

    const scanner = await loadScanner()
    const out = await scanner.scanFolder(ROOT, dbDouble)

    expect(out.map((t) => t.path)).toEqual(['Music/ok1.mp3', 'Music/ok2.mp3'])
    expect(state.inserted).toEqual(['Music/ok1.mp3', 'Music/ok2.mp3'])
    // 坏文件确实被尝试解析过（不是被去重静默跳过）
    expect(state.parseCount.get('bad.mp3')).toBe(1)
  })

  it('空目录返回空数组，不触发任何解析与写库', async () => {
    state.files = []
    const scanner = await loadScanner()
    const out = await scanner.scanFolder(ROOT, dbDouble)
    expect(out).toEqual([])
    expect(state.inserted).toEqual([])
  })

  it('查重抛错只跳过该文件，不 reject 整轮（与旧实现一致）', async () => {
    // 旧实现把查重放在 processFile 的 try/catch 内：读库出错只跳过该文件，其余照常入库。
    // 新流水线把查重提到主循环后，若放任异常冒泡会 reject 整个 scanFolder ——
    // 单条记录读不出来会让整张库扫不动，是明确的退化。
    state.files = ['Music/a.mp3', 'Music/b.mp3', 'Music/c.mp3']
    state.lookupFails.add('Music/b.mp3')

    const scanner = await loadScanner()
    const out = await scanner.scanFolder(ROOT, dbDouble)

    expect(out.map((t) => t.path)).toEqual(['Music/a.mp3', 'Music/c.mp3'])
    expect(state.inserted).toEqual(['Music/a.mp3', 'Music/c.mp3'])
  })

  it('onTrack 抛错不会导致同一首被重复提交或重复通知', async () => {
    // onTrack 是外部注入的回调（生产路径是 store 更新）。若游标在回调之后才推进，
    // 回调抛错会让下一次 commitReady 从同一位置再来一遍 —— 重复 push + 重复通知。
    state.files = ['Music/a.mp3', 'Music/b.mp3', 'Music/c.mp3']
    const scanner = await loadScanner()

    const notified: string[] = []
    let thrown = 0
    // 回调抛错会经 flush 的 promise 链传播；实现上刻意不吞掉它，
    // 因此这里容忍 reject —— 要断言的是**副作用**（提交只发生一次）。
    const out: Track[] = await scanner
      .scanFolder(ROOT, dbDouble, (t) => {
        notified.push(t.path)
        if (t.path === 'Music/b.mp3' && thrown++ === 0) throw new Error('onTrack 抛错')
      })
      .catch(() => [] as Track[])

    expect(notified).toEqual(['Music/a.mp3', 'Music/b.mp3', 'Music/c.mp3'])
    expect(state.inserted).toEqual(['Music/a.mp3', 'Music/b.mp3', 'Music/c.mp3'])
    // 若发生重复提交，a/b/c 会再次出现
    expect(new Set(state.inserted).size).toBe(state.inserted.length)
    void out
  })

  it('同一文件不会被解析两次（并发段按文件列表去重推进）', async () => {
    state.files = Array.from({ length: 6 }, (_, i) => `Music/t${i}.mp3`)
    const scanner = await loadScanner()
    await scanner.scanFolder(ROOT, dbDouble)
    for (const [name, count] of state.parseCount) {
      expect(count, `${name} 被解析 ${count} 次`).toBe(1)
    }
    expect(state.parseCount.size).toBe(6)
  })
})

/**
 * 渐进式刷新的**时机**回归（独立验证者抓到的 E5）。四阶段重构（查重串行屏障 →
 * 解析并发屏障 → 统一提交）曾让首条 onTrack 被推迟到「全部查重结束」之后：
 * 三个文件各 300ms 查重、解析≈0 时，首条通知从 301ms 变成 902ms，而总耗时两版相同
 * ——纯粹是通知时机后移，用户看到的是「扫描半天列表还空着」。
 *
 * 现在的实现是流水线 + 按序滚动闸门：查重仍串行，但解析一完成、且它前面的文件都已
 * 就绪，就立刻提交并通知。因此这里断言的不是「比旧版快」，而是**首条通知必须先于
 * 全部查重结束出现** —— 这条性质一旦被改回屏障式实现就会失败。
 */
describe('移动端 scanFolder：渐进式刷新时机', () => {
  /** 每个文件的查重耗时（毫秒），用于把查重拉长到可观测 */
  function slowLookups(delayOf: (name: string) => number) {
    return {
      async getTrackByPath(path: string) {
        const name = path.split('/').pop() || path
        const ms = delayOf(name)
        if (ms) await new Promise((r) => setTimeout(r, ms))
        return null
      },
      async insertTrack(track: { path: string }) {
        state.inserted.push(track.path)
      },
      async deleteTracksWithMissingFiles() {
        return 0
      },
    } as never
  }

  it('首条 onTrack 早于「全部查重结束」出现（不是等整轮查重才通知）', async () => {
    state.files = ['Music/p1.mp3', 'Music/p2.mp3', 'Music/p3.mp3']
    // 每个文件查重 300ms：全部查完需 ~900ms
    const db = slowLookups(() => 300)

    const scanner = await loadScanner()
    const t0 = Date.now()
    let firstAt = -1
    const out = await scanner.scanFolder(ROOT, db, () => {
      if (firstAt < 0) firstAt = Date.now() - t0
    })
    const total = Date.now() - t0

    expect(out).toHaveLength(3)
    expect(firstAt).toBeGreaterThanOrEqual(0)
    // 关键断言：首条通知必须远早于「三轮查重都做完」（~900ms）。
    // 屏障式实现下这里是 ~900ms，会直接失败。
    expect(firstAt).toBeLessThan(600)
    // 且确实有等待（不是同步假通知）：至少等完第一个文件的查重
    expect(firstAt).toBeGreaterThanOrEqual(250)
    // 总耗时仍由查重累加决定（流水线不改变总时长，只改变通知时机）
    expect(total).toBeGreaterThanOrEqual(850)
  })

  it('首个文件解析慢也不影响后续已就绪文件——通知严格按文件顺序滚动推进', async () => {
    state.files = ['Music/p1.mp3', 'Music/p2.mp3', 'Music/p3.mp3']
    // p1 解析很慢（400ms），p2/p3 秒回：p1 未就绪时不能越过它先通知 p2
    state.readDelay = new Map([['p1.mp3', 400]])
    const db = slowLookups(() => 0)

    const scanner = await loadScanner()
    const order: string[] = []
    const t0 = Date.now()
    const firstTimes: number[] = []
    const out = await scanner.scanFolder(ROOT, db, (t) => {
      order.push(t.path)
      firstTimes.push(Date.now() - t0)
    })

    // 顺序仍严格等于文件顺序（p1 虽是最后一个解析完，但必须先通知它）
    expect(out.map((t) => t.path)).toEqual(['Music/p1.mp3', 'Music/p2.mp3', 'Music/p3.mp3'])
    expect(order).toEqual(['Music/p1.mp3', 'Music/p2.mp3', 'Music/p3.mp3'])
    // p2/p3 的解析早已完成，却都排在 p1 之后 —— 证明闸门按序推进而非按完成序
    expect(firstTimes[0]).toBeGreaterThanOrEqual(350)
    expect(firstTimes[2] - firstTimes[0]).toBeLessThan(150)
  })

  it('已入库曲目同样在其查重完成后立即通知，不被后续文件的解析拖住', async () => {
    state.files = ['Music/old.mp3', 'Music/slow.mp3']
    state.existing.add('Music/old.mp3')
    state.readDelay = new Map([['slow.mp3', 500]])
    const db = slowLookups(() => 0)

    const scanner = await loadScanner()
    const t0 = Date.now()
    let firstAt = -1
    await scanner.scanFolder(ROOT, db, () => {
      if (firstAt < 0) firstAt = Date.now() - t0
    })
    // old.mp3 命中查重后立刻可通知，无需等 slow.mp3 那 500ms 的解析
    expect(firstAt).toBeLessThan(300)
  })
})

/**
 * 专辑封面借用的**并发等价性**（自查发现、并已修的第二个缺陷）。
 *
 * 旧实现逐文件串行，「无内嵌封面的曲目借用同专辑已有封面」这件事是**依赖文件顺序**的：
 * 同专辑里带封面那首只要排在前面就必然已登记。把它放进并发解析阶段就地查表后，
 * 后面的曲目可能比带封面那首先跑完 → 漏借 → 「同一张专辑部分曲目没封面」，
 * 而串行版是全部都有。
 *
 * 现在的实现把封面借用/登记全部收敛到**按文件顺序串行推进的提交阶段**，
 * 因此这里的断言必须与串行语义逐字一致：借用只能来自「排在自己之前」的同专辑曲目。
 */
describe('移动端 scanFolder：专辑封面借用的并发等价性', () => {
  /** 指定哪些文件自带内嵌封面（解析耗时一律用 state.readDelay，见模块级护栏） */
  function withCovers(own: string[]) {
    state.hasCover = new Set(own)
  }

  const coversOf = (out: Array<{ path: string; coverPath?: string }>) =>
    out.map((t) => [t.path.split('/').pop(), t.coverPath ? 'has' : 'none'])

  it('同一专辑：无封面曲目借用「排在自己之前」那首的封面（与串行语义一致）', async () => {
    // 顺序：a（自带封面）、b（无）、c（无）。b/c 必须借到 a 的封面。
    state.files = ['Music/a.mp3', 'Music/b.mp3', 'Music/c.mp3']
    withCovers(['a.mp3'])

    const scanner = await loadScanner()
    const out = await scanner.scanFolder(ROOT, dbDouble)

    const byName = new Map(out.map((t) => [t.path, t.coverPath]))
    expect(byName.get('Music/a.mp3')).toBeTruthy()
    expect(byName.get('Music/b.mp3')).toBe(byName.get('Music/a.mp3'))
    expect(byName.get('Music/c.mp3')).toBe(byName.get('Music/a.mp3'))
  })

  it('带封面那首排在最后时，前面的曲目不借（串行版同样借不到）——借用只向后生效', async () => {
    // 顺序：x（无）、y（无）、z（自带封面）。串行版里 x/y 先处理，表里还没有封面 → 不借。
    state.files = ['Music/x.mp3', 'Music/y.mp3', 'Music/z.mp3']
    withCovers(['z.mp3'])

    const scanner = await loadScanner()
    const out = await scanner.scanFolder(ROOT, dbDouble)

    const byName = new Map(out.map((t) => [t.path, t.coverPath]))
    expect(byName.get('Music/x.mp3')).toBeUndefined()
    expect(byName.get('Music/y.mp3')).toBeUndefined()
    expect(byName.get('Music/z.mp3')).toBeTruthy()
  })

  it('关键：带封面那首**解析最慢**时仍必须被后面的曲目借到（并发不改变借用结果）', async () => {
    // a 自带封面但解析要 300ms；b 秒回。若封面逻辑留在并发解析段就地查表，
    // b 会在 a 登记之前跑完 → 借不到；提交阶段按序推进则必然借到。
    state.files = ['Music/a.mp3', 'Music/b.mp3']
    withCovers(['a.mp3'])
    state.readDelay = new Map([['a.mp3', 300]])

    const scanner = await loadScanner()
    const out = await scanner.scanFolder(ROOT, dbDouble)

    const byName = new Map(out.map((t) => [t.path, t.coverPath]))
    expect(byName.get('Music/a.mp3')).toBeTruthy()
    expect(byName.get('Music/b.mp3')).toBe(byName.get('Music/a.mp3'))
  })

  it('不同专辑互不串用封面', async () => {
    state.files = ['Music/a1.mp3', 'Music/a2.mp3', 'Music/b1.mp3', 'Music/b2.mp3']
    // 通过 overload 让不同文件落在不同专辑：这里用文件名前缀区分专辑
    state.albumOf = (name) => (name.startsWith('a') ? '专辑A' : '专辑B')
    withCovers(['a1.mp3', 'b1.mp3'])

    const scanner = await loadScanner()
    const out = await scanner.scanFolder(ROOT, dbDouble)

    const byName = new Map(out.map((t) => [t.path, t.coverPath]))
    expect(byName.get('Music/a2.mp3')).toBe(byName.get('Music/a1.mp3'))
    expect(byName.get('Music/b2.mp3')).toBe(byName.get('Music/b1.mp3'))
    expect(byName.get('Music/a2.mp3')).not.toBe(byName.get('Music/b1.mp3'))
  })

  it('关键构造 C13：带封面那首排最后且解析**最快**时，前面的曲目仍不借（证伪「解析段登记」）', async () => {
    // 独立验证者用这条构造证伪了我一次错误的自查结论 —— 它是唯一能区分
    // 「封面登记放在并发解析段」与「登记放在按序提交段」的用例：
    //
    //   a 无封面（解析慢 200ms）、b 有封面（解析快 0ms）。
    //
    // - 若登记发生在**解析段**：b 解析完就把封面写进复用表 → a 稍后解析完时
    //   表里已有 b 的封面 → **a 借到后面曲目的封面**（向前借用，HEAD 绝不可能）。
    // - 正确实现里 a 在提交时表里还没有 b（a 的解析更慢，提交序仍是 a→b），故 a 无封面。
    //
    // 注意：现有「带封面那首解析最慢仍须被借到」那条用的是「封面在后、解析**慢**」，
    // 两种实现都会让后面的曲目借到，因此区分不了登记位置。
    state.files = ['Music/a.mp3', 'Music/b.mp3']
    withCovers(['b.mp3'])
    state.readDelay = new Map([['a.mp3', 200]])

    const scanner = await loadScanner()
    const out = await scanner.scanFolder(ROOT, dbDouble)

    // ── 自证构造前提（这一步是本用例的防假绿核心） ──
    // 本用例的区分力**完全依赖**「带封面的 b 先于 a 解析完」。这一条曾因把延迟打在
    // 不生效的 coverDelay 上而静默失效，导致用例全绿却什么都没验证到（实际测出：
    // 「解析段登记」错法照样 21/21 通过）。所以这里不由人眼保证方向，而是直接断言
    // 观测到的完成序号 —— 一旦构造写反，下一步就会红在这里，而不是悄悄放过错法。
    const doneA = state.parseDoneSeq.get('a.mp3')
    const doneB = state.parseDoneSeq.get('b.mp3')
    expect(doneA).toBeDefined()
    expect(doneB).toBeDefined()
    expect(
      doneB!,
      `C13 构造失效：带封面的 b 必须比 a 先解析完，否则本用例无法区分「解析段登记」。` +
        `实测完成序号 a=${doneA} b=${doneB}（数值越小越早）。`
    ).toBeLessThan(doneA!)

    const byName = new Map(out.map((t) => [t.path, t.coverPath]))
    // a 排在 b 前面（提交序靠前），且 a 解析更晚 —— 无论按哪种标准，a 都不该拿到 b 的封面
    expect(byName.get('Music/a.mp3')).toBeUndefined()
    expect(byName.get('Music/b.mp3')).toBeTruthy()
  })

  it('自带封面但落盘失败：既不登记也不借用（与 HEAD 的 if/else-if 分支走向一致）', async () => {
    // 三个同专辑文件，构造必须让「借用与否」真的产生可观测差异：
    //   z.mp3 自带封面且**成功**落盘 → 登记进复用表（这一步提供「表里已有封面」的前提）
    //   a.mp3 自带封面但落盘**失败** → HEAD 语义下既不登记也不借用
    //   b.mp3 无封面                → 正常借用，应拿到 z 的封面
    //
    // 期望（与 HEAD 一致）：z 有封面、a 无封面、b 借到 z 的封面。
    // 若把 a 的落盘失败降级为「视同无自有封面 → 允许借用」，a 会错误地拿到 z 的封面
    // （a 排在 z 之后，表里已有 z），那时 a 为有封面 —— 用例即失败。
    // 注意：若表里没有任何封面（没有 z），两种实现都会让 a 无封面，用例就没有区分力。
    state.files = ['Music/z.mp3', 'Music/a.mp3', 'Music/b.mp3']
    withCovers(['z.mp3', 'a.mp3'])
    state.coverWriteFails.add('a.mp3')

    const scanner = await loadScanner()
    const out = await scanner.scanFolder(ROOT, dbDouble)

    const byName = new Map(out.map((t) => [t.path, t.coverPath]))
    expect(byName.get('Music/z.mp3')).toBeTruthy()
    // 关键：a 不得借用 z 的封面
    expect(byName.get('Music/a.mp3')).toBeUndefined()
    // b 正常借用 z 的封面（确认复用表本身工作正常，不是「整表没生效」）
    expect(byName.get('Music/b.mp3')).toBe(byName.get('Music/z.mp3'))
  })
})