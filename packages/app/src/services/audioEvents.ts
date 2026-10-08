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
  /**
   * 加载/播放失败。⚠️ 必须带上**出错的曲目**（trackId 至少要带）：
   * 旧曲目的 Howl 出错回调有可能在新曲目已开始后送达，订阅方若按
   * 「当前曲目」判定，就会把用户刚点的那首误当成坏文件踢出队列。
   */
  error: { error: unknown; trackId?: string }
  trackChange: { track: Track }
  // 播放统计事件：服务层触发，libraryStore 独立订阅更新曲库数据。
  // 携带完整曲目快照：在线曲目不在本地曲库（updateTrack 对其无效），
  // 订阅方需据此把播放记录登记到 recentPlayedTracks 持久化
  playStatsUpdate: { trackId: string; lastPlayedAt: number; playCount: number; track: Track }
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
