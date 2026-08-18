import { ipcMain, dialog, BrowserWindow } from 'electron'
import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import { getAllTracks, getTrackById, initDatabase } from './database'
import { scanFolder, ensureCover } from './scanner'
import type { OnlineTrackSearchResult, Track } from '../types'

let mainWindow: BrowserWindow | null = null

export function setMainWindow(win: BrowserWindow) {
  mainWindow = win
}

/** 安全地向渲染进程发送事件（窗口可能已销毁） */
function sendToRenderer(channel: string, ...args: unknown[]) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, ...args)
  }
}

// 已扫描过的目录白名单：fs:readFile 仅允许读取这些目录内的文件
const allowedRoots = new Set<string>()

function isPathAllowed(target: string): boolean {
  const resolved = path.resolve(target)
  for (const root of allowedRoots) {
    const prefix = root.endsWith(path.sep) ? root : root + path.sep
    if (resolved.startsWith(prefix)) return true
  }
  return false
}

/** trackId 仅允许字母数字与连字符（uuid / netease-xxx / qq-xxx），防止路径穿越 */
function isValidTrackId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(id)
}

// 扫描队列：多个目录串行执行，避免并发写数据库、进度事件互相覆盖
let scanChain: Promise<unknown> = Promise.resolve()

function enqueueScan(folderPath: string): Promise<Track[]> {
  const task = scanChain.then(() => runScan(folderPath))
  // 链上吞掉错误，避免一次失败阻断后续扫描
  scanChain = task.catch(() => {})
  return task
}

async function runScan(folderPath: string): Promise<Track[]> {
  const userData = app.getPath('userData')

  try {
    if (!fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) {
      throw new Error('文件夹不存在或不可访问')
    }
    allowedRoots.add(path.resolve(folderPath))
    // 静默后台扫描：不发送进度事件，仅在完成/失败时通知
    await scanFolder(folderPath, userData)
    const allTracks = getAllTracks()
    sendToRenderer('scan:complete', allTracks)
    return allTracks
  } catch (err) {
    console.error('扫描失败:', folderPath, err)
    // 静默后台扫描：仅通知渲染进程记录日志，不向用户展示
    sendToRenderer('scan:error', {
      folder: folderPath,
      message: `扫描失败：文件夹「${folderPath}」不存在或无法读取`,
    })
    throw err
  }
}

// 统一 UA（部分接口对 UA 敏感）
const HTTP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

// 网易云搜索：/api/search/get 搜列表 → /api/song/enhance/player/url 批量取播放地址
async function searchNetease(query: string): Promise<OnlineTrackSearchResult[]> {
  try {
    const trimmed = (query || '').trim()
    if (!trimmed) return []

    const searchParams = new URLSearchParams()
    searchParams.set('s', trimmed)
    searchParams.set('type', '1')
    searchParams.set('limit', '20')
    searchParams.set('offset', '0')
    const searchUrl = `https://music.163.com/api/search/get?${searchParams.toString()}`
    const searchResp = await fetch(searchUrl, {
      headers: { 'User-Agent': HTTP_UA, Referer: 'https://music.163.com' },
      signal: AbortSignal.timeout(8000),
    })
    if (!searchResp.ok) return []
    const searchData = (await searchResp.json()) as {
      code?: number
      result?: {
        songs?: Array<{
          id: number
          name: string
          artists?: Array<{ name: string }>
          artist?: { name: string }
          album?: { name: string; picUrl?: string }
          duration?: number
        }>
      }
    }
    const songs = searchData?.result?.songs
    if (!Array.isArray(songs) || songs.length === 0) return []

    // 批量取播放 URL
    const songIds = songs.map((s) => s.id).join(',')
    const urlParams = new URLSearchParams()
    urlParams.set('ids', `[${songIds}]`)
    urlParams.set('br', '320000')
    const urlResp = await fetch(`https://music.163.com/api/song/enhance/player/url?${urlParams.toString()}`, {
      headers: { 'User-Agent': HTTP_UA, Referer: 'https://music.163.com' },
      signal: AbortSignal.timeout(8000),
    })
    const urlMap = new Map<number, string>()
    if (urlResp.ok) {
      const urlData = (await urlResp.json()) as { data?: Array<{ id: number; url: string | null }> }
      if (Array.isArray(urlData?.data)) {
        for (const item of urlData.data) {
          if (item.url) urlMap.set(item.id, item.url)
        }
      }
    }

    return songs
      .filter((s) => urlMap.has(s.id))
      .map((s) => {
        const artistName = s.artists?.map((a) => a.name).join(', ') || s.artist?.name || '未知艺术家'
        return {
          id: `netease-${s.id}`,
          title: s.name || '未知歌曲',
          artist: artistName,
          album: s.album?.name || '',
          duration: Math.round((s.duration || 0) / 1000),
          coverUrl: s.album?.picUrl ? `${s.album.picUrl}?param=120y120` : undefined,
          audioUrl: urlMap.get(s.id)!,
          source: 'netease' as const,
        }
      })
  } catch (err) {
    // 抛给调用方区分"无结果"与"网络失败"，由聚合层决定是否提示用户
    console.warn('网易云搜索失败:', err)
    throw err
  }
}

