import type mobile from '../zh-CN/mobile'
import type { LocalizedOf } from '../schema'

/**
 * English messages. 类型标注刻意写成 `typeof` 中文侧的形状：
 * 少键 / 多键 / 拼错键都会在 tsc 阶段直接报错，语言覆盖度由编译器守门。
 *
 * 键与中文侧逐条对应（`mobile.update.error.*` / `mobile.media.error.*` /
 * `mobile.permission.error.*`），插值占位符集合必须与中文侧一致。
 * 占位符里的 {detail} 是底层异常原文（往往是英文技术文本），原样透出不翻译。
 */
const en: LocalizedOf<typeof mobile> = {
  update: {
    error: {
      busy: 'A download is already in progress',
      urlInvalid: 'Invalid download URL',
      httpStatus: 'The server returned HTTP {status}',
      canceled: 'Canceled',
      incomplete: 'Download incomplete ({received} of {expected} bytes)',
      pathInvalid: 'Invalid installer path',
      apkMissing: 'The installer file is missing. Please download it again.',
      launchFailed: 'Failed to launch the installer: {detail}',
      permissionSettings: 'Unable to open the install permission settings: {detail}',
      downloadFailed: 'Download failed',
    },
  },
  media: {
    error: {
      serviceStartFailed: 'Failed to start the media service: {detail}',
      serviceStopFailed: 'Failed to stop the media service: {detail}',
      serviceNotRunning: 'The media service is not running',
      playQueueFailed: 'Failed to set the playback queue: {detail}',
      syncQueueFailed: 'Failed to sync the playback queue: {detail}',
    },
  },
  permission: {
    error: {
      settingsUnavailable: 'Unable to open the permission settings: {detail}',
    },
  },
}

export default en
