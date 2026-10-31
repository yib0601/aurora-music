/**
 * 来源配置的**字段取值**（插件声明式字段 ↔ 存量扁平字段的兼容层）。
 *
 * ## 为什么需要它
 *
 * 存储插件化后，插件私有配置写在 `LibrarySourceConfig.settings` 里，键由插件的
 * 声明式 `fields` 定义（webdav 是 baseUrl / rootPath / username / password）。
 * 而存量配置把这几个字段**摊在配置顶层**（`cfg.baseUrl` 这种），且已经在用户的
 * localStorage / 主进程内存里了。
 *
 * 本函数把「两处取哪一份」收成一个判定：`settings[key]` 优先，缺失时读顶层同名字段。
 * 于是：
 * - 老配置**零迁移**可读（不需要写数据库/持久化迁移脚本）；
 * - 新代码只认 `settings`，不再出现 `cfg.baseUrl` 这种协议专有读法；
 * - 迁移完成后删掉兜底分支即可，调用点一处都不用动。
 *
 * 放在独立文件而不是 `types.ts`：协议层（`webdav.ts`）也要用它取自己的字段，
 * 而 `types.ts` 是「契约形状」、不该被协议实现反向依赖。本文件只依赖类型，
 * 运行期零依赖，故不产生循环。
 */

import type { LibrarySourceConfig } from '../../webdav'

/**
 * 顶层字段里**已被占用**的键：兼容兜底不得从它们取值，
 * 否则插件声明一个 `key: 'name'` 就会读到来源自己的展示名。
 */
const RESERVED_SOURCE_KEYS = new Set(['id', 'kind', 'name', 'pluginId', 'settings', 'enabled'])

/**
 * 取一个声明式字段的原始值。
 *
 * 取值顺序：`config.settings[key]` → 旧配置的**顶层同名字段**（仅字符串）。
 * 注意顶层兜底只认字符串：`enabled` / `id` 这类非字符串字段不该被当成插件配置读走。
 */
export function storageFieldValue(
  config: LibrarySourceConfig | null | undefined,
  key: string
): unknown {
  if (!config || typeof key !== 'string' || !key) return undefined
  const settings = config.settings
  if (settings && Object.prototype.hasOwnProperty.call(settings, key)) return settings[key]
  if (RESERVED_SOURCE_KEYS.has(key)) return undefined
  const flat = (config as unknown as Record<string, unknown>)[key]
  return typeof flat === 'string' ? flat : undefined
}

/** 同 `storageFieldValue`，但归一成字符串（缺失 / 非字符串 → `''`，首尾空白已裁掉） */
export function storageStringField(
  config: LibrarySourceConfig | null | undefined,
  key: string
): string {
  const raw = storageFieldValue(config, key)
  if (typeof raw === 'string') return raw.trim()
  if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw)
  return ''
}
