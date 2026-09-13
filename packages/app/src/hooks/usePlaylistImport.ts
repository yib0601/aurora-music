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
  dedupeTracksForDisplay,
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

    // 在去重后的曲库上做名称匹配：同一首歌既有本机副本又有 NAS 副本时，
    // 导入的歌单绑定到本机副本（用户偏好本机，且播放不依赖网络）
    const localMatches = matchTracksByNames(
      songs,
      dedupeTracksForDisplay(useLibraryStore.getState().tracks).tracks
    )
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
      if (imported.length === 0) {
        // 一首都没匹配到：不创建空歌单，对话框保持打开供用户调整
        setPhase('idle')
        toast('没有可导入的歌曲：本地曲库未匹配，在线匹配也无结果', { type: 'error', duration: 6000 })
        return null
      }
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
