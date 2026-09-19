import { useState } from 'react'
import { Music, Heart, Clock, ListMusic, Settings, Plus, MoreHorizontal, Trash2, Pencil, Upload, FileText, Link2 } from 'lucide-react'
import { NavLink, useNavigate } from 'react-router-dom'
import { cn, generateId } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { usePlaylistStore } from '@/stores/playlistStore'
import { useLibraryStore } from '@/stores/libraryStore'
import { pickM3UFile, parseM3U, matchTracksByPaths } from '@/services/playlistIO.service'
import { APP_VERSION } from '@/services/update.service'
import { PlaylistImportDialog } from '@/components/PlaylistImportDialog'
import { toast } from '@/components/common/Toast'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'

const navItems = [
  { to: '/library', icon: Music, label: '音乐库' },
  { to: '/liked', icon: Heart, label: '收藏' },
  { to: '/recent', icon: Clock, label: '最近播放' },
  { to: '/settings', icon: Settings, label: '设置' },
]

/**
 * 侧边栏：Mineradio 品牌色 × DeepSeek Harness 结构语言
 * - 品牌主色仍是 mint #00F5D4（项目识别），DS 负责结构/材质/排版
 * - active 态按 DS 改为「surface 层级 + 1px 发丝描边」标识选中，
 *   不再用大面积 mint 色块与 text-shadow 微光（DS Don't：不滥用发光）
 * - 导航项圆角走 DS media 档（10px），间距走 DS 阶梯
 */
