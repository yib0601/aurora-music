/**
 * 插件启停状态的落盘（移动端）。
 *
 * ## 为什么不能与桌面端共用 `pluginAvailability.ts`
 *
 * 桌面端用 `node:fs`（同步、原子 rename）；移动端只有 `@capacitor/filesystem`
 * （异步、`Directory.Data` 这类抽象目录），没有共同的"原子写"原语。
 * 与 `pluginStore.ts` 分家的理由完全一致：**共用的是纪律，不是代码**。
 *
 * 落盘位置 `Directory.Data/plugin-availability.json` = 应用私有目录
 * （Android 为 `/data/data/<pkg>/files/`），卸载随应用清除，无需存储权限。
 *
 * ## 纯逻辑仍然共用
 *
 * 归一、容错解析、序列化、内存态与执行门禁都在 `@aurora/shared` 的
 * `plugin/availability.ts`；本文件只负责 I/O。于是"哪些插件被停用"这件事
 * 在三端只有一个真源，两个平台不会各自解释出一套规则。
 */

import { Directory, Encoding, Filesystem } from '@capacitor/filesystem'
import {
  disabledPluginIds,
  parseDisabledPluginIds,
  serializeDisabledPluginIds,
  setDisabledPluginIds,
  setPluginEnabled,
  type PluginAvailabilitySnapshot,
} from '@aurora/shared'

/** 启停文件（相对 `Directory.Data`） */
const AVAILABILITY_FILE = 'plugin-availability.json'

/**
 * 读盘并灌入 shared 的内存态。
 *
 * 文件不存在是最常见的情况（用户没停用过任何插件），此时保持空集合 = 全部启用，
 * 且**不创建文件** —— 没停用过就不该在磁盘上留一份空配置，那会让备份/迁移
 * 多一个需要解释的文件。
 *
 * 读失败（权限 / 坏 JSON）按"全部启用"处理：让插件复活比让插件集体消失
 * 容易自救得多（开关就在列表上）。
 */
export async function loadPluginAvailability(): Promise<void> {
  try {
    const result = await Filesystem.readFile({
      path: AVAILABILITY_FILE,
      directory: Directory.Data,
      encoding: Encoding.UTF8,
    })
    const text = typeof result.data === 'string' ? result.data : ''
    setDisabledPluginIds(parseDisabledPluginIds(JSON.parse(text)))
  } catch (err) {
    // ENOENT 与坏数据都走这里：前者是正常路径，不值得刷日志
    const message = String((err as Error)?.message || err)
    if (!/not exist|ENOENT|no such file/i.test(message)) {
      console.warn('[plugin-availability] 读取启停状态失败，按全部启用处理:', err)
    }
    setDisabledPluginIds([])
  }
}

/** 落盘（移动端没有 rename，只能整文件覆盖；写失败由调用方回滚内存态） */
async function persistDisabledPluginIds(): Promise<void> {
  await Filesystem.writeFile({
    path: AVAILABILITY_FILE,
    directory: Directory.Data,
    encoding: Encoding.UTF8,
    data: serializeDisabledPluginIds(disabledPluginIds()),
    recursive: true,
  })
}

/**
 * 开 / 关一个插件（内存态 + 落盘）。
 *
 * 与桌面端同一条纪律：写盘失败**回滚内存态**。否则内存说"已停用"而磁盘说"启用"，
 * 用户下次启动会发现开关自己弹回去了，却找不到原因。
 */
export async function applyPluginEnabled(
  pluginId: unknown,
  enabled: boolean
): Promise<{ ok: boolean; enabled: boolean }> {
  const id = typeof pluginId === 'string' ? pluginId.trim() : ''
  const before = id ? !disabledPluginIds().includes(id) : true
  const changed = setPluginEnabled(id, enabled)
  if (!changed) return { ok: Boolean(id), enabled: before }
  try {
    await persistDisabledPluginIds()
    return { ok: true, enabled: enabled !== false }
  } catch (err) {
    console.error('[plugin-availability] 写入启停状态失败，已回滚:', err)
    setPluginEnabled(id, before)
    return { ok: false, enabled: before }
  }
}

/** 当前快照（供诊断与单测直接断言） */
export function pluginAvailabilitySnapshot(): PluginAvailabilitySnapshot {
  const disabled = disabledPluginIds()
  return { disabled, disabledCount: disabled.length }
}
