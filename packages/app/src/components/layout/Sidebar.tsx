import { useState } from 'react'
import { Music, Heart, Clock, ListMusic, Settings, Plus, MoreHorizontal, Trash2, Pencil, Upload, FileText, Link2, Library, Radio } from 'lucide-react'
import { NavLink, useNavigate } from 'react-router-dom'
import { cn, generateId } from '@/lib/utils'
import { NAV_LABEL_KEYS, ROUTES, type NavItem } from '@/lib/routes'
import { Button } from '@/components/ui/button'
import { usePlaylistStore } from '@/stores/playlistStore'
import { useLibraryStore } from '@/stores/libraryStore'
import { pickM3UFile, parseM3U, matchTracksByPaths } from '@/services/playlistIO.service'
import { APP_VERSION } from '@/services/update.service'
import { PlaylistImportDialog } from '@/components/PlaylistImportDialog'
import { toast } from '@/components/common/Toast'
import { useT } from '@/i18n'
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

/**
 * 主导航表（扁平，无分组标题）。路径一律取 `@/lib/routes` 的常量；
 * 形状与移动端抽屉（MobileNav）共用 NavItem。
 *
 * 顺序即产品优先级：**音乐库（在线）排第一位**，它是冷启动主屏（HOME_ROUTE），
 * 导航首位与主屏保持一致，用户按「第一位 = 首屏」的直觉操作不会错位。
 * 我的音乐（本地曲库）紧随其后。
 *
 * 名称沿革见 lib/routes.ts 的 NAV_LABEL_KEYS 处注释：曾用「音乐库 / 音乐馆」，
 * 再改「我的音乐 / 在线音乐」+「我的 / 在线」分组，现取消分组且「音乐库」改指在线页。
 * 「收藏 / 最近播放」跨来源（最近播放统一登记本地与在线；收藏入口对在线曲目开放但当前空转），
 * 取消分组后它们与两个内容页平级，不再需要为分组标题措辞纠结。
 *
 * 表里存的是**键**（`NavItem.labelKey`）而不是译文：模块级常量数组若存字符串，
 * 语言会在模块加载那一刻被冻结，用户切语言后导航项不会跟着变。译文一律在渲染期取。
 * 「设置」不在此表，由 footerItems 单独给出（它是应用配置，不是内容项）。
 */
const navItems: NavItem[] = [
  { to: ROUTES.hall, icon: Radio, labelKey: NAV_LABEL_KEYS.hall },
  { to: ROUTES.library, icon: Library, labelKey: NAV_LABEL_KEYS.library },
  { to: ROUTES.liked, icon: Heart, labelKey: 'nav.item.liked' },
  { to: ROUTES.recent, icon: Clock, labelKey: 'nav.item.recent' },
]

/** 独立入口（设置是应用配置，不是内容），与内容项用间距区隔 */
const footerItems: NavItem[] = [{ to: ROUTES.settings, icon: Settings, labelKey: 'nav.item.settings' }]

/**
 * 导航项样式。抽成一处：内容项与组外项两条渲染路径共用，
 * 内联两份同样的 className 必然漂移（改一处忘另一处 → 选中态不一致）。
 * 组外项多一个 mt-3 与内容区拉开距离。
 */
const navLinkClass = (isActive: boolean, spaced = false) =>
  cn(
    'group flex items-center gap-2.5 h-9 px-3 rounded-ds-media text-[14px] font-normal tracking-[-0.224px] transition-all duration-200 ease-mineradio border',
    spaced && 'mt-3',
    isActive
      ? 'bg-mint/[0.13] border-mint/[0.18] text-mint font-medium shadow-[inset_0_1px_0_rgba(255,255,255,.06)]'
      : 'border-transparent text-white/72 hover:text-white hover:bg-white/[0.05]',
  )

/**
 * 侧边栏：Mineradio 品牌色 × DeepSeek Harness 结构语言
 * - 品牌主色仍是 mint #00F5D4（项目识别），DS 负责结构/材质/排版
 * - active 态用「品牌低透底色 + 主色字/图标」标识选中：导航是全局方位锚点，
 *   仅靠 surface 层级差（白 7% 底 + 发丝边）在浅色主题与暖色封面色场下
 *   辨识度不足——底色与玻璃同族时几乎看不出选中项，改用色相区分
 * - 仍不用实心 mint 色块与 text-shadow 微光（DS Don't：不滥用发光）
 * - 导航项圆角走 DS media 档（10px），间距走 DS 阶梯
 */