// QQ音乐搜索：client_search_cp 搜列表 → musicu.fcg 用 songmid 换 purl，拼 isure.stream 直链
async function searchQQ(query: string): Promise<OnlineTrackSearchResult[]> {
  try {
    const trimmed = (query || '').trim()
    if (!trimmed) return []

    // 1) 搜索歌曲列表
    const searchParams = new URLSearchParams()
    searchParams.set('ct', '24')
    searchParams.set('qqmusic_ver', '1298')
    searchParams.set('new_json', '1')
    searchParams.set('remoteplace', 'txt.yqq.song')
    searchParams.set('searchid', '61460539676714578')
    searchParams.set('t', '0')
    searchParams.set('aggr', '1')
    searchParams.set('cr', '1')
    searchParams.set('catZhida', '1')
    searchParams.set('lossless', '0')
    searchParams.set('flag_qc', '0')
    searchParams.set('p', '1')
    searchParams.set('n', '20')
    searchParams.set('w', trimmed)
    searchParams.set('g_tk', '5381')
    searchParams.set('loginUin', '0')
    searchParams.set('hostUin', '0')
    searchParams.set('format', 'json')
    searchParams.set('inCharset', 'utf8')
    searchParams.set('outCharset', 'utf-8')
    searchParams.set('notice', '0')
    searchParams.set('platform', 'yqq.json')
    searchParams.set('needNewCode', '0')
    const searchUrl = `https://c.y.qq.com/soso/fcgi-bin/client_search_cp?${searchParams.toString()}`
    const searchResp = await fetch(searchUrl, {
      headers: { 'User-Agent': HTTP_UA, Referer: 'https://y.qq.com/' },
      signal: AbortSignal.timeout(8000),
    })
    if (!searchResp.ok) return []
    const searchData = (await searchResp.json()) as {
      code?: number
      data?: {
        song?: {
          list?: Array<{
            mid: string
            name: string
            singer?: Array<{ name: string }>
            album?: { name: string; mid: string }
            interval?: number
          }>
        }
      }
    }
    const songs = searchData?.data?.song?.list
    if (!Array.isArray(songs) || songs.length === 0) return []

    // 2) 批量获取播放 purl（用 songmid 换）
    const songmids = songs.map((s) => s.mid)
    const guid = '358840384'
    const vkeyData = {
      req: {
        module: 'CDN.SrfCdnDispatchServer',
        method: 'GetCdnDispatch',
        param: { guid, calltype: 0, userip: '' },
      },
      req_0: {
        module: 'vkey.GetVkeyServer',
        method: 'CgiGetVkey',
        param: { guid, songmid: songmids, songtype: songmids.map(() => 0), uin: '0', loginflag: 1, platform: '20' },
      },
      comm: { uin: 0, format: 'json', ct: 20, cv: 0 },
    }
    const vkeyUrl = `https://u.y.qq.com/cgi-bin/musicu.fcg?format=json&data=${encodeURIComponent(JSON.stringify(vkeyData))}`
    const vkeyResp = await fetch(vkeyUrl, {
      headers: { 'User-Agent': HTTP_UA, Referer: 'https://y.qq.com/' },
      signal: AbortSignal.timeout(8000),
    })
    const purlMap = new Map<string, string>()
    if (vkeyResp.ok) {
      const vkeyResult = (await vkeyResp.json()) as {
        req_0?: { data?: { midurlinfo?: Array<{ purl: string }>; sip?: string[] } }
      }
      const infos = vkeyResult?.req_0?.data?.midurlinfo
      const sip = vkeyResult?.req_0?.data?.sip
      const prefix = sip && sip.length > 0 ? sip[0] : 'https://isure.stream.qqmusic.qq.com/'
      if (Array.isArray(infos)) {
        songmids.forEach((mid, i) => {
          const purl = infos[i]?.purl
          if (purl) purlMap.set(mid, `${prefix}${purl}`)
        })
      }
    }

    // 3) 拼装结果，过滤无 purl 的（VIP/版权曲）
    return songs
      .filter((s) => purlMap.has(s.mid))
      .map((s) => {
        const artistName = s.singer?.map((a) => a.name).join(', ') || '未知艺术家'
        const albumMid = s.album?.mid
        return {
          id: `qq-${s.mid}`,
          title: s.name || '未知歌曲',
          artist: artistName,
          album: s.album?.name || '',
          duration: s.interval || 0,
          coverUrl: albumMid ? `https://y.gtimg.cn/music/photo_new/T002R120x120M000${albumMid}.jpg` : undefined,
          audioUrl: purlMap.get(s.mid)!,
          source: 'qq' as const,
        }
      })
  } catch (err) {
    console.warn('QQ音乐搜索失败:', err)
    throw err
  }
}

