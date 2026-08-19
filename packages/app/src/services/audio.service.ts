import { Howl, Howler } from 'howler'
import type { Track } from '@/types'
import { audioEvents } from './audioEvents'
import { platform } from '@/services/platform'
import {
  ensureMediaSessionStarted,
  updateNativePlayback,
  stopMediaSession,
} from './mediaSession'

let tickInterval: ReturnType<typeof setInterval> | null = null
let currentHowl: Howl | null = null
let nextHowl: Howl | null = null
let audioContext: AudioContext | null = null
let analyserNode: AnalyserNode | null = null
let currentMediaSource: MediaElementAudioSourceNode | null = null

const FADE_DURATION = 800 // ms

function getPlatformSrc(path: string): string {
  // 在线流地址直接返回（http/https）
  if (/^https?:\/\//i.test(path)) {
    return path
  }
  // 委托 platform 层处理协议转换（桌面端 cover-local://，移动端 Capacitor.convertFileSrc）
  return platform.getAudioSrc(path)
}

function startTick(howl: Howl) {
  if (tickInterval) clearInterval(tickInterval)
  // ⚠️ 性能：500ms 足够进度条显示，过高频率会触发 LyricsView/PlayerBar 频繁更新
  tickInterval = setInterval(() => {
    const progress = howl.seek() as number
    if (typeof progress === 'number' && !isNaN(progress)) {
      audioEvents.emit('progress', { currentTime: progress })
    }
  }, 500)
}

function stopTick() {
  if (tickInterval) {
    clearInterval(tickInterval)
    tickInterval = null
  }
}

export function initAudioAnalyser(): AnalyserNode | null {
  try {
    const AC = window.AudioContext || (window as any).webkitAudioContext
    if (!AC) return null

    if (!audioContext) {
      audioContext = new AC()
      analyserNode = audioContext.createAnalyser()
      analyserNode.fftSize = 2048
      analyserNode.smoothingTimeConstant = 0.8
      analyserNode.connect(audioContext.destination)
    }
    return analyserNode
  } catch {
    return null
  }
}

export function getAnalyser(): AnalyserNode | null {
  return analyserNode
}

export function playTrack(track: Track, volume: number = 0.7, muted: boolean = false, autoplay: boolean = true): void {
  const targetVolume = muted ? 0 : volume

  // 处理旧 howl：立即停止播放并清理,避免新旧 Howl 同时播放导致重叠声音
  // 注:为保持切换流畅,不使用异步 fade out——旧 Howl 立即 unload,新 Howl fade in
  if (currentHowl) {
    const oldHowl = currentHowl
    // 立即停止输出(即使 unload 之前的 fade 也已无效)
    oldHowl.volume(0)
    oldHowl.unload()
    currentHowl = null
  }
  // 清理旧 MediaElementSource 节点
  if (currentMediaSource) {
    try { currentMediaSource.disconnect() } catch {}
    currentMediaSource = null
  }
  stopTick()

  // 在线流优先使用 onlineUrl，本地用 path
  const rawPath = track.onlineUrl || track.path
  const src = getPlatformSrc(rawPath)
  const isOnline = /^https?:\/\//i.test(rawPath)

  const howl = new Howl({
    src: [src],
    html5: true,
    format: isOnline ? undefined : detectFormat(track.path),
    volume: 0, // 初始为 0，播放后 fade in
    onplay: () => {
      audioEvents.emit('play', { track })
      // 触发播放统计事件，libraryStore 独立订阅更新音乐库数据
      audioEvents.emit('playStatsUpdate', {
        trackId: track.id,
        lastPlayedAt: Date.now(),
        playCount: (track.playCount || 0) + 1,
      })
      if (audioContext && audioContext.state === 'suspended') {
        audioContext.resume()
      }
      startTick(howl)
      // 通知原生 MediaSession：正在播放（保持 foreground service 活跃 +
      // Honor 系统才会把 STREAM_MUSIC 路由到扬声器而非 remote_submix）
      updateNativePlayback({
        isPlaying: true,
        position: 0,
        duration: howl.duration() || 0,
        track,
      }).catch(() => {})
    },
    onpause: () => {
      audioEvents.emit('pause', {})
      stopTick()
      updateNativePlayback({
        isPlaying: false,
        position: howl.seek() as number,
        duration: howl.duration() || 0,
        track,
      }).catch(() => {})
    },
    onstop: () => {
      audioEvents.emit('stop', {})
      stopTick()
      updateNativePlayback({
        isPlaying: false,
        position: 0,
        duration: howl.duration() || 0,
        track,
      }).catch(() => {})
    },
    onend: () => {
      stopTick()
      audioEvents.emit('end', {})
    },
    onload: () => {
      const dur = howl.duration()
      audioEvents.emit('duration', { duration: dur })
    },
    onloaderror: (_id, error) => {
      console.error('Audio load error:', error)
      audioEvents.emit('error', { error })
    },
    onplayerror: (_id, error) => {
      console.error('Audio play error:', error)
      howl.once('unlock', () => howl.play())
    },
  })

  currentHowl = howl
  audioEvents.emit('trackChange', { track })

  // 启动原生 MediaSession foreground service（Android 14+ 要求播放后才能 start）
  // 用 .catch 避免 fg service 启动失败影响播放本身
  ensureMediaSessionStarted()
    .then(() =>
      updateNativePlayback({
        isPlaying: autoplay,
        position: 0,
        duration: howl.duration() || 0,
        track,
      })
    )
    .catch(() => {})

  if (autoplay) {
    howl.play()
    // 淡入到目标音量
    howl.fade(0, targetVolume, FADE_DURATION)
  } else {
    // 不自动播放（断点续播场景），直接设置目标音量
    howl.volume(targetVolume)
  }

  connectAnalyser(howl)
}

