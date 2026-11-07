/**
 * base64 ↔ 字节（WebView 里唯一的二进制转运方式）。
 *
 * 两个方向都有真实调用点：写文件（Capacitor Filesystem 只收 base64 字符串）、
 * 读原生 HTTP 的二进制响应（`CapacitorHttp` 的 `responseType: 'blob'` 回的是 base64）。
 *
 * `btoa` 只吃 Latin-1 且逐字符调用，大文件必须分块喂：一次性
 * `String.fromCharCode(...bytes)` 在几十 MB 的音频上会因参数个数上限直接抛
 * RangeError（封面图几十 KB 时看不出来，换到整首音频就是必现的崩溃点），
 * 所以这里固定按 0x8000 分块。
 */

export function uint8ArrayToBase64(data: Uint8Array): string {
  let bin = ''
  const chunk = 0x8000
  for (let i = 0; i < data.length; i += chunk) {
    bin += String.fromCharCode.apply(null, data.subarray(i, i + chunk) as unknown as number[])
  }
  return btoa(bin)
}

export function base64ToUint8Array(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
