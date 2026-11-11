import { useState } from 'react'
import { usePlaylistStore } from '@/stores/playlistStore'
import { useT } from '@/i18n'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'

/**
 * 「新建歌单」对话框：桌面侧栏（Sidebar）与移动端抽屉（MobileNav）共用一份。
 *
 * 为什么抽出来：两处都要这一套 UI 与校验，各写一份的代价不是多写 20 行，而是**漂移**——
 * 改一处忘另一处，就会出现「桌面创建后清空输入、移动端不清空」这种只有一半场景复现的差异，
 * 文案与提交条件（trim 后非空、Enter 直接提交）也一样会分叉。
 *
 * 行为与原先内联在 Sidebar 里的那份**逐字对齐**（不许在这里自创新行为）：
 * - 提交：`createPlaylist(name)` 后清空输入并关闭对话框；
 * - 不自动跳转到新歌单页（创建即离开当前页面会打断用户正在做的事，桌面一直如此）；
 * - 取消关闭时保留输入内容（只是收起对话框），下次打开仍是上次未提交的名字；
 * - 输入为空（或全空白）时提交无效，对话框不关闭。
 *
 * 尺寸刻意不用宽度断点：`w-[calc(100%-2rem)]` + `max-w-sm` 在任何视口都留出两侧 1rem，
 * 窄到 320px 的手机上也不会贴边；`DialogContent` 自带 `w-full`，这里是同组覆盖。
 * （抽屉侧的「不得写宽度断点」原因见 MobileNav 文件头：车机像素密度低，断点判定不可信。）
 */
export function CreatePlaylistDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const t = useT()
  const createPlaylist = usePlaylistStore((s) => s.createPlaylist)
  const [name, setName] = useState('')

  const handleSubmit = () => {
    if (!name.trim()) return
    createPlaylist(name.trim())
    setName('')
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm w-[calc(100%-2rem)]">
        <DialogHeader>
          <DialogTitle>{t('shell.playlist.create')}</DialogTitle>
        </DialogHeader>
        <Input
          autoFocus
          placeholder={t('shell.playlist.namePlaceholder')}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleSubmit()
          }}
        />
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            {t('common.action.cancel')}
          </Button>
          <Button variant="primary" onClick={handleSubmit}>{t('shell.playlist.submit')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
