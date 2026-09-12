# 歌单导入功能实施计划（简化版）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Aurora Music 添加歌单导入功能：粘贴其他平台的歌单（分享链接或纯文本）→ 解析出歌曲清单 → 本地曲库有就用本地、没有就用用户配置的歌源搜索结果直接展示在歌单里（不下载）。

**Architecture:** 两步走。①解析：分享链接走用户自配置的「歌单解析源」（`{url}` 占位符协议，与现有音乐源/歌词源同一架构），纯文本本地解析兜底；②匹配：按归一化标题+歌手匹配本地曲库，未命中的经用户配置的音乐源搜索取最佳结果，转成在线曲目直接进歌单展示。在线曲目元数据持久化在 playlistStore（跨重启可展示），播放地址会过期不落盘，点击播放时按需重新搜索一次即可。

**Tech Stack:** TypeScript / React 18 / Zustand 5 (persist) / Radix Dialog / Tailwind / @aurora/shared 协议执行器 / Vitest（新增，仅测 shared 纯逻辑）

**不动的部分：** platform 抽象层、桌面端 IPC / preload、audio.service、playerStore —— 播放复用现有 `track.onlineUrl || track.path` 机制，只在歌单页播放入口前做一次按需取址。

**法律风险控制:**
1. 应用不内置任何平台的歌单抓取器、不调用任何音乐平台接口——链接解析能力由用户自行配置的「歌单解析源」提供（与项目「移除内置源」的法律设计一致）；
2. 纯文本导入零网络请求，开箱即用；
3. 在线补齐只复用用户已配置的音乐源，只展示不下载；
4. 导入对话框含合规说明：仅处理歌名/歌手等元数据。

---

## 关键既有事实（实现者必读）

- **歌单模型**：[Playlist](file:///c:/code/aurora-music/packages/app/src/types/index.ts#L60-L66) 只存 `trackIds`；[playlistStore](file:///c:/code/aurora-music/packages/app/src/stores/playlistStore.ts) persist key `aurora-playlists-state`。
- **曲库不跨重启持久化**：启动时 `platform.getAllTracks()` 整体覆盖 `libraryStore.tracks`，所以导入的在线曲目必须放独立切片（`playlistStore.importedTracks`），不能进曲库。
- **在线搜索**：`platform.searchOnlineTracks(query, { sources, quality })`，歌源配置在 `libraryStore.onlineSources`；结果类型 `OnlineTrackSearchResult`（含 `audioUrl/coverUrl/qualityUrls/source/sourceName`）。
- **播放取流**：[audio.service.ts:84](file:///c:/code/aurora-music/packages/app/src/services/audio.service.ts#L84) `track.onlineUrl || track.path`——只要 Track 对象带 `onlineUrl` 就能播，无需任何管道改造。
- **在线曲目转 Track 的既有范式**：[SearchOverlay.tsx:393-411](file:///c:/code/aurora-music/packages/app/src/components/SearchOverlay.tsx#L393-L411)。
- **UI 模式**：[toast()](file:///c:/code/aurora-music/packages/app/src/components/common/Toast.tsx#L35-L47) 模块级调用；[dialog.tsx](file:///c:/code/aurora-music/packages/app/src/components/ui/dialog.tsx) 玻璃风；设置页源管理范式 [SettingsPage](file:///c:/code/aurora-music/packages/app/src/pages/SettingsPage.tsx#L27-L309)。
- **验证命令**：
  - `pnpm --filter @aurora/shared test`
  - `pnpm --filter @aurora/shared build`（app/desktop 的 types 指向 shared/dist，改 shared 后必须先构建）
  - `pnpm --filter @aurora/app exec tsc --noEmit`
  - `pnpm --filter @aurora/desktop typecheck`
- **PowerShell 5**：禁止 `&&`（用 `;`）；禁止 heredoc；提交信息用 Write 写临时文件 + `git commit -F .git/COMMIT_MSG_TMP`；提交后 `git log -1 --stat` 验证（历史教训：PS5 曾静默吞提交）。

---

## Task 1: shared — Vitest 基础设施 + 协议类型 + 文本解析/本地匹配（TDD）

**Files:**
- Modify: `packages/shared/package.json`、`packages/shared/tsconfig.json`、`packages/shared/src/types.ts`、`packages/shared/src/index.ts`
- Create: `packages/shared/vitest.config.ts`、`packages/shared/src/importMatch.ts`、`packages/shared/src/__tests__/importMatch.test.ts`

- [ ] **Step 1: 安装 vitest**

```powershell
pnpm --filter @aurora/shared add -D vitest
```

- [ ] **Step 2: packages/shared/package.json scripts 增加**

```json
    "test": "vitest run"
```

- [ ] **Step 3: 创建 packages/shared/vitest.config.ts**

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['src/**/*.test.ts'],
  },
})
```

- [ ] **Step 4: packages/shared/tsconfig.json 增加 vitest globals 类型**

`compilerOptions` 中 `"sourceMap": false` 之后追加一行：

```json
    "types": ["vitest/globals"]
```

- [ ] **Step 5: packages/shared/src/types.ts 末尾追加歌单导入协议类型**

```ts
// ─── 歌单导入协议 ─────────────────────────────────────────────
// 应用不内置任何平台的歌单抓取器：分享链接解析由用户按协议配置的
// 「歌单解析源」完成（与音乐源/歌词源同一免责架构）；纯文本导入则
// 完全在本地解析、零网络请求。

/** 歌单解析源配置：把歌单分享链接解析为歌曲元数据列表 */
export interface PlaylistResolverConfig {
  id: string
  name: string
  /**
   * 解析接口地址，需包含 {url} 占位符（调用时替换为 URL 编码后的歌单链接）。
   * 响应需为 JSON，支持数组或 { results:[] } / { data:[] } / { songs:[] } / { list:[] } 包裹；
   * 可选 name 字段提供歌单标题。
   * 每项字段（宽松兼容）：title / name / songName；artist / singer / artists
   */
  apiUrl: string
  /** 附加请求头（如鉴权 Token），同名头覆盖默认值 */
  headers?: Record<string, string>
  enabled: boolean
}

/** 导入流程中解析出的单首歌曲（仅元数据，不含任何音频地址） */
export interface ParsedSong {
  title: string
  artist: string
}

/** 歌单解析源的解析结果 */
export interface PlaylistParseResult {
  /** 歌单标题（源未提供时为空字符串） */
  name: string
  songs: ParsedSong[]
}
```

- [ ] **Step 6: packages/shared/src/index.ts 类型导出块追加三个类型**

```ts
export type {
  OnlineSourceConfig,
  OnlineSearchOptions,
  OnlineTrackSearchResult,
  DownloadQuality,
  LyricsSourceConfig,
  LyricsSearchOptions,
  LyricsSearchResult,
  PlaylistResolverConfig,
  ParsedSong,
  PlaylistParseResult,
} from './types'
```

- [ ] **Step 7: 写失败测试 packages/shared/src/__tests__/importMatch.test.ts**

```ts
import {
  normalizeName,
  parsePlaylistText,
  artistScore,
  scoreOnlineResult,
  matchTracksByNames,
} from '../importMatch'
import type { OnlineTrackSearchResult } from '../types'

describe('normalizeName', () => {
  it('去除空白并转小写', () => {
    expect(normalizeName('  Hotel California  ')).toBe('hotelcalifornia')
  })
  it('去除括号内的版本/备注说明', () => {
    expect(normalizeName('七里香 (Live)')).toBe('七里香')
    expect(normalizeName('七里香（伴奏）')).toBe('七里香')
  })
  it('全角转半角并去掉标点', () => {
    expect(normalizeName('ＮＥＷ　ＷＯＲＬＤ！')).toBe('newworld')
  })
  it('空串返回空串', () => {
    expect(normalizeName('   ')).toBe('')
  })
})

describe('parsePlaylistText', () => {
  it('解析「歌名 - 歌手」行', () => {
    const songs = parsePlaylistText('七里香 - 周杰伦\n晴天-周杰伦')
    expect(songs).toEqual([
      { title: '七里香', artist: '周杰伦' },
      { title: '晴天', artist: '周杰伦' },
    ])
  })
  it('剥离序号前缀（1. / 02、）', () => {
    const songs = parsePlaylistText('1. 七里香 - 周杰伦\n02、晴天 - 周杰伦')
    expect(songs.map((s) => s.title)).toEqual(['七里香', '晴天'])
  })
  it('无歌手分隔符时 artist 为空（只按标题匹配）', () => {
    expect(parsePlaylistText('七里香')).toEqual([{ title: '七里香', artist: '' }])
  })
  it('跳过空行与 URL 行', () => {
    const songs = parsePlaylistText('\nhttps://music.163.com/playlist?id=1\n晴天 - 周杰伦\n')
    expect(songs).toEqual([{ title: '晴天', artist: '周杰伦' }])
  })
  it('限制最多 1000 首，防止误粘超大文本', () => {
    const text = Array.from({ length: 1200 }, (_, i) => `歌${i} - 某人`).join('\n')
    expect(parsePlaylistText(text).length).toBe(1000)
  })
})

describe('打分函数', () => {
  it('artistScore：一方为空视为未知，返回中性分', () => {
    expect(artistScore('', '周杰伦')).toBe(0.5)
    expect(artistScore('周杰伦', '')).toBe(0.5)
  })
  it('artistScore：包含关系得高分', () => {
    expect(artistScore('周杰伦', '周杰伦/温岚')).toBeGreaterThan(0.8)
  })
  it('scoreOnlineResult：标题不达标直接 0', () => {
    const r: OnlineTrackSearchResult = {
      id: 's-1', title: '夜曲', artist: '周杰伦', album: '', duration: 0,
      audioUrl: 'https://x/a.mp3', source: 's', sourceName: 's',
    }
    expect(scoreOnlineResult(r, { title: '七里香', artist: '周杰伦' })).toBe(0)
  })
  it('scoreOnlineResult：标题+歌手匹配得高分', () => {
    const r: OnlineTrackSearchResult = {
      id: 's-1', title: '七里香', artist: '周杰伦', album: '', duration: 0,
      audioUrl: 'https://x/a.mp3', source: 's', sourceName: 's',
    }
    expect(scoreOnlineResult(r, { title: '七里香', artist: '周杰伦' })).toBeGreaterThan(1)
  })
})

describe('matchTracksByNames', () => {
  const tracks = [
    { id: 't1', title: '七里香', artist: '周杰伦' },
    { id: 't2', title: '七里香', artist: '其他歌手' },
    { id: 't3', title: '晴天', artist: '周杰伦' },
  ].map((t) => ({ ...t, path: '', album: '', duration: 0, addedAt: 0, playCount: 0, liked: false }))

  it('标题+歌手精确匹配', () => {
    const res = matchTracksByNames([{ title: '七里香', artist: '周杰伦' }], tracks)
    expect(res.map((t) => t?.id)).toEqual(['t1'])
  })
  it('括号备注不影响匹配', () => {
    const res = matchTracksByNames([{ title: '晴天（Live）', artist: '周杰伦' }], tracks)
    expect(res.map((t) => t?.id)).toEqual(['t3'])
  })
  it('未匹配返回 null 占位', () => {
    expect(matchTracksByNames([{ title: '不存在的歌', artist: '' }], tracks)).toEqual([null])
  })
  it('同一首本地歌不会被两行重复占用', () => {
    const res = matchTracksByNames(
      [{ title: '晴天', artist: '周杰伦' }, { title: '晴天', artist: '周杰伦' }],
      tracks
    )
    expect(res[0]?.id).toBe('t3')
    expect(res[1]).toBeNull()
  })
})
```

- [ ] **Step 8: 运行测试验证失败**

```powershell
pnpm --filter @aurora/shared test
```

预期：失败（`../importMatch` 不存在）。

- [ ] **Step 9: 实现 packages/shared/src/importMatch.ts**

```ts
import type { OnlineTrackSearchResult, ParsedSong } from './types'

/**
 * 歌单导入的文本解析与匹配逻辑（纯函数，双端共用，可单测）。
 * 法律边界：本模块只处理歌名/歌手等元数据文本，不访问任何平台接口。
 */

/** 单次导入的歌曲行数上限，防止误粘超大文本拖垮 UI 与搜索 */
export const MAX_IMPORT_SONGS = 1000

/**
 * 名称归一化：小写、全角转半角、去括号内备注（(Live)/(伴奏) 等）、
 * 只保留字母/数字/中日韩文字，用于跨平台的宽松比较
 */
export function normalizeName(raw: string): string {
  return (raw || '')
    .toLowerCase()
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/\u3000/g, ' ')
    .replace(/[（(][^（()）]*[)）]/g, '')
    .replace(/[^\p{L}\p{N}]/gu, '')
}

