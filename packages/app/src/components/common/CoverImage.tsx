import { useEffect, useState, type ImgHTMLAttributes, type ReactNode } from 'react'
import type { Track } from '@/types'
import { platform } from '@/services/platform'
import { useLibraryStore } from '@/stores/libraryStore'

/**
 * 封面懒加载组件。
 *
 * 背景：桌面端扫描阶段用 `skipCovers: true` 跳过内嵌图片读取以保证扫描速度
 * （这是扫描提速的最大来源），封面改为按需提取——主进程 `ensureCover()`
 * 通过 `covers:ensure` IPC 解析并落盘缓存。
 * 因此渲染层必须在 `coverPath` 缺失时主动触发一次提取，否则新入库曲目的
 * 封面永远是空的（UI 全部走 `coverPath ? <img> : <占位>` 分支）。
 *
 * 两个关键设计点：
 * 1. 结果同时写入「组件本地 state」与 libraryStore。playerStore 的 queue /
 *    currentTrack 是 Track 的独立副本，与 libraryStore 不同源，只更新 store
 *    无法刷新播放条与队列里的封面。
 * 2. 同一首歌的提取按 trackId 合并为一次请求，并缓存结果（含"确认无封面"），
 *    避免列表里同一首歌多次渲染时重复解析同一个音频文件。
 */

/** 已完成提取的曲目：值为封面路径，null 表示确认该曲目无内嵌封面 */
const resolvedCovers = new Map<string, string | null>()
/** 进行中的提取，供同一首歌的多个渲染实例复用同一个 Promise */
const inflightCovers = new Map<string, Promise<string | null>>()

function requestCover(trackId: string): Promise<string | null> {
  if (resolvedCovers.has(trackId)) return Promise.resolve(resolvedCovers.get(trackId)!)
  const running = inflightCovers.get(trackId)
  if (running) return running

  const task = Promise.resolve(platform.ensureCover?.(trackId))
    .then((result) => {
      // 失败或无封面都记 null：避免每次渲染反复触发 IPC 解析
      resolvedCovers.set(trackId, result ?? null)
      return result ?? null
    })
    .catch(() => {
      resolvedCovers.set(trackId, null)
      return null
    })
    .finally(() => {
      inflightCovers.delete(trackId)
    })

  inflightCovers.set(trackId, task)
  return task
}

/** 仅取封面相关字段，便于传入 playerStore 队列项等 Track 副本 */
type CoverTrack = Pick<Track, 'id' | 'coverPath' | 'onlineUrl'>

export interface CoverImageProps extends Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'> {
  track?: CoverTrack | null
  /** 无封面（或图片加载失败）时渲染的占位内容 */
  fallback?: ReactNode
}

export function CoverImage({ track, fallback = null, alt = '', ...imgProps }: CoverImageProps) {
  const updateTrack = useLibraryStore((s) => s.updateTrack)
  const [resolved, setResolved] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  const trackId = track?.id
  const coverPath = track?.coverPath
  // 在线曲目的封面是远端 https 地址，只有本地文件才需要按需提取
  const needsExtraction = !!trackId && !coverPath && !track?.onlineUrl

  // 曲目切换时清空上一首的解析结果与失败态
  useEffect(() => {
    setResolved(null)
    setFailed(false)
  }, [trackId, coverPath])

  useEffect(() => {
    if (!needsExtraction || !platform.ensureCover) return
    let cancelled = false
    requestCover(trackId!).then((path) => {
      if (cancelled || !path) return
      setResolved(path)
      // 回写 store：其他列表位置立即复用（DB 持久化由主进程 ensureCover 完成）
      updateTrack(trackId!, { coverPath: path })
    })
    return () => {
      cancelled = true
    }
  }, [trackId, needsExtraction, updateTrack])

  const src = coverPath || resolved
  // 封面文件缺失/损坏时回退到占位图，而不是留一个碎图或空框
  if (!src || failed) return <>{fallback}</>

  return (
    <img
      {...imgProps}
      src={platform.getCoverSrc(src)}
      alt={alt}
      onError={(e) => {
        setFailed(true)
        imgProps.onError?.(e)
      }}
    />
  )
}
