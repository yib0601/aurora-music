/**
 * Mineradio SVG 玻璃滤镜生成系统
 * 参考 Mineradio public/index.html 的实现
 *
 * 核心思路：通过 feDisplacementMap + feOffset + feColorMatrix 三通道分离，
 * 再用 feBlend screen 混合，产生 RGB 色差玻璃质感。
 */

// ─── 滤镜与贴图 ID 常量 ───────────────────────────────────────────

/** 底栏控件玻璃滤镜 ID */
export const CONTROL_GLASS_FILTER_ID = 'mineradio-control-glass-filter'
/** 底栏控件玻璃 displacement map（feImage）ID */
export const CONTROL_GLASS_MAP_ID = 'control-glass-map'

/** 搜索框玻璃滤镜 ID */
export const SEARCH_GLASS_FILTER_ID = 'mineradio-search-glass-filter'
/** 搜索框玻璃 displacement map（feImage）ID */
export const SEARCH_GLASS_MAP_ID = 'search-glass-map'

/** 搜索标签小药丸玻璃滤镜 ID */
export const SEARCH_PILL_GLASS_FILTER_ID = 'mineradio-search-pill-glass-filter'
/** 搜索标签小药丸玻璃 displacement map（feImage）ID */
export const SEARCH_PILL_GLASS_MAP_ID = 'search-pill-glass-map'

// ─── displacement map 生成 ────────────────────────────────────────

/**
 * 生成控件玻璃的 SVG 置换贴图（displacement map）。
 *
 * 贴图结构：
 *  - 黑色背景 rect
 *  - 红色水平渐变 rect（rx=radius）
 *  - 蓝色垂直渐变 rect（mix-blend-mode:difference）
 *  - 中心灰色模糊 rect（产生水波扭曲中心）
 *
 * @param width  贴图宽度，默认 400，最小 240
 * @param height 贴图高度，默认 92，最小 48
 * @param radius  圆角半径，默认 50，最小 12
 * @returns SVG data URI 字符串
 */
export function generateControlGlassDisplacementMap(
  width = 400,
  height = 92,
  radius = 50,
): string {
  const w = Math.max(240, Math.round(width))
  const h = Math.max(48, Math.round(height))
  const r = Math.max(12, Math.round(radius))

  const borderWidth = 0.07
  const edge = Math.min(w, h) * (borderWidth * 0.5)
  const innerW = Math.max(1, w - edge * 2)
  const innerH = Math.max(1, h - edge * 2)

  const svg =
    `<svg viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">` +
    '<defs>' +
    '<linearGradient id="glass-red" x1="100%" y1="0%" x2="0%" y2="0%">' +
    '<stop offset="0%" stop-color="#0000"/>' +
    '<stop offset="100%" stop-color="red"/>' +
    '</linearGradient>' +
    '<linearGradient id="glass-blue" x1="0%" y1="0%" x2="0%" y2="100%">' +
    '<stop offset="0%" stop-color="#0000"/>' +
    '<stop offset="100%" stop-color="blue"/>' +
    '</linearGradient>' +
    '</defs>' +
    `<rect x="0" y="0" width="${w}" height="${h}" fill="black"/>` +
    `<rect x="0" y="0" width="${w}" height="${h}" rx="${r}" fill="url(#glass-red)"/>` +
    `<rect x="0" y="0" width="${w}" height="${h}" rx="${r}" fill="url(#glass-blue)" style="mix-blend-mode:difference"/>` +
    `<rect x="${edge.toFixed(2)}" y="${edge.toFixed(2)}" width="${innerW.toFixed(2)}" height="${innerH.toFixed(2)}" rx="${r}" fill="hsl(0 0% 50% / 1)" style="filter:blur(11px)"/>` +
    '</svg>'

  return 'data:image/svg+xml,' + encodeURIComponent(svg)
}

// ─── 浏览器支持检测 ──────────────────────────────────────────────

/**
 * 检测浏览器是否支持 SVG 玻璃滤镜。
 *
 * 仅 Chromium 系返回 true；Safari 和 Firefox 返回 false。
 * 参考 Mineradio supportsControlGlassSvgFilter()。
 */
export function supportsSvgFilter(): boolean {
  try {
    const ua = navigator.userAgent || ''
    // Safari（非 Chrome）和 Firefox 不支持
    if ((/Safari/.test(ua) && !/Chrome/.test(ua)) || /Firefox/.test(ua)) {
      return false
    }
    // 检测 backdrop-filter 是否支持 url() 引用
    const div = document.createElement('div')
    div.style.backdropFilter = `url(#${CONTROL_GLASS_FILTER_ID})`
    return div.style.backdropFilter !== ''
  } catch {
    return false
  }
}

// ─── SVG filter 定义 ─────────────────────────────────────────────

interface GlassFilterConfig {
  filterId: string
  mapId: string
  /** filter 区域 */
  region: { x: string; y: string; width: string; height: string }
  /** feImage 在 filter 内的定位 */
  mapAttrs: { x: string; y: string; width: string; height: string }
  /** RGB 三通道 displacement scale */
  scales: { red: number; green: number; blue: number }
  /** 水平偏移 */
  dx: number
  /** 最终高斯模糊标准差 */
  stdDeviation: number
}

/**
 * 构建单个 RGB 通道的 displacement → offset → merge → colorMatrix 链。
 */
