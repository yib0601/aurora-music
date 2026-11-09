/**
 * UTF-8 编码的最小实现（给 `md5` 用）。
 *
 * 优先 `TextEncoder`（Node 11+ / 所有现代 WebView 都有）；老 WebView 缺这个全局时
 * 退回 `encodeURIComponent` 逐字节还原 —— 两者结果一致，只是后者慢一些，
 * 而这里每次搜索只编码一次查询串。
 */
export function utf8Bytes(input: string): Uint8Array {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(input)

  const encoded = encodeURIComponent(input)
  const out: number[] = []
  for (let i = 0; i < encoded.length; i++) {
    const ch = encoded[i]
    if (ch === '%') {
      out.push(parseInt(encoded.slice(i + 1, i + 3), 16))
      i += 2
    } else {
      out.push(ch.charCodeAt(0))
    }
  }
  return new Uint8Array(out)
}
