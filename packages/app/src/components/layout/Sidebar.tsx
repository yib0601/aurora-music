import { useState } from 'react'
import { Music, Heart, Clock, ListMusic, Search, Settings, Plus, MoreHorizontal, Trash2, Pencil } from 'lucide-react'
import { NavLink, useNavigate } from 'react-router-dom'
import { cn, generateId } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { usePlaylistStore } from '@/stores/playlistStore'
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
  { to: '/search', icon: Search, label: '搜索' },
  { to: '/settings', icon: Settings, label: '设置' },
]

/**
 * Mineradio 暗色玻璃风格 Sidebar
 * - 暗色优先，薄荷青（mint #00F5D4）为主色调
 * - active 态使用 mint/[0.10] 背景 + mint 微光 text-shadow
 * - hover 态使用 mint/[0.06] 背景，整体冷色调
 */
export function Sidebar() {
  const navigate = useNavigate()
  const playlists = usePlaylistStore((s) => s.playlists)
  const createPlaylist = usePlaylistStore((s) => s.createPlaylist)
  const deletePlaylist = usePlaylistStore((s) => s.deletePlaylist)
  const renamePlaylist = usePlaylistStore((s) => s.renamePlaylist)
  const [showCreateDialog, setShowCreateDialog] = useState(false)
  const [newPlaylistName, setNewPlaylistName] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingName, setEditingName] = useState('')

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

  return (
    <div className="flex-1 flex flex-col min-h-0 h-full">
      {/* 品牌区 */}
      <div className="flex items-center gap-3 px-4 py-5">
        <div className="w-8 h-8 rounded-md bg-mint flex items-center justify-center">
          <Music className="h-4 w-4 text-[#030608]" strokeWidth={2} />
        </div>
        <div className="flex flex-col">
          <span className="font-display font-semibold text-[15px] tracking-[-0.224px] text-white/96 leading-tight">
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
                'flex items-center gap-2.5 px-3 py-[7px] rounded-md text-[14px] font-normal tracking-[-0.224px] transition-all duration-200 ease-mineradio border',
                isActive
                  ? 'bg-white/[0.08] border-white/10 text-white [text-shadow:0_0_12px_rgba(0,245,212,.18)] shadow-[inset_0_1px_0_rgba(255,255,255,.08)]'
                  : 'border-transparent text-white/60 hover:text-white hover:bg-white/[0.05]'
              )
            }
          >
            <Icon className="h-[15px] w-[15px]" strokeWidth={1.5} />
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
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-white/40 hover:text-mint"
            onClick={() => setShowCreateDialog(true)}
          >
            <Plus className="h-3.5 w-3.5" strokeWidth={1.5} />
          </Button>
        </div>
        <div className="flex flex-col gap-px">
          {playlists.length === 0 ? (
            <p className="px-3 py-2 text-[13px] text-white/35">暂无播放列表</p>
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
                    className="h-7 text-[13px] px-2.5 py-0.5 flex-1"
                  />
                ) : (
                  <NavLink
                    to={`/playlist/${pl.id}`}
                    className={({ isActive }) =>
                      cn(
                        'flex items-center gap-2.5 px-3 py-[7px] rounded-md flex-1 min-w-0 transition-all duration-200 ease-mineradio border',
                        isActive
                          ? 'bg-white/[0.08] border-white/10 text-white shadow-[inset_0_1px_0_rgba(255,255,255,.08)]'
                          : 'border-transparent text-white/60 hover:text-white hover:bg-white/[0.05]'
                      )
                    }
                  >
                    <ListMusic className="h-3.5 w-3.5 flex-shrink-0 opacity-50" strokeWidth={1.5} />
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
                      className="opacity-0 group-hover:opacity-100 text-white/40 hover:text-white flex-shrink-0"
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
        <p className="font-text text-[11px] text-white/30 tracking-[-0.12px]">Aurora Music v0.1.2</p>
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
    </div>
  )
}
