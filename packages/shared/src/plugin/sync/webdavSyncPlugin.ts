/**
 * `webdav-sync` 插件：把快照搬进搬出 WebDAV。
 *
 * 布局（`docs/playlist-sync.md` §6）：`<用户填的目录>/aurora-sync/<deviceId>.json`，
 * **每设备一个文件**。写只写自己那份，读时枚举目录合并全部——
 * WebDAV 没有可靠的条件写（`If-Match` 各家支持参差），两台设备同时 PUT 同一个文件
 * 就是互相覆盖且事后无从发现；各写各的文件、读取侧合并，从根上消灭丢更新。
 *
 * 本插件只做搬运：**不合并、不裁剪、不改写**快照内容。合并是基础能力的职责，
 * 两处各算一遍必然不一致（§15.4）。
 */

import { auroraError, errorDetailOf, toErrorInfo } from '../../i18n/errors'
import {
  ensureWebdavDir,
  listWebdavDir,
  readWebdavText,
  testWebdavConnection,
  writeWebdavText,
  type LibrarySourceConfig,
} from '../../webdav'
import { storageErrorStatus } from '../storage/errors'
import { parseSnapshot, serializeSnapshot } from './snapshot'
import type {
  SyncConfig,
  SyncContext,
  SyncFieldDef,
  SyncPlugin,
  SyncProbeResult,
  SyncSnapshot,
} from './types'

/** 快照目录名（固定，不随用户配置变化；用户配的是它的父目录） */
const SYNC_DIR_NAME = 'aurora-sync'

/**
 * 声明式字段（键与 `docs/playlist-sync.md` §6 的表格一致）。
 *
 * `password` 的 `kind` 是 `password`：调用方在保存前会把它从 `settings` 里剥出去走
 * safeStorage，运行期由引擎经 `ctx.secrets` 注入——`webdav.ts` 的旧缺陷正是把口令
 * 明文塞进 localStorage，这里不复制。
 */
const fields: readonly SyncFieldDef[] = [
  {
    key: 'url',
    labelKey: 'sync.webdav.baseUrlLabel',
    kind: 'url',
    required: true,
    placeholderKey: 'sync.webdav.baseUrlPlaceholder',
    hintKey: 'sync.webdav.baseUrlHint',
  },
  { key: 'username', labelKey: 'sync.webdav.usernameLabel', kind: 'text', required: true },
  {
    key: 'password',
    labelKey: 'sync.webdav.passwordLabel',
    kind: 'password',
    hintKey: 'sync.webdav.passwordHint',
  },
  {
    key: 'dir',
    labelKey: 'sync.webdav.rootLabel',
    kind: 'path',
    placeholderKey: 'sync.webdav.rootPlaceholder',
    hintKey: 'sync.webdav.rootHint',
  },
]

/** 取一个声明式配置值（`settings` 里可能是数字，统一成裁剪过的字符串） */
function settingOf(config: SyncConfig, key: string): string {
  const raw = config.settings?.[key]
  if (typeof raw === 'string') return raw.trim()
  if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw)
  return ''
}

/**
 * 把同步配置翻译成 `webdav.ts` 吃的 `LibrarySourceConfig`。
 *
 * 字段改名（`url`→`baseUrl`、`dir`→`rootPath`）只为复用协议层：`webdav.ts` 的
 * 键名是给存储插件定下的，同步另起一套协议实现才是真正的重复。
 * 口令只在这一层的内存对象里出现一次，不落盘、不进日志。
 */
function sourceConfigOf(config: SyncConfig, ctx: SyncContext): LibrarySourceConfig {
  return {
    id: config.id,
    kind: 'webdav',
    name: config.name,
    pluginId: 'webdav',
    settings: {
      baseUrl: settingOf(config, 'url'),
      rootPath: settingOf(config, 'dir'),
      username: settingOf(config, 'username'),
      password: typeof ctx.secrets?.password === 'string' ? ctx.secrets.password : '',
    },
    enabled: config.enabled,
  }
}

/**
 * 本设备的快照文件名。
 *
 * 设备 id 由主进程生成（uuid），但快照文件名会进 URL，所以还是把路径分隔符与
 * 奇怪的字符换掉：一个含 `/` 的 id 会把 PUT 打到别的目录去。
 */
function snapshotFileNameOf(deviceId: string): string {
  const safe = (deviceId || '').trim().replace(/[^A-Za-z0-9._-]/g, '_')
  return `${safe || 'unknown-device'}.json`
}