export function registerIpcHandlers() {
  initDatabase()

  ipcMain.handle('dialog:openFolder', async () => {
    if (!mainWindow || mainWindow.isDestroyed()) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      title: '选择音乐文件夹',
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle('fs:readDir', async (_event, dirPath: string) => {
    try {
      if (typeof dirPath !== 'string' || !isPathAllowed(dirPath)) return []
      const entries = await fs.promises.readdir(dirPath, { withFileTypes: true })
      return entries.map((e) => ({
        name: e.name,
        path: path.join(dirPath, e.name),
        isDirectory: e.isDirectory(),
      }))
    } catch {
      return []
    }
  })

  ipcMain.handle('fs:readFile', async (_event, filePath: string) => {
    try {
      // 只允许读取已扫描目录内的文件，防止任意文件读取
      if (typeof filePath !== 'string' || !isPathAllowed(filePath)) return new ArrayBuffer(0)
      const buf = await fs.promises.readFile(filePath)
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    } catch {
      return new ArrayBuffer(0)
    }
  })

  ipcMain.handle('window:minimize', () => {
    mainWindow?.minimize()
  })

  ipcMain.handle('window:maximize', () => {
    if (mainWindow?.isMaximized()) {
      mainWindow.unmaximize()
    } else {
      mainWindow?.maximize()
    }
  })

  ipcMain.handle('window:close', () => {
    mainWindow?.close()
  })

  ipcMain.handle('window:isMaximized', () => {
    return mainWindow?.isMaximized() ?? false
  })

  // 无边框窗口的边缘缩放：由渲染进程驱动鼠标手势，主进程应用 setBounds
  ipcMain.handle('window:getBounds', () => {
    if (!mainWindow) return null
    return mainWindow.getBounds()
  })

  ipcMain.handle('window:setBounds', (_event, bounds: Electron.Rectangle) => {
    if (!mainWindow) return
    mainWindow.setBounds(bounds)
  })

  ipcMain.handle('app:getUserDataPath', () => {
    return app.getPath('userData')
  })

  ipcMain.handle('scan:start', async (_event, folderPath: string) => {
    if (typeof folderPath !== 'string' || !folderPath.trim()) {
      sendToRenderer('scan:error', { folder: '', message: '扫描失败：未指定文件夹' })
      throw new Error('empty folder path')
    }
    // 进入串行队列执行；失败时 runScan 已发送 scan:error 事件
    return enqueueScan(folderPath)
  })

  ipcMain.handle('db:getAllTracks', () => {
    return getAllTracks()
  })

  ipcMain.handle('tracks:get', async (_event, id: string) => {
    return getTrackById(id)
  })

  // 按需补齐封面：扫描时为提速跳过了嵌入图片读取，UI 需要时单独提取并缓存
  ipcMain.handle('covers:ensure', async (_event, id: string): Promise<string | null> => {
    const track = getTrackById(id)
    if (!track) return null
    return ensureCover(track, app.getPath('userData'))
  })

  // 读取本地歌词文件：路径 ${userData}/aurora-music/lyrics/${trackId}.lrc，不存在返回 null
  ipcMain.handle('lyrics:read', async (_event, trackId: string): Promise<string | null> => {
    try {
      // trackId 白名单校验，防止路径穿越（在线曲目的 id 来自远端服务器）
      if (typeof trackId !== 'string' || !isValidTrackId(trackId)) return null
      const filePath = path.join(app.getPath('userData'), 'aurora-music', 'lyrics', `${trackId}.lrc`)
      const content = await fs.promises.readFile(filePath, 'utf-8')
      return content
    } catch {
      return null
    }
  })

  // 保存歌词到本地，返回保存的文件路径
  ipcMain.handle('lyrics:save', async (_event, lyrics: string, trackId: string): Promise<string> => {
    if (typeof trackId !== 'string' || !isValidTrackId(trackId)) {
      throw new Error('invalid track id')
    }
    if (typeof lyrics !== 'string') lyrics = ''
    const dir = path.join(app.getPath('userData'), 'aurora-music', 'lyrics')
    await fs.promises.mkdir(dir, { recursive: true })
    const filePath = path.join(dir, `${trackId}.lrc`)
    await fs.promises.writeFile(filePath, lyrics, 'utf-8')
    return filePath
  })

  // 在线搜索歌词（LRCLIB API，提供带时间标签的同步歌词）
  // 文档：https://lrclib.net/docs
  ipcMain.handle(
    'lyrics:search',
    async (
      _event,
      query: string,
      artist?: string,
      album?: string,
      duration?: number
    ): Promise<{ lrc: string | null; name: string; artist: string } | null> => {
      const UA = 'Aurora-Music v0.1.2 (https://github.com/yib0601/aurora-music)'
      try {
        // 优先用 /api/get 精确匹配（需要 track_name + artist_name，album 和 duration 提高精度）
        // query 即 track_name，artist 即 artist_name
        const params = new URLSearchParams()
        params.set('track_name', query)
        if (artist) params.set('artist_name', artist)
        if (album) params.set('album_name', album)
        if (duration && duration > 0 && duration <= 3600) params.set('duration', String(Math.round(duration)))

        const getUrl = `https://lrclib.net/api/get?${params.toString()}`
        const getResp = await fetch(getUrl, {
          headers: { 'User-Agent': UA },
          signal: AbortSignal.timeout(8000),
        })

        if (getResp.ok) {
          const data = (await getResp.json()) as {
            trackName?: string
            artistName?: string
            syncedLyrics?: string | null
            plainLyrics?: string | null
          }
          // 优先返回同步歌词（带时间标签），其次纯文本歌词
          const lrc = data.syncedLyrics || data.plainLyrics || null
          if (lrc) {
            return {
              lrc,
              name: data.trackName || query,
              artist: data.artistName || artist || '',
            }
          }
        }

        // /api/get 未命中，用 /api/search 模糊搜索作为 fallback
        const searchParams = new URLSearchParams()
        searchParams.set('track_name', query)
        if (artist) searchParams.set('artist_name', artist)
        const searchUrl = `https://lrclib.net/api/search?${searchParams.toString()}`
        const searchResp = await fetch(searchUrl, {
          headers: { 'User-Agent': UA },
          signal: AbortSignal.timeout(8000),
        })

        if (searchResp.ok) {
          const results = (await searchResp.json()) as Array<{
            trackName?: string
            artistName?: string
            duration?: number
            syncedLyrics?: string | null
            plainLyrics?: string | null
          }>
          if (Array.isArray(results) && results.length > 0) {
            // 如果有 duration，优先选 duration 最接近的
            let best = results[0]
            if (duration && duration > 0) {
              const targetDur = Math.round(duration)
              best = results.reduce((acc, cur) => {
                const accDiff = Math.abs((acc.duration || 0) - targetDur)
                const curDiff = Math.abs((cur.duration || 0) - targetDur)
                return curDiff < accDiff ? cur : acc
              })
            }
            const lrc = best.syncedLyrics || best.plainLyrics || null
            if (lrc) {
              return {
                lrc,
                name: best.trackName || query,
                artist: best.artistName || artist || '',
              }
            }
          }
        }

        return null
      } catch {
        return null
      }
    }
  )

  // 聚合在线搜索：网易云 + QQ音乐 双源并行
  // 单源失败不影响另一源；两源都失败时抛错，前端展示直白的中文网络错误提示
  ipcMain.handle(
    'tracks:searchOnline',
    async (_event, query: string): Promise<OnlineTrackSearchResult[]> => {
      const [neteaseRes, qqRes] = await Promise.allSettled([
        searchNetease(query),
        searchQQ(query),
      ])
      const results: OnlineTrackSearchResult[] = []
      if (neteaseRes.status === 'fulfilled') results.push(...neteaseRes.value)
      if (qqRes.status === 'fulfilled') results.push(...qqRes.value)
      if (neteaseRes.status === 'rejected' && qqRes.status === 'rejected') {
        throw new Error('网络请求失败，请检查网络连接')
      }
      return results
    }
  )
}
