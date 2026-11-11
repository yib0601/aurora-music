/**
 * `Track` → 同步层的曲目匹配输入（`SyncMatchTrack`）。
 *
 * 同一个映射被两处需要：
 * - `services/playlistSync.service.ts`：采集快照（歌单成员）与建匹配索引；
 * - `stores/libraryStore.ts`：用户点收藏时把曲目落成一条跨设备引用（`SyncedLike.ref`）。
 *
 * 各写一份的代价是「收藏用一套字段、歌单用另一套」——两边对同一首歌算出不同的
 * `likeKeyOf`/引用形状，同步时认不出来，症状是「收藏同步过去了，但那首歌在对面
 * 显示成另一首」。所以只留这一份。
 */
import type { SyncMatchTrack, SyncTrackRef } from '@aurora/shared'
import { toSyncTrackRef } from '@aurora/shared'
import type { Track } from '@/types'

/**
 * `onlinePlatformOf` 的口径与 `toSyncTrackRef` 的 `meta.platform` 一致：
 * 优先取源给的定位令牌里的平台，其次取来源标识（`OnlineTrackSearchResult.source` 同口径）。
 */
export function toSyncMatchTrack(track: Track): SyncMatchTrack {
  const platform = track.trackRef?.platform || track.onlineSource || ''
  return {
    id: track.id,
    title: track.title,
    artist: track.artist,
    duration: track.duration,
    path: track.path,
    ...(track.sourceId ? { sourceId: track.sourceId } : {}),
    album: track.album,
    ...(track.onlineId ? { onlineId: track.onlineId } : {}),
    ...(platform ? { platform } : {}),
    ...(track.coverUrl ? { coverUrl: track.coverUrl } : {}),
  }
}

/** `Track` → 快照引用（`storagePluginIdOf` 决定远端来源用哪个插件 id 表达） */
export function toSyncRefOf(
  track: Track,
  storagePluginIdOf?: (sourceId: string) => string | undefined
): SyncTrackRef {
  return toSyncTrackRef(toSyncMatchTrack(track), storagePluginIdOf)
}
