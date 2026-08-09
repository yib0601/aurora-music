import { ipcMain, dialog, BrowserWindow } from 'electron'
import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import { getAllTracks, initDatabase } from './database'
import { scanFolder } from './scanner'
import type { OnlineTrackSearchResult } from '../types'

let mainWindow: BrowserWindow | null = null

export function setMainWindow(win: BrowserWindow) {
  mainWindow = win
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
  } catch {
    return []
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
  } catch {
    return []
  }
}

export function registerIpcHandlers() {
  initDatabase()

  ipcMain.handle('dialog:openFolder', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openDirectory'],
      title: '选择音乐文件夹',
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle('fs:readDir', async (_event, dirPath: string) => {
    try {
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
    const userData = app.getPath('userData')
    mainWindow?.webContents.send('scan:progress', {
      current: 0,
      total: 0,
      file: '准备扫描...',
    })

    const tracks = await scanFolder(folderPath, userData, (progress) => {
      mainWindow?.webContents.send('scan:progress', progress)
    })

    const allTracks = getAllTracks()
    mainWindow?.webContents.send('scan:complete', allTracks)
    return allTracks
  })

  ipcMain.handle('db:getAllTracks', () => {
    return getAllTracks()
  })

  // 读取本地歌词文件：路径 ${userData}/aurora-music/lyrics/${trackId}.lrc，不存在返回 null
  ipcMain.handle('lyrics:read', async (_event, trackId: string): Promise<string | null> => {
    try {
      const filePath = path.join(app.getPath('userData'), 'aurora-music', 'lyrics', `${trackId}.lrc`)
      const content = await fs.promises.readFile(filePath, 'utf-8')
      return content
    } catch {
      return null
    }
  })

  // 保存歌词到本地，返回保存的文件路径
  ipcMain.handle('lyrics:save', async (_event, lyrics: string, trackId: string): Promise<string> => {
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
  // 单源失败不影响另一源，返回结果按 source 分组（前端可按来源展示）
  ipcMain.handle(
    'tracks:searchOnline',
    async (_event, query: string): Promise<OnlineTrackSearchResult[]> => {
      const [neteaseResults, qqResults] = await Promise.all([
        searchNetease(query),
        searchQQ(query),
      ])
      return [...neteaseResults, ...qqResults]
    }
  )
}
