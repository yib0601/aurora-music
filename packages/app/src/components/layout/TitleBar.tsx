import React from 'react'
import { Minus, Square, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { isDesktop } from '@/lib/utils'

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
    <div className="titlebar-drag h-9 flex items-center justify-between px-3.5 select-none glass-strong rounded-none border-0 border-b border-white/[0.04]">
      <div className="flex items-center gap-2 titlebar-no-drag">
        <span className="text-[12px] font-medium text-foreground/45 tracking-tight">Aurora Music</span>
      </div>
      <div className="flex items-center gap-0.5 titlebar-no-drag">
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 rounded-full hover:bg-foreground/[0.06] transition-all duration-200 ease-apple"
          onClick={handleMinimize}
        >
          <Minus className="h-3 w-3" strokeWidth={1.7} />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 rounded-full hover:bg-foreground/[0.06] transition-all duration-200 ease-apple"
          onClick={handleMaximize}
        >
          <Square className="h-2.5 w-2.5" strokeWidth={1.7} />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 rounded-full hover:bg-red-500/80 hover:text-white transition-all duration-200 ease-apple"
          onClick={handleClose}
        >
          <X className="h-3 w-3" strokeWidth={1.7} />
        </Button>
      </div>
    </div>
  )
}