/**
 * 预加载下一首曲目（gapless 播放预留接口）
 * TODO: 实现真正的无缝播放需要 playerStore 提供 getNextTrack() 方法
 */
export function preloadNextTrack(_track: Track, _volume: number, _muted: boolean): void {
  // 预留接口，暂不实现
}

function connectAnalyser(howl: Howl) {
  if (!analyserNode) {
    initAudioAnalyser()
  }
  if (!analyserNode || !audioContext) return

  try {
    // ⚠️ howler 私有 API：防御性访问，内部结构变化时静默降级（无可视化但正常出声）
    const audioEl = (howl as any)?._sounds?.[0]?._node
    if (audioEl && audioEl instanceof HTMLMediaElement) {
      // 同一个 audioEl 只能创建一次 MediaElementSource,否则抛 InvalidStateError
      // 用属性标记缓存,避免重复创建;但 howler 会复用 html5 Audio 元素,
      // 切歌时命中缓存也需强制重连 analyser,否则 AudioContext 挂起导致不播放、进度卡 00:00
      let source = (audioEl as any).__auroraSource
      if (!source) {
        source = audioContext.createMediaElementSource(audioEl)
        ;(audioEl as any).__auroraSource = source
      }
      try { source.disconnect() } catch {}
      source.connect(analyserNode)
      currentMediaSource = source
    } else {
      console.warn('Analyser: 无法获取 audio 元素，跳过可视化连接')
    }
  } catch (e) {
    console.warn('Analyser connection failed:', e)
  }
}

export function pausePlayback(): void {
  if (currentHowl && currentHowl.playing()) {
    currentHowl.pause()
  }
}

export function resumePlayback(): void {
  if (currentHowl) {
    currentHowl.play()
  }
}

/** 当前是否持有 Howl 实例（用于判断 togglePlay 是否需要重建播放器） */
export function hasCurrentHowl(): boolean {
  return currentHowl !== null
}

export function seekTo(seconds: number): void {
  if (currentHowl) {
    currentHowl.seek(seconds)
    audioEvents.emit('progress', { currentTime: seconds })
  }
}

export function setVolume(volume: number): void {
  if (currentHowl) {
    currentHowl.volume(volume)
  }
}

export function setMuted(muted: boolean, volume: number = 0.7): void {
  if (currentHowl) {
    currentHowl.volume(muted ? 0 : volume)
  }
}

export function togglePlayPause(isPlaying: boolean): void {
  if (isPlaying) {
    pausePlayback()
  } else {
    resumePlayback()
  }
}

export function stopPlayback(): void {
  if (currentHowl) {
    currentHowl.stop()
    currentHowl.unload()
    currentHowl = null
  }
  if (nextHowl) {
    nextHowl.unload()
    nextHowl = null
  }
  if (currentMediaSource) {
    try { currentMediaSource.disconnect() } catch {}
    currentMediaSource = null
  }
  stopTick()
  // 停止原生 MediaSession foreground service
  stopMediaSession().catch(() => {})
}

function detectFormat(path: string): string | undefined {
  const ext = path.split('.').pop()?.toLowerCase()
  if (!ext) return undefined
  const map: Record<string, string> = {
    mp3: 'mp3',
    flac: 'flac',
    m4a: 'mp4',
    aac: 'aac',
    ogg: 'ogg',
    wav: 'wav',
    wma: 'wma',
  }
  return map[ext]
}

export function cleanupAudio(): void {
  stopPlayback()
  if (audioContext) {
    audioContext.close()
    audioContext = null
    analyserNode = null
  }
}

/**
 * 为当前 Howl 注册一次性的 load 回调,用于断点续播场景下精确 seek
 * 如果 Howl 已加载则立即调用 callback
 */
export function onCurrentTrackLoad(callback: () => void): void {
  if (!currentHowl) return
  const dur = currentHowl.duration()
  // Howl duration() 在未加载时返回 0
  if (dur && isFinite(dur) && dur > 0) {
    callback()
  } else {
    currentHowl.once('load', callback)
  }
}

export function setOutputDevice(deviceId: string): void {
  if (!currentHowl) return
  const audioEl = (currentHowl as any)._sounds?.[0]?._node
  if (audioEl && typeof (audioEl as any).setSinkId === 'function') {
    (audioEl as any).setSinkId(deviceId).catch((e: any) => {
      console.warn('Failed to set audio output device:', e)
    })
  }
}
