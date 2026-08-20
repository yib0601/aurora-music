import type { OnlineTrackSearchResult, OnlineSearchOptions, OnlineSourceConfig } from '@/types'

// 统一 UA（部分接口对 UA 敏感）— 与桌面端 packages/desktop/src/ipc/handlers.ts 保持一致
const HTTP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

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
    const urlResp = await fetch(
      `https://music.163.com/api/song/enhance/player/url?${urlParams.toString()}`,
      {
        headers: { 'User-Agent': HTTP_UA, Referer: 'https://music.163.com' },
        signal: AbortSignal.timeout(8000),
      }
    )
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
        const artistName =
          s.artists?.map((a) => a.name).join(', ') || s.artist?.name || '未知艺术家'
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
    console.warn('网易云搜索失败:', err)
    throw err
  }
}

// QQ音乐搜索：client_search_cp 搜列表 → musicu.fcg 用 songmid 换 purl，拼 isure.stream 直链
async function searchQQ(query: string): Promise<OnlineTrackSearchResult[]> {
  try {
    const trimmed = (query || '').trim()
    if (!trimmed) return []

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

    // 批量获取播放 purl（用 songmid 换）
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
          coverUrl: albumMid
            ? `https://y.gtimg.cn/music/photo_new/T002R120x120M000${albumMid}.jpg`
            : undefined,
          audioUrl: purlMap.get(s.mid)!,
          source: 'qq' as const,
        }
      })
  } catch (err) {
    console.warn('QQ音乐搜索失败:', err)
    throw err
  }
}

/**
 * 自定义音乐源搜索：用户在设置页配置的接口
 * 与桌面端 packages/desktop/src/ipc/handlers.ts 中 searchCustomSource 逻辑保持一致
 */
async function searchCustomSource(
  source: OnlineSourceConfig,
  query: string
): Promise<OnlineTrackSearchResult[]> {
  try {
    const trimmed = (query || '').trim()
    if (!trimmed) return []
    if (!source.apiUrl || !source.apiUrl.includes('{query}')) {
      throw new Error(`源「${source.name}」的接口地址无效，必须包含 {query} 占位符`)
    }

    const url = source.apiUrl.replace('{query}', encodeURIComponent(trimmed))
    const resp = await fetch(url, {
      headers: { 'User-Agent': HTTP_UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    })
    if (!resp.ok) throw new Error(`源「${source.name}」返回 HTTP ${resp.status}`)

    const json = (await resp.json()) as any
    let rawItems: any[] = []
    if (Array.isArray(json)) {
      rawItems = json
    } else if (Array.isArray(json?.results)) {
      rawItems = json.results
    } else if (Array.isArray(json?.data)) {
      rawItems = Array.isArray(json.data) ? json.data : Array.isArray(json.data?.song?.list) ? json.data.song.list : []
    } else if (Array.isArray(json?.songs)) {
      rawItems = json.songs
    } else if (Array.isArray(json?.list)) {
      rawItems = json.list
    }

    const results: OnlineTrackSearchResult[] = []
    for (const item of rawItems) {
      if (!item || typeof item !== 'object') continue
      const audioUrl =
        item.audioUrl || item.url || item.playUrl || item.play_url || item.link
      if (!audioUrl || typeof audioUrl !== 'string') continue
      const rawId = item.id ?? item.songId ?? item.song_id ?? item.mid
      const idStr = rawId != null ? String(rawId) : `custom-${source.id}-${results.length}`
      results.push({
        id: `custom-${source.id}-${idStr}`,
        title: String(item.title || item.name || item.songName || '未知歌曲'),
        artist: String(item.artist || item.singer || item.artists || '未知艺术家'),
        album: String(item.album || item.albumName || ''),
        duration: Number(item.duration || item.interval || 0) || 0,
        coverUrl: item.coverUrl || item.cover || item.picUrl || item.pic || item.albumPic || undefined,
        audioUrl,
        source: 'custom' as const,
        sourceName: source.name,
      })
    }
    return results
  } catch (err) {
    console.warn(`自定义源「${source.name}」搜索失败:`, err)
    throw err
  }
}

/**
 * 聚合在线搜索：按用户配置并发调用内置源（网易云/QQ）+ 自定义源
 * - options.useNetease 默认 true：启用网易云
 * - options.useQQ 默认 true：启用 QQ 音乐
 * - options.customSources：用户自定义源列表，仅 enabled=true 的会被调用
 * - 单源失败不影响其他源；全部失败时抛错，前端展示直白的中文网络错误提示
 */
export async function searchOnlineTracks(
  query: string,
  options?: OnlineSearchOptions
): Promise<OnlineTrackSearchResult[]> {
  const useNetease = options?.useNetease !== false
  const useQQ = options?.useQQ !== false
  const customSources = (options?.customSources || []).filter((s) => s && s.enabled && s.apiUrl)

  const tasks: Promise<OnlineTrackSearchResult[]>[] = []
  if (useNetease) tasks.push(searchNetease(query))
  if (useQQ) tasks.push(searchQQ(query))
  for (const src of customSources) {
    tasks.push(searchCustomSource(src, query))
  }

  if (tasks.length === 0) return []

  const settled = await Promise.allSettled(tasks)
  const results: OnlineTrackSearchResult[] = []
  let allFailed = true
  for (const r of settled) {
    if (r.status === 'fulfilled') {
      allFailed = false
      results.push(...r.value)
    }
  }
  if (allFailed) {
    throw new Error('所有音乐源请求失败，请检查网络连接或源配置')
  }
  return results
}

/**
 * 在线搜索歌词（LRCLIB API，提供带时间标签的同步歌词）
 * 与桌面端 packages/desktop/src/ipc/handlers.ts 中 lyrics:search 逻辑保持一致
 */
export async function searchLyrics(
  query: string,
  artist?: string,
  album?: string,
  duration?: number
): Promise<{ lrc: string | null; name: string; artist: string } | null> {
  const UA = 'Aurora-Music v0.1.9 (https://github.com/yib0601/aurora-music)'
  try {
    // 优先用 /api/get 精确匹配（需要 track_name + artist_name，album 和 duration 提高精度）
    const params = new URLSearchParams()
    params.set('track_name', query)
    if (artist) params.set('artist_name', artist)
    if (album) params.set('album_name', album)
    if (duration && duration > 0 && duration <= 3600)
      params.set('duration', String(Math.round(duration)))

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
