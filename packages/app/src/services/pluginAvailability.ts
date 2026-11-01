/**
 * 渲染层的**启停状态镜像**。
 *
 * ## 为什么需要镜像
 *
 * 桌面端有**两个** `@aurora/shared` 实例：主进程一个、渲染进程一个。每个实例各有一份
 * `availability.ts` 的内存表。主进程那份是权威的（持久化在那里、执行也在那里），
 * 而渲染层这份**默认为空**（= 全部启用）。
 *
 * 若不镜像，会出现本仓库反复修过的那类错位：
 *
 * - 主进程执行门禁已经跳过被停用的插件 → 搜索返回空
 * - 渲染层的 `canBrowseHall()` / `isSearchableSource()` / `searchEndpointOf()` 仍在说
 *   "这条源可用" → 界面显示入口、点了没结果
 *
 * 这正是「界面说能搜、实际搜不出」的形态。所以渲染层必须把主进程的权威状态拉过来，
 * 灌进自己那份内存表，让两侧判定口径一致。
 *
 * ## 为什么放在平台层而不是每个调用点
 *
 * 渲染层有十几处调用 `canBrowseHall` / `searchEndpointOf` / `canSearchSource`。
 * 让每个调用点自己去同步，等于把这个前提抄十几遍，加一处新调用就漏一处。
 * 这里收口成「平台层在合适时机灌一次」，调用点无需知情。
 *
 * 移动端不需要镜像：插件注册表与启停状态都在同一个 WebView 进程里，本来就只有一份。
 */

import { setDisabledPluginIds } from '@aurora/shared'
import { platform } from './platform'

/**
 * 从平台层拉一次权威的停用清单，灌进渲染层这份 shared 内存态。
 *
 * **必须逐次 awaited 调用**（不是 fire-and-forget）：它决定的是"接下来界面怎么判断"，
 * 在它完成之前的判断都可能是旧口径。调用点只有两处（启动、每次拨开关后），
 * 成本可忽略。
 *
 * 取不到（老 preload / 无该通道）时灌空集合：那是"这一端没有启停能力"的正常形态，
 * 而不是错误 —— 此时界面的判定应与"全部启用"一致（开关本来也不会渲染）。
 */
export async function syncPluginAvailability(): Promise<string[]> {
  const read = platform.plugins?.listDisabledPlugins
  if (typeof read !== 'function') {
    setDisabledPluginIds([])
    return []
  }
  try {
    const list = await read()
    const ids = Array.isArray(list) ? list.map((id) => String(id)) : []
    setDisabledPluginIds(ids)
    return ids
  } catch (err) {
    // 读失败按"全部启用"处理：让插件复活比让插件集体消失容易自救，
    // 而且真正的执行门禁在主进程，这里宁可与"全部启用"保持一致
    console.warn('[plugin] 读取插件启停状态失败，按全部启用处理:', err)
    setDisabledPluginIds([])
    return []
  }
}
