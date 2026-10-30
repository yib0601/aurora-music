/**
 * public/ 静态资源的地址拼接。
 *
 * 唯一的存在理由：**不能用根相对路径**（以 `/` 开头）。
 * 生产端 Electron 用 `loadFile()` 以 `file://` 加载产物 index.html，根相对地址会被
 * 解析成文件系统根：`/favicon.svg` → `file:///favicon.svg` → 加载失败、裂图。
 * dev（vite http://localhost:5173）与移动端（capacitor 本地服务）都从根提供资源，
 * 所以这个差异**只在打包后出现**，开发期看不见——别再写 `/xxx.svg`。
 *
 * 用法：`assetUrl(import.meta.env.BASE_URL, 'favicon.svg')`。
 * vite.config.ts 的 build base 是 './'，因此生产端拿到的是 './favicon.svg'
 * （相对 index.html 所在目录），dev 端拿到 '/favicon.svg'，两边都落在产物目录里。
 */
export function assetUrl(baseUrl: string | undefined, file: string): string {
  const base = baseUrl && baseUrl.length > 0 ? baseUrl : './'
  const dir = base.endsWith('/') ? base : `${base}/`
  const name = file.startsWith('/') ? file.slice(1) : file
  return `${dir}${name}`
}
