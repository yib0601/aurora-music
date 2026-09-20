/**
 * 本地路径 ↔ URL 编解码工具（桌面端主进程 / 浏览器渲染进程 / WebView 三端共用）
 *
 * 背景：直接拼接 `file://${path}` 时，文件名里的 `#` 会被 URL 解析成 fragment、
 * `?` 会被当成 query 起点，中文/空格/`%` 也未转义，导致音频加载失败。
 * 本模块统一逐段 encodeURIComponent，保证路径中的任意可打印字符都能安全进入 URL。
 *
 * 约束：纯函数、无副作用、不依赖 Node 或平台 API（不使用 Buffer / path），
 * 只使用 Web 标准的全局对象，可在 Electron 主进程、浏览器与 WebView 中运行。
 */

/** Windows 盘符前缀，例如 `C:` */
const WINDOWS_DRIVE_RE = /^[A-Za-z]:$/

/** 判断某一段解码后是否已经是合法且「无需再编码」的形态 */
function safeDecode(segment: string): string | null {
  try {
    return decodeURIComponent(segment)
  } catch {
    // 存在孤立 `%` 等无法解码的片段，说明该段不是合法编码结果
    return null
  }
}

/** 逐段编码：跳过空段（避免产生 `//`），每段独立 encodeURIComponent */
function mapSegments(path: string, transform: (segment: string) => string): string {
  return path
    .split('/')
    .filter((segment) => segment.length > 0)
    .map(transform)
    .join('/')
}

/**
 * 逐段 encodeURIComponent 的纯函数（不含 `file://` 前缀）。
 *
 * 供 `cover-local://` 协议与 Capacitor `convertFileSrc` 复用。
 * 幂等安全：某一段解码成功且重新编码后与原值完全一致时，视为已编码，原样保留。
 *
 * @example encodePathSegments('/home/a/歌曲 #1.mp3') // 'home/a/%E6%AD%8C%E6%9B%B2%20%231.mp3'
 */
export function encodePathSegments(path: string): string {
  return mapSegments(path, (segment) => {
    // 已经是编码形态（解码→再编码后与原值一致）则不二次编码
    const decoded = safeDecode(segment)
    if (decoded !== null && encodeURIComponent(decoded) === segment) return segment
    return encodeURIComponent(segment)
  })
}

/**
 * 本机绝对路径 → `file://` URL，逐段 encodeURIComponent，保留前导 `/`。
 *
 * - 反斜杠统一成正斜杠；
 * - Windows 盘符 `C:\a\b` → `file:///C:/a/b`（盘符前补 `/`，构成空 authority）；
 * - 空串输入返回空串；
 * - 已编码的段不会被二次编码（`decodeURIComponent` 失败时原样返回，不抛错）。
 *
 * @example encodeFilePathToUrl('/home/李四/Music/歌曲 #1.mp3')
 *          // 'file:///home/%E6%9D%8E%E5%9B%9B/Music/%E6%AD%8C%E6%9B%B2%20%231.mp3'
 * @example encodeFilePathToUrl('C:\\Users\\张三\\歌.mp3')
 *          // 'file:///C:/Users/%E5%BC%A0%E4%B8%89/%E6%AD%8C.mp3'
 */
export function encodeFilePathToUrl(path: string): string {
  if (path.length === 0) return ''
  const withoutPrefix = path.replace(/^file:\/\//i, '')
  const segments = withoutPrefix
    .replace(/\\/g, '/')
    // 盘符冒号先临时占位，避免被当成路径段分隔逻辑之外的字符处理
    .replace(/^([A-Za-z]):/, '$1\u0000')
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.replace('\u0000', ':'))

  if (segments.length === 0) return 'file:///'

  const encoded = segments.map((segment, index) => {
    if (index === 0 && WINDOWS_DRIVE_RE.test(segment)) return segment
    const decoded = safeDecode(segment)
    if (decoded !== null && encodeURIComponent(decoded) === segment) return segment
    return encodeURIComponent(segment)
  })

  // Unix 绝对路径与 Windows 盘符路径都形如 file:///...（盘符前已有斜杠）
  return `file:///${encoded.join('/')}`
}

/**
 * `file://` URL → 本机路径，逐段 decodeURIComponent（`encodeFilePathToUrl` 的逆操作）。
 *
 * - 结果保持正斜杠，Windows 的 `/C:/...` 会还原成 `C:/...`，是否进一步转反斜杠由调用方决定；
 * - 兼容 `file://host/share/x` 形式（宿主名会被忽略，仅取其后的 pathname）；
 * - 某一段解码失败时该段原样保留，不抛错；
 * - 非 `file://` 开头的输入按普通路径处理。
 *
 * @example decodeFileUrlToPath('file:///home/%E6%9D%8E%E5%9B%9B/%E6%AD%8C%E6%9B%B2%20%231.mp3')
 *          // '/home/李四/歌曲 #1.mp3'
 * @example decodeFileUrlToPath('file:///C:/Users/%E5%BC%A0%E4%B8%89/%E6%AD%8C.mp3')
 *          // 'C:/Users/张三/歌.mp3'
 */
export function decodeFileUrlToPath(url: string): string {
  if (url.length === 0) return ''

  let rest = url
  if (rest.startsWith('file://')) {
    rest = rest.slice('file://'.length)
    // 去掉 authority（netloc）部分：空 authority 时 rest 以 `/` 开头
    if (!rest.startsWith('/')) {
      const slash = rest.indexOf('/')
      rest = slash === -1 ? '' : rest.slice(slash)
    }
  }

  const segments = rest
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => safeDecode(segment) ?? segment)

  // 盘符段（C:）前不再补前导斜杠，其余路径补回前导 `/`
  const hasDrive = segments.length > 0 && WINDOWS_DRIVE_RE.test(segments[0])
  return hasDrive ? segments.join('/') : `/${segments.join('/')}`
}