/** 远端异常 → 同步层的结构化错误（错误词汇只有这四条，UI 才能统一渲染） */
function webdavSyncErrorOf(err: unknown, config: SyncConfig): Error {
  const status = storageErrorStatus(err)
  const detail = errorDetailOf(err)
  if (status === 401 || status === 403) {
    return auroraError('sync.error.webdavAuth', { name: config.name }, detail)
  }
  if (status === 404 || status === 409) {
    return auroraError('sync.error.webdavPath', { name: config.name }, detail)
  }
  if (status !== undefined) {
    return auroraError('sync.error.webdavStatus', { name: config.name, status }, detail)
  }
  return auroraError('sync.error.webdavConnect', { name: config.name, reason: detail }, detail)
}

/** 单个文件坏掉不是同步失败：跳过的理由写日志，下一次同步还会再读到它 */
function isSnapshotFormatError(err: unknown): boolean {
  const code = toErrorInfo(err).code
  return code === 'sync.error.snapshotInvalid' || code === 'sync.error.snapshotVersion'
}

async function probe(config: SyncConfig, ctx: SyncContext): Promise<SyncProbeResult> {
  // 复用存储链路的「测试连接」：同一份地址/鉴权判定，用户在两处看到同一句话
  const result = await testWebdavConnection(sourceConfigOf(config, ctx))
  const detail = result.sample?.length ? result.sample.join(', ') : undefined
  return { ok: result.ok, message: result.message, ...(detail ? { detail } : {}) }
}

async function pull(config: SyncConfig, ctx: SyncContext): Promise<SyncSnapshot[]> {
  const source = sourceConfigOf(config, ctx)
  let entries
  try {
    entries = await listWebdavDir(source, SYNC_DIR_NAME)
  } catch (err) {
    // 404 = 目录还没被创建过 = 对端还没有任何快照。首次同步的**正常状态**，
    // 报错会让"第一次同步"永远失败（§6 与 §15.2 都明确要求返回空数组）
    if (storageErrorStatus(err) === 404) {
      ctx.log?.('同步目录尚不存在，按「对端还没有快照」处理', SYNC_DIR_NAME)
      return []
    }
    throw webdavSyncErrorOf(err, config)
  }

  const ownFile = snapshotFileNameOf(ctx.device?.deviceId ?? '')
  const files = entries.filter(
    (entry) => !entry.isDirectory && /\.json$/i.test(entry.name) && entry.name !== ownFile
  )

  const snapshots: SyncSnapshot[] = []
  for (const file of files) {
    try {
      const text = await readWebdavText(source, file.path)
      // 列举与读取之间被对端删掉：跳过，不算错误
      if (text === null) {
        ctx.log?.('快照文件在读取前消失，已跳过', file.name)
        continue
      }
      snapshots.push(parseSnapshot(text, file.name))
    } catch (err) {
      if (isSnapshotFormatError(err)) {
        // 坏文件只影响它自己：一份半截 JSON 不该让这台设备的全部歌单都同步不了
        ctx.log?.('快照文件不可用，已跳过', { file: file.name, error: errorDetailOf(err) })
        continue
      }
      throw webdavSyncErrorOf(err, config)
    }
  }
  return snapshots
}

async function push(config: SyncConfig, snapshot: SyncSnapshot, ctx: SyncContext): Promise<void> {
  const source = sourceConfigOf(config, ctx)
  try {
    await ensureWebdavDir(source, SYNC_DIR_NAME)
  } catch (err) {
    // 目录建不出来（父目录不存在 / 无写权限）是配置问题，文案要指向"目录"字段
    throw webdavSyncErrorOf(err, config)
  }
  const fileName = snapshotFileNameOf(ctx.device?.deviceId || snapshot.deviceId)
  try {
    // 写入内容就是引擎算好的那份快照，插件不合并、不裁剪
    await writeWebdavText(source, `${SYNC_DIR_NAME}/${fileName}`, serializeSnapshot(snapshot))
  } catch (err) {
    throw webdavSyncErrorOf(err, config)
  }
}

export const webdavSyncPlugin: SyncPlugin = {
  id: 'webdav-sync',
  displayNameKey: 'sync.plugin.webdav.name',
  descriptionKey: 'sync.plugin.webdav.description',
  version: '1.0.0',
  fields,
  probe,
  pull,
  push,
}
