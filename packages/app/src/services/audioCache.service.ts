/**
 * 在线播放缓存（渲染层门面）
 *
 * 缓存实体在主进程磁盘（见 desktop/ipc/audioCache.ts）：歌源直链有效期只有
 * 几十分钟，不能作为缓存键，这里按「来源 id + 歌曲 id」推导稳定键。
 * 命中时返回 aurora-cache:// 播放地址；未命中时主进程后台拉流写入，本次
 * 播放仍走源直链，下次再播同一首即命中。
 *
 * 仅桌面端实现；Web / 移动端平台层未实现对应方法，调用处可选链短路。
 */
import { platform } from '@/services/platform'
import { useLibraryStore } from '@/stores/libraryStore'
import type { Track } from '@/types'

/** 从曲目推导稳定缓存键：直链会变，来源内歌曲 id 不变 */
export function cacheKeyForTrack(track: Track): string | null {
  const songId = track.onlineId || track.id
  if (!track.onlineSource || !songId) return null
  return `${track.onlineSource}|${songId}`
}

/**
 * 解析播放地址：命中缓存返回缓存协议地址，未命中返回 null（并已由主进程
 * 触发后台下载）。直链过期/网络异常时由调用方回退到原始地址。
 * 附加请求头（Referer/UA 等）自动取自该曲目对应歌源配置，与搜索/下载请求一致。
 */
export async function resolveCachedAudioSrc(track: Track): Promise<string | null> {
  const url = track.onlineUrl
  if (!url || !/^https?:\/\//i.test(url)) return null
  const key = cacheKeyForTrack(track)
  if (!key) return null
  const source = useLibraryStore.getState().onlineSources.find((s) => s.id === track.onlineSource)
  try {
    const res = await platform.resolveCachedAudio?.({ url, key, headers: source?.headers })
    return res?.src || null
  } catch {
    return null
  }
}

/** 下发缓存容量配置（0 = 关闭并清空） */
export async function configureAudioCache(limitMB: number): Promise<void> {
  try {
    await platform.configureAudioCache?.({ limitMB })
  } catch {
    // 平台不支持时静默
  }
}

/** 当前缓存占用；平台不支持时返回零值 */
export async function getAudioCacheUsage(): Promise<{ usedBytes: number; count: number }> {
  try {
    return (await platform.getAudioCacheUsage?.()) || { usedBytes: 0, count: 0 }
  } catch {
    return { usedBytes: 0, count: 0 }
  }
}

export async function clearAudioCache(): Promise<void> {
  try {
    await platform.clearAudioCache?.()
  } catch {
    // 忽略
  }
}
