/**
 * 插件启停（用户级开关）的**纯逻辑**。
 *
 * ## 为什么需要这一层
 *
 * "卸载"与"停用"是两件事，而在此之前只能二选一：
 *
 * - 卸载会**连磁盘一起删**（`removeInstalledPlugin`），连带删掉凭证、脚本正文与安装记录。
 *   用户只是想"这个源先别参与搜索"，却被告知只能删了重装。
 * - 内置插件根本不能卸（实现编译在应用里），于是它连"别用它"都做不到 ——
 *   用户装了三个音源插件、想临时只留一个，只能去逐条改每条音源配置的 `enabled`。
 *
 * 所以启停是**插件粒度**的开关，与源配置里的 `enabled` 是两层：
 * 源开关回答"这条配置参不参与"，插件开关回答"这个实现还上不上场"。
 * 前者是配置数据，后者是运行期门禁。
 *
 * ## 为什么存「已停用集合」而不是「已启用集合」
 *
 * 存已启用集合时，任何**新出现**的 id（刚装的第三方插件、版本升级后新增的内置插件）
 * 都不在集合里 —— 默认就是停用。用户装完一个插件发现它不工作，而界面上没有任何
 * 开关是关着的，这种"新东西默认坏掉"是最难自查的一类故障。
 *
 * 存已停用集合则天然满足"默认启用"：没写过盘的 id 一律启用，落盘可以只有几个 id
 * 甚至不存在（首次使用）。代价是"删掉插件后再装回来会继承旧的停用状态" ——
 * 这是可接受的：用户当初停用它是有理由的，重装不等于改变主意；而且开关就在
 * 插件列表上，一眼能看见它是关的。
 *
 * ## 本层只保存内存态，不读也不写磁盘
 *
 * 落盘由两端各自负责（与信任表当年的分法一致）：
 * - 桌面：`packages/desktop/src/ipc/pluginAvailability.ts`（`<userData>/aurora-music/plugin-availability.json`）
 * - 移动：`packages/app/src/services/platform/mobile/pluginAvailability.ts`（`Directory.Data`）
 *
 * 启动时由持久化层把已停用 id **全量灌入**（`setDisabledPluginIds`）；执行门禁
 * （`pluginForSource` / `storagePluginOf`）只读这里的内存态。这样门禁不需要 await，
 * 也不必知道当前是哪个端。
 *
 * ## 一个必须说清的边界：id 是全局唯一的
 *
 * 本表按**插件 id** 记录，不区分域。这与注册表的口径一致（音源插件与存储插件是两张表，
 * 但 id 的合法形状与语义都是"一个实现"，历史上也没有跨域重名的插件）。若将来真的出现
 * 跨域同 id，本表会让它们一起被停用 —— 那时需要把键换成 `domain:id`，且落盘格式要升版。
 */

/** 插件 id 的合法形状（与注册表、凭证文件名、清单校验**同一正则**，含 `i` 标志） */
const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i

/**
 * 已停用的插件 id。
 *
 * 用 `Set` 而不是数组：门禁在**搜索聚合 / 每次取址**的热路径上被调用，
 * 数组的 `includes` 是 O(n)，而插件数量虽然小、调用频次不低。
 */
const DISABLED = new Set<string>()

/** 归一一个待记录的 id；不合法返回空串（调用方按"没有这个 id"处理） */
function normalizeId(pluginId: unknown): string {
  if (typeof pluginId !== 'string') return ''
  const id = pluginId.trim()
  return PLUGIN_ID_RE.test(id) ? id : ''
}

/**
 * 这个插件当前是否可用。
 *
 * **未登记 = 启用**（见文件头的"存已停用集合"）。空 id / 非字符串也返回 `true`：
 * 调用方拿到一个坏 id 时应当继续走"查注册表失败"那条既有分支，
 * 而不是在这里多造一个"被停用"的假象 —— 两者的用户可见原因完全不同。
 */
export function isPluginEnabled(pluginId: unknown): boolean {
  const id = normalizeId(pluginId)
  if (!id) return true
  return !DISABLED.has(id)
}

/**
 * 开 / 关一个插件。返回是否**发生了变化**（没变化时不触发任何重渲染/落盘）。
 *
 * 非法 id 静默忽略：这里的入参来自 UI 与持久化文件两条路，都不是可信来源，
 * 而"记不住一个坏 id"不是需要上屏的错误。
 */
export function setPluginEnabled(pluginId: unknown, enabled: boolean): boolean {
  const id = normalizeId(pluginId)
  if (!id) return false
  const wasEnabled = !DISABLED.has(id)
  const nextEnabled = enabled !== false
  if (wasEnabled === nextEnabled) return false
  if (nextEnabled) DISABLED.delete(id)
  else DISABLED.add(id)
  return true
}

/** 全部已停用的 id（按加入顺序；UI 与落盘都用它） */
export function disabledPluginIds(): string[] {
  return [...DISABLED]
}

/**
 * 全量替换（启动时由持久化层灌入）。
 *
 * 坏条目逐条跳过而不是整体拒绝：与信任表当年的容错同理 —— 一条坏数据不该让
 * 所有插件一起消失。跳过的后果仅仅是"那个插件被视为启用"，是安全的一侧。
 */
export function setDisabledPluginIds(ids: readonly unknown[]): void {
  DISABLED.clear()
  if (!Array.isArray(ids)) return
  for (const raw of ids) {
    const id = normalizeId(raw)
    if (id) DISABLED.add(id)
  }
}

/** 启停状态快照（供诊断与单测断言；UI 的当前状态以目录条目的 `enabled` 为准） */
export interface PluginAvailabilitySnapshot {
  /** 已停用的插件 id */
  disabled: string[]
  disabledCount: number
}

/** **仅供单测**：清空启停状态（生产代码没有"恢复全部启用"的需求，用户是一次次拨开关的） */
export function clearPluginAvailabilityForTest(): void {
  DISABLED.clear()
}

// ─── 落盘形状（两端共用，避免两套解析各错一半） ──────────────────

/**
 * 落盘文件的内容形状。
 *
 * 带 `version` 是为了将来换键（比如真的出现跨域同 id 而改成 `domain:id`）时，
 * 旧文件能被明确识别并迁移，而不是被当成一堆非法 id 静默丢光。
 */
export interface PluginAvailabilityFile {
  version: 1
  /** 已停用的插件 id（顺序不承载语义，读回后按文件顺序灌入） */
  disabled: string[]
}

export const PLUGIN_AVAILABILITY_FILE_VERSION = 1

/**
 * 解析落盘内容（容错）。
 *
 * 接受三种历史/手工形态，因为这是**用户可能手改**的配置文件（备份、迁移、
 * 排查时打开看一眼都很正常）：
 * 1. 完整对象 `{ version, disabled: [...] }`
 * 2. 裸数组 `["id1"]`（手写时最省事的形态）
 * 3. 坏数据/空文件 → 空数组（全部启用）
 *
 * 三种都归一到"已停用 id 列表"，剩下的交给 `setDisabledPluginIds`。
 */
export function parseDisabledPluginIds(raw: unknown): string[] {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object'
      ? (raw as Record<string, unknown>).disabled
      : undefined
  if (!Array.isArray(list)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of list) {
    const id = normalizeId(item)
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

/** 序列化落盘内容（形状稳定，便于人工检查与备份） */
export function serializeDisabledPluginIds(ids: readonly string[]): string {
  const file: PluginAvailabilityFile = {
    version: PLUGIN_AVAILABILITY_FILE_VERSION,
    disabled: parseDisabledPluginIds([...ids]),
  }
  return JSON.stringify(file, null, 2)
}