export function Sidebar() {
  const t = useT()
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
      toast(t('shell.playlist.importNoPath'), { type: 'error' })
      return
    }
    const matchedTracks = matchTracksByPaths(paths, tracks)
    if (matchedTracks.length === 0) {
      // 页面名走占位符：英文下「我的音乐」是 My Music，拼句子必然翻车
      toast(t('shell.playlist.importNoMatch', { library: t(NAV_LABEL_KEYS.library) }), { type: 'error' })
      return
    }
    const newPlaylist = createPlaylist(t('shell.playlist.importedName'))
    addTracksToPlaylist(newPlaylist.id, matchedTracks.map((track) => track.id))
    toast(t('shell.playlist.imported', { count: matchedTracks.length }))
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
            {t('nav.brand.name')}
          </span>
          <span className="font-text text-[11px] text-white/65 leading-tight mt-0.5">
            {t('nav.brand.subtitle')}
          </span>
        </div>
      </div>

      {/* 主导航：音乐库（在线发现）居首，与主屏一致 */}
      <nav className="flex flex-col gap-px px-3 mt-1">
        {navItems.map(({ to, icon: Icon, labelKey }) => (
          <NavLink key={to} to={to} className={({ isActive }) => navLinkClass(isActive)}>
            <Icon className="h-[15px] w-[15px] group-aria-[current=page]:text-mint" strokeWidth={1.5} />
            {t(labelKey)}
          </NavLink>
        ))}
        {/* 设置：应用配置，不属于内容项，用间距区隔 */}
        {footerItems.map(({ to, icon: Icon, labelKey }) => (
          <NavLink key={to} to={to} className={({ isActive }) => navLinkClass(isActive, true)}>
            <Icon className="h-[15px] w-[15px] group-aria-[current=page]:text-mint" strokeWidth={1.5} />
            {t(labelKey)}
          </NavLink>
        ))}
      </nav>

      {/* 播放列表 */}
      <div className="mt-5 flex-1 overflow-y-auto scrollbar-thin min-h-0 px-3">
        <div className="flex items-center justify-between px-3 py-1.5">
          <span className="font-text text-[11px] font-semibold text-white/65 uppercase tracking-wider">
            {t('nav.item.playlists')}
          </span>
          <div className="flex items-center gap-1">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button type="button" className="btn-icon" title={t('shell.playlist.importLink')}>
                  <Upload className="h-3.5 w-3.5" strokeWidth={1.5} />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                <DropdownMenuItem onClick={() => setShowImportDialog(true)}>
                  <Link2 className="h-4 w-4 mr-2" strokeWidth={1.5} />
                  {t('shell.playlist.importLinkText')}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={handleImportPlaylist}>
                  <FileText className="h-4 w-4 mr-2" strokeWidth={1.5} />
                  {t('shell.playlist.importFile')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <button
              type="button"
              className="btn-icon"
              onClick={() => setShowCreateDialog(true)}
              title={t('shell.playlist.create')}
            >
              <Plus className="h-3.5 w-3.5" strokeWidth={1.5} />
            </button>
          </div>
        </div>
        <div className="flex flex-col gap-px">
          {playlists.length === 0 ? (
            <p className="px-3 py-2 text-[12px] text-white/65 leading-relaxed">{t('shell.playlist.empty')}</p>
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
                          : 'border-transparent text-white/72 hover:text-white hover:bg-white/[0.05]'
                      )
                    }
                  >
                    <ListMusic className="h-3.5 w-3.5 flex-shrink-0 opacity-50 group-aria-[current=page]:text-mint group-aria-[current=page]:opacity-100" strokeWidth={1.5} />
                    <span className="truncate text-[13px] tracking-[-0.224px]">{pl.name}</span>
                    <span className="text-[11px] text-white/65 ml-auto tabular-nums font-semibold">
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
                      {t('common.action.rename')}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      className="text-destructive focus:text-destructive"
                      onClick={() => deletePlaylist(pl.id)}
                    >
                      <Trash2 className="h-4 w-4 mr-2" strokeWidth={1.5} />
                      {t('common.action.delete')}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            ))
          )}
        </div>
      </div>

      {/* 版本号：品牌名与版本号是产品标识串，不进字典（与 nav.brand.name 同源） */}
      <div className="px-4 py-3 border-t border-white/5">
        <p className="font-text text-[11px] text-white/65 tracking-[-0.12px]">
          {t('shell.brand.full')} v{APP_VERSION}
        </p>
      </div>

      <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('shell.playlist.create')}</DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            placeholder={t('shell.playlist.namePlaceholder')}
            value={newPlaylistName}
            onChange={(e) => setNewPlaylistName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleCreatePlaylist()
            }}
          />
          <DialogFooter>
            <Button variant="secondary" onClick={() => setShowCreateDialog(false)}>
              {t('common.action.cancel')}
            </Button>
            <Button variant="primary" onClick={handleCreatePlaylist}>{t('shell.playlist.submit')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <PlaylistImportDialog open={showImportDialog} onOpenChange={setShowImportDialog} />
    </div>
  )
}
