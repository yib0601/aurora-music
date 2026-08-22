import type { Track } from '@/types'
import { isDesktop } from '@/lib/utils'

/**
 * 移动端原生播放器桥接
 *
 * 音频由 Android 原生 MediaPlayer（MediaPlaybackService 内）播放，而非 WebView。
 * 原因：锁屏后系统会杀掉 WebView 渲染进程，WebView 内的 HTML5 Audio 会中断，
 * 且锁屏控件依赖 JS 回调导致点击无响应。原生引擎不受此影响。
 *
 * JS 侧职责：下发队列与控制指令、接收 playbackevent 同步 UI 状态。
 * 桌面端所有函数为空操作。
 */

export interface NativeQueueItem {
  path: string
  title: string
  artist: string
  album: string
}

export interface NativePlaybackEvent {
  type: 'play' | 'pause' | 'prepared' | 'indexChanged' | 'seeked' | 'endedAll' | 'stopped' | 'error'
  position?: number
  duration?: number
  index?: number
  what?: number
  extra?: number
}

interface NativePlayerPlugin {
  start(): Promise<void>
  stop(): Promise<void>
  playQueue(opts: {
    items: NativeQueueItem[]
    index: number
    autoplay: boolean
    position: number
    volume: number
    shuffle: string
    repeat: string
  }): Promise<void>
  syncQueue(opts: { items: NativeQueueItem[]; index: number; shuffle: string; repeat: string }): Promise<void>
  pause(): Promise<void>
  resume(): Promise<void>
  seekTo(opts: { position: number }): Promise<void>
  setVolume(opts: { volume: number }): Promise<void>
  next(): Promise<void>
  previous(): Promise<void>
  playAt(opts: { index: number }): Promise<void>
  stopEngine(): Promise<void>
  getState(): Promise<{ index: number; isPlaying: boolean; position: number; duration: number }>
  addListener(
    eventName: 'playbackevent',
    cb: (data: NativePlaybackEvent) => void
  ): Promise<{ remove: () => Promise<void> }>
  removeAllListeners(): Promise<void>
}

function getPlugin(): NativePlayerPlugin | null {
  if (isDesktop()) return null
  const cap = (window as any).Capacitor
  if (!cap?.Plugins?.MediaSession) return null
  return cap.Plugins.MediaSession as NativePlayerPlugin
}

/** 原生播放器是否可用（仅移动端真机环境为 true） */
export function isNativePlayerAvailable(): boolean {
  return getPlugin() !== null
}

let started = false

/** 启动前台媒体服务（Android 14+ 要求在用户触发播放后尽快调用） */
export async function startNativeService(): Promise<boolean> {
  const plugin = getPlugin()
  if (!plugin) return false
  if (started) return true
  try {
    await plugin.start()
    started = true
    return true
  } catch (e) {
    console.warn('[NativePlayer] start 失败:', e)
    return false
  }
}

export async function stopNativeService(): Promise<void> {
  const plugin = getPlugin()
  if (!plugin) return
  try {
    await plugin.stop()
  } catch (e) {
    console.warn('[NativePlayer] stop 失败:', e)
  }
  started = false
}

/** Track[] → 原生队列项（本地相对路径/在线 URL 原样传递，原生侧转绝对路径） */
export function toQueueItems(tracks: Track[]): NativeQueueItem[] {
  return tracks.map((t) => ({
    path: t.onlineUrl || t.path,
    title: t.title,
    artist: t.artist,
    album: t.album || '',
  }))
}

/**
 * 设置队列并播放。服务实例可能尚未创建完成（startForegroundService 异步），
 * 失败时短暂重试，最多 1.5s。
 */
export async function nativePlayQueue(
  items: NativeQueueItem[],
  index: number,
  autoplay: boolean,
  positionSec: number,
  volume: number,
  shuffle: string,
  repeat: string
): Promise<void> {
  const plugin = getPlugin()
  if (!plugin) return
  for (let attempt = 0; attempt < 15; attempt++) {
    try {
      await plugin.playQueue({ items, index, autoplay, position: positionSec, volume, shuffle, repeat })
      return
    } catch (e) {
      if (attempt === 14) {
        console.warn('[NativePlayer] playQueue 失败:', e)
        return
      }
      await new Promise((r) => setTimeout(r, 100))
    }
  }
}

/** 仅同步队列镜像（增删队列、切换循环/随机时），不打断播放 */
export function nativeSyncQueue(
  items: NativeQueueItem[],
  index: number,
  shuffle: string,
  repeat: string
): void {
  const plugin = getPlugin()
  if (!plugin) return
  plugin.syncQueue({ items, index, shuffle, repeat }).catch(() => {})
}

export function nativePause(): void {
  getPlugin()?.pause().catch(() => {})
}

export function nativeResume(): void {
  getPlugin()?.resume().catch(() => {})
}

export function nativeSeekTo(positionSec: number): void {
  getPlugin()?.seekTo({ position: positionSec }).catch(() => {})
}

export function nativeSetVolume(volume: number): void {
  getPlugin()?.setVolume({ volume }).catch(() => {})
}

export function nativeNext(): void {
  getPlugin()?.next().catch(() => {})
}

export function nativePrevious(): void {
  getPlugin()?.previous().catch(() => {})
}

export function nativePlayAt(index: number): void {
  getPlugin()?.playAt({ index }).catch(() => {})
}

/** 查询原生引擎播放快照（服务未启动时返回空状态） */
export async function nativeGetState(): Promise<{ index: number; isPlaying: boolean; position: number; duration: number }> {
  const plugin = getPlugin()
  if (!plugin) return { index: -1, isPlaying: false, position: 0, duration: 0 }
  try {
    return await plugin.getState()
  } catch {
    return { index: -1, isPlaying: false, position: 0, duration: 0 }
  }
}

export function nativeStopEngine(): void {
  getPlugin()?.stopEngine().catch(() => {})
}

/**
 * 订阅原生引擎播放状态事件。返回反注册函数。
 * 事件类型：play / pause / prepared / indexChanged / seeked / endedAll / stopped / error
 */
export async function onPlaybackEvent(cb: (event: NativePlaybackEvent) => void): Promise<() => void> {
  const plugin = getPlugin()
  if (!plugin) return () => {}
  try {
    const listener = await plugin.addListener('playbackevent', cb)
    return () => {
      listener.remove().catch(() => {})
    }
  } catch (e) {
    console.warn('[NativePlayer] addListener 失败:', e)
    return () => {}
  }
}
