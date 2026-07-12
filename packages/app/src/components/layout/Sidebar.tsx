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
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex items-center gap-3 px-3 py-3">
        <div className="w-9 h-9 rounded-[11px] bg-gradient-to-br from-primary/95 to-primary/75 flex items-center justify-center shadow-lg shadow-primary/20 border border-white/[0.12]">
          <Music className="h-[17px] w-[17px] text-white" strokeWidth={1.8} />
        </div>
        <div className="flex flex-col">
          <span className="font-semibold text-[15px] tracking-tight text-foreground/90 leading-tight">Aurora</span>
          <span className="text-[9px] text-foreground/35 leading-tight mt-0.5">Music Player</span>
        </div>
      </div>

      <nav className="flex flex-col gap-0.5 px-1">
        {navItems.map(({ to, icon: Icon, label }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              cn(
                'flex items-center gap-3 px-3.5 py-2.5 rounded-[11px] text-[12.5px] font-medium transition-all duration-200 ease-apple border',
                isActive
                  ? 'glass-strong text-foreground/90 shadow-sm border-white/[0.08]'
                  : 'text-foreground/50 hover:text-foreground/85 hover:bg-white/[0.04] border-transparent'
              )
            }
          >
            <Icon className="h-[16px] w-[16px]" strokeWidth={1.6} />
            {label}
          </NavLink>
        ))}
      </nav>

      <div className="mt-3 flex-1 overflow-y-auto scrollbar-thin min-h-0">
        <div className="flex items-center justify-between px-3.5 py-2">
          <span className="text-[10px] font-semibold text-foreground/35 uppercase tracking-wider">
            播放列表
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 rounded-lg text-foreground/35 hover:text-foreground/80 hover:bg-white/[0.06] transition-all duration-200 ease-apple"
            onClick={() => setShowCreateDialog(true)}
          >
            <Plus className="h-3.5 w-3.5" strokeWidth={1.8} />
          </Button>
        </div>
        <div className="flex flex-col gap-0.5 text-[12px] pr-1 px-1">
          {playlists.length === 0 ? (
            <p className="px-3.5 py-2 text-[11px] text-foreground/25">暂无播放列表</p>
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
                    className="h-7 text-[12px] px-2.5 py-0.5 flex-1 bg-transparent rounded-[9px]"
                  />
                ) : (
                  <NavLink
                    to={`/playlist/${pl.id}`}
                    className={({ isActive }) =>
                      cn(
                        'flex items-center gap-2.5 px-3.5 py-2 rounded-[11px] flex-1 min-w-0 transition-all duration-200 ease-apple border',
                        isActive
                          ? 'glass text-foreground/90 shadow-sm border-white/[0.06]'
                          : 'text-foreground/50 hover:text-foreground/85 hover:bg-white/[0.04] border-transparent'
                      )
                    }
                  >
                    <ListMusic className="h-3.5 w-3.5 flex-shrink-0 opacity-60" strokeWidth={1.6} />
                    <span className="truncate">{pl.name}</span>
                    <span className="text-[9px] text-foreground/30 ml-auto tabular-nums font-medium">{pl.trackIds.length}</span>
                  </NavLink>
                )}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 rounded-lg opacity-0 group-hover:opacity-100 text-foreground/35 hover:text-foreground/80 hover:bg-white/[0.06] flex-shrink-0 transition-all duration-200 ease-apple"
                    >
                      <MoreHorizontal className="h-3 w-3" strokeWidth={1.8} />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-40">
                    <DropdownMenuItem
                      onClick={() => {
                        setEditingId(pl.id)
                        setEditingName(pl.name)
                      }}
                    >
                      <Pencil className="h-4 w-4 mr-2" strokeWidth={1.6} />
                      重命名
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      className="text-destructive focus:text-destructive"
                      onClick={() => deletePlaylist(pl.id)}
                    >
                      <Trash2 className="h-4 w-4 mr-2" strokeWidth={1.6} />
                      删除
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="mt-auto px-3.5 py-2">
        <p className="text-[9px] text-foreground/25 font-medium">Aurora Music v0.1.2</p>
      </div>

      <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
        <DialogContent className="sm:max-w-sm rounded-[18px]">
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
            <Button variant="outline" onClick={() => setShowCreateDialog(false)}>
              取消
            </Button>
            <Button onClick={handleCreatePlaylist}>创建</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
