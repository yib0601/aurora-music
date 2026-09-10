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
 * 三个关键设计点：
 * 1. 结果同时写入「组件本地 state」与 libraryStore。playerStore 的 queue /
 *    currentTrack 是 Track 的独立副本，与 libraryStore 不同源，只更新 store
 *    无法刷新播放条与队列里的封面。
 * 2. 同一首歌的提取按 trackId 合并为一次请求；只缓存「成功」与「确认无封面」
 *    两种终态。提取失败（扫描期间记录尚未入库、文件暂不可读等）不缓存，
 *    由组件退避重试，避免一次瞬时失败导致封面整会话空白。
 * 3. 提取并发受限：首屏或扫描完成瞬间可能同时挂载上百个实例，
 *    无限制时会把几百个 IPC/音频解析同时打向主进程。
 *
 * 在线兜底：确认无内嵌封面后（含内嵌提取终态为 null 的曲目），
 * 按标题/艺术家搜索用户配置的在线歌源下载封面。在线结果同样只缓存
 * 「成功」与「确认无匹配」；在线没找到时本次会话不再重复请求，避免刷歌源。
 */

/** 已完成提取的曲目：值为封面路径，null 表示确认该曲目无内嵌封面 */
const resolvedCovers = new Map<string, string | null>()
/** 进行中的提取，供同一首歌的多个渲染实例复用同一个 Promise */
const inflightCovers = new Map<string, Promise<string | null>>()

/** 封面提取并发上限：防止大批量挂载时 IPC/解析瞬间打满主进程 */
const MAX_CONCURRENT_COVERS = 4
let activeCoverRequests = 0
const coverSlotQueue: Array<() => void> = []

async function withCoverSlot<T>(task: () => Promise<T>): Promise<T> {
  if (activeCoverRequests >= MAX_CONCURRENT_COVERS) {
    await new Promise<void>((resolve) => coverSlotQueue.push(resolve))
  }
  activeCoverRequests++
  try {
    return await task()
  } finally {
    activeCoverRequests--
    coverSlotQueue.shift()?.()
  }
}

/** 提取失败后的退避重试间隔（ms），重试耗尽后等下次挂载再试 */
const COVER_RETRY_DELAYS = [2000, 4000, 8000]

function requestCover(trackId: string): Promise<string | null> {
  if (resolvedCovers.has(trackId)) return Promise.resolve(resolvedCovers.get(trackId)!)
  const running = inflightCovers.get(trackId)
  if (running) return running

  const task = withCoverSlot(() => Promise.resolve(platform.ensureCover?.(trackId)))
    .then((result) => {
      // 成功与"确认无内嵌封面"都是终态，缓存避免重复解析同一音频文件
      resolvedCovers.set(trackId, result ?? null)
      return result ?? null
    })
    .catch(() => {
      // 失败不缓存：交给组件退避重试 / 下次挂载重新提取
      return null
    })
    .finally(() => {
      inflightCovers.delete(trackId)
    })

  inflightCovers.set(trackId, task)
  return task
}

/** 已完成在线获取的曲目：值为封面路径，null 表示确认在线也没找到匹配封面 */
const resolvedOnlineCovers = new Map<string, string | null>()
/** 进行中的在线获取，同一首歌的多个渲染实例复用同一个 Promise */
const inflightOnlineCovers = new Map<string, Promise<string | null>>()

function requestOnlineCover(trackId: string): Promise<string | null> {
  if (resolvedOnlineCovers.has(trackId)) return Promise.resolve(resolvedOnlineCovers.get(trackId)!)
  const running = inflightOnlineCovers.get(trackId)
  if (running) return running

  const task = withCoverSlot(() => {
    // 无实现（移动端/Web）或未配置歌源时静默跳过
    const sources = useLibraryStore.getState().onlineSources
    if (!platform.fetchOnlineCover || !sources || sources.length === 0) {
      return Promise.resolve(null)
    }
    return platform.fetchOnlineCover(trackId, { sources })
  })
    .then((result) => {
      // 成功与"确认无匹配"都缓存：在线没找到时本次会话不再重复刷歌源
      resolvedOnlineCovers.set(trackId, result ?? null)
      return result ?? null
    })
    .catch(() => {
      // 在线获取失败不缓存，等下次挂载再试
      return null
    })
    .finally(() => {
      inflightOnlineCovers.delete(trackId)
    })

  inflightOnlineCovers.set(trackId, task)
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
    let retryTimer: ReturnType<typeof setTimeout> | undefined

    const attempt = (retryIndex: number) => {
      requestCover(trackId!).then(async (path) => {
        if (cancelled) return
        if (path) {
          setResolved(path)
          // 回写 store：其他列表位置立即复用（DB 持久化由主进程 ensureCover 完成）
          updateTrack(trackId!, { coverPath: path })
          return
        }
        if (!resolvedCovers.has(trackId!)) {
          // 内嵌提取失败（未入缓存）：退避重试
          if (retryIndex < COVER_RETRY_DELAYS.length) {
            retryTimer = setTimeout(() => attempt(retryIndex + 1), COVER_RETRY_DELAYS[retryIndex])
          }
          return
        }
        // 确认无内嵌封面：在线歌源兜底（在线没找到则本次挂载到此为止）
        const onlinePath = await requestOnlineCover(trackId!)
        if (cancelled || !onlinePath) return
        setResolved(onlinePath)
        updateTrack(trackId!, { coverPath: onlinePath })
      })
    }
    attempt(0)

    return () => {
      cancelled = true
      if (retryTimer) clearTimeout(retryTimer)
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