/**
 * 解析用户粘贴的纯文本歌单，每行一首「歌名 - 歌手」；
 * 无歌手的行只按标题匹配；自动剥离「1.」「01、」等序号前缀；跳过空行与 URL 行
 */
export function parsePlaylistText(text: string): ParsedSong[] {
  const songs: ParsedSong[] = []
  for (const rawLine of (text || '').split(/\r?\n/)) {
    if (songs.length >= MAX_IMPORT_SONGS) break
    let line = rawLine.trim()
    if (!line) continue
    if (/^https?:\/\//i.test(line)) continue
    // 剥离序号前缀：1. / 01、/ 1) / 01：
    line = line.replace(/^\s*\d{1,3}\s*[.、)）:：]\s*/, '').trim()
    if (!line) continue
    const m = line.match(/^(.+?)\s+[-–—]\s+(.+)$/) || line.match(/^(.+?)\s*[-–—]\s*(.+)$/)
    if (m && m[1].trim() && m[2].trim()) {
      songs.push({ title: m[1].trim(), artist: m[2].trim() })
    } else {
      songs.push({ title: line, artist: '' })
    }
  }
  return songs
}

/** Sørensen–Dice 二元组相似度：0~1，完全相同为 1 */
function similarity(a: string, b: string): number {
  if (!a || !b) return 0
  if (a === b) return 1
  const gramsOf = (s: string): Set<string> => {
    const grams = new Set<string>()
    if (s.length === 1) {
      grams.add(s)
      return grams
    }
    for (let i = 0; i < s.length - 1; i++) grams.add(s.slice(i, i + 2))
    return grams
  }
  const ga = gramsOf(a)
  const gb = gramsOf(b)
  let inter = 0
  for (const g of ga) if (gb.has(g)) inter++
  return (2 * inter) / (ga.size + gb.size)
}

/** 标题相似度（先归一化），包含关系视为高度相似 */
export function titleScore(titleA: string, titleB: string): number {
  const a = normalizeName(titleA)
  const b = normalizeName(titleB)
  if (!a || !b) return 0
  if (a === b) return 1
  if (a.includes(b) || b.includes(a)) return Math.max(0.9, similarity(a, b))
  return similarity(a, b)
}

/**
 * 歌手相似度（先归一化）。任一方为空视为「未知」返回中性分 0.5：
 * 导入文本缺歌手时不惩罚结果，但也不加分
 */
export function artistScore(artistA: string, artistB: string): number {
  const a = normalizeName(artistA)
  const b = normalizeName(artistB)
  if (!a || !b) return 0.5
  if (a === b) return 1
  if (a.includes(b) || b.includes(a)) return 0.9
  return similarity(a, b)
}

/** 在线结果匹配阈值：标题相似度低于此值直接淘汰 */
export const TITLE_THRESHOLD = 0.82

/**
 * 在线搜索结果与目标歌曲的匹配总分：标题不达标直接 0，
 * 达标后总分 = 标题分 + 歌手分（满分 2，≥1.4 视为可靠匹配）
 */
export function scoreOnlineResult(result: OnlineTrackSearchResult, song: ParsedSong): number {
  const ts = titleScore(result.title, song.title)
  if (ts < TITLE_THRESHOLD) return 0
  return ts + artistScore(result.artist, song.artist)
}

/**
 * 把解析出的歌曲与本地曲库匹配：按归一化标题建索引，歌手归一化相等优先。
 * 返回与输入等长的数组，未匹配位置为 null；每首本地歌只会被占用一次
 */
