import { expect } from 'vitest'
import { en, lookupMessage, parseErrorInfo, zhCN, type ErrorInfo } from '../i18n'

/**
 * 测试用：结构化文案（错误码 + 参数）的断言辅助。
 *
 * 为什么需要它：底层改造后，错误与结论文案在**产生地**只剩「码 + 参数」
 * （`AURORA_ERR:{...}` 信封，见 i18n/errors.ts），中文句子已经不存在于源码里 ——
 * `rejects.toThrow(/已停用/)` 这类子串断言必然失真。
 *
 * 这里把断言换成**更强**的口径，而不是放宽：
 *   1. 载荷里的码必须精确等于预期（子串匹配允许的「恰好包含」不再成立）；
 *   2. 参数逐个精确比对（源名 / 平台 / 状态码有没有带对）；
 *   3. 该码在 **zh 与 en 两侧字典**里都必须存在且非空 —— 码打错、漏译、译空的
 *      情况都在这里判红（只断言码会漏掉「码对但字典没写」）。
 */

/** 取编码载荷；自由文本（第三方脚本抛出的原文）返回 null */
export function infoOf(value: unknown): ErrorInfo | null {
  const text =
    value instanceof Error ? value.message : typeof value === 'string' ? value : ''
  return text ? parseErrorInfo(text) : null
}

/** 码；非载荷返回 null */
export function codeOf(value: unknown): string | null {
  return infoOf(value)?.code ?? null
}

/** 参数；非载荷返回空对象 */
export function paramsOf(value: unknown): Record<string, string | number> {
  return infoOf(value)?.params ?? {}
}

/** 两种语言的字典里都要有这条文案且非空（缺一即判红） */
export function dictionariesHave(code: string): boolean {
  const zh = lookupMessage(zhCN as never, code)
  const english = lookupMessage(en as never, code)
  return (
    typeof zh === 'string' &&
    zh.trim().length > 0 &&
    typeof english === 'string' &&
    english.trim().length > 0
  )
}

/**
 * 断言 value 是编码载荷：码精确相等（可选：参数精确相等），且两种语言都有文案。
 * value 可以是 Error（抛出的）或字符串（reason / error / message 字段）。
 */
export function expectCode(
  value: unknown,
  code: string,
  params?: Record<string, string | number>
): void {
  const info = infoOf(value)
  expect(info, `期望结构化错误载荷，实际：${String(value)}`).not.toBeNull()
  expect(info?.code).toBe(code)
  if (params) expect(info?.params).toEqual(params)
  expect(dictionariesHave(code), `字典缺少 ${code}（zh / en 都必须有非空文案）`).toBe(true)
}

/**
 * 取 promise 的拒绝值（不抛）；用于把 `rejects.toThrow(/中文/)` 改写成
 * 「拒绝值 → 断言错误码」。断言失败信息里能看到原始载荷，便于排错。
 */
export async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    (value) => {
      throw new Error(`期望被拒绝，实际成功返回：${JSON.stringify(value)?.slice(0, 200)}`)
    },
    (err) => err
  )
}
