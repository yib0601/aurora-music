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
    <aside className="w-64 flex-shrink-0 flex flex-col p-3 gap-1">
      <div className="flex items-center gap-2 px-3 py-2 mb-2">
        <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-purple-500 to-pink-500 flex items-center justify-center">
          <Music className="h-5 w-5 text-white" />
        </div>
        <span className="font-bold text-lg bg-gradient-to-r from-purple-400 to-pink-400 bg-clip-text text-transparent">
          Aurora
        </span>
      </div>

      <nav className="flex flex-col gap-0.5">
        {navItems.map(({ to, icon: Icon, label }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              cn(
                'flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-all',
                isActive
                  ? 'bg-foreground/10 text-foreground'
                  : 'text-foreground/60 hover:text-foreground hover:bg-foreground/5'
              )
            }
          >
            <Icon className="h-4 w-4" />
            {label}
          </NavLink>
        ))}
      </nav>

      <div className="mt-4 flex-1 overflow-y-auto scrollbar-thin">
        <div className="flex items-center justify-between px-3 py-2">
          <span className="text-xs font-semibold text-foreground/40 uppercase tracking-wider">
            播放列表
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 text-foreground/40 hover:text-foreground"
            onClick={() => setShowCreateDialog(true)}
          >
            <Plus className="h-4 w-4" />
          </Button>
        </div>
        <div className="flex flex-col gap-0.5 text-sm">
          {playlists.length === 0 ? (
            <p className="px-3 py-2 text-xs text-foreground/30">暂无播放列表</p>
          ) : (
            playlists.map((pl) => (
              <div key={pl.id} className="group flex items-center gap-1">
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
                    className="h-7 text-sm px-2 py-1 flex-1"
                  />
                ) : (
                  <NavLink
                    to={`/playlist/${pl.id}`}
                    className={({ isActive }) =>
                      cn(
                        'flex items-center gap-2 px-3 py-1.5 rounded-lg flex-1 min-w-0 transition-colors',
                        isActive ? 'bg-foreground/10 text-foreground' : 'text-foreground/60 hover:text-foreground hover:bg-foreground/5'
                      )
                    }
                  >
                    <ListMusic className="h-4 w-4 flex-shrink-0" />
                    <span className="truncate">{pl.name}</span>
                    <span className="text-xs text-foreground/30 ml-auto">{pl.trackIds.length}</span>
                  </NavLink>
                )}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 opacity-0 group-hover:opacity-100 text-foreground/40 hover:text-foreground flex-shrink-0"
                    >
                      <MoreHorizontal className="h-3.5 w-3.5" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-40">
                    <DropdownMenuItem
                      onClick={() => {
                        setEditingId(pl.id)
                        setEditingName(pl.name)
                      }}
                    >
                      <Pencil className="h-4 w-4 mr-2" />
                      重命名
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      className="text-destructive focus:text-destructive"
                      onClick={() => deletePlaylist(pl.id)}
                    >
                      <Trash2 className="h-4 w-4 mr-2" />
                      删除
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="mt-auto px-3 py-2">
        <p className="text-xs text-foreground/30">Aurora Music v0.1.0</p>
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
            <Button variant="outline" onClick={() => setShowCreateDialog(false)}>
              取消
            </Button>
            <Button onClick={handleCreatePlaylist}>创建</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </aside>
  )
}