export function matchTracksByNames<T extends { id: string; title: string; artist: string }>(
  songs: ParsedSong[],
  tracks: T[]
): Array<T | null> {
  const byTitle = new Map<string, T[]>()
  for (const t of tracks) {
    const key = normalizeName(t.title)
    if (!key) continue
    const list = byTitle.get(key)
    if (list) list.push(t)
    else byTitle.set(key, [t])
  }
  const used = new Set<string>()
  return songs.map((song) => {
    const candidates = byTitle.get(normalizeName(song.title))
    if (!candidates) return null
    const wantArtist = normalizeName(song.artist)
    for (const t of candidates) {
      if (used.has(t.id)) continue
      if (!wantArtist || normalizeName(t.artist) === wantArtist) {
        used.add(t.id)
        return t
      }
    }
    // 歌手不匹配/导入文本无歌手：标题命中也接受（取第一个未占用的）
    for (const t of candidates) {
      if (used.has(t.id)) continue
      used.add(t.id)
      return t
    }
    return null
  })
}
```

- [ ] **Step 10: 运行测试验证通过并构建**

```powershell
pnpm --filter @aurora/shared test
pnpm --filter @aurora/shared build
```

预期：测试全绿、构建成功。

- [ ] **Step 11: index.ts 导出匹配函数并提交**

`packages/shared/src/index.ts` 末尾追加：

```ts
export {
  normalizeName,
  parsePlaylistText,
  titleScore,
  artistScore,
  scoreOnlineResult,
  matchTracksByNames,
  MAX_IMPORT_SONGS,
  TITLE_THRESHOLD,
} from './importMatch'
```

用 Write 写 `.git/COMMIT_MSG_TMP`：

```
feat(shared): vitest 基础设施 + 歌单导入协议类型与匹配逻辑

新增歌单解析源协议类型、歌单文本解析、名称归一化与
Dice 相似度匹配纯函数（带单测）；应用不内置任何平台源
```

```powershell
git add packages/shared
git add pnpm-lock.yaml
git commit -F .git/COMMIT_MSG_TMP
git log -1 --stat
```

---

## Task 2: shared — 歌单解析源协议执行器（TDD）

**Files:**
- Create: `packages/shared/src/playlistResolver.ts`、`packages/shared/src/__tests__/playlistResolver.test.ts`
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: 写失败测试 packages/shared/src/__tests__/playlistResolver.test.ts**

```ts
import { extractShareUrl } from '../playlistResolver'

describe('extractShareUrl', () => {
  it('从纯链接文本提取', () => {
    expect(extractShareUrl('https://music.163.com/playlist?id=123')).toBe(
      'https://music.163.com/playlist?id=123'
    )
  })
  it('从分享文案中提取第一个链接', () => {
    const text = '分享周杰伦创建的歌单「七里香」：https://music.163.com/playlist?id=123 (来自网易云音乐)'
    expect(extractShareUrl(text)).toBe('https://music.163.com/playlist?id=123')
  })
  it('无链接返回 null', () => {
    expect(extractShareUrl('七里香 - 周杰伦')).toBeNull()
  })
})
```

- [ ] **Step 2: 运行测试验证失败**

```powershell
pnpm --filter @aurora/shared test
```

预期：playlistResolver 相关用例失败（模块不存在）。

- [ ] **Step 3: 实现 packages/shared/src/playlistResolver.ts**

```ts
import type { PlaylistResolverConfig, PlaylistParseResult, ParsedSong } from './types'
import { fetchWithTimeout } from './fetchWithTimeout'

/**
 * 歌单解析源协议执行器（与音乐源/歌词源同一架构）：
 * 应用不内置任何平台的歌单抓取逻辑，解析能力由用户自行配置的接口提供。
 */

const DEFAULT_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'application/json',
}

