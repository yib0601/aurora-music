import type { Track } from '@/types'

/**
 * 音频事件映射 — 服务层通过事件通知状态变化，状态管理层订阅事件并更新状态
 * 解耦服务层与状态管理层，消除循环依赖
 */
export interface AudioEventMap {
  play: { track: Track }
  pause: {}
  stop: {}
  end: {}
  progress: { currentTime: number }
  duration: { duration: number }
  error: { error: unknown }
  trackChange: { track: Track }
}

type EventHandler<T> = (data: T) => void

class AudioEventEmitter {
  private listeners: Map<string, Set<Function>> = new Map()

  on<K extends keyof AudioEventMap>(event: K, handler: EventHandler<AudioEventMap[K]>): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set())
    }
    this.listeners.get(event)!.add(handler)
    return () => this.off(event, handler)
  }

  off<K extends keyof AudioEventMap>(event: K, handler: EventHandler<AudioEventMap[K]>): void {
    this.listeners.get(event)?.delete(handler)
  }

  emit<K extends keyof AudioEventMap>(event: K, data: AudioEventMap[K]): void {
    this.listeners.get(event)?.forEach((handler) => handler(data))
  }
}

export const audioEvents = new AudioEventEmitter()
