/**
 * 纯 TS 的 MD5（RFC 1321）。
 *
 * ## 为什么不直接用现成的
 *
 * - `node:crypto` 只有主进程/Node 端能用：本包要同时跑在渲染进程、主进程与移动端；
 * - `crypto.subtle.digest` 是异步的，且要求 secure context（Web 端不一定满足）。
 *
 * 全仓只有咪咕搜索的签名用它，且每次搜索只算一次，性能无关紧要 —— 自实现换来的是
 * 「三端行为完全一致、零环境依赖」。同样的取舍见 `lxHost` 把 `md5` 交给宿主的做法：
 * 那边的 md5 是给**用户脚本**用的，必须与脚本运行环境一致；这里是内置代码自用。
 */

import { utf8Bytes } from './bytes'

/** 每轮左移位数（RFC 1321 §3.4） */
const SHIFTS = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9,
  14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
]

/** 常量表 T[i] = floor(2^32 × |sin(i+1)|)，按定义硬编码，避免浮点实现差异 */
const T = new Uint32Array([
  0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
  0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
  0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
  0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
  0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
  0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
  0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
  0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
])

function rotl(value: number, bits: number): number {
  return ((value << bits) | (value >>> (32 - bits))) >>> 0
}

/** 把一个 32 位字按小端写成 8 位十六进制 */
function hexOfWord(word: number): string {
  let out = ''
  for (let i = 0; i < 4; i++) {
    const byte = (word >>> (i * 8)) & 0xff
    out += (byte < 16 ? '0' : '') + byte.toString(16)
  }
  return out
}

/** 计算字符串的 MD5（UTF-8 编码），返回小写十六进制 */
export function md5(input: string): string {
  const bytes = utf8Bytes(input)
  // 补位：0x80 + 若干 0，使长度 ≡ 56 (mod 64)，再追加 64 位比特长度
  const total = (((bytes.length + 8) >> 6) + 1) << 6
  const buffer = new Uint8Array(total)
  buffer.set(bytes)
  buffer[bytes.length] = 0x80
  const view = new DataView(buffer.buffer)
  const bitLength = bytes.length * 8
  view.setUint32(total - 8, bitLength >>> 0, true)
  view.setUint32(total - 4, Math.floor(bitLength / 0x100000000) >>> 0, true)

  let a0 = 0x67452301
  let b0 = 0xefcdab89
  let c0 = 0x98badcfe
  let d0 = 0x10325476
  const words = new Uint32Array(16)

  for (let offset = 0; offset < total; offset += 64) {
    for (let i = 0; i < 16; i++) words[i] = view.getUint32(offset + i * 4, true)
    let a = a0
    let b = b0
    let c = c0
    let d = d0
    for (let i = 0; i < 64; i++) {
      let f: number
      let g: number
      if (i < 16) {
        f = (b & c) | (~b & d)
        g = i
      } else if (i < 32) {
        f = (d & b) | (~d & c)
        g = (5 * i + 1) % 16
      } else if (i < 48) {
        f = b ^ c ^ d
        g = (3 * i + 5) % 16
      } else {
        f = c ^ (b | ~d)
        g = (7 * i) % 16
      }
      const next = d
      d = c
      c = b
      b = (b + rotl((a + f + T[i] + words[g]) >>> 0, SHIFTS[i])) >>> 0
      a = next
    }
    a0 = (a0 + a) >>> 0
    b0 = (b0 + b) >>> 0
    c0 = (c0 + c) >>> 0
    d0 = (d0 + d) >>> 0
  }

  return hexOfWord(a0) + hexOfWord(b0) + hexOfWord(c0) + hexOfWord(d0)
}
