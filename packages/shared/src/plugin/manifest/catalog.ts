/**
 * 插件目录（跨域统一视图）。
 *
 * ## 为什么需要这一层
 *
 * 仓库里现在有**三个**插件来源，各自有注册表，形状互不相同：
 *
 * 1. 音源插件注册表（`../registry.ts`，`SourcePlugin`，自带 `capabilities` 声明）
 * 2. 存储插件注册表（`../storage/registry.ts`，`StoragePlugin`，能力由方法存在性派生）
 * 3. 已安装的声明式清单（磁盘上的 `PluginManifest`，需要现场构造实现）
 *
 * 「插件管理」页面要一张**统一的列表**：谁装上了、谁内置、能不能卸、有什么能力。
 * 让 UI 自己去拼三个注册表等于把「有哪些插件来源」这件事抄写三遍，
 * 加第四种来源时必然漏一处。所以这里做一次投影。
 *
 * ## 纯数据约束
 *
 * `PluginCatalogEntry` 里**只有可序列化字段**：插件对象上挂着函数，而 Electron IPC 走
 * structured clone，函数会直接抛 `DataCloneError`（内���插件列表早就在这条坑上
 * 踩过一次，见 `storage/registry.ts` 的 `listStoragePluginMeta` 注释）。
 * 所以本层输出的任何东西都能安全过 IPC。
 */

import type { SourcePlugin } from '../types'
import type { StoragePlugin } from '../storage/types'
// 必须从 `../storage`（出口）取而不是 `../storage/registry`：内置存储插件的注册是
// **该出口的模块求值副作用**（`for (const p of BUILTIN_STORAGE_PLUGINS) registerStoragePlugin(p)`）。
// 直接引 registry 会拿到空表 —— 而这个失败是静默的（目录里少一项，没有任何报错）。
import { listStoragePlugins } from '../storage'
import { storageCapabilitiesOf } from '../storage/types'
import { builtinPlugins, ensureBuiltinsRegistered } from '../builtins'
import { getPlugin } from '../registry'
import type { PluginCatalogEntry, PluginDomain, PluginManifest } from './types'
import { manifestDescription, manifestDisplayName } from './source'

/**
 * 内置音频插件 → 目录条目。
 *
 * ## 为什么遍历 `builtinPlugins()` 而不是 `listPlugins()`
 *
 * 已安装插件**注册进同一个注册表**（执行路径必须一致，见 `installed.ts` 顶部说明），
 * 所以 `listPlugins()` 里同时含内置与已安装。若这里用它，已安装插件会**出现两次**：
 * 一次被当成"内置、不可卸载"，一次是真正的已安装条目。用户会看到一个卸不掉的重复项 ——
 * 而真实原因是"目录投影把注册表当成了内置清单"。
 *
 * 顺带的好处：内置条目能直接给出 `displayNameKey`（字典键），不必先取实现。
 *
 * `ensureBuiltinsRegistered()` 仍需先调：`getPlugin` 的存在性检查依赖它
 * （内置实现在首次执行时才注册，见 `builtins.ts`），一个没注册的内置插件不该出现在目录里
 * —— 那会让用户点进去发现"不支持"。
 */
function sourceEntries(): PluginCatalogEntry[] {
  ensureBuiltinsRegistered()
  const entries: PluginCatalogEntry[] = []
  for (const plugin of builtinPlugins()) {
    // 注册表里查一次：清单里有但注册失败的插件不进目录（否则 UI 会给出一个不可用的入口）
    if (!getPlugin(plugin.id)) continue
    entries.push({
      id: plugin.id,
      domain: 'source' as PluginDomain,
      displayNameKey: plugin.displayNameKey,
      ...(plugin.descriptionKey ? { descriptionKey: plugin.descriptionKey } : {}),
      version: plugin.version,
      capabilities: [...plugin.capabilities],
      provenance: 'builtin' as const,
      removable: false,
    })
  }
  return entries
}

function storageEntries(): PluginCatalogEntry[] {
  return listStoragePlugins().map((plugin: StoragePlugin) => ({
    id: plugin.id,
    domain: 'storage' as PluginDomain,
    displayNameKey: plugin.displayNameKey,
    ...(plugin.descriptionKey ? { descriptionKey: plugin.descriptionKey } : {}),
    version: plugin.version,
    // 存储插件的能力一律由方法存在性派生（一份实现只能有一种说法）
    capabilities: storageCapabilitiesOf(plugin),
    provenance: 'builtin' as const,
    removable: false,
  }))
}

