/**
 * 端点预览压缩。
 *
 * 弹窗可用宽度约 400px，整条 URL（host + 长密钥 + 占位符）必被 truncate 砍成半截，
 * 看不到结构。这里把每条端点压成「路径 + 参数名」：host 与参数值本来就是用户自己填的
 * （填了 key 至少两次），回显没有信息量，值一律换成 …（占位符原样保留）。一行一眼看得全。
 *
 * 外层仍保留「密钥遮蔽」这一层（把真实密钥换成 •••）：压缩后密钥已变成 …，
 * 遮蔽通常不再命中，只作为「压缩失败退回原串」时的第二层兜底。
 */
export function compactEndpointUrl(url: string): string {
  try {
    const u = new URL(url)
    const params = [...u.searchParams.entries()]
      .map(([k, v]) => `${k}=${/^\{.*\}$/.test(v) ? v : '…'}`)
      .join('&')
    return params ? `${u.pathname}?${params}` : u.pathname
  } catch {
    // 不是合法 URL 就原样返回，交给外层 truncate 兜底
    return url
  }
}
