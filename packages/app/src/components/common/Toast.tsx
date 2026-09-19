import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertCircle, CheckCircle2, Loader2, X } from 'lucide-react'

export interface ToastAction {
  label: string
  onClick: () => void
}

export interface ToastOptions {
  /** info：进行中提示（旋转图标），用于下载开始等既非成功也非失败的过渡提示 */
  type?: 'success' | 'error' | 'info'
  /** 自动关闭毫秒数；带操作按钮时默认 8000，否则 4000 */
  duration?: number
  action?: ToastAction
}

interface ToastItem {
  id: number
  message: string
  type: 'success' | 'error' | 'info'
  duration: number
  action?: ToastAction
}

let nextId = 1
let items: ToastItem[] = []
const listeners = new Set<(items: ToastItem[]) => void>()

function emit() {
  const snapshot = [...items]
  listeners.forEach((l) => l(snapshot))
}

/** 软件内轻量提示：模块级发布订阅，无需 Provider，任意位置调用 toast() 即可 */
export function toast(message: string, options: ToastOptions = {}) {
  const item: ToastItem = {
    id: nextId++,
    message,
    type: options.type ?? 'success',
    duration: options.duration ?? (options.action ? 8000 : 4000),
    action: options.action,
  }
  items = [...items, item]
  emit()
  setTimeout(() => dismissToast(item.id), item.duration)
  return item.id
}

export function dismissToast(id: number) {
  items = items.filter((t) => t.id !== id)
  emit()
}

/** Toast 挂载点：渲染到 body 顶层，z-index 高于搜索浮层（z-[80]）与右键菜单（z-[90]） */
export function ToastHost() {
  const [toasts, setToasts] = useState<ToastItem[]>(items)

  useEffect(() => {
    listeners.add(setToasts)
    return () => {
      listeners.delete(setToasts)
    }
  }, [])

  return createPortal(
    <div className="pointer-events-none fixed left-1/2 top-12 z-[100] flex w-full max-w-md -translate-x-1/2 flex-col items-center gap-2 px-4">
      {toasts.map((t) => (
        <div
          key={t.id}
          role="status"
          /* 入场仅淡入：位移/缩放动画会让玻璃模糊区域逐帧变化，软件渲染下掉帧 */
          className="pointer-events-auto flex max-w-full items-start gap-2.5 rounded-[10px] glass-floating px-4 py-2.5 animate-in fade-in-0 duration-200"
        >
          {t.type === 'error' ? (
            <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0 text-coral" strokeWidth={1.8} />
          ) : t.type === 'info' ? (
            <Loader2 className="mt-0.5 h-4 w-4 flex-shrink-0 animate-spin text-mint/80" strokeWidth={1.8} />
          ) : (
            <CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0 text-mint" strokeWidth={1.8} />
          )}
          <p className="min-w-0 whitespace-pre-line break-all font-text text-[13px] leading-5 text-white/85">
            {t.message}
          </p>
          {t.action && (
            <button
              className="flex-shrink-0 pill pill-sm pill-mint"
              onClick={() => {
                t.action!.onClick()
                dismissToast(t.id)
              }}
            >
              {t.action.label}
            </button>
          )}
          <button
            aria-label="关闭提示"
            className="btn-icon -mr-1 flex-shrink-0 rounded-full text-white/50 hover:text-white"
            onClick={() => dismissToast(t.id)}
          >
            <X className="h-3.5 w-3.5" strokeWidth={1.8} />
          </button>
        </div>
      ))}
    </div>,
    document.body
  )
}