/**
 * 已安装清单 → 目录条目。
 *
 * `locale` 由调用方给（主进程从 IPC 收到当前语言；缺省 `zh-CN`）：
 * 展示名要在**取数这一侧**解析成字面量，因为渲染层拿到的是纯数据，
 * 不能指望它知道清单里有哪些语言标记。
 */
function installedEntries(
  installed: readonly { manifest: PluginManifest; record: { sha256: string } }[],
  locale: string
): PluginCatalogEntry[] {
  return installed.map(({ manifest, record }) => {
    const capabilities: string[] = []
    if (manifest.source?.search) capabilities.push('search')
    if (manifest.source?.resolveTrack) capabilities.push('resolveTrack')
    if (manifest.source?.playlistTracks) capabilities.push('playlistParse')
    if (manifest.source?.recommend) capabilities.push('recommendPlaylists')
    if (manifest.source?.toplists) capabilities.push('toplists')
    if (manifest.source?.toplistDetail) capabilities.push('toplistDetail')
    if (manifest.lyrics) capabilities.push('lyrics')
    // B 档：脚本源一定有取址（洛雪协议的核心），自带搜索可能有 ——
    // 前者写进徽章，后者不写（避免承诺了却取不到）
    if (manifest.script) capabilities.push('resolveTrack')

    // 域判定：有音源端点或有脚本都算 source；只有歌词才算 lyrics。
    // 顺序很重要 —— 一个同时带 lyrics 的脚本源应当归到 source（用户找的是"音源"）。
    const domain: PluginDomain = manifest.source || manifest.script ? 'source' : 'lyrics'
    return {
      id: manifest.id,
      domain,
      displayName: manifestDisplayName(manifest, locale),
      ...(manifest.description
        ? { description: manifestDescription(manifest, locale) }
        : {}),
      version: manifest.version,
      capabilities,
      provenance: 'installed' as const,
      sha256: record.sha256,
      permissions: [...manifest.permissions],
      hosts: [...manifest.hosts],
      // 已安装插件**可以**卸载：清单与本机安装记录都能删干净
      removable: true,
    }
  })
}

/**
 * 组装完整目录。
 *
 * 顺序：内置音源 → 内置存储 → 已安装。内置在前是刻意的：新用户打开插件页应该先看到
 * 「本来就有这些」，再看到「我还装了这些」，而不是让装来的插件把内置的挤到屏幕外。
 *
 * 同 id 冲突的处理：已安装条目会在**注册期**就与内置插件撞名并被拒绝（见
 * `../installed/register.ts` 的 `canInstall`），所以这里不需要去重逻辑 ——
 * 冲突不该在这层被"解决"，那是安装期该挡的事。
 */
export function buildPluginCatalog(
  installed: readonly { manifest: PluginManifest; record: { sha256: string } }[],
  locale = 'zh-CN'
): PluginCatalogEntry[] {
  return [...sourceEntries(), ...storageEntries(), ...installedEntries(installed, locale)]
}

/** 只取某个域的条目（设置页「音源」分区只要 source，存储页只要 storage） */
export function catalogByDomain(
  entries: readonly PluginCatalogEntry[],
  domain: PluginDomain
): PluginCatalogEntry[] {
  return entries.filter((entry) => entry.domain === domain)
}

/**
 * 条目是否具备某能力（供 UI 决定显示哪些入口）。
 *
 * 与注册表的 `hasCapability` 同一纪律：**只用于展示与诊断**，
 * 调用前判定仍然用「方法是否存在」。
 */
export function entryHasCapability(entry: PluginCatalogEntry, capability: string): boolean {
  return Array.isArray(entry.capabilities) && entry.capabilities.includes(capability)
}

/** 条目是否可被用户在设置页选中作为音源（需要搜索或歌单能力之一） */
export function entryUsableAsSource(entry: PluginCatalogEntry): boolean {
  if (entry.domain !== 'source') return false
  return entryHasCapability(entry, 'search') || entryHasCapability(entry, 'playlistParse')
}
