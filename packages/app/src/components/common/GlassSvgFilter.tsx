import { useEffect, useMemo } from 'react'
import {
  CONTROL_GLASS_FILTER_ID,
  CONTROL_GLASS_MAP_ID,
  CONTROL_GLASS_SVG_FILTER,
  generateControlGlassDisplacementMap,
  supportsSvgFilter,
} from '@/lib/glassFilter'

/**
 * Mineradio 玻璃滤镜 SVG 容器组件。
 *
 * 渲染一个隐藏的 SVG，包含底栏控件玻璃的 filter 定义（默认贴图 1080×92×50）。
 * 搜索框 / 搜索药丸两组滤镜已随零引用类删除，浮层统一走 `.glass-liquid`。
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

  // feImage 的默认 displacement map href
  const controlMapHref = useMemo(
    () => generateControlGlassDisplacementMap(1080, 92, 50),
    [],
  )

  // 因为 CONTROL_GLASS_SVG_FILTER 是字符串，需要手动把 href 注入到 feImage 上，
  // 这里通过 <defs dangerouslySetInnerHTML> + 通过 ID 后处理的方式实现。
  // 直接构造完整 defs 字符串最简单可靠。
  const defsHtml = useMemo(
    // 把 feImage 的 href 内联进 filter 字符串，避免 dangerouslySetInnerHTML 后还要再 setAttribute
    () =>
      CONTROL_GLASS_SVG_FILTER.replace(
        `id="${CONTROL_GLASS_MAP_ID}"`,
        `id="${CONTROL_GLASS_MAP_ID}" href="${controlMapHref}"`,
      ),
    [controlMapHref],
  )

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
      // 标记 filter 的 feImage 已就绪，方便外部通过 ID 查询
      data-glass-svg
      data-control-filter-id={CONTROL_GLASS_FILTER_ID}
    >
      <defs dangerouslySetInnerHTML={{ __html: defsHtml }} />
    </svg>
  )
}
