import { useEffect, useState, type ImgHTMLAttributes, type ReactNode } from 'react'
import type { Track } from '@/types'
import { platform } from '@/services/platform'
import { resolveCachedCoverSrc } from '@/services/audioCache.service'
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
 *
 * 远端封面缓存：在线曲目的封面本身就是远端地址，逐次渲染都要重新下载，
 * 交给主进程按曲目身份缓存到本地（音频、封面、歌词共用一份容量配额），
 * 命中后直接读本地文件；缓存被清掉时退回远端地址重试。
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
type CoverTrack = Pick<Track, 'id' | 'coverPath' | 'coverUrl' | 'onlineUrl' | 'onlineId' | 'onlineSource'>

/**
 * 远端封面（在线曲目的 coverUrl）的本地缓存地址。
 * 命中即记下来，同一地址在会话内不再重复问主进程；未命中不记，
 * 等主进程后台写完下次挂载再问一次。
 */
const cachedRemoteCovers = new Map<string, string>()
const inflightRemoteCovers = new Map<string, Promise<string | null>>()

function requestRemoteCoverCache(track: CoverTrack): Promise<string | null> {
  const url = track.coverUrl
  if (!url) return Promise.resolve(null)
  const cached = cachedRemoteCovers.get(url)
  if (cached) return Promise.resolve(cached)
  const running = inflightRemoteCovers.get(url)
  if (running) return running
  const task = resolveCachedCoverSrc(track)
    .then((src) => {
      if (src) cachedRemoteCovers.set(url, src)
      return src
    })
    .catch(() => null)
    .finally(() => {
      inflightRemoteCovers.delete(url)
    })
  inflightRemoteCovers.set(url, task)
  return task
}

/**
 * 丢弃会话内的封面解析结果：清空缓存后调用。
 * 解析结果（内嵌提取与在线获取的终态）此前会整会话复用，不清就会一直指向
 * 已被删掉的文件。
 */
export function resetCoverCache(): void {
  resolvedCovers.clear()
  resolvedOnlineCovers.clear()
  cachedRemoteCovers.clear()
}

export interface CoverImageProps extends Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'> {
  track?: CoverTrack | null
  /** 无封面（或图片加载失败）时渲染的占位内容 */
  fallback?: ReactNode
}

/** 内嵌封面短边低于该值视为低清：铺满沉浸背景会明显糊，触发在线高清补齐 */
const LOWRES_COVER_THRESHOLD = 512

export function CoverImage({ track, fallback = null, alt = '', ...imgProps }: CoverImageProps) {
  const updateTrack = useLibraryStore((s) => s.updateTrack)
  const [resolved, setResolved] = useState<string | null>(null)
  const [upgraded, setUpgraded] = useState<string | null>(null)
  const [cachedRemote, setCachedRemote] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  const trackId = track?.id
  const coverPath = track?.coverPath
  const coverUrl = track?.coverUrl
  // 在线曲目的封面是远端 https 地址，只有本地文件才需要按需提取
  const needsExtraction = !!trackId && !coverPath && !track?.onlineUrl

  // 曲目切换时清空上一首的解析结果与失败态
  useEffect(() => {
    setResolved(null)
    setFailed(false)
    setUpgraded(null)
    setCachedRemote(null)
  }, [trackId, coverPath, coverUrl])

  // 远端封面：先问主进程本地缓存有没有，命中就直接读本地文件，不再走网络；
  // 未命中时主进程已在后台拉取，本次仍显示远端地址（见下面的 src 计算）
  useEffect(() => {
    if (!trackId || !coverUrl || !/^https?:\/\//i.test(coverUrl)) return
    let cancelled = false
    requestRemoteCoverCache(track!).then((src) => {
      if (!cancelled && src) setCachedRemote(src)
    })
    return () => {
      cancelled = true
    }
  }, [trackId, coverUrl, track?.onlineSource, track?.onlineId])

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

  // 低清内嵌封面升级：内嵌封面短边过小时（铺满沉浸背景会明显糊），
  // 复用在线兜底搜索一张高清封面覆盖。已升级过的（coverPath 指向在线缓存）不再重复触发。
  useEffect(() => {
    if (!trackId || !coverPath || track?.onlineUrl) return
    let cancelled = false
    const img = new Image()
    img.onload = () => {
      if (cancelled) return
      if (Math.min(img.naturalWidth, img.naturalHeight) >= LOWRES_COVER_THRESHOLD) return
      requestOnlineCover(trackId).then((onlinePath) => {
        if (!cancelled && onlinePath) {
          setUpgraded(onlinePath)
          updateTrack(trackId, { coverPath: onlinePath })
        }
      })
    }
    img.src = platform.getCoverSrc(coverPath)
    return () => {
      cancelled = true
    }
  }, [trackId, coverPath, track?.onlineUrl, updateTrack])

  const src = upgraded || coverPath || resolved
  // 在线曲目无本地封面时用源提供的远端 coverUrl（本地路径才走 cover-local 协议）
  const remoteSrc = !src && track?.coverUrl && /^https?:\/\//i.test(track.coverUrl) ? track.coverUrl : null
  // 远端封面命中本地缓存后用缓存地址；否则本次仍读远端地址
  const finalSrc = src ? platform.getCoverSrc(src) : cachedRemote || remoteSrc
  // 封面文件缺失/损坏时回退到占位图，而不是留一个碎图或空框
  if (!finalSrc || failed) return <>{fallback}</>

  return (
    <img
      {...imgProps}
      src={finalSrc}
      alt={alt}
      // 远端封面常有防盗链，不发送 Referer（读本地缓存文件时无需该策略，与搜索列表一致）
      referrerPolicy={!src && !cachedRemote && remoteSrc ? 'no-referrer' : imgProps.referrerPolicy}
      onError={(e) => {
        // 远端封面的本地缓存文件可能刚被清掉（缓存驱逐/清空）：丢掉这个缓存地址，
        // 退回原始远端地址重试；不重试的话列表里这一格会一直停在碎图上
        if (!src && cachedRemote && coverUrl) {
          cachedRemoteCovers.delete(coverUrl)
          setCachedRemote(null)
          setFailed(false)
          imgProps.onError?.(e)
          return
        }
        // 本地封面文件同样可能是刚被驱逐掉的：清掉记录让组件重新提取，
        // 否则 store 里 coverPath 还在、needsExtraction 不触发，封面就永久空了
        // （重新提取有「确认无封面」终态兜底，不会反复重试）
        if (src && trackId) updateTrack(trackId, { coverPath: undefined })
        setFailed(true)
        imgProps.onError?.(e)
      }}
    />
  )
}
