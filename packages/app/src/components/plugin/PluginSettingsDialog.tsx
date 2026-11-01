import { useEffect, useMemo, useState } from 'react'
import { Loader2, Plus, Settings2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useT } from '@/i18n'
import { platform } from '@/services/platform'
import { NAV_LABEL_KEYS } from '@/lib/routes'
import { PluginAuthRow } from '@/components/common/PluginAuthPanel'
import { configsOfPlugin, pluginConfigSurfaces } from '@/components/common/pluginConfig'
import { displayNameOf } from '@/components/common/pluginManage'
import { formKindOf } from '@/components/common/pluginForm'
import {
  SourceConfigAddDialog,
  SourceConfigCard,
  StorageConfigAddDialog,
  StorageConfigCard,
  type LibrarySourceStatus,
} from './pluginConfigCards'
import { useLibraryStore } from '@/stores/libraryStore'
import { storagePathPrefix } from '@aurora/shared'
import type { PluginCatalogEntry } from '@aurora/shared'
import type { LibrarySourceConfig, StoragePluginMeta } from '@/types'

/**
 * 单个插件的设置面板。
 *
 * ## 为什么是一个**独立弹窗**而不是设置页里的一块
 *
 * 配置按插件归属之后，每个插件都要有自己的一份 UI，而插件数量随用户安装而增长。
 * 若全部平铺进设置页，页面长度由"装了多少插件"决定 —— 装十个插件的人要滚十屏，
 * 而其中九屏他并不想改。以弹窗承载，设置页的长度就只与分区数有关。
 *
 * ## 面板里放什么：只放**这个插件自己的**东西
 *
 * 三段（音源 / 网络存储 / 登录）互不排斥，由 `pluginConfigSurfaces()` 按插件域与
 * 能力声明决定；插件不涉及的那一段整块不渲染（不是渲染成空段——空段会让人以为
 * "这里本该有东西但没加载出来"）。
 *
 * ## 配置的增删改全在这里
 *
 * 设置页不再有「音源」「网络存储」两行，因此这里必须把原来那两行能做的一切都接过来：
 * 新增、编辑、启停、删除、测试连接、扫描入库。任何一项漏掉，用户就得靠改配置文件
 * 才能完成对应操作。
 */
