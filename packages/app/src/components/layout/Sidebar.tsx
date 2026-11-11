import { useState } from 'react'
import { Heart, Clock, ListMusic, Settings, Plus, MoreHorizontal, Trash2, Pencil, Upload, FileText, Link2, Library, Radio } from 'lucide-react'
import { BrandMark } from '@/components/common/BrandMark'
import { NavLink } from 'react-router-dom'
import { cn } from '@/lib/utils'
import { NAV_LABEL_KEYS, ROUTES, visibleNavItems, type NavItem } from '@/lib/routes'
import { useHallAvailable } from '@/hooks/useHallAvailability'
import { useLikedDisplayCount } from '@/hooks/useLikedDisplayCount'
import { Button } from '@/components/ui/button'
import { usePlaylistStore } from '@/stores/playlistStore'
import { useLibraryStore } from '@/stores/libraryStore'
import { pickM3UFile, parseM3U, matchTracksByPaths } from '@/services/playlistIO.service'
import { APP_VERSION } from '@/services/update.service'
import { PlaylistImportDialog } from '@/components/PlaylistImportDialog'
import { CreatePlaylistDialog } from '@/components/layout/CreatePlaylistDialog'
import { toast } from '@/components/common/Toast'
import { useT } from '@/i18n'
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
 * 顺序即产品优先级：**音乐库（在线）排第一位**，它是冷启动主屏的首选（`homeRoute`），
 * 导航首位与主屏保持一致，用户按「第一位 = 首屏」的直觉操作不会错位。
 * 我的音乐（本地曲库）紧随其后。
 *
 * 这张表是**全量**表：没有可用音源时「音乐库」这一项要藏起来（点进去只有引导空态），
 * 过滤统一走 `visibleNavItems`，判定口径见 `lib/hallAvailability.ts`。
 * 不要在渲染处再写一遍 `hallAvailable ? ... : ...`——移动端抽屉有同样一张表。
 *
 * ⚠️ 「收藏」**不在这张表里**：它是「系统歌单」，与用户自建歌单同列在下方歌单组的第一位
 * （= `nav.item.liked` 那一行，不可改名、不可删除，计数见 `useLikedDisplayCount`）。
 * 用户对「收藏是不是一个歌单」的直觉是「是」——那就让它在结构上也站在歌单里，
 * 而不是先在主导航占一格、再让人去歌单里另找一个不存在的自己。
 * 移动端抽屉（MobileNav）同样是这个结构：它渲染同一份歌单分组，收藏也在组里。
 *
 * ⚠️ 收藏页只列**曲库里的歌**：在线曲目不在 `libraryStore.tracks` 里，对它点收藏当前是
 * **空转**——`toggleLike` 只映射 `tracks`，找不到曲目就既不点亮爱心、也不写 `likeRecords`。
 * 入口对在线曲目是开放的（歌曲详情页、搜索、列表右键），但点了不生效；别把这条读成
 * 「在线曲目已支持收藏」，也别说成「收藏页会显示在线歌曲」。
 *
 * 名称沿革见 lib/routes.ts 的 NAV_LABEL_KEYS 处注释：曾用「音乐库 / 音乐馆」，
 * 再改「我的音乐 / 在线音乐」+「我的 / 在线」分组，现取消分组且「音乐库」改指在线页。
 * 「最近播放」跨来源（统一登记本地与在线），与两个内容页平级。
 *
 * 表里存的是**键**（`NavItem.labelKey`）而不是译文：模块级常量数组若存字符串，
 * 语言会在模块加载那一刻被冻结，用户切语言后导航项不会跟着变。译文一律在渲染期取。
 * 「设置」不在此表，由 footerItems 单独给出（它是应用配置，不是内容项）。
 */
const navItems: NavItem[] = [
  { to: ROUTES.hall, icon: Radio, labelKey: NAV_LABEL_KEYS.hall },
  { to: ROUTES.library, icon: Library, labelKey: NAV_LABEL_KEYS.library },
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
    'nav-link group relative flex items-center gap-3 h-10 px-3 rounded-ds-media text-[14px] font-normal tracking-[-0.224px] transition-[background,color,box-shadow] duration-200 ease-mineradio border',
    spaced && 'mt-3',
    isActive
      ? 'nav-link-active bg-mint/[0.09] border-mint/[0.12] text-white font-medium'
      : 'border-transparent text-white/65 hover:text-white/95 hover:bg-white/[0.045]',
  )

/**
 * 侧边栏：Mineradio 品牌色 × DS 参考设计语言的结构语言
 * - 品牌主色仍是 mint #00F5D4（项目识别），DS 负责结构/材质/排版
 * - active 态用「品牌低透底色 + 主色字/图标」标识选中：导航是全局方位锚点，
 *   仅靠 surface 层级差（白 7% 底 + 发丝边）在浅色主题与暖色封面色场下
 *   辨识度不足——底色与玻璃同族时几乎看不出选中项，改用色相区分
 * - 仍不用实心 mint 色块与 text-shadow 微光（DS Don't：不滥用发光）
 * - 导航项圆角走 DS media 档（10px），间距走 DS 阶梯
 */
