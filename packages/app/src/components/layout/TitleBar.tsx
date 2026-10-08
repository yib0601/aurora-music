import React, { useState, useEffect, type ReactNode } from 'react'
import { Minus, Square, PanelTopClose, X } from 'lucide-react'
import { isDesktop } from '@/lib/utils'

/**
 * 桌面外壳标题栏是否可用。
 * TitleBar 的渲染条件与 App 的顶部留白补偿（侧栏 / 内容列的 pt-11）必须同源，
 * 否则条件漂移会在没有标题栏时凭空多出 44px 空白（或标题栏压住内容）。
 */
export function hasDesktopTitleBar(): boolean {
  if (!isDesktop()) return false
  return !!(window as any).electronAPI?.windowControls
}

/**
 * 桌面外壳 TitleBar（DS 化）
 * - 高度 44px，透明背景（让 ambient-backdrop 光晕透过）
 * - **绝对定位浮层，不占文档流**：左右玻璃面板（侧栏 / 封面瓷砖）因此能从窗口
 *   最顶端 y=0 开始铺满，其 `--glass-liquid-edge` 的 1px 顶边锐亮线落在窗口上沿，
 *   与底边的柔折返光一样贴着窗口边界；若标题栏占位 44px，这条顶边线会被顶到
 *   y=44 裸露成「两段悬空白线」（左侧栏 224px + 右栏 288px，中间断开）。
 *   浮层方案下主区域用 pt-11 补回高度，内容位置与占位时逐像素一致。
 * - 极简：移除品牌名，仅保留右侧窗口控制按钮
 * - 右侧开一个可选尾部插槽（`trailing`）：窗口控制按钮是资产区，只放窗口操作，
 *   商业/更新等属于应用内容的控件一律走这个插槽排在按钮左侧
 * - **拖拽面覆盖整条带子，窗口拖拽区按「最上层元素 + 祖先链」判定**：
 *   本组件是 44px 全宽 z-50 面板，内容列自己的顶栏工具带落在同一 y 段。
 *   后者必须整体压在本层之上（z-[60]）并给两端实体标 `-webkit-app-region: no-drag`，
 *   否则整条带子会被本层吃掉点击（DOM 看得见、点不到，CDP 里也不报任何错）。
 *   本层自身不要加 pointer-events-none：拖拽区与点击命中同源，
 *   一旦该层不参与命中，窗口就再也拖不动了
 * - 拖拽区域：titlebar-drag / titlebar-no-drag
 * - 按钮规格：38×30px + 圆角对齐 DS media 档（10px）+ 1px 发丝描边 hover
 *   - min/max hover 用辅助色（--fc-accent-2，体系内唯一辅助色相）
 *   - close hover 用语义危险色（--tw-coral）
 * 颜色一律走 token，不在此硬编码色值。
 * 仅视觉调整：onClick 绑定、title、图标与条件渲染逻辑均未改动。
 */
export function TitleBar({ trailing }: { trailing?: ReactNode }) {
  const api = (window as any).electronAPI
  const [isMaximized, setIsMaximized] = useState(false)

  // 只在桌面环境且具备窗口控制 API 时渲染
  if (!hasDesktopTitleBar()) {
    return null
  }

  // 初始化时检查窗口状态
  useEffect(() => {
    api.windowControls.isMaximized?.().then(setIsMaximized)
  }, [api])

  const handleMinimize = () => api.windowControls.minimize()
  const handleMaximize = () => {
    api.windowControls.maximize()
    setIsMaximized((v) => !v)
  }
  const handleClose = () => api.windowControls.close()

  // 按钮通用样式：38×30px 点击区，无边框无背景，仅展示图标
  // 颜色走主题感知的 text-white（浅色模式下自动翻转为深墨色）
  // 圆角对齐 DS media 档（10px），hover 叠加极轻 surface 而非色块
  const btnBase =
    'w-[38px] h-[30px] rounded-ds-media flex items-center justify-center ' +
    'text-white/70 hover:text-white hover:bg-white/[0.06] ' +
    'transition-all active:scale-95'

  return (
    <div className="titlebar-drag absolute top-0 left-0 right-0 h-11 flex items-center pl-[18px] pr-3 select-none z-50">
      {/* 左侧空档：整条标题栏透明，让 ambient 光晕透过 */}
      <div className="flex-1" />

      {/* 应用级控件插槽：排在窗口控制按钮左侧（窗口控制区只放窗口操作），
          自身必须 no-drag，否则落在拖拽层里点不动 */}
      {trailing && <div className="titlebar-no-drag flex items-center mr-3">{trailing}</div>}

      {/* 右侧窗口控制按钮 */}
      <div className="titlebar-no-drag flex items-center gap-1.5">
        <button
          onClick={handleMinimize}
          title="最小化"
          className={`${btnBase} hover:text-fc-accent-2`}
        >
          <Minus className="h-3.5 w-3.5" strokeWidth={2} />
        </button>
        <button
          onClick={handleMaximize}
          title={isMaximized ? '还原' : '最大化'}
          className={`${btnBase} hover:text-fc-accent-2`}
        >
          {isMaximized ? (
            <PanelTopClose className="h-3 w-3" strokeWidth={2} />
          ) : (
            <Square className="h-3 w-3" strokeWidth={2} />
          )}
        </button>
        <button
          onClick={handleClose}
          title="关闭（最小化到托盘）"
          className={`${btnBase} hover:text-coral`}
        >
          <X className="h-3.5 w-3.5" strokeWidth={2} />
        </button>
      </div>
    </div>
  )
}