export function PluginSettingsDialog({
  entry,
  open,
  onOpenChange,
}: {
  entry: PluginCatalogEntry
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const t = useT()
  // 仅桌面端实现了主进程侧的存储插件代理与扫描；Web/移动端即便目录里有存储条目，
  // 也没有可用的配置动作（连不上、扫不了）。那种情况下把「网络存储」整段去掉，
  // 而不是留一个只有空态、没有新增按钮的分区 —— 后者读起来像功能坏了。
  const supportsLibrarySources = typeof platform.scanLibrarySource === 'function'
  // 硬件能力参与「有哪些面」的判定：与卡片上的齿轮用**同一个** capability，
  // 否则会出现"卡片有入口、点开是空分区"
  const configCapability = { storage: supportsLibrarySources }
  const surfaces = pluginConfigSurfaces(entry, configCapability)

  // ─── 音源配置 ───
  const onlineSources = useLibraryStore((s) => s.onlineSources)
  const addOnlineSource = useLibraryStore((s) => s.addOnlineSource)
  const updateOnlineSource = useLibraryStore((s) => s.updateOnlineSource)
  const removeOnlineSource = useLibraryStore((s) => s.removeOnlineSource)

  // ─── 网络存储配置 ───
  const librarySources = useLibraryStore((s) => s.librarySources)
  const addLibrarySource = useLibraryStore((s) => s.addLibrarySource)
  const updateLibrarySource = useLibraryStore((s) => s.updateLibrarySource)
  const removeLibrarySource = useLibraryStore((s) => s.removeLibrarySource)
  /**
   * 可用的存储协议（插件的纯数据 meta）：决定卡片渲染哪些字段，以及新增弹窗的字段集。
   *
   * `null` = 还没读到，"空数组" = 读到了但没有这个插件。两者必须分开：
   * 混成空数组会让面板在首帧渲染出「一条字段都没有」的编辑表单 —— 用户看到的是
   * 一个点不动的保存按钮，而不是"正在加载"。
   */
  const [storagePlugins, setStoragePlugins] = useState<StoragePluginMeta[] | null>(null)
  const [libraryStatus, setLibraryStatus] = useState<Record<string, LibrarySourceStatus>>({})

  // 只拉一次：本插件的字段声明在面板打开期间不会变
  useEffect(() => {
    if (!open || !supportsLibrarySources) return
    let cancelled = false
    void (async () => {
      const list = (await platform.listStoragePlugins?.()) || []
      if (!cancelled) setStoragePlugins(list)
    })()
    return () => {
      cancelled = true
    }
  }, [open, supportsLibrarySources])

  const [addSourceOpen, setAddSourceOpen] = useState(false)
  const [addStorageOpen, setAddStorageOpen] = useState(false)

  // 关闭面板时收起两个新增弹窗：下次打开是"这个插件现在的设置"，不该留着上次的弹窗
  useEffect(() => {
    if (open) return
    setAddSourceOpen(false)
    setAddStorageOpen(false)
  }, [open])

  const bundle = useMemo(
    () => configsOfPlugin(entry, onlineSources, librarySources, { storage: supportsLibrarySources }),
    [entry, onlineSources, librarySources, supportsLibrarySources]
  )

  // 展示名双形态（内置给字典键、已安装给字面量）的解析收在 pluginManage 一处，不在这里再写一遍
  const displayName = displayNameOf(entry, t)
  const storageMeta = storagePlugins?.find((p) => p.id === entry.id)
  /** 本插件的存储字段是否还没读到：读到之前整段存储配置显示加载态而不是空表单 */
  const storageMetaLoading = supportsLibrarySources && storagePlugins === null && surfaces.includes('storage')

  /**
   * 测试存储连通性：只列举根目录，不递归、不入库，用于确认地址与账号是否正确。
   */
  const handleProbeStorage = async (source: LibrarySourceConfig) => {
    setLibraryStatus((s) => ({ ...s, [source.id]: { loading: true } }))
    try {
      const result = await platform.probeLibrarySource?.(source.id)
      setLibraryStatus((s) => ({
        ...s,
        [source.id]: { loading: false, ok: result?.ok, message: result?.message },
      }))
    } catch (err) {
      setLibraryStatus((s) => ({
        ...s,
        [source.id]: { loading: false, ok: false, message: (err as Error).message },
      }))
    }
  }

  /**
   * 扫描网络存储并入库。渐进式结果经 track:scanned 事件流式刷新曲库，
   * 这里只负责给出「是否完整」的反馈——有目录列举失败时必须明确告知用户，
   * 因为那种情况下应用会保守地跳过缺失清理，曲库可能与远端不一致。
   */
  const handleScanStorage = async (source: LibrarySourceConfig) => {
    setLibraryStatus((s) => ({ ...s, [source.id]: { loading: true } }))
    try {
      const result = await platform.scanLibrarySource?.(source.id)
      if (result?.tracks) useLibraryStore.getState().setTracks(result.tracks)
      const count = result?.tracks.length ?? 0
      setLibraryStatus((s) => ({
        ...s,
        [source.id]: result?.complete
          ? { loading: false, ok: true, message: t('sources.webdav.scanComplete', { count }) }
          : {
              loading: false,
              ok: false,
              message: t('sources.webdav.scanIncomplete', { count: result?.failedDirs ?? 0 }),
            },
      }))
    } catch (err) {
      setLibraryStatus((s) => ({
        ...s,
        [source.id]: { loading: false, ok: false, message: (err as Error).message },
      }))
    }
  }

  /** 移除网络存储来源：连同该来源的曲目一起从曲库删除（远端文件不受影响） */
  const handleRemoveStorage = async (source: LibrarySourceConfig) => {
    // 前缀形状由 shared 的 storagePathPrefix 唯一决定，本层不复写字面量
    const prefix = storagePathPrefix(source.id)
    const libraryLabel = t(NAV_LABEL_KEYS.library)
    const affected = useLibraryStore.getState().tracks.filter((track) => track.path.startsWith(prefix)).length
    const ok = window.confirm(
      affected > 0
        ? t('sources.webdav.removeConfirmWithCount', { name: source.name, count: affected, library: libraryLabel })
        : t('sources.webdav.removeConfirm', { name: source.name })
    )
    if (!ok) return
    // 先从配置里摘掉，避免移除过程中后台扫描又把曲目写回（与本地目录移除同一套顺序）
    removeLibrarySource(source.id)
    try {
      const remaining = await platform.removeLibrarySource?.(source.id)
      if (remaining) useLibraryStore.getState().setTracks(remaining)
    } catch (err) {
      console.warn('移除来源曲目失败，已解除该来源配置:', err)
    }
  }

  // 这个插件没有任何可配置面：不显示空面板（设置页侧也不会给「配置」入口，
  // 这里是双保险，避免入口判定与本面板判定将来分叉）
  if (surfaces.length === 0) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-white text-tagline">{t('sources.config.title', { name: displayName })}</DialogTitle>
          </DialogHeader>
          <p className="font-text text-caption text-white/50">{t('sources.config.noConfig')}</p>
          <DialogFooter>
            <Button variant="ghost" size="sm" className="h-9 px-4 text-white/70" onClick={() => onOpenChange(false)}>
              {t('common.action.close')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    )
  }

  const sectionHead = (title: string, hint: string, action?: React.ReactNode) => (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="font-text text-caption-strong text-white/85">{title}</p>
        <p className="font-text text-caption text-white/45 mt-0.5">{hint}</p>
      </div>
      {action && <div className="flex-shrink-0">{action}</div>}
    </div>
  )

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-white text-tagline">
              <Settings2 className="h-4 w-4 text-mint flex-shrink-0" strokeWidth={1.7} />
              {t('sources.config.title', { name: displayName })}
            </DialogTitle>
            <p className="font-text text-caption text-white/50">{t('sources.config.desc')}</p>
          </DialogHeader>

          {/* 弹窗内部自己滚动：装了很多条配置的插件不该把弹窗顶出屏幕 */}
          <div className="max-h-[60vh] overflow-y-auto scrollbar-thin -mr-2 pr-2 space-y-5">
            {/* ─── 音源 ─── */}
            {surfaces.includes('sources') && (
              <section className="space-y-2">
                {sectionHead(
                  t('sources.config.sectionSources'),
                  t('sources.config.sectionSourcesHint'),
                  <Button
                    variant="secondary"
                    size="sm"
                    className="h-8 px-3"
                    onClick={() => setAddSourceOpen(true)}
                  >
                    <Plus className="h-3.5 w-3.5 mr-1.5" strokeWidth={1.6} />
                    {t('common.action.add')}
                  </Button>
                )}
                {bundle.sources.length === 0 ? (
                  <p className="font-text text-caption text-white/40 py-1.5">{t('sources.config.sourceEmpty')}</p>
                ) : (
                  <div className="space-y-2">
                    {bundle.sources.map((source) => (
                      <SourceConfigCard
                        key={source.id}
                        source={source}
                        // 字段布局按插件形态推导（service / script / playlist），与归属是两件事
                        formKind={formKindOf(entry.id)}
                        onUpdate={(updates) => updateOnlineSource(source.id, updates)}
                        onRemove={() => removeOnlineSource(source.id)}
                      />
                    ))}
                  </div>
                )}
              </section>
            )}

            {/* ─── 网络存储 ─── */}
            {surfaces.includes('storage') && (
              <section className="space-y-2">
                {sectionHead(
                  t('sources.config.sectionStorage'),
                  t('sources.config.sectionStorageHint'),
                  supportsLibrarySources ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      className="h-8 px-3"
                      onClick={() => setAddStorageOpen(true)}
                    >
                      <Plus className="h-3.5 w-3.5 mr-1.5" strokeWidth={1.6} />
                      {t('common.action.add')}
                    </Button>
                  ) : undefined
                )}
                {storageMetaLoading ? (
                  // 字段声明还没到：显示加载态。渲染成"没有网络存储"或空编辑表单都是错的
                  // —— 前者否认已有配置，后者给人一个存不下去的表单
                  <p className="flex items-center gap-2 font-text text-caption text-white/45 py-1.5">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.6} />
                    {t('common.state.loading')}
                  </p>
                ) : bundle.librarySources.length === 0 ? (
                  <p className="font-text text-caption text-white/40 py-1.5">{t('sources.config.storageEmpty')}</p>
                ) : (
                  <div className="space-y-2">
                    {bundle.librarySources.map((source) => (
                      <StorageConfigCard
                        key={source.id}
                        source={source}
                        plugin={storageMeta}
                        status={libraryStatus[source.id] || {}}
                        onUpdate={(updates) => updateLibrarySource(source.id, updates)}
                        onProbe={() => void handleProbeStorage(source)}
                        onScan={() => void handleScanStorage(source)}
                        onRemove={() => void handleRemoveStorage(source)}
                        onClearCredential={() => platform.clearStorageCredential?.(source.id) ?? Promise.resolve(undefined)}
                      />
                    ))}
                  </div>
                )}
              </section>
            )}

            {/* ─── 登录 ─── */}
            {surfaces.includes('auth') && (
              <section className="space-y-2">
                {sectionHead(t('sources.config.sectionAuth'), t('sources.config.sectionAuthHint'))}
                <PluginAuthRow
                  plugin={{
                    displayNameKey: entry.displayNameKey ?? entry.id,
                    id: entry.id,
                  }}
                />
              </section>
            )}
          </div>

          <DialogFooter>
            <Button variant="ghost" size="sm" className="h-9 px-4 text-white/70" onClick={() => onOpenChange(false)}>
              {t('common.action.close')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 新增弹窗挂在面板之外：面板滚动区里固定定位的弹层会被裁切 */}
      {surfaces.includes('sources') && (
        <SourceConfigAddDialog
          open={addSourceOpen}
          onOpenChange={setAddSourceOpen}
          entry={entry}
          // 不加成功 toast：弹窗关闭 + 新卡片出现在列表里就是反馈，
          // 再补一句「已保存」只是把视线从结果上引开
          onSave={(source) => addOnlineSource(source)}
        />
      )}
      {surfaces.includes('storage') && (
        <StorageConfigAddDialog
          open={addStorageOpen}
          onOpenChange={setAddStorageOpen}
          plugin={storageMeta}
          onSave={(source, secrets) => {
            const id = addLibrarySource({ ...source, enabled: true })
            // 口令不进 store / localStorage：直接送主进程加密落盘。
            // 写入失败（如本机无 keyring）不静默——卡片会显示「需重新输入」。
            if (Object.keys(secrets).length > 0) {
              void (async () => {
                const result = await platform.saveStorageCredential?.(id, secrets)
                if (!result?.ok) {
                  setLibraryStatus((s) => ({
                    ...s,
                    [id]: {
                      loading: false,
                      ok: false,
                      message: result?.encryptionAvailable
                        ? t('sources.webdav.credentialMissing')
                        : t('sources.webdav.credentialUnavailable'),
                    },
                  }))
                }
              })()
            }
          }}
        />
      )}
    </>
  )
}
