import type { Track } from '@/types'
import { isDesktop } from '@/lib/utils'

/**
 * 移动端原生 MediaSession 桥接
 *
 * Honor/Huawei AudioHardening 会把未声明 foreground service 的 app 的
 * STREAM_MUSIC 路由到 remote_submix（静音）。本模块通过 Capacitor 插件
 * 调用 Android 原生 MediaPlaybackService，让系统识别为合法媒体 app，
 * 音频正常路由到扬声器，并支持后台播放 + 通知栏控件。
 *
 * 桌面端为空操作（直接用浏览器 navigator.mediaSession）。
 */

interface NativeMediaSessionPlugin {
  start(): Promise<void>
  stop(): Promise<void>
  updatePlayback(opts: {
    isPlaying: boolean
    position: number
    duration: number
    title?: string | null
    artist?: string | null
    album?: string | null
    coverUrl?: string | null
  }): Promise<void>
  addListener(eventName: 'mediabuttonevent', cb: (data: { action: string; position: number }) => void): Promise<void>
  removeAllListeners(): Promise<void>
}

function getPlugin(): NativeMediaSessionPlugin | null {
  if (isDesktop()) return null
  const cap = (window as any).Capacitor
  if (!cap?.Plugins?.MediaSession) return null
  return cap.Plugins.MediaSession as NativeMediaSessionPlugin
}

let started = false

export async function ensureMediaSessionStarted(): Promise<void> {
  const plugin = getPlugin()
  if (!plugin) return
  if (started) return
  try {
    await plugin.start()
    started = true
  } catch (e) {
    console.warn('[MediaSession] start 失败:', e)
  }
}

export async function stopMediaSession(): Promise<void> {
  const plugin = getPlugin()
  if (!plugin) return
  try {
    await plugin.stop()
    started = false
  } catch (e) {
    console.warn('[MediaSession] stop 失败:', e)
  }
}

export async function updateNativePlayback(opts: {
  isPlaying: boolean
  position: number
  duration: number
  track?: Track | null
}): Promise<void> {
  const plugin = getPlugin()
  if (!plugin) return
  try {
    await plugin.updatePlayback({
      isPlaying: opts.isPlaying,
      position: opts.position,
      duration: opts.duration,
      title: opts.track?.title,
      artist: opts.track?.artist,
      album: opts.track?.album,
      coverUrl: opts.track?.coverPath,
    })
  } catch (e) {
    console.warn('[MediaSession] updatePlayback 失败:', e)
  }
}

/**
 * 注册通知栏/锁屏按钮事件回调（action: play/pause/next/prev/seek/stop）
 * 返回反注册函数
 */
export async function onMediaButtonEvent(cb: (action: string, position?: number) => void): Promise<() => void> {
  const plugin = getPlugin()
  if (!plugin) return () => {}
  const handler = (data: { action: string; position: number }) => cb(data.action, data.position)
  try {
    await plugin.addListener('mediabuttonevent', handler)
  } catch (e) {
    console.warn('[MediaSession] addListener 失败:', e)
    return () => {}
  }
  return () => {
    plugin.removeAllListeners().catch(() => {})
  }
}
