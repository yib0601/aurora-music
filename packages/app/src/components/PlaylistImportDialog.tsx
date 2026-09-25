import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Loader2, Link2, FileText, ListMusic } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { toast } from '@/components/common/Toast'
import { usePlaylistImport, type ImportPreview } from '@/hooks/usePlaylistImport'

interface PlaylistImportDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * 歌单导入对话框：粘贴其他平台的歌单（分享链接或纯文本）。
 * 本地曲库有就用本地，没有的用已配置音源的搜索结果直接展示（不下载）。
 *
 * 合规说明：应用不内置任何平台的歌单抓取器——链接解析依赖用户
 * 自行配置的音源（其中的歌单解析接口），纯文本导入完全在本地处理、零网络请求。
 */
export function PlaylistImportDialog({ open, onOpenChange }: PlaylistImportDialogProps) {
  const navigate = useNavigate()
  const { phase, progress, parse, confirm, cancel } = usePlaylistImport()
  const [text, setText] = useState('')
  const [playlistName, setPlaylistName] = useState('')
  const [preview, setPreview] = useState<ImportPreview | null>(null)

  // 每次打开重置表单
  useEffect(() => {
    if (open) {
      setText('')
      setPlaylistName('')
      setPreview(null)
      cancel()
    }
  }, [open, cancel])

  const busy = phase !== 'idle'
  const localMatched = preview ? preview.localMatches.filter(Boolean).length : 0
  const pendingOnline = preview ? preview.songs.length - localMatched : 0

  const handleParse = async () => {
    const result = await parse(text)
    if (result) {
      setPreview(result)
      if (!playlistName.trim() && result.suggestedName !== '导入的播放列表') {
        setPlaylistName(result.suggestedName)
      }
    }
  }

  const handleConfirm = async () => {
    if (!preview) return
    const result = await confirm(preview, playlistName)
    if (!result) return
    onOpenChange(false)
    let msg = `成功导入 ${result.importedCount} 首（本地 ${result.localCount} 首`
    if (result.onlineCount > 0) msg += `，在线 ${result.onlineCount} 首`
    msg += '）'
    if (result.unmatched.length > 0) msg += `\n${result.unmatched.length} 首未找到，已跳过`
    toast(msg, { duration: 6000 })
    navigate(`/playlist/${result.playlistId}`)
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!busy) onOpenChange(v) }}>
      <DialogContent className="sm:max-w-lg max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>导入歌单</DialogTitle>
          <DialogDescription className="font-text text-[12px] leading-relaxed">
            粘贴歌单分享链接或纯文本（每行一首：歌名 - 歌手）。
            应用不内置任何平台的抓取器：链接解析由你配置的音源提供（设置里填好音源的服务地址与密钥即可），纯文本导入无需任何配置。
          </DialogDescription>
        </DialogHeader>

        {!preview ? (
          <>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              disabled={busy}
              rows={7}
              placeholder={'粘贴歌单分享链接，或按行粘贴歌曲列表：\n七里香 - 周杰伦\n晴天 - 周杰伦'}
              className="w-full resize-none bg-white/[0.03] border border-white/[0.08] rounded-[10px] px-3 py-2.5 font-text text-[13px] text-white/85 outline-none focus:border-mint/50 transition-colors duration-200 placeholder:text-white/25"
            />
            <Input
              value={playlistName}
              onChange={(e) => setPlaylistName(e.target.value)}
              disabled={busy}
              placeholder="歌单名称（可选，默认「导入的播放列表」）"
            />
            <div className="flex items-center justify-between gap-3">
              <p className="font-text text-[11px] text-white/35 leading-snug flex-1">
                仅导入歌名/歌手等元数据；在线歌曲只展示与在线播放，不会下载
              </p>
              {phase === 'parsing' ? (
                <Button variant="secondary" disabled>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" strokeWidth={1.6} />
                  解析中…
                </Button>
              ) : (
                <Button variant="primary" onClick={handleParse} disabled={!text.trim()}>
                  解析并预览
                </Button>
              )}
            </div>
          </>
        ) : (
          <>
            <div className="flex items-center justify-between gap-3">
              <Input
                value={playlistName}
                onChange={(e) => setPlaylistName(e.target.value)}
                disabled={phase === 'importing'}
                placeholder={preview.suggestedName}
                className="max-w-[240px]"
              />
              <p className="font-text text-[12px] text-white/50 tabular-nums">
                共 {preview.songs.length} 首 · 本地 {localMatched} 首
                {pendingOnline > 0 && ` · 待在线匹配 ${pendingOnline} 首`}
              </p>
            </div>

            {/* 预览列表：本地匹配状态一目了然 */}
            <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin border border-white/[0.06] rounded-[10px]">
              {preview.songs.map((song, i) => {
                const matched = preview.localMatches[i]
                const isSearching = phase === 'importing' && !matched
                return (
                  <div key={i} className="flex items-center gap-2.5 px-3 py-2 border-b border-white/[0.05] last:border-0">
                    {isSearching ? (
                      <Loader2 className="h-3.5 w-3.5 flex-shrink-0 animate-spin text-mint/70" strokeWidth={1.6} />
                    ) : matched ? (
                      <FileText className="h-3.5 w-3.5 flex-shrink-0 text-mint/80" strokeWidth={1.6} />
                    ) : (
                      <Link2 className="h-3.5 w-3.5 flex-shrink-0 text-white/30" strokeWidth={1.6} />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="font-text text-[13px] text-white/85 truncate">{song.title}</p>
                      {song.artist && (
                        <p className="font-text text-[11px] text-white/40 truncate">{song.artist}</p>
                      )}
                    </div>
                    <span className="font-text text-[11px] text-white/35 flex-shrink-0">
                      {matched ? '本地' : phase === 'importing' ? '匹配中' : '在线'}
                    </span>
                  </div>
                )
              })}
            </div>

            {phase === 'importing' && progress[1] > 0 && (
              <p className="font-text text-[12px] text-white/50 tabular-nums">
                在线匹配中 {progress[0]}/{progress[1]}…
              </p>
            )}

            <div className="flex items-center justify-end gap-2">
              {phase === 'importing' ? (
                <Button variant="secondary" onClick={() => { cancel(); onOpenChange(false) }}>
                  取消
                </Button>
              ) : (
                <>
                  <Button variant="secondary" onClick={() => setPreview(null)}>
                    重新粘贴
                  </Button>
                  <Button variant="primary" onClick={handleConfirm} className="min-w-[120px]">
                    <ListMusic className="h-4 w-4 mr-2" strokeWidth={1.6} />
                    创建歌单
                  </Button>
                </>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
