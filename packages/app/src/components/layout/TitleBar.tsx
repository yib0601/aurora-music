import React from 'react'
import { Minus, Square, X } from 'lucide-react'
import { isDesktop } from '@/lib/utils'

/**
 * Mineradio 桌面外壳风格 TitleBar
 * - 高度 44px，透明背景（让 ambient-backdrop 光晕透过）
 * - 极简：移除品牌名，仅保留右侧窗口控制按钮
 * - 拖拽区域：titlebar-drag / titlebar-no-drag
 * - 按钮规格：38×30px + 圆角 10px + rgba(4,8,10,.42) 背景
 *   - min/max hover 用香槟色（#fff1bd / rgba(244,210,138,.14)）
 *   - close hover 用珊瑚红（rgba(255,86,100,.86)）
 */
export function TitleBar() {
  const desktop = isDesktop()
  const api = (window as any).electronAPI

  // 只在桌面环境且具备窗口控制 API 时渲染
  if (!desktop || !api?.windowControls) {
    return null
  }

  const handleMinimize = () => api.windowControls.minimize()
  const handleMaximize = () => api.windowControls.maximize()
  const handleClose = () => api.windowControls.close()

  // 按钮通用样式：38×30px，圆角 10px，Mineradio 玻璃珍珠按钮底
  const btnBase =
    'w-[38px] h-[30px] rounded-[10px] flex items-center justify-center ' +
    'bg-[rgba(0,0,0,.10)] text-[rgba(255,255,255,.72)] ' +
    'backdrop-blur-[12px] saturate-[1.8] ' +
    'shadow-[inset_0_0_2px_1px_rgba(255,255,255,.34),inset_0_0_10px_4px_rgba(255,255,255,.13),0_10px_30px_rgba(0,0,0,.18)] ' +
    'hover:-translate-y-px hover:bg-[rgba(255,255,255,.055)] ' +
    'hover:shadow-[inset_0_0_2px_1px_rgba(255,255,255,.42),inset_0_0_12px_5px_rgba(255,255,255,.17),0_12px_34px_rgba(0,0,0,.22),0_0_18px_rgba(255,255,255,.06)] ' +
    'transition-all active:scale-95'

  return (
    <div className="titlebar-drag h-11 flex items-center justify-between pl-[18px] pr-3 select-none relative z-50">
      {/* 左侧留空：标题栏透明，让 ambient 光晕透过 */}
      <div className="flex-1" />

      {/* 右侧窗口控制按钮 */}
      <div className="titlebar-no-drag flex items-center gap-1.5">
        <button
          onClick={handleMinimize}
          title="最小化"
          className={`${btnBase} hover:text-[#fff1bd]`}
        >
          <Minus className="h-3.5 w-3.5" strokeWidth={2} />
        </button>
        <button
          onClick={handleMaximize}
          title="最大化"
          className={`${btnBase} hover:text-[#fff1bd]`}
        >
          <Square className="h-3 w-3" strokeWidth={2} />
        </button>
        <button
          onClick={handleClose}
          title="关闭"
          className={`${btnBase} hover:bg-[rgba(255,86,100,.86)] hover:text-white hover:shadow-[inset_0_0_2px_1px_rgba(255,255,255,.42),0_12px_34px_rgba(0,0,0,.22),0_0_18px_rgba(255,255,255,.06)]`}
        >
          <X className="h-3.5 w-3.5" strokeWidth={2} />
        </button>
      </div>
    </div>
  )
}
