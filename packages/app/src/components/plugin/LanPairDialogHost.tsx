import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useT } from '@/i18n'
import { toast } from '@/components/common/Toast'
import { platform } from '@/services/platform'
import { completeLanPairing, respondLanPairRequest } from '@/services/playlistSync.service'
import type { LanPairRequest } from '@aurora/shared'

/**
 * 「一键配对」的**应答方**界面（全局）。
 *
 * 为什么挂在 App 根部而不是同步面板里：对端在别的设备上点「配对」时，本机用户
 * 可能正在听歌、翻歌单、甚至在设置页的其它分区 —— 确认框只在「设置 → 插件 →
 * 歌单同步」打开时才出现，等于要求两台设备的用户同时把界面停在同一页，这不现实。
 *
 * 本组件只做三件事：
 * 1. 收到 `pairRequest` 弹框（显示对端设备名 + 过期时间自动收掉）；
 * 2. 「允许 / 拒绝」→ 调 `respondLanPairRequest`；
 * 3. 收到 `paired`（码已经换完）→ 建一条双向目标并跑一轮同步。
 *
 * 注意：**不接收也不展示配对码**。码在对端主进程与本机主进程之间以 ECDH 封装传递
 * （docs/playlist-sync.md §16），渲染层拿到的只有「哪台设备」与「成没成」。
 */
export function LanPairDialogHost() {
  const t = useT()
  const [request, setRequest] = useState<LanPairRequest | null>(null)
  const [busy, setBusy] = useState(false)

  // 订阅必须跟随平台能力：Web 端 / 老 preload 没有这两条通道，订阅函数本身就是空实现
  useEffect(() => {
    const offRequest = platform.onLanPairRequest?.((incoming) => {
      setRequest(incoming)
    })
    const offPaired = platform.onLanPaired?.((peer) => {
      void completeLanPairing(peer).then((config) => {
        if (config) {
          toast(t('sync.pair.paired', { name: config.name }), { type: 'success' })
        } else {
          // 建配置失败只可能是码没落住（配对已过期/被取走）：不弹错误码，给可执行的一句话
          toast(t('sync.pair.expired'), { type: 'error' })
        }
      })
    })
    return () => {
      offRequest?.()
      offPaired?.()
    }
  }, [t])

  // 过期自动收掉：对端等满 TTL 会判超时，本机留着一个点不动的框只会让人反复点
  useEffect(() => {
    if (!request) return
    const remaining = Math.max(0, request.expiresAt - Date.now())
    const timer = setTimeout(() => setRequest(null), remaining)
    return () => clearTimeout(timer)
  }, [request])

  const answer = (accept: boolean) => {
    const pairId = request?.pairId
    if (!pairId || busy) return
    setBusy(true)
    void respondLanPairRequest(pairId, accept)
      .then((accepted) => {
        if (accept && !accepted) {
          // 应答失败通常是对端已经超时/断开：别让用户以为「点了允许就配上了」
          toast(t('sync.pair.timeout'), { type: 'error' })
        }
      })
      .finally(() => {
        setBusy(false)
        setRequest(null)
      })
  }

  return (
    <Dialog
      open={request !== null}
      onOpenChange={(open) => {
        if (!open) answer(false)
      }}
    >
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-white text-tagline">{t('sync.pair.title')}</DialogTitle>
          <DialogDescription className="font-text text-caption text-white/60 break-words">
            {t('sync.pair.requestDesc', { name: request?.deviceName ?? '' })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="ghost"
            size="sm"
            className="h-9 px-4 text-white/60 hover:text-white/90"
            disabled={busy}
            onClick={() => answer(false)}
          >
            {t('sync.pair.deny')}
          </Button>
          <Button
            size="sm"
            className="h-9 px-5 bg-mint text-mint-fg font-semibold hover:bg-mint/90 disabled:opacity-40 disabled:hover:bg-mint"
            disabled={busy}
            onClick={() => answer(true)}
          >
            {t('sync.pair.allow')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
