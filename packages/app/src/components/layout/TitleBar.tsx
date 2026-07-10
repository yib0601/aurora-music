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
    <div className="titlebar-drag h-10 flex items-center justify-between px-4 select-none">
      <div className="flex items-center gap-2 titlebar-no-drag">
        <span className="text-sm font-semibold text-foreground/80">Aurora Music</span>
      </div>
      <div className="flex items-center gap-1 titlebar-no-drag">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 hover:bg-foreground/10"
          onClick={handleMinimize}
        >
          <Minus className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 hover:bg-foreground/10"
          onClick={handleMaximize}
        >
          <Square className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 hover:bg-red-500 hover:text-white"
          onClick={handleClose}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
    </div>
  )
}
