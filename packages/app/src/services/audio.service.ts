import { Howl, Howler } from 'howler'
import type { Track } from '@/types'
import { audioEvents } from './audioEvents'

let tickInterval: ReturnType<typeof setInterval> | null = null
let currentHowl: Howl | null = null
let nextHowl: Howl | null = null
let audioContext: AudioContext | null = null
let analyserNode: AnalyserNode | null = null

const FADE_DURATION = 800 // ms

function getPlatformSrc(path: string): string {
  // 在线流地址直接返回（http/https）
  if (/^https?:\/\//i.test(path)) {
    return path
  }
  const cap = (window as any).Capacitor
  if (cap) {
    return cap.convertFileSrc(path)
  }
  if ((window as any).electronAPI) {
    return `file://${path}`
  }
  return path
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

  // 处理旧 howl：淡出后 unload
  if (currentHowl) {
    const oldHowl = currentHowl
    if (oldHowl.playing()) {
      // 淡出旧曲目
      oldHowl.fade(oldHowl.volume(), 0, FADE_DURATION)
      oldHowl.once('fade', () => {
        oldHowl.unload()
      })
    } else {
      // 没在播放，直接 unload
      oldHowl.unload()
    }
    currentHowl = null
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
    },
    onpause: () => {
      audioEvents.emit('pause', {})
      stopTick()
    },
    onstop: () => {
      audioEvents.emit('stop', {})
      stopTick()
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
    const audioEl = (howl as any)._sounds?.[0]?._node
    if (audioEl && audioEl instanceof HTMLMediaElement) {
      const source = audioContext.createMediaElementSource(audioEl)
      source.connect(analyserNode)
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
  stopTick()
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

export function setOutputDevice(deviceId: string): void {
  if (!currentHowl) return
  const audioEl = (currentHowl as any)._sounds?.[0]?._node
  if (audioEl && typeof (audioEl as any).setSinkId === 'function') {
    (audioEl as any).setSinkId(deviceId).catch((e: any) => {
      console.warn('Failed to set audio output device:', e)
    })
  }
}