/** 从粘贴文本中提取第一个 http/https 链接（分享文案通常夹带描述文字） */
export function extractShareUrl(text: string): string | null {
  const m = (text || '').match(/https?:\/\/[^\s，。！？;；'")）\]】]+/i)
  return m ? m[0] : null
}

/** 从响应 JSON 中容错提取歌曲条目数组（与音乐源相同的包裹兼容策略） */
function extractItems(json: any): any[] {
  if (Array.isArray(json)) return json
  if (json && typeof json === 'object') {
    if (Array.isArray(json.results)) return json.results
    if (Array.isArray(json.data)) return json.data
    if (Array.isArray(json.songs)) return json.songs
    if (Array.isArray(json.list)) return json.list
    if (json.data && typeof json.data === 'object' && Array.isArray(json.data.songs)) return json.data.songs
  }
  return []
}

/** 单条目容错转 ParsedSong；无标题返回 null */
function toSong(item: any): ParsedSong | null {
  if (!item || typeof item !== 'object') return null
  const title = item.title || item.name || item.songName
  if (!title || typeof title !== 'string') return null
  let artist: any = item.artist || item.singer || ''
  if (Array.isArray(artist)) artist = artist.map((a: any) => (typeof a === 'string' ? a : a?.name || '')).join('/')
  return { title: String(title).trim(), artist: String(artist || '').trim() }
}

/**
 * 用单个解析源解析歌单分享链接：
 * apiUrl 中 {url} 占位符替换为 URL 编码后的链接；响应宽松解析，
 * 可选 name 字段作为歌单标题。解析不出任何歌曲时抛错
 */
export async function resolvePlaylistUrl(
  source: PlaylistResolverConfig,
  shareUrl: string
): Promise<PlaylistParseResult> {
  if (!source.apiUrl || !source.apiUrl.includes('{url}')) {
    throw new Error(`解析源「${source.name}」的接口地址无效，必须包含 {url} 占位符`)
  }
  const url = source.apiUrl.replace('{url}', encodeURIComponent(shareUrl))
  const resp = await fetchWithTimeout(
    url,
    { headers: { ...DEFAULT_HEADERS, ...(source.headers || {}) } },
    15000
  )
  if (!resp.ok) throw new Error(`解析源「${source.name}」返回 HTTP ${resp.status}`)
  const json = (await resp.json()) as any

  const songs: ParsedSong[] = []
  for (const item of extractItems(json)) {
    const song = toSong(item)
    if (song) songs.push(song)
  }
  if (songs.length === 0) {
    throw new Error(`解析源「${source.name}」未返回任何歌曲`)
  }
  const name =
    typeof json?.name === 'string' && json.name.trim()
      ? json.name.trim()
      : typeof json?.data?.name === 'string' && json.data.name.trim()
        ? json.data.name.trim()
        : ''
  return { name, songs }
}

/**
 * 聚合解析：按配置顺序依次尝试启用的解析源，第一个成功即返回；
 * 全部失败时抛最后一个错误（前端展示直白的中文提示）
 */
export async function parsePlaylistLink(
  sources: PlaylistResolverConfig[],
  shareUrl: string
): Promise<PlaylistParseResult> {
  const enabled = (sources || []).filter((s) => s && s.enabled && s.apiUrl)
  if (enabled.length === 0) {
    throw new Error('尚未配置歌单解析源，请在「设置 → 在线搜索」中添加，或改用纯文本粘贴导入')
  }
  let lastError: unknown = null
  for (const source of enabled) {
    try {
      return await resolvePlaylistUrl(source, shareUrl)
    } catch (err) {
      lastError = err
      console.warn(`[歌单解析] 「${source.name}」解析失败:`, err)
    }
  }
  throw lastError instanceof Error ? lastError : new Error('歌单解析失败')
}
```

- [ ] **Step 4: 运行测试验证通过**

```powershell
pnpm --filter @aurora/shared test
```

预期：全部通过。

- [ ] **Step 5: 导出、构建并提交**

`packages/shared/src/index.ts` 末尾追加：

```ts
export { extractShareUrl, resolvePlaylistUrl, parsePlaylistLink } from './playlistResolver'
```

```powershell
pnpm --filter @aurora/shared build
```

用 Write 写 `.git/COMMIT_MSG_TMP`：

```
feat(shared): 歌单解析源协议执行器

链接提取与宽松 JSON 解析；解析能力由用户按协议自行配置，
应用不内置任何平台抓取器
```

```powershell
git add packages/shared/src
git commit -F .git/COMMIT_MSG_TMP
git log -1 --stat
```

---

## Task 3: app 类型转发 + libraryStore 歌单解析源配置

**Files:**
- Modify: `packages/app/src/types/index.ts`、`packages/app/src/stores/libraryStore.ts`

- [ ] **Step 1: packages/app/src/types/index.ts 转发新类型**

文件开头两个块改为：

```ts
import type {
  OnlineSourceConfig,
  OnlineSearchOptions,
  OnlineTrackSearchResult,
  DownloadQuality,
  LyricsSourceConfig,
  LyricsSearchOptions,
  LyricsSearchResult,
  PlaylistResolverConfig,
  ParsedSong,
  PlaylistParseResult,
} from '@aurora/shared'

export type {
  OnlineSourceConfig,
  OnlineSearchOptions,
  OnlineTrackSearchResult,
  DownloadQuality,
  LyricsSourceConfig,
  LyricsSearchOptions,
  LyricsSearchResult,
  PlaylistResolverConfig,
  ParsedSong,
  PlaylistParseResult,
}
```

- [ ] **Step 2: packages/app/src/stores/libraryStore.ts 增加解析源状态与操作**

（a）`LibraryState` 接口中 `lyricsSources: LyricsSourceConfig[]` 之后追加：

```ts
  /** 歌单解析源配置（应用不内置任何平台抓取器，全部由用户按协议配置） */
  playlistResolverSources: PlaylistResolverConfig[]
```

`removeLyricsSource` 声明之后追加：

```ts
  // 歌单解析源配置操作
  addPlaylistResolverSource: (source: Omit<PlaylistResolverConfig, 'id'>) => void
  updatePlaylistResolverSource: (id: string, updates: Partial<PlaylistResolverConfig>) => void
  removePlaylistResolverSource: (id: string) => void
```

（b）初始状态 `lyricsSources: [],` 之后追加：

```ts
      playlistResolverSources: [],
```

（c）`removeLyricsSource` 实现之后追加实现（id 规则与现有源一致）：

```ts
      addPlaylistResolverSource: (source) => {
        const id = `plr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        set({ playlistResolverSources: [...get().playlistResolverSources, { ...source, id }] })
      },
      updatePlaylistResolverSource: (id, updates) => {
        set({
          playlistResolverSources: get().playlistResolverSources.map((s) =>
            s.id === id ? { ...s, ...updates } : s
          ),
        })
      },
      removePlaylistResolverSource: (id) => {
        set({ playlistResolverSources: get().playlistResolverSources.filter((s) => s.id !== id) })
      },
```

（d）`partialize` 中 `lyricsSources: state.lyricsSources,` 之后追加：

```ts
        playlistResolverSources: state.playlistResolverSources,
```

（e）`version: 4` 改为 `version: 5`；`migrate` 内最前面追加 v5 迁移，并把版本注释补一行：

```ts
      // v5 新增歌单解析源配置（歌单导入功能）
      migrate: (persisted: any, version: number) => {
        if (persisted) {
          if (version < 5) {
            if (!Array.isArray(persisted.playlistResolverSources)) persisted.playlistResolverSources = []
          }
          if (version < 4) {
            delete persisted.downloadQuality
          }
          if (version < 3) {
            delete persisted.useNeteaseSources
            delete persisted.useQQSources
            if (!Array.isArray(persisted.lyricsSources)) persisted.lyricsSources = []
          }
          if (version < 2 && persisted.useBuiltinSources !== undefined) {
            delete persisted.useBuiltinSources
          }
        }
        return persisted
      },
      version: 5,
```

- [ ] **Step 3: 类型检查**

```powershell
pnpm --filter @aurora/app exec tsc --noEmit
```

预期：通过。

- [ ] **Step 4: 提交**

用 Write 写 `.git/COMMIT_MSG_TMP`：

```
feat(app): libraryStore 持久化歌单解析源配置

persist version 4→5：新增 playlistResolverSources 及增删改操作，
旧数据迁移补空数组
```

```powershell
git add packages/app/src/types/index.ts packages/app/src/stores/libraryStore.ts
git commit -F .git/COMMIT_MSG_TMP
git log -1 --stat
```

---

## Task 4: 设置页「歌单解析源」管理 UI + 协议说明

**Files:**
- Modify: `packages/app/src/pages/SettingsPage.tsx`

复用现有 `SourceEditorCard` 与 `SourceAddDialog`，只加数据接线、源区块与协议说明。

- [ ] **Step 1: SourceAddDialog 支持 playlist kind**

在 [SettingsPage.tsx](file:///c:/code/aurora-music/packages/app/src/pages/SettingsPage.tsx#L170-L309) `SourceAddDialog` 中：

（a）props 的 `kind: 'music' | 'lyrics'` 改为：

```ts
  kind: 'music' | 'lyrics' | 'playlist'
```

（b）函数体内：

```ts
  const isLyrics = kind === 'lyrics'
  const requiredPlaceholders = isLyrics ? ['{track}', '{artist}'] : ['{query}']
```

改为：

```ts
  const isLyrics = kind === 'lyrics'
  const isPlaylist = kind === 'playlist'
  const requiredPlaceholders = isPlaylist ? ['{url}'] : isLyrics ? ['{track}', '{artist}'] : ['{query}']
```

（c）`handleSave` 中 `name: name.trim() || (isLyrics ? '新歌词源' : '新音乐源'),` 改为：

```ts
      name: name.trim() || (isPlaylist ? '新歌单解析源' : isLyrics ? '新歌词源' : '新音乐源'),
```

（d）`DialogTitle` 改为：

```tsx
          <DialogTitle className="text-white text-tagline">
            {isPlaylist ? '添加歌单解析源' : isLyrics ? '添加歌词源' : '添加音乐源'}
          </DialogTitle>
```

（e）`DialogDescription` 改为：

```tsx
          <DialogDescription className="font-text text-caption text-white/60">
            {isPlaylist
              ? '接口地址需包含 {url} 占位符（替换为歌单分享链接），保存后立即生效'
              : isLyrics
                ? '接口地址需包含 {track} 与 {artist} 占位符，保存后立即生效'
                : '接口地址需包含 {query} 占位符，保存后立即生效'}
          </DialogDescription>
```

（f）名称输入框 placeholder 改为：

```tsx
              placeholder={isPlaylist ? '如：我的歌单解析接口' : isLyrics ? '如：LRCLIB' : '如：我的音乐接口'}
```

（g）接口地址输入框 placeholder 改为：

```tsx
              placeholder={
                isPlaylist
                  ? 'https://your-api.com/resolve?url={url}'
                  : isLyrics
                    ? 'https://lrclib.net/api/search?track_name={track}&artist_name={artist}'
                    : 'https://your-api.com/search?q={query}'
              }
```

- [ ] **Step 2: SettingsPage 主组件接线**

`removeLyricsSource` 订阅之后追加：

```ts
  // 歌单解析源（歌单导入：应用不内置任何平台抓取器，解析接口由用户按协议配置）
  const playlistResolverSources = useLibraryStore((s) => s.playlistResolverSources)
  const addPlaylistResolverSource = useLibraryStore((s) => s.addPlaylistResolverSource)
  const updatePlaylistResolverSource = useLibraryStore((s) => s.updatePlaylistResolverSource)
  const removePlaylistResolverSource = useLibraryStore((s) => s.removePlaylistResolverSource)
```

`const [addLyricsOpen, setAddLyricsOpen] = useState(false)` 之后追加：

```ts
  const [addPlaylistOpen, setAddPlaylistOpen] = useState(false)
```

- [ ] **Step 3: 在「歌词源」区块之后插入「歌单解析源」区块**

在歌词源区块结束的 `</div>`（[约第 616 行](file:///c:/code/aurora-music/packages/app/src/pages/SettingsPage.tsx#L615-L616)）之后、「协议规范说明」注释之前插入：

```tsx
              {/* 歌单解析源：歌单导入时解析分享链接；应用不内置任何平台抓取器 */}
              <div>
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <p className="font-text text-caption-strong text-white/80">歌单解析源</p>
                    <p className="font-text text-caption text-white/60 mt-0.5">
                      导入歌单时把分享链接解析为歌曲列表；不配置也可用纯文本粘贴导入
                    </p>
                  </div>
                  <Button variant="secondary" size="sm" className="h-9 px-3.5" onClick={() => setAddPlaylistOpen(true)}>
                    <Plus className="h-4 w-4 mr-2" strokeWidth={1.6} />
                    添加
                  </Button>
                </div>

                {playlistResolverSources.length === 0 ? (
                  <div className="bg-white/[0.02] border border-dashed border-white/10 rounded-md px-3.5 py-6 text-center">
                    <Cloud className="h-6 w-6 text-white/30 mx-auto mb-2" strokeWidth={1.4} />
                    <p className="font-text text-caption text-white/50">尚未配置歌单解析源，分享链接导入不可用（纯文本导入不受影响）</p>
                  </div>
                ) : (
                  <div className="space-y-2.5">
                    {playlistResolverSources.map((src) => (
                      <SourceEditorCard
                        key={src.id}
                        name={src.name}
                        apiUrl={src.apiUrl}
                        headers={src.headers}
                        enabled={src.enabled}
                        placeholderUrl="https://your-api.com/resolve?url={url}"
                        onUpdate={(updates) => updatePlaylistResolverSource(src.id, updates)}
                        onRemove={() => removePlaylistResolverSource(src.id)}
                      />
                    ))}
                  </div>
                )}
              </div>
```

- [ ] **Step 4: 协议规范说明追加歌单解析源段落**

在「歌源协议规范」说明区歌词源说明 `<p>` 之后、请求头说明 `<p>` 之前插入：

```tsx
                <p className="font-text text-caption text-white/50 leading-relaxed">
                  <span className="text-white/70">歌单解析源：</span>
                  占位符 <code className="text-mint/80 bg-mint/[0.08] px-1 rounded-sm">{`{url}`}</code>（替换为歌单分享链接）。
                  响应为 JSON，支持数组或 <code className="text-mint/80 bg-mint/[0.08] px-1 rounded-sm">{`{results:[]}`}</code> / <code className="text-mint/80 bg-mint/[0.08] px-1 rounded-sm">{`{data:[]}`}</code> / <code className="text-mint/80 bg-mint/[0.08] px-1 rounded-sm">{`{songs:[]}`}</code> / <code className="text-mint/80 bg-mint/[0.08] px-1 rounded-sm">{`{list:[]}`}</code> 包裹；
                  可选 name 字段提供歌单标题。每项字段：<span className="text-white/70">title / artist</span>（兼容 name / songName / singer）。
                </p>
```

- [ ] **Step 5: 页面底部追加弹窗实例**

第二个 `<SourceAddDialog ... kind="lyrics" ... />` 之后追加：

```tsx
      <SourceAddDialog
        open={addPlaylistOpen}
        kind="playlist"
        onOpenChange={setAddPlaylistOpen}
        onSave={(source) => addPlaylistResolverSource({ ...source, enabled: true })}
      />
```

- [ ] **Step 6: 类型检查并提交**

```powershell
pnpm --filter @aurora/app exec tsc --noEmit
```

用 Write 写 `.git/COMMIT_MSG_TMP`：

```
feat(app): 设置页支持歌单解析源管理

复用现有源卡片/添加弹窗范式，新增 {url} 占位符协议说明；
明确提示未配置时仍可用纯文本导入
```

```powershell
git add packages/app/src/pages/SettingsPage.tsx
git commit -F .git/COMMIT_MSG_TMP
git log -1 --stat
```

---

## Task 5: playlistStore 持久化导入的在线曲目（importedTracks）

**Files:**
- Modify: `packages/app/src/stores/playlistStore.ts`

说明：歌单引用在线曲目必须有跨重启可用的 Track 对象；曲库会被启动时的平台数据整体覆盖，故在线曲目元数据存 playlistStore 自己的切片。播放地址会过期：**内存中保留**（本次会话可直接播），**持久化时剥离**（播放时按需重搜），用 persist 的 partialize 一步完成。

- [ ] **Step 1: 修改 packages/app/src/stores/playlistStore.ts**

（a）import 改为：

```ts
import type { Playlist, Track } from '@/types'
```

（b）`PlaylistState` 接口 `showQueuePanel: boolean` 之后追加：

```ts
  /**
   * 歌单导入的在线曲目：trackId → Track，与歌单同生命周期持久化。
   * 内存中保留播放地址（会话内可直接播）；持久化时剥离会过期的
   * onlineUrl，播放时按需重新搜索（见 playlistIO.service 的 ensurePlayableTrack）
   */
  importedTracks: Record<string, Track>
```

`setCurrentPlaylist` 声明之后追加：

```ts
  /** 登记歌单导入的在线曲目（同 id 覆盖更新） */
  addImportedTracks: (tracks: Track[]) => void
```

（c）初始状态 `showQueuePanel: false,` 之后追加：

```ts
      importedTracks: {},
```

（d）`setCurrentPlaylist` 实现之后追加：

```ts
      addImportedTracks: (tracks) => {
        if (tracks.length === 0) return
        const next = { ...get().importedTracks }
        for (const t of tracks) next[t.id] = t
        set({ importedTracks: next })
      },
```

（e）persist 配置改为（新增 partialize：落盘时剥离在线播放地址）：

```ts
    {
      name: 'aurora-playlists-state',
      partialize: (state) => ({
        playlists: state.playlists,
        currentPlaylistId: state.currentPlaylistId,
        showQueuePanel: state.showQueuePanel,
        // 在线播放地址会过期：落盘时剥离，播放时按需重新搜索
        importedTracks: Object.fromEntries(
          Object.entries(state.importedTracks).map(([id, t]) => {
            const { onlineUrl: _omit, ...rest } = t
            return [id, rest as Track]
          })
        ),
      }),
    }
```

- [ ] **Step 2: 类型检查并提交**

```powershell
pnpm --filter @aurora/app exec tsc --noEmit
```

用 Write 写 `.git/COMMIT_MSG_TMP`：

```
feat(app): playlistStore 持久化歌单导入的在线曲目

importedTracks 切片与歌单同生命周期；落盘时剥离会过期的
onlineUrl，会话内保留可直接播放
```

```powershell
git add packages/app/src/stores/playlistStore.ts
git commit -F .git/COMMIT_MSG_TMP
git log -1 --stat
```

---

## Task 6: 导入编排 Hook（usePlaylistImport）

**Files:**
- Create: `packages/app/src/hooks/usePlaylistImport.ts`

编排两步流程：①解析（链接→解析源，失败回退纯文本）②匹配（本地优先，未命中搜歌源取最佳结果转 Track，只展示不下载）。

- [ ] **Step 1: 创建 packages/app/src/hooks/usePlaylistImport.ts**

```ts
import { useCallback, useRef, useState } from 'react'
import { platform } from '@/services/platform'
import { useLibraryStore } from '@/stores/libraryStore'
import { usePlaylistStore } from '@/stores/playlistStore'
import { toast } from '@/components/common/Toast'
import {
  parsePlaylistText,
  extractShareUrl,
  parsePlaylistLink,
  matchTracksByNames,
  scoreOnlineResult,
} from '@aurora/shared'
import type { Track, ParsedSong, OnlineTrackSearchResult } from '@/types'

/** 在线补齐并发上限（与封面提取并发约束一致，防止打爆歌源） */
const SEARCH_CONCURRENCY = 4
/** 在线匹配总分阈值（标题分 + 歌手分，满分 2） */
const ACCEPT_SCORE = 1.4

export interface ImportPreview {
  /** 解析出的歌曲列表 */
  songs: ParsedSong[]
  /** 本地匹配结果（与 songs 等长，未匹配为 null） */
  localMatches: Array<Track | null>
  /** 建议的歌单名（解析源返回的标题或默认名） */
  suggestedName: string
}

export interface ImportResult {
  playlistId: string
  importedCount: number
  localCount: number
  onlineCount: number
  /** 彻底没找到的歌曲 */
  unmatched: ParsedSong[]
}

/** 在线搜索结果转歌单曲目（带当前可用的播放地址，只展示不下载） */
function toImportedTrack(r: OnlineTrackSearchResult): Track {
  return {
    id: r.id,
    path: '',
    title: r.title,
    artist: r.artist,
    album: r.album,
    duration: r.duration,
    addedAt: Date.now(),
    playCount: 0,
    liked: false,
    onlineUrl: r.audioUrl,
    onlineQualityUrls: r.qualityUrls,
    coverUrl: r.coverUrl,
    onlineSource: r.source,
    onlineSourceName: r.sourceName,
    onlineId: r.id,
  }
}

/**
 * 歌单导入编排（两步）：
 * 1. parse：含链接先走用户配置的歌单解析源（失败回退纯文本解析），否则纯文本本地解析
 * 2. confirm：本地曲库有就用本地；没有的搜用户配置的音乐源取最佳结果直接进歌单（不下载）
 */
export function usePlaylistImport() {
  const [phase, setPhase] = useState<'idle' | 'parsing' | 'importing'>('idle')
  /** 在线补齐进度 [已完成, 总数] */
  const [progress, setProgress] = useState<[number, number]>([0, 0])
  const cancelRef = useRef(false)

  const parse = useCallback(async (rawText: string): Promise<ImportPreview | null> => {
    const text = rawText.trim()
    if (!text) return null
    setPhase('parsing')
    cancelRef.current = false

    let songs: ParsedSong[] = []
    let suggestedName = '导入的播放列表'

    const shareUrl = extractShareUrl(text)
    if (shareUrl) {
      // 链接路径：走用户配置的歌单解析源；失败回退纯文本解析（链接行会被跳过）
      try {
        const sources = useLibraryStore.getState().playlistResolverSources
        const result = await parsePlaylistLink(sources, shareUrl)
        songs = result.songs
        if (result.name) suggestedName = result.name
      } catch (err: any) {
        toast(err?.message || '歌单解析失败', { type: 'error', duration: 6000 })
        songs = parsePlaylistText(text)
      }
    } else {
      songs = parsePlaylistText(text)
    }

    if (songs.length === 0) {
      toast('没有解析出任何歌曲，请检查粘贴内容（每行一首：歌名 - 歌手）', { type: 'error', duration: 6000 })
      setPhase('idle')
      return null
    }

    const localMatches = matchTracksByNames(songs, useLibraryStore.getState().tracks)
    setPhase('idle')
    return { songs, localMatches, suggestedName }
  }, [])

  const confirm = useCallback(
    async (preview: ImportPreview, playlistName: string): Promise<ImportResult | null> => {
      const { songs, localMatches } = preview
      setPhase('importing')
      cancelRef.current = false

      // ── 本地没有的歌曲走音乐源在线补齐（并发 4） ──
      const pending: Array<{ song: ParsedSong; index: number }> = []
      localMatches.forEach((m, i) => {
        if (!m) pending.push({ song: songs[i], index: i })
      })

      const resolvedTracks: Array<Track | null> = [...localMatches]
      let done = 0
      setProgress([0, pending.length])

      const lib = useLibraryStore.getState()
      const hasSource = lib.onlineSources.some((s) => s.enabled && s.apiUrl)
      let cursor = 0

      const worker = async () => {
        while (cursor < pending.length) {
          if (cancelRef.current) return
          const job = pending[cursor++]
          if (hasSource) {
            try {
              const results = await platform.searchOnlineTracks(
                `${job.song.title} ${job.song.artist}`.trim(),
                { sources: lib.onlineSources, quality: lib.downloadQuality }
              )
              let best: OnlineTrackSearchResult | null = null
              let bestScore = 0
              for (const r of results) {
                const score = scoreOnlineResult(r, job.song)
                if (score > bestScore) {
                  bestScore = score
                  best = r
                }
              }
              if (best && bestScore >= ACCEPT_SCORE) {
                resolvedTracks[job.index] = toImportedTrack(best)
              }
            } catch {
              // 单曲搜索失败不中断整体，计入未匹配
            }
          }
          done++
          setProgress([done, pending.length])
        }
      }

      if (pending.length > 0) {
        await Promise.all(
          Array.from({ length: Math.min(SEARCH_CONCURRENCY, pending.length) }, () => worker())
        )
      }
      if (cancelRef.current) {
        setPhase('idle')
        return null
      }

      // ── 创建歌单（保持原歌单顺序）并持久化在线曲目 ──
      const imported = resolvedTracks.filter((t): t is Track => t !== null)
      const playlist = usePlaylistStore.getState().createPlaylist(playlistName.trim() || preview.suggestedName)
      usePlaylistStore.getState().addTracksToPlaylist(playlist.id, imported.map((t) => t.id))
      const onlineTracks = imported.filter((t) => !t.path)
      if (onlineTracks.length > 0) {
        usePlaylistStore.getState().addImportedTracks(onlineTracks)
      }

      const unmatched = songs.filter((_, i) => resolvedTracks[i] === null)
      setPhase('idle')
      return {
        playlistId: playlist.id,
        importedCount: imported.length,
        localCount: imported.length - onlineTracks.length,
        onlineCount: onlineTracks.length,
        unmatched,
      }
    },
    []
  )

  const cancel = useCallback(() => {
    cancelRef.current = true
  }, [])

  return { phase, progress, parse, confirm, cancel }
}
```

- [ ] **Step 2: 类型检查并提交**

```powershell
pnpm --filter @aurora/app exec tsc --noEmit
```

用 Write 写 `.git/COMMIT_MSG_TMP`：

```
feat(app): 歌单导入编排 hook

两步流程：解析（链接走用户配置解析源、失败回退纯文本）→
匹配（本地优先，未命中搜音乐源取最佳结果直接进歌单，不下载）
```

```powershell
git add packages/app/src/hooks/usePlaylistImport.ts
git commit -F .git/COMMIT_MSG_TMP
git log -1 --stat
```

---

## Task 7: 导入对话框 + 三处入口（侧栏 / 歌单页 / 移动端抽屉）

**Files:**
- Create: `packages/app/src/components/PlaylistImportDialog.tsx`
- Modify: `packages/app/src/components/layout/Sidebar.tsx`、`packages/app/src/pages/PlaylistPage.tsx`、`packages/app/src/components/layout/MobileNav.tsx`

- [ ] **Step 1: 创建 packages/app/src/components/PlaylistImportDialog.tsx**

```tsx
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Loader2, Link2, FileText, ListMusic } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { toast } from '@/components/common/Toast'
import { usePlaylistImport, type ImportPreview } from '@/hooks/usePlaylistImport'

interface PlaylistImportDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * 歌单导入对话框：粘贴其他平台的歌单（分享链接或纯文本）。
 * 本地曲库有就用本地，没有的用已配置音乐源的搜索结果直接展示（不下载）。
 *
 * 合规说明：应用不内置任何平台的歌单抓取器——链接解析依赖用户
 * 自行配置的解析源，纯文本导入完全在本地处理、零网络请求。
 */
export function PlaylistImportDialog({ open, onOpenChange }: PlaylistImportDialogProps) {
  const navigate = useNavigate()
  const { phase, progress, parse, confirm, cancel } = usePlaylistImport()
  const [text, setText] = useState('')
  const [playlistName, setPlaylistName] = useState('')
  const [preview, setPreview] = useState<ImportPreview | null>(null)

  // 每次打开重置表单
  useEffect(() => {
    if (open) {
      setText('')
      setPlaylistName('')
      setPreview(null)
      cancel()
    }
  }, [open, cancel])

  const busy = phase !== 'idle'
  const localMatched = preview ? preview.localMatches.filter(Boolean).length : 0
  const pendingOnline = preview ? preview.songs.length - localMatched : 0

  const handleParse = async () => {
    const result = await parse(text)
    if (result) {
      setPreview(result)
      if (!playlistName.trim() && result.suggestedName !== '导入的播放列表') {
        setPlaylistName(result.suggestedName)
      }
    }
  }

  const handleConfirm = async () => {
    if (!preview) return
    const result = await confirm(preview, playlistName)
    if (!result) return
    onOpenChange(false)
    let msg = `成功导入 ${result.importedCount} 首（本地 ${result.localCount} 首`
    if (result.onlineCount > 0) msg += `，在线 ${result.onlineCount} 首`
    msg += '）'
    if (result.unmatched.length > 0) msg += `\n${result.unmatched.length} 首未找到，已跳过`
    toast(msg, { duration: 6000 })
    navigate(`/playlist/${result.playlistId}`)
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!busy) onOpenChange(v) }}>
      <DialogContent className="sm:max-w-lg max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>导入歌单</DialogTitle>
          <DialogDescription className="font-text text-[12px] leading-relaxed">
            粘贴歌单分享链接或纯文本（每行一首：歌名 - 歌手）。
            应用不内置任何平台的抓取器：链接解析需先在设置中配置解析源，纯文本导入无需任何配置。
          </DialogDescription>
        </DialogHeader>

        {!preview ? (
          <>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              disabled={busy}
              rows={7}
              placeholder={'粘贴歌单分享链接，或按行粘贴歌曲列表：\n七里香 - 周杰伦\n晴天 - 周杰伦'}
              className="w-full resize-none bg-white/[0.03] border border-white/10 rounded-md px-3 py-2.5 font-text text-[13px] text-white/85 outline-none focus:border-mint/50 transition-colors duration-200 placeholder:text-white/25"
            />
            <Input
              value={playlistName}
              onChange={(e) => setPlaylistName(e.target.value)}
              disabled={busy}
              placeholder="歌单名称（可选，默认「导入的播放列表」）"
            />
            <div className="flex items-center justify-between gap-3">
              <p className="font-text text-[11px] text-white/35 leading-snug flex-1">
                仅导入歌名/歌手等元数据；在线歌曲只展示与在线播放，不会下载
              </p>
              {phase === 'parsing' ? (
                <Button variant="secondary" disabled>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" strokeWidth={1.6} />
                  解析中…
                </Button>
              ) : (
                <Button variant="primary" onClick={handleParse} disabled={!text.trim()}>
                  解析并预览
                </Button>
              )}
            </div>
          </>
        ) : (
          <>
            <div className="flex items-center justify-between gap-3">
              <Input
                value={playlistName}
                onChange={(e) => setPlaylistName(e.target.value)}
                disabled={phase === 'importing'}
                placeholder={preview.suggestedName}
                className="max-w-[240px]"
              />
              <p className="font-text text-[12px] text-white/50 tabular-nums">
                共 {preview.songs.length} 首 · 本地 {localMatched} 首
                {pendingOnline > 0 && ` · 待在线匹配 ${pendingOnline} 首`}
              </p>
            </div>

            {/* 预览列表：本地匹配状态一目了然 */}
            <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin border border-white/[0.06] rounded-md">
              {preview.songs.map((song, i) => {
                const matched = preview.localMatches[i]
                const isSearching = phase === 'importing' && !matched
                return (
                  <div key={i} className="flex items-center gap-2.5 px-3 py-2 border-b border-white/5 last:border-0">
                    {isSearching ? (
                      <Loader2 className="h-3.5 w-3.5 flex-shrink-0 animate-spin text-mint/70" strokeWidth={1.6} />
                    ) : matched ? (
                      <FileText className="h-3.5 w-3.5 flex-shrink-0 text-mint/80" strokeWidth={1.6} />
                    ) : (
                      <Link2 className="h-3.5 w-3.5 flex-shrink-0 text-white/30" strokeWidth={1.6} />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="font-text text-[13px] text-white/85 truncate">{song.title}</p>
                      {song.artist && (
                        <p className="font-text text-[11px] text-white/40 truncate">{song.artist}</p>
                      )}
                    </div>
                    <span className="font-text text-[11px] text-white/35 flex-shrink-0">
                      {matched ? '本地' : phase === 'importing' ? '匹配中' : '在线'}
                    </span>
                  </div>
                )
              })}
            </div>

            {phase === 'importing' && progress[1] > 0 && (
              <p className="font-text text-[12px] text-white/50 tabular-nums">
                在线匹配中 {progress[0]}/{progress[1]}…
              </p>
            )}

            <div className="flex items-center justify-end gap-2">
              {phase === 'importing' ? (
                <Button variant="secondary" onClick={() => { cancel(); onOpenChange(false) }}>
                  取消
                </Button>
              ) : (
                <>
                  <Button variant="secondary" onClick={() => setPreview(null)}>
                    重新粘贴
                  </Button>
                  <Button variant="primary" onClick={handleConfirm} className="min-w-[120px]">
                    <ListMusic className="h-4 w-4 mr-2" strokeWidth={1.6} />
                    创建歌单
                  </Button>
                </>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 2: Sidebar 接入**

`packages/app/src/components/layout/Sidebar.tsx`：

（a）lucide 导入行改为：

```tsx
import { Music, Heart, Clock, ListMusic, Settings, Plus, MoreHorizontal, Trash2, Pencil, Upload, FileText, Link2 } from 'lucide-react'
```

（b）追加导入：

```tsx
import { PlaylistImportDialog } from '@/components/PlaylistImportDialog'
import { toast } from '@/components/common/Toast'
```

（c）state 区（`const [editingName, setEditingName] = useState('')` 之后）追加：

```tsx
  const [showImportDialog, setShowImportDialog] = useState(false)
```

（d）原「导入播放列表」按钮（第 130-137 行）替换为下拉菜单：

```tsx
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button type="button" className="btn-icon" title="导入播放列表">
                  <Upload className="h-3.5 w-3.5" strokeWidth={1.5} />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                <DropdownMenuItem onClick={() => setShowImportDialog(true)}>
                  <Link2 className="h-4 w-4 mr-2" strokeWidth={1.5} />
                  导入歌单（链接/文本）
                </DropdownMenuItem>
                <DropdownMenuItem onClick={handleImportPlaylist}>
                  <FileText className="h-4 w-4 mr-2" strokeWidth={1.5} />
                  导入 M3U 文件
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
```

（e）`handleImportPlaylist` 中两处 `alert(...)` 改为 Toast（用户偏好不用系统弹窗）：

```tsx
      toast('文件中没有找到有效的音乐路径', { type: 'error' })
```

```tsx
      toast('没有匹配到音乐库中的歌曲，请先扫描包含这些歌曲的目录', { type: 'error' })
```

并在 `addTracksToPlaylist(...)` 之后追加：

```tsx
    toast(`已导入 ${matchedTracks.length} 首歌曲`)
```

（f）return 末尾（创建歌单 `</Dialog>` 之后、最外层 `</div>` 之前）挂载：

```tsx
      <PlaylistImportDialog open={showImportDialog} onOpenChange={setShowImportDialog} />
```

- [ ] **Step 3: PlaylistPage 菜单加入口**

`packages/app/src/pages/PlaylistPage.tsx`：

（a）lucide 导入行追加 `Link2`（`Upload,` 之后一行 `Link2,`）。

（b）追加导入：

```tsx
import { PlaylistImportDialog } from '@/components/PlaylistImportDialog'
import { toast } from '@/components/common/Toast'
```

（c）组件内（`const playlist = playlists.find(...)` 之前）追加：

```tsx
  const [showImportDialog, setShowImportDialog] = useState(false)
```

（d）`handleImport`（M3U）中两处 `alert(...)` 改为与 Sidebar 相同的 `toast(..., { type: 'error' })`。

（e）下拉菜单「导入 M3U 文件」项之后追加：

```tsx
              <DropdownMenuItem onClick={() => setShowImportDialog(true)}>
                <Link2 className="h-4 w-4 mr-2" strokeWidth={1.6} />
                导入歌单（链接/文本）
              </DropdownMenuItem>
```

（f）return 末尾（最外层 `</div>` 之前）挂载：

```tsx
      <PlaylistImportDialog open={showImportDialog} onOpenChange={setShowImportDialog} />
```

- [ ] **Step 4: MobileNav 抽屉加入口**

`packages/app/src/components/layout/MobileNav.tsx`：

（a）追加导入：

```tsx
import { Link2 } from 'lucide-react'
import { PlaylistImportDialog } from '@/components/PlaylistImportDialog'
```

（b）组件内追加：

```tsx
  const [showImportDialog, setShowImportDialog] = useState(false)
```

（c）`<nav>` 的 `navItems.map(...)` 之后（`</nav>` 之前）追加：

```tsx
          <button
            type="button"
            onClick={() => {
              setOpen(false)
              setShowImportDialog(true)
            }}
            className="flex items-center gap-3 px-3 py-3 rounded-xl text-[14px] tracking-[-0.2px] text-white/70 hover:text-white hover:bg-white/[0.05] transition-all duration-200 text-left"
          >
            <Link2 className="h-5 w-5" strokeWidth={1.6} />
            导入歌单
          </button>
```

（d）`</aside>` 之后、Fragment 结束之前挂载：

```tsx
      <PlaylistImportDialog open={showImportDialog} onOpenChange={setShowImportDialog} />
```

- [ ] **Step 5: 类型检查并提交**

```powershell
pnpm --filter @aurora/app exec tsc --noEmit
```

用 Write 写 `.git/COMMIT_MSG_TMP`：

```
feat(app): 歌单导入对话框与入口

粘贴链接/文本 → 解析预览（本地/在线状态）→ 创建歌单并跳转；
侧栏下拉、歌单页菜单、移动端抽屉三处入口；既有 M3U 导入的
alert 统一改为应用内 Toast
```

```powershell
git add packages/app/src/components/PlaylistImportDialog.tsx packages/app/src/components/layout/Sidebar.tsx packages/app/src/pages/PlaylistPage.tsx packages/app/src/components/layout/MobileNav.tsx
git commit -F .git/COMMIT_MSG_TMP
git log -1 --stat
```

---

## Task 8: PlaylistPage 展示兜底 + 播放按需取址

**说明**：歌单渲染用 `tracks.find()` 反查，导入的在线曲目不在曲库里，反查要兜底 `importedTracks`；播放时在线曲目若没有可用地址（重启后地址过期被剥离），先用音乐源重搜一次再播——这是整个播放链路唯一的改动点。

**Files:**
- Modify: `packages/app/src/services/playlistIO.service.ts`、`packages/app/src/pages/PlaylistPage.tsx`

- [ ] **Step 1: playlistIO.service 追加播放取址助手**

`packages/app/src/services/playlistIO.service.ts` 顶部 import 区追加：

```ts
import { platform } from '@/services/platform'
import { useLibraryStore } from '@/stores/libraryStore'
import { usePlaylistStore } from '@/stores/playlistStore'
import { scoreOnlineResult } from '@aurora/shared'
import type { OnlineTrackSearchResult } from '@/types'
```

文件末尾追加：

```ts
/** 播放前按需取址并发上限 */
const PLAY_RESOLVE_CONCURRENCY = 4

/**
 * 让在线曲目可播放：本地曲目/已有地址的原样返回；
 * 导入歌单的在线曲目不持久化播放地址（会过期），用用户配置的
 * 音乐源重新搜索取最佳结果，并回填 importedTracks 供后续播放直接使用。
 * 未配置音乐源或无结果返回 null
 */
export async function ensurePlayableTrack(track: Track): Promise<Track | null> {
  if (track.path || track.onlineUrl) return track
  const { onlineSources, downloadQuality } = useLibraryStore.getState()
  if (!onlineSources.some((s) => s.enabled && s.apiUrl)) return null
  try {
    const results = await platform.searchOnlineTracks(
      `${track.title} ${track.artist}`.trim(),
      { sources: onlineSources, quality: downloadQuality }
    )
    let best: OnlineTrackSearchResult | null = null
    let bestScore = 0
    for (const r of results) {
      const score = scoreOnlineResult(r, { title: track.title, artist: track.artist })
      if (score > bestScore) {
        bestScore = score
        best = r
      }
    }
    const r = best || results[0]
    if (!r) return null
    const resolved: Track = {
      ...track,
      onlineUrl: r.audioUrl,
      onlineQualityUrls: r.qualityUrls,
      coverUrl: r.coverUrl || track.coverUrl,
      onlineSource: r.source,
      onlineSourceName: r.sourceName,
      onlineId: r.id,
      duration: track.duration || r.duration,
    }
    usePlaylistStore.getState().addImportedTracks([resolved])
    return resolved
  } catch {
    return null
  }
}

/** 批量让歌单可播放（播放全部场景）：只处理缺地址的曲目，并发 4 */
export async function resolvePlayableTracks(tracks: Track[]): Promise<Track[]> {
  const result = [...tracks]
  const jobs = tracks
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => !t.path && !t.onlineUrl)
  if (jobs.length === 0) return result
  let cursor = 0
  const worker = async () => {
    while (cursor < jobs.length) {
      const job = jobs[cursor++]
      const resolved = await ensurePlayableTrack(job.t).catch(() => null)
      if (resolved) result[job.i] = resolved
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(PLAY_RESOLVE_CONCURRENCY, jobs.length) }, () => worker())
  )
  return result
}
```

- [ ] **Step 2: PlaylistPage 反查兜底 + 播放改造**

`packages/app/src/pages/PlaylistPage.tsx`：

（a）imports 中 `playlistIO.service` 一行改为：

```tsx
import {
  downloadPlaylistAsM3U,
  parseM3U,
  matchTracksByPaths,
  pickM3UFile,
  ensurePlayableTrack,
  resolvePlayableTracks,
} from '@/services/playlistIO.service'
```

（b）`const tracks = useLibraryStore((s) => s.tracks)` 之后追加：

```tsx
  // 歌单导入的在线曲目（不在曲库里，反查兜底用）
  const importedTracks = usePlaylistStore((s) => s.importedTracks)
```

（c）`playlistTracks` 的 useMemo 改为：

```tsx
  const playlistTracks = useMemo(() => {
    if (!playlist) return []
    return playlist.trackIds
      .map((tid) => tracks.find((t) => t.id === tid) || importedTracks[tid])
      .filter(Boolean) as typeof tracks
  }, [playlist, tracks, importedTracks])
```

（d）`handlePlayAll` 改为：

```tsx
  const handlePlayAll = async () => {
    if (playlistTracks.length === 0) return
    // 在线曲目可能没有可用地址（重启后过期被剥离），播放前按需取址
    const queue = await resolvePlayableTracks(playlistTracks)
    playQueue(queue, 0)
  }
```

（e）`handlePlayTrack` 改为：

```tsx
  const handlePlayTrack = async (track: typeof tracks[0], index: number) => {
    if (currentTrack?.id === track.id) {
      usePlayerStore.getState().togglePlay()
      return
    }
    const playable = await ensurePlayableTrack(track)
    if (!playable) {
      toast('无法播放该在线歌曲：未配置音乐源或搜索无结果', { type: 'error' })
      return
    }
    const queue = playlistTracks.map((t) => (t.id === playable.id ? playable : t))
    playQueue(queue, index)
  }
```

- [ ] **Step 3: 类型检查并提交**

```powershell
pnpm --filter @aurora/app exec tsc --noEmit
```

用 Write 写 `.git/COMMIT_MSG_TMP`：

```
feat(app): 歌单页展示导入的在线曲目并支持按需取址播放

反查兜底 importedTracks；播放无地址的在线曲目前先用音乐源
重搜一次，播放链路其余部分零改动
```

```powershell
git add packages/app/src/services/playlistIO.service.ts packages/app/src/pages/PlaylistPage.tsx
git commit -F .git/COMMIT_MSG_TMP
git log -1 --stat
```

---

## Task 9: 全量验证（测试 + 类型 + 构建 + 手动验收）

- [ ] **Step 1: shared 测试与构建**

```powershell
pnpm --filter @aurora/shared test
pnpm --filter @aurora/shared build
pnpm --filter @aurora/shared typecheck
```

预期：全部通过。

- [ ] **Step 2: app / desktop 类型检查与构建**

```powershell
pnpm --filter @aurora/app exec tsc --noEmit
pnpm --filter @aurora/desktop typecheck
pnpm --filter @aurora/app build
```

预期：全部通过。

- [ ] **Step 3: 启动测试环境手动验收**

```powershell
pnpm dev
```

（Vite http://localhost:5173 + Electron 窗口）逐项验收：

1. **纯文本导入**：侧栏导入按钮 → 「导入歌单（链接/文本）」，粘贴：
   ```
   1. 七里香 - 周杰伦
   晴天 - 周杰伦
   虚构的不存在歌曲xyz - 虚构歌手
   ```
   「解析并预览」：3 行解析正确、序号剥离；本地曲库有的标「本地」。
2. **本地优先**：曲库里已有的歌显示「本地」，入单用的是本地曲目。
3. **在线展示不下载**：配置了音乐源时，未匹配歌曲在线匹配后直接出现在歌单里（带封面），没有任何下载行为；未配置源时跳过并 toast 汇总。
4. **持久化**：重启应用后歌单与在线曲目仍展示。
5. **播放**：点击在线曲目可播；重启后再点（地址已剥离）→ 自动重搜后可播；未配置源时友好报错。
6. **设置页**：歌单解析源添加/编辑/启用/删除/持久化正常，`{url}` 占位符校验生效。
7. **移动端抽屉**（窗口缩窄）：「导入歌单」入口可用。
8. **回归**：M3U 导入/导出、在线搜索、下载不受影响；控制台无报错。

- [ ] **Step 4: 如有修复，按同样方式提交**

Write 临时信息文件 + `git commit -F .git/COMMIT_MSG_TMP`，并 `git log -1 --stat` 验证。

---

## 自查记录（Self-Review）

1. **需求覆盖**（用户两步模型）：
   - 「从链接分析歌曲清单」→ Task 2 解析源执行器 + Task 6 parse（含纯文本兜底）✓
   - 「本地存在用本地」→ Task 1 matchTracksByNames + Task 6 confirm 本地优先 ✓
   - 「本地不存在用音源中的，不下载只展示」→ Task 6 confirm 在线补齐转 Track 直接进歌单；无任何下载调用 ✓
   - 「不要有法律风险」→ 不内置平台抓取器、解析源用户自配置、纯文本零请求、合规文案 ✓
2. **占位符扫描**：无 TBD/TODO，所有代码步骤含完整代码 ✓
3. **类型一致性**：`PlaylistResolverConfig/ParsedSong/PlaylistParseResult`（Task 1）→ 执行器（Task 2）→ store（Task 3）→ hook（Task 6）一致；`addImportedTracks/importedTracks`（Task 5）→ Task 6/8 一致；`ensurePlayableTrack/resolvePlayableTracks`（Task 8）内部自洽 ✓
4. **相比第一版砍掉**：shared resolveOnlineTrackUrl、PlatformInterface 扩展、桌面端 IPC/preload、audio.service 播放解析钩子、playerStore 解析/队列更新、App.tsx 启动合并 —— 播放完全复用现有 `onlineUrl || path` 机制 ✓
