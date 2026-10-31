/**
 * WebDAV → 存储插件适配器（内置的第一个存储协议）。
 *
 * **只做转发，不重写内部逻辑**：PROPFIND 解析、XML 的服务器怪癖、Basic 鉴权的
 * UTF-8 处理、Range 读取、错误码映射全都还在 `webdav.ts` 里。这里只把它们包成
 * 插件契约的形状（外加声明式字段），让上层从此按能力调用，不再判断 `kind`。
 *
 * 字段 key **刻意与旧扁平字段同名**（baseUrl / rootPath / username / password）：
 * app 侧迁移时把顶层字段原样搬进 `settings` 即可，零转换；`storageFieldValue()`
 * 也让旧配置在**不做任何迁移**的情况下照常可读。
 */

import {
  openWebdavRange,
  openWebdavStream,
  testWebdavConnection,
  walkWebdavAudio,
  type LibrarySourceConfig,
} from '../../webdav'
import type { StoragePlugin } from './types'

/** 字段声明：UI 据此通用渲染表单，插件不发一行业务表单代码 */
export const WEBDAV_STORAGE_FIELDS = [
  {
    key: 'baseUrl',
    labelKey: 'sources.webdav.baseUrlLabel',
    kind: 'url',
    required: true,
    placeholderKey: 'sources.webdav.baseUrlPlaceholder',
    hintKey: 'sources.webdav.baseUrlHint',
  },
  {
    key: 'rootPath',
    labelKey: 'sources.webdav.rootLabel',
    kind: 'path',
    placeholderKey: 'sources.webdav.rootPlaceholder',
  },
  {
    key: 'username',
    labelKey: 'sources.webdav.usernameLabel',
    kind: 'text',
  },
  {
    key: 'password',
    labelKey: 'sources.webdav.passwordLabel',
    kind: 'password',
    hintKey: 'sources.webdav.passwordHint',
  },
] as const satisfies StoragePlugin['fields']

/** WebDAV（群晖 / 威联通 / Nextcloud / rclone serve webdav 等标准实现） */
export const webdavStoragePlugin: StoragePlugin = {
  id: 'webdav',
  displayNameKey: 'sources.webdav.title',
  descriptionKey: 'sources.webdav.desc',
  version: '1.0.0',
  fields: WEBDAV_STORAGE_FIELDS,

  listAudio: (cfg: LibrarySourceConfig, options) => walkWebdavAudio(cfg, options),
  openRange: (cfg, relPath, start, end) => openWebdavRange(cfg, relPath, start, end),
  // 播放代理的首选路径：Range 头原样透传，206 与 Content-Range 原样回给调用方
  openStream: (cfg, relPath, init) => openWebdavStream(cfg, relPath, init),
  probe: (cfg) => testWebdavConnection(cfg),
}