function buildDisplacementChannel(
  channel: 'Red' | 'Green' | 'Blue',
  scale: number,
  dx: number,
): string {
  const lower = channel.toLowerCase()
  const colorMatrix =
    channel === 'Red'
      ? '1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0'
      : channel === 'Green'
        ? '0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0'
        : '0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0'

  return (
    `<feDisplacementMap in="SourceGraphic" in2="map" scale="${scale}" xChannelSelector="R" yChannelSelector="B" result="disp${channel}"/>` +
    `<feOffset in="disp${channel}" dx="${dx}" dy="0" result="disp${channel}Shifted"/>` +
    '<feMerge>' +
    '<feMergeNode in="SourceGraphic"/>' +
    `<feMergeNode in="disp${channel}Shifted"/>` +
    '</feMerge>' +
    `<feColorMatrix type="matrix" values="${colorMatrix}" result="${lower}"/>`
  )
}

/**
 * 根据配置构建一个完整的 `<filter>` 字符串。
 */
function buildGlassFilter(cfg: GlassFilterConfig): string {
  const { filterId, mapId, region, mapAttrs, scales, dx, stdDeviation } = cfg
  return (
    `<filter id="${filterId}" color-interpolation-filters="sRGB" x="${region.x}" y="${region.y}" width="${region.width}" height="${region.height}">` +
    `<feImage id="${mapId}" x="${mapAttrs.x}" y="${mapAttrs.y}" width="${mapAttrs.width}" height="${mapAttrs.height}" preserveAspectRatio="none" result="map"/>` +
    buildDisplacementChannel('Red', scales.red, dx) +
    buildDisplacementChannel('Green', scales.green, dx) +
    buildDisplacementChannel('Blue', scales.blue, dx) +
    '<feBlend in="red" in2="green" mode="screen" result="rg"/>' +
    '<feBlend in="rg" in2="blue" mode="screen" result="output"/>' +
    `<feGaussianBlur in="output" stdDeviation="${stdDeviation}"/>` +
    '</filter>'
  )
}

// 三组滤镜配置
const FILTER_CONFIGS: GlassFilterConfig[] = [
  // 底栏控件玻璃
  {
    filterId: CONTROL_GLASS_FILTER_ID,
    mapId: CONTROL_GLASS_MAP_ID,
    region: { x: '-12%', y: '-28%', width: '124%', height: '156%' },
    mapAttrs: { x: '0', y: '0', width: '100%', height: '100%' },
    scales: { red: 180, green: 170, blue: 160 },
    dx: -90,
    stdDeviation: 0.5,
  },
  // 搜索框玻璃
  {
    filterId: SEARCH_GLASS_FILTER_ID,
    mapId: SEARCH_GLASS_MAP_ID,
    region: { x: '-24%', y: '-34%', width: '158%', height: '168%' },
    mapAttrs: { x: '-10%', y: '-4%', width: '120%', height: '108%' },
    scales: { red: 180, green: 170, blue: 160 },
    dx: -90,
    stdDeviation: 0.5,
  },
  // 搜索标签小药丸玻璃
  {
    filterId: SEARCH_PILL_GLASS_FILTER_ID,
    mapId: SEARCH_PILL_GLASS_MAP_ID,
    region: { x: '-48%', y: '-68%', width: '210%', height: '236%' },
    mapAttrs: { x: '-24%', y: '-14%', width: '148%', height: '128%' },
    scales: { red: 118, green: 108, blue: 98 },
    dx: -34,
    stdDeviation: 0.35,
  },
]

/**
 * 完整的 SVG `<filter>` 定义字符串（不含外层 `<svg>` 标签）。
 *
 * 包含三个 filter：
 *  - `mineradio-control-glass-filter`（底栏）
 *  - `mineradio-search-glass-filter`（搜索框）
 *  - `mineradio-search-pill-glass-filter`（搜索标签小药丸）
 *
 * 供在 React 组件中通过 dangerouslySetInnerHTML 注入 `<defs>`。
 */
export const CONTROL_GLASS_SVG_FILTER: string = FILTER_CONFIGS.map(
  buildGlassFilter,
).join('')

// ─── 工具函数 ─────────────────────────────────────────────────────

/**
 * 查找 feImage 元素。
 * 优先使用传入的 element；否则通过 filterId 在 document 中查找。
 * filterId 可以是 feImage 自身的 ID，也可以是其所属 filter 的 ID。
 */
function resolveGlassMapElement(
  element: SVGFEImageElement | null | undefined,
  filterId: string,
): SVGFEImageElement | null {
  if (element) return element
  const found = document.getElementById(filterId)
  if (!found) return null
  if (found instanceof SVGFEImageElement) return found
  // 若找到的是 filter 或其他容器，则查找其中的 feImage
  return found.querySelector('feImage')
}

/**
 * 给指定 filter 的 feImage 元素设置正确的 displacement map href。
 * 用于动态更新不同尺寸元素的玻璃贴图。
 *
 * @param element  feImage 元素，若为 null 则通过 filterId 查找
 * @param filterId feImage 或 filter 的 ID
 * @param width    贴图宽度
 * @param height   贴图高度
 * @param radius   圆角半径
 */
export function applyGlassMap(
  element: SVGFEImageElement | null | undefined,
  filterId: string,
  width: number,
  height: number,
  radius: number,
): void {
  const img = resolveGlassMapElement(element, filterId)
  if (!img) return

  const href = generateControlGlassDisplacementMap(width, height, radius)
  img.setAttribute('href', href)
  try {
    img.setAttributeNS('http://www.w3.org/1999/xlink', 'href', href)
  } catch {
    // 忽略 xlink 设置失败
  }
}
