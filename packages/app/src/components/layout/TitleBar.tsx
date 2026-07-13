import React from 'react'
import { Minus, Square, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { isDesktop } from '@/lib/utils'

/**
 * Apple sub-nav-frosted 风格的标题栏
 * - 极薄高度 44px（Apple global-nav 标准）
 * - 透明背景 + 底部 1px hairline
 * - 窗口控制按钮采用 btn-icon 风格
 */
export function TitleBar() {
  const desktop = isDesktop()
  const api = (window as any).electronAPI

  if (!desktop || !api?.windowControls) {
    return null
  }

  const handleMinimize = () => api.windowControls.minimize()
  const handleMaximize = () => api.windowControls.maximize()
  const handleClose = () => api.windowControls.close()

  return (
    <div className="titlebar-drag h-11 flex items-center justify-between px-4 select-none border-b border-border bg-background/80 backdrop-blur-md">
      <div className="flex items-center gap-2 titlebar-no-drag">
        <span className="font-display text-[13px] font-semibold tracking-[0.231px] text-foreground">
          Aurora Music
        </span>
      </div>
      <div className="flex items-center gap-0.5 titlebar-no-drag">
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-foreground/60 hover:text-foreground"
          onClick={handleMinimize}
        >
          <Minus className="h-3.5 w-3.5" strokeWidth={1.5} />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-foreground/60 hover:text-foreground"
          onClick={handleMaximize}
        >
          <Square className="h-3 w-3" strokeWidth={1.5} />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-foreground/60 hover:bg-destructive hover:text-white"
          onClick={handleClose}
        >
          <X className="h-3.5 w-3.5" strokeWidth={1.5} />
        </Button>
      </div>
    </div>
  )
}