export function Sidebar() {
  const navigate = useNavigate()
  const playlists = usePlaylistStore((s) => s.playlists)
  const createPlaylist = usePlaylistStore((s) => s.createPlaylist)
  const deletePlaylist = usePlaylistStore((s) => s.deletePlaylist)
  const renamePlaylist = usePlaylistStore((s) => s.renamePlaylist)
  const addTracksToPlaylist = usePlaylistStore((s) => s.addTracksToPlaylist)
  const tracks = useLibraryStore((s) => s.tracks)
  const [showCreateDialog, setShowCreateDialog] = useState(false)
  const [newPlaylistName, setNewPlaylistName] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingName, setEditingName] = useState('')
  const [showImportDialog, setShowImportDialog] = useState(false)

  const handleCreatePlaylist = () => {
    if (newPlaylistName.trim()) {
      createPlaylist(newPlaylistName.trim())
      setNewPlaylistName('')
      setShowCreateDialog(false)
    }
  }

  const handleRename = (id: string) => {
    if (editingName.trim()) {
      renamePlaylist(id, editingName.trim())
    }
    setEditingId(null)
    setEditingName('')
  }

  const handleImportPlaylist = async () => {
    const content = await pickM3UFile()
    if (!content) return
    const paths = parseM3U(content)
    if (paths.length === 0) {
      toast('文件中没有找到有效的音乐路径', { type: 'error' })
      return
    }
    const matchedTracks = matchTracksByPaths(paths, tracks)
    if (matchedTracks.length === 0) {
      toast('没有匹配到音乐库中的歌曲，请先扫描包含这些歌曲的目录', { type: 'error' })
      return
    }
    const newPlaylist = createPlaylist('导入的播放列表')
    addTracksToPlaylist(newPlaylist.id, matchedTracks.map((t) => t.id))
    toast(`已导入 ${matchedTracks.length} 首歌曲`)
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 h-full">
      {/* 品牌区 */}
      <div className="flex items-center gap-3 px-4 py-5">
        <div className="w-8 h-8 rounded-ds-media bg-mint flex items-center justify-center">
          <Music className="h-4 w-4 text-mint-fg" strokeWidth={2} />
        </div>
        <div className="flex flex-col">
          <span className="font-display font-semibold text-[15px] tracking-[-0.224px] text-white/[0.96] leading-tight">
            Aurora
          </span>
          <span className="font-text text-[11px] text-white/40 leading-tight mt-0.5">
            Music Player
          </span>
        </div>
      </div>

      {/* 主导航 */}
      <nav className="flex flex-col gap-px px-3 mt-1">
        {navItems.map(({ to, icon: Icon, label }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              cn(
                'group flex items-center gap-2.5 h-9 px-3 rounded-ds-media text-[14px] font-normal tracking-[-0.224px] transition-all duration-200 ease-mineradio border',
                isActive
                  ? 'bg-white/[0.07] border-white/[0.10] text-white shadow-[inset_0_1px_0_rgba(255,255,255,.06)]'
                  : 'border-transparent text-white/60 hover:text-white hover:bg-white/[0.05]'
              )
            }
          >
            <Icon className="h-[15px] w-[15px] group-aria-[current=page]:text-mint" strokeWidth={1.5} />
            {label}
          </NavLink>
        ))}
      </nav>

      {/* 播放列表 */}
      <div className="mt-5 flex-1 overflow-y-auto scrollbar-thin min-h-0 px-3">
        <div className="flex items-center justify-between px-3 py-1.5">
          <span className="font-text text-[11px] font-semibold text-white/40 uppercase tracking-wider">
            播放列表
          </span>
          <div className="flex items-center gap-1">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button type="button" className="btn-icon" title="导入播放列表">
                  <Upload className="h-3.5 w-3.5" strokeWidth={1.5} />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                <DropdownMenuItem onClick={() => setShowImportDialog(true)}>
                  <Link2 className="h-4 w-4 mr-2" strokeWidth={1.5} />
                  导入歌单（链接/文本）
                </DropdownMenuItem>
                <DropdownMenuItem onClick={handleImportPlaylist}>
                  <FileText className="h-4 w-4 mr-2" strokeWidth={1.5} />
                  导入 M3U 文件
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <button
              type="button"
              className="btn-icon"
              onClick={() => setShowCreateDialog(true)}
              title="新建播放列表"
            >
              <Plus className="h-3.5 w-3.5" strokeWidth={1.5} />
            </button>
          </div>
        </div>
        <div className="flex flex-col gap-px">
          {playlists.length === 0 ? (
            <p className="px-3 py-2 text-[12px] text-white/30 leading-relaxed">点击 + 创建你的第一个播放列表</p>
          ) : (
            playlists.map((pl) => (
              <div key={pl.id} className="group flex items-center gap-0.5">
                {editingId === pl.id ? (
                  <Input
                    autoFocus
                    value={editingName}
                    onChange={(e) => setEditingName(e.target.value)}
                    onBlur={() => handleRename(pl.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleRename(pl.id)
                      if (e.key === 'Escape') { setEditingId(null); setEditingName('') }
                    }}
                    className="h-7 text-[13px] px-2.5 py-0.5 flex-1 rounded-ds-sm"
                  />
                ) : (
                  <NavLink
                    to={`/playlist/${pl.id}`}
                    className={({ isActive }) =>
                      cn(
                        'group flex items-center gap-2.5 h-9 px-3 rounded-ds-media flex-1 min-w-0 transition-all duration-200 ease-mineradio border',
                        isActive
                          ? 'bg-white/[0.07] border-white/[0.10] text-white shadow-[inset_0_1px_0_rgba(255,255,255,.06)]'
                          : 'border-transparent text-white/60 hover:text-white hover:bg-white/[0.05]'
                      )
                    }
                  >
                    <ListMusic className="h-3.5 w-3.5 flex-shrink-0 opacity-50 group-aria-[current=page]:text-mint group-aria-[current=page]:opacity-100" strokeWidth={1.5} />
                    <span className="truncate text-[13px] tracking-[-0.224px]">{pl.name}</span>
                    <span className="text-[11px] text-white/30 ml-auto tabular-nums font-semibold">
                      {pl.trackIds.length}
                    </span>
                  </NavLink>
                )}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="rounded-ds-sm opacity-0 group-hover:opacity-100 text-white/40 hover:text-white flex-shrink-0"
                    >
                      <MoreHorizontal className="h-3 w-3" strokeWidth={1.5} />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-40">
                    <DropdownMenuItem
                      onClick={() => {
                        setEditingId(pl.id)
                        setEditingName(pl.name)
                      }}
                    >
                      <Pencil className="h-4 w-4 mr-2" strokeWidth={1.5} />
                      重命名
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      className="text-destructive focus:text-destructive"
                      onClick={() => deletePlaylist(pl.id)}
                    >
                      <Trash2 className="h-4 w-4 mr-2" strokeWidth={1.5} />
                      删除
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            ))
          )}
        </div>
      </div>

      {/* 版本号 */}
      <div className="px-4 py-3 border-t border-white/5">
        <p className="font-text text-[11px] text-white/50 tracking-[-0.12px]">Aurora Music v{APP_VERSION}</p>
      </div>

      <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>新建播放列表</DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            placeholder="播放列表名称"
            value={newPlaylistName}
            onChange={(e) => setNewPlaylistName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleCreatePlaylist()
            }}
          />
          <DialogFooter>
            <Button variant="secondary" onClick={() => setShowCreateDialog(false)}>
              取消
            </Button>
            <Button variant="primary" onClick={handleCreatePlaylist}>创建</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <PlaylistImportDialog open={showImportDialog} onOpenChange={setShowImportDialog} />
    </div>
  )
}
