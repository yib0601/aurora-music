/**
 * 存储层的**结构化错误判据**。
 *
 * ## 为什么需要这一层
 *
 * 插件化之前，上层用原型链判断错误来源：
 * ```ts
 * const status = err instanceof WebdavError && err.status ? err.status : 502
 * ```
 * 这是又一处形态判断——它把「这是 WebDAV」写死进了播放代理与扫描管线，
 * 加第二种存储协议时同一行会静默走错分支（拿不到 status、一律 502）。
 *
 * 这里改成**结构判定**：只问「错误对象上有没有可用的 HTTP 状态」「有没有标成
 * 传输层失败」，不关心它是哪个类、哪个插件抛的。将来新插件抛自己的错误类，
 * 只要挂上同名标记（或带 status）就能被上层正确识别，无需改调用方。
 *
 * ## 两个判据的语义边界（这是本文件最容易被误用的地方）
 *
 * - `isStorageTransportError(err)` = **传输层失败**：断网、超时、401/403、
 *   路径不存在、5xx。语义是「这条来源 / 这个文件此刻读不到，可重试」。
 *   扫描管线遇到它必须**保留旧记录、不写新占位记录**——否则一次网络抖动会让
 *   整个曲库被判成「文件都被删了」。
 * - 反之（`isStorageTransportError` 为 false）= **内容 / 格式问题**：元数据解析失败、
 *   读取到的字节不足以解析等。扫描管线应当**按文件名兜底入库**，
 *   宁可元数据粗糙，也不能让用户看到「少了一张专辑」。
 *
 * 两者都不表示「来源配置非法」（那是查不到插件的另一种失败，由调用方单独处理）。
 */

import { isTimeoutError } from '../../fetchWithTimeout'

/**
 * 取错误携带的 HTTP 状态码；没有则 `undefined`。
 *
 * 判据是「对象上有 `status` 且为有限数字」，不依赖任何具体错误类。
 * 非有限数字一律视为没有（避免把 `NaN` 拼进 HTTP 响应）。
 */
export function storageErrorStatus(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined
  const status = (err as { status?: unknown }).status
  if (typeof status !== 'number' || !Number.isFinite(status)) return undefined
  return Math.trunc(status)
}

/**
 * 是否「传输层失败」错误（可重试、扫描时应保留旧记录）。
 *
 * 三种判据，任一成立即为传输层失败：
 * 1. 错误对象上标了 `transport === true`（本层的 `WebdavError` 与将来插件的同类错误用）；
 * 2. 携带了 HTTP 状态码（4xx / 5xx 都是服务器层面的拒绝，不是内容格式问题）；
 * 3. 是超时类错误（`TimeoutError` / `AbortError`，见 `fetchWithTimeout`）。
 *
 * 注意第 2 条也包含 2xx：`openRange` 收到 200 表示服务器**不支持 Range**、
 * 返回了整文件——那是能力缺失而非内容错误，按可重试的传输层情况处理更安全。
 */
export function isStorageTransportError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  if ((err as { transport?: unknown }).transport === true) return true
  if (storageErrorStatus(err) !== undefined) return true
  return isTimeoutError(err)
}

/**
 * 给任意错误对象挂上「传输层失败」标记（返回同一对象，便于 `throw markTransportError(e)`）。
 *
 * 用途：平台层自造的错误（如「远端返回 404」这类在协议层之外发现的失败）不必
 * 引入本层的错误类，只要挂上标记，`isStorageTransportError` 就能认出它。
 * 只有对象才改得动；改不动时原样返回，判据退回 status / 超时判定。
 */
export function markTransportError<T>(err: T): T {
  if (err && typeof err === 'object' && (err as { transport?: unknown }).transport !== true) {
    try {
      Object.defineProperty(err, 'transport', {
        value: true,
        enumerable: false,
        configurable: true,
        writable: false,
      })
    } catch {
      // 冻结对象改不动：连带 status 的判定仍是主要路径，不值得为此抛错
    }
  }
  return err
}
