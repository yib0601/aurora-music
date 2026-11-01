/**
 * 插件启停状态的落盘（主进程）。
 *
 * 存储位置：`<userData>/aurora-music/plugin-availability.json`
 *
 * ## 为什么与插件目录、源配置都分开
 *
 * - 插件目录是"我装了哪些插件"（卸载就没了）
 * - 源配置是"我配了哪些音源"（在渲染层的 localStorage 里）
 * - 本文件是"哪些插件现在别上场"（用户级偏好）
 *
 * 三者改动时机不同、生命周期也不同：卸载一个插件不该影响"以后同名插件是否默认停用"
 * 之外的任何东西，而停用一个插件更**绝不能**碰它的磁盘目录（那等于偷偷卸载）。
 * 放在同一份文件里会让"删一个插件"顺手把别的东西也带坏。
 *
 * ## 与 `@aurora/shared` 的分工
 *
 * 纯逻辑（归一、容错解析、序列化、内存态与门禁）都在 shared 的 `plugin/availability.ts`；
 * 本文件只做 I/O：读盘 → 灌入 shared 的内存态；改内存态 → 原子写盘。
 * 这样执行门禁（`pluginForSource` / `storagePluginOf`）不需要 await，也不必知道是哪个端。
 */

import { app, ipcMain } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import {
  disabledPluginIds,
  parseDisabledPluginIds,
  serializeDisabledPluginIds,
  setPluginEnabled,
  setDisabledPluginIds,
  type PluginAvailabilitySnapshot,
} from '@aurora/shared'

/** 启停文件（惰性解析：app 未 ready 时不能取 userData） */
function availabilityFilePath(): string {
  return path.join(app.getPath('userData'), 'aurora-music', 'plugin-availability.json')
}

/**
 * 读盘并灌入 shared 的内存态。
 *
 * 文件不存在 = 用户没停用过任何插件（最常见的情况），此时内存态保持空集合
 * 即"全部启用"，不需要写盘也不需要提示。
 *
 * 文件损坏时**按空表处理并继续启动**：不能让一份坏配置把所有插件变成"被停用"。
 * 用户看到的现象是"插件全部复活"，这比"插件全部消失"容易自救得多
 * （开关就在列表上，再关一次即可）。
 */
export function loadPluginAvailability(): void {
  try {
    const text = fs.readFileSync(availabilityFilePath(), 'utf8')
    setDisabledPluginIds(parseDisabledPluginIds(JSON.parse(text)))
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code !== 'ENOENT') {
      console.warn('[plugin-availability] 读取启停状态失败，按全部启用处理:', err)
    }
    setDisabledPluginIds([])
  }
}

/**
 * 写盘（原子）。
 *
 * 先写 `.tmp` 再 rename：进程中途崩掉不会留下半截 JSON。
 * 半截 JSON 的后果是下次启动读失败 → 全部启用 → 用户以为自己的停用设置丢了。
 */
function persistDisabledPluginIds(): void {
  const file = availabilityFilePath()
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, serializeDisabledPluginIds(disabledPluginIds()), { mode: 0o600 })
  fs.renameSync(tmp, file)
}

/**
 * 开 / 关一个插件（落盘 + 内存态）。
 *
 * 先改内存态再写盘：`setPluginEnabled` 返回 `false` 表示"没有变化"，
 * 那时不该产生一次磁盘写入（用户连点同一个开关会把它变成一个写放大问题，
 * 而 SSD 上没有好处）。
 *
 * 写盘失败时**回滚内存态**：内存态说"已停用"而磁盘说"启用"，重启后开关会自己
 * 弹回去，用户会以为设置不生效。回滚后调用方拿到 `ok: false`，
 * UI 停在真实状态上并给出可读原因。
 */
export function applyPluginEnabled(pluginId: unknown, enabled: boolean): {
  ok: boolean
  enabled: boolean
} {
  const id = typeof pluginId === 'string' ? pluginId.trim() : ''
  const before = id ? !disabledPluginIds().includes(id) : true
  const changed = setPluginEnabled(id, enabled)
  if (!changed) {
    // 没变化（重复设置 / 非法 id）：回一份"落盘后的真实状态"让 UI 对齐
    return { ok: Boolean(id), enabled: before }
  }
  try {
    persistDisabledPluginIds()
    return { ok: true, enabled: enabled !== false }
  } catch (err) {
    console.error('[plugin-availability] 写入启停状态失败，已回滚:', err)
    setPluginEnabled(id, before)
    return { ok: false, enabled: before }
  }
}

// ─── IPC ──────────────────────────────────────────────────────

/**
 * 注册启停通道。
 *
 * 与安装通道分开注册：启停**不动磁盘上的插件目录**，也不需要清单校验，
 * 信任边界与 `plugin:install*` 完全不同（那条通道的入参含路径与 URL）。
 */
export function registerPluginAvailabilityIpc(): void {
  /** 开 / 关一个插件；返回落盘后的真实状态 */
  ipcMain.handle('plugin:setEnabled', (_event, pluginId: unknown, enabled: unknown) =>
    applyPluginEnabled(pluginId, enabled !== false)
  )

  /**
   * 全部已停用的插件 id。
   *
   * UI 的当前状态以 `plugin:catalog` 里每个条目的 `enabled` 为准，这条通道是
   * 诊断与对账用的（例如用户手动编辑过配置文件，想确认主进程读到的是什么）。
   */
  ipcMain.handle('plugin:disabled', () => disabledPluginIds())
}

/** 当前快照（供单测与诊断直接断言，不经过 IPC） */
export function pluginAvailabilitySnapshot(): PluginAvailabilitySnapshot {
  const disabled = disabledPluginIds()
  return { disabled, disabledCount: disabled.length }
}