export function Sidebar() {
  const t = useT()
  const playlists = usePlaylistStore((s) => s.playlists)
  const createPlaylist = usePlaylistStore((s) => s.createPlaylist)
  const deletePlaylist = usePlaylistStore((s) => s.deletePlaylist)
  const renamePlaylist = usePlaylistStore((s) => s.renamePlaylist)
  const addTracksToPlaylist = usePlaylistStore((s) => s.addTracksToPlaylist)
  const tracks = useLibraryStore((s) => s.tracks)
  // 系统歌单「收藏」的条数：去重后的展示行数，与收藏页同一口径（见 useLikedDisplayCount）。
  const likedCount = useLikedDisplayCount()
  // 没有可用音源时音乐库入口整项隐藏：它点进去只有「去配置音源」空态，
  // 留在侧栏第一项会让人以为应用坏了（判定口径见 lib/hallAvailability.ts）
  const hallAvailable = useHallAvailable()
  const items = visibleNavItems(navItems, hallAvailable)
  const [showCreateDialog, setShowCreateDialog] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingName, setEditingName] = useState('')
  const [showImportDialog, setShowImportDialog] = useState(false)

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
      <div className="flex items-center gap-3 px-4 pb-6 pt-5">
        <BrandMark className="h-10 w-10" />
        <div className="flex flex-col">
          <span className="font-display font-semibold text-[16px] tracking-[-0.32px] text-white/[0.96] leading-tight">
            {t('nav.brand.name')}
          </span>
          <span className="font-text text-[11px] text-white/65 leading-tight mt-0.5">
            {t('nav.brand.subtitle')}
          </span>
        </div>
      </div>

      {/* 主导航：音乐库（在线发现）居首，与主屏一致；无可用音源时该项由 visibleNavItems 滤掉 */}
      <nav className="flex flex-col gap-px px-3 mt-1">
        {items.map(({ to, icon: Icon, labelKey }) => (
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

      {/*
        歌单分组：标题与系统歌单「收藏」**固定**，只有自建歌单列表滚动。
        收藏不跟着滚——它是歌单组的第一项，但「歌单多到把它挤出视野」会让人以为
        收藏没了（旧版它在主导航里是常驻可见的），所以这里把滚动区收到的只有列表。
      */}
      <div className="mt-5 flex-1 flex flex-col min-h-0 px-3">
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
          {/*
            系统歌单「收藏」：它不是 `playlistStore` 里的 Playlist 记录——不能改名、不能删除，
            路由仍是 /liked（页面标题「我喜欢的音乐」）。它在同步里是另一套记录
            （每首歌一条、逐条裁决，见 docs/playlist-sync.md §5.1），但仍然属于歌单分组。
            但对用户来说它就是歌单组里的第一个歌单，所以与下方自建歌单**共用同一行样式**：
            样式不同会让「这是不是歌单」重新变成一个要靠猜的问题。
            计数取去重后的展示行数（与收藏页同源，见 useLikedDisplayCount）；
            为 0 时也照常显示，空歌单本来就是歌单。
          */}
          <NavLink
            to={ROUTES.liked}
            className={({ isActive }) =>
              cn(
                'group flex items-center gap-2.5 h-9 px-3 rounded-ds-media min-w-0 transition-all duration-200 ease-mineradio border',
                isActive
                  ? 'bg-white/[0.07] border-white/[0.10] text-white shadow-[inset_0_1px_0_rgba(255,255,255,.06)]'
                  : 'border-transparent text-white/65 hover:text-white hover:bg-white/[0.045]'
              )
            }
          >
            <Heart
              className="h-3.5 w-3.5 flex-shrink-0 opacity-50 group-aria-[current=page]:text-mint group-aria-[current=page]:opacity-100"
              strokeWidth={1.5}
            />
            <span className="truncate text-[13px] tracking-[-0.224px]">{t('nav.item.liked')}</span>
            <span className="text-[11px] text-white/65 ml-auto tabular-nums font-semibold">
              {likedCount}
            </span>
          </NavLink>
        </div>
        {/* 自建歌单列表：整块滚动区只有它（收藏已在上面固定住） */}
        <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin flex flex-col gap-px">
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
                          : 'border-transparent text-white/65 hover:text-white hover:bg-white/[0.045]'
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

      {/* 新建歌单：与移动端抽屉共用同一份对话框（见 CreatePlaylistDialog） */}
      <CreatePlaylistDialog open={showCreateDialog} onOpenChange={setShowCreateDialog} />

      <PlaylistImportDialog open={showImportDialog} onOpenChange={setShowImportDialog} />
    </div>
  )
}
