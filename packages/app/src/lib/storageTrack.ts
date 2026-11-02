/**
 * 「这条曲目现在能不能直接交给播放器」的判据（播放器与取址闸门共用一份）。
 *
 * ## 为什么单独一个文件
 *
 * 判据在**两处**被用到，且必须完全一致：
 * - `playerStore.hasPlayableSrc`：决定要不要先走异步取址；
 * - `playlistIO.ensurePlayableTrack`：真正去把地址取回来。
 *
 * 两处若各写一遍，出现分叉时的表现是「点了没反应」或「明明有地址却反复取址」，
 * 都很难复现 —— 与仓库里 `pluginConfig` 收口归属判定的理由一模一样。
 *
 * ## 远端媒体库曲目的两种形态
 *
 * - 桌面端：`remoteUrl = aurora-remote://<sourceId>/<path>`，主进程注册了协议代理，
 *   播放器拿到就能直接播（流式，Range 透传）；
 * - 移动端：**没有**自定义协议，插件把可直连地址 + 鉴权头交给原生 HTTP，先落成
 *   本地缓存文件再播（见 `mobile/storage.ts` 的 `resolveStorageAudio`）。
 *
 * 于是"有 `sourceId` 但没有 `remoteUrl`"就是**移动端那条待取地址的形态**：
 * 它必须被取址闸门拦下，否则播放器会拿着 `webdav:...` 这种不可加载的坐标去起播。
 */

import type { Track } from '@/types'

/**
 * 是否为「远端媒体库里、但还没有可播地址」的曲目。
 *
 * 判据只看三个字段：认领了来源（`sourceId`）、没有桌面端的协议地址（`remoteUrl`）、
 * 也没有已经取到的可播地址（`onlineUrl`）。
 */
export function needsStorageResolve(
  track: Pick<Track, 'sourceId' | 'path' | 'onlineUrl' | 'remoteUrl'>
): boolean {
  return Boolean(track.sourceId && track.path && !track.onlineUrl && !track.remoteUrl)
}
