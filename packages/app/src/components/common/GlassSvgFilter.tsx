import { useEffect, useMemo } from 'react'
import {
  CONTROL_GLASS_FILTER_ID,
  CONTROL_GLASS_MAP_ID,
  CONTROL_GLASS_SVG_FILTER,
  SEARCH_GLASS_FILTER_ID,
  SEARCH_GLASS_MAP_ID,
  SEARCH_PILL_GLASS_FILTER_ID,
  SEARCH_PILL_GLASS_MAP_ID,
  applyGlassMap,
  generateControlGlassDisplacementMap,
  supportsSvgFilter,
} from '@/lib/glassFilter'

/**
 * Mineradio 玻璃滤镜 SVG 容器组件。
 *
 * 渲染一个隐藏的 SVG，包含三个 filter 定义：
 *  - 底栏控件玻璃（默认贴图 1080×92×50）
 *  - 搜索框玻璃（默认贴图 520×58×22）
 *  - 搜索标签小药丸玻璃（默认贴图 180×32×999）
 *
 * 挂载时检测浏览器支持情况，若支持则给 `<html>` 添加 `control-glass-svg-ok` class。
 */
export function GlassSvgFilter() {
  // 挂载时检测支持，并打 class 标记，CSS 通过该 class 启用 url() 玻璃滤镜
  useEffect(() => {
    if (supportsSvgFilter()) {
      document.documentElement.classList.add('control-glass-svg-ok')
    } else {
      document.documentElement.classList.remove('control-glass-svg-ok')
    }
  }, [])

  // 三个 feImage 的默认 displacement map href
  const controlMapHref = useMemo(
    () => generateControlGlassDisplacementMap(1080, 92, 50),
    [],
  )
  const searchMapHref = useMemo(
    () => generateControlGlassDisplacementMap(520, 58, 22),
    [],
  )
  const searchPillMapHref = useMemo(
    () => generateControlGlassDisplacementMap(180, 32, 999),
    [],
  )

  // 因为 CONTROL_GLASS_SVG_FILTER 是字符串，需要手动把 href 注入到 feImage 上，
  // 这里通过 <defs dangerouslySetInnerHTML> + 通过 ID 后处理的方式实现。
  // 直接构造完整 defs 字符串最简单可靠。
  const defsHtml = useMemo(() => {
    // 先把 feImage 的 href 内联进 filter 字符串，
    // 避免 dangerouslySetInnerHTML 后还要再 setAttribute。
    const withControl = CONTROL_GLASS_SVG_FILTER.replace(
      `id="${CONTROL_GLASS_MAP_ID}"`,
      `id="${CONTROL_GLASS_MAP_ID}" href="${controlMapHref}"`,
    )
    const withSearch = withControl.replace(
      `id="${SEARCH_GLASS_MAP_ID}"`,
      `id="${SEARCH_GLASS_MAP_ID}" href="${searchMapHref}"`,
    )
    const withPill = withSearch.replace(
      `id="${SEARCH_PILL_GLASS_MAP_ID}"`,
      `id="${SEARCH_PILL_GLASS_MAP_ID}" href="${searchPillMapHref}"`,
    )
    return withPill
  }, [controlMapHref, searchMapHref, searchPillMapHref])

  return (
    <svg
      aria-hidden="true"
      focusable="false"
      style={{
        position: 'fixed',
        width: 0,
        height: 0,
        pointerEvents: 'none',
      }}
      xmlns="http://www.w3.org/2000/svg"
      // 标记这三个 filter 的 feImage 已就绪，方便外部通过 ID 查询
      data-glass-svg
      data-control-filter-id={CONTROL_GLASS_FILTER_ID}
      data-search-filter-id={SEARCH_GLASS_FILTER_ID}
      data-search-pill-filter-id={SEARCH_PILL_GLASS_FILTER_ID}
    >
      <defs dangerouslySetInnerHTML={{ __html: defsHtml }} />
    </svg>
  )
}

/**
 * 动态更新某个玻璃 filter 的 displacement map。
 * 是 applyGlassMap 的 React 友好包装，方便组件中调用。
 */
export function updateGlassMap(
  filterId: string,
  width: number,
  height: number,
  radius: number,
): void {
  applyGlassMap(null, filterId, width, height, radius)
}

export { CONTROL_GLASS_FILTER_ID, SEARCH_GLASS_FILTER_ID, SEARCH_PILL_GLASS_FILTER_ID }
