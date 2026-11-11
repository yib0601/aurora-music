import { useEffect, useRef, useState } from 'react'
import { Copy, Loader2, Plus, Radar, RefreshCw, ShieldCheck } from 'lucide-react'
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
import {
  pairWithLanPeer,
  refreshLanStatus,
  rotateLanCode,
  scanLanPeers,
  setLanSyncEnabled,
  syncAllNow,
} from '@/services/playlistSync.service'
import { useSyncStore } from '@/stores/syncStore'
import { SyncConfigAddDialog, SyncConfigCard, newSyncConfig, type SyncConfigDraft } from './syncConfigCards'
import { LAN_SYNC_PLUGIN_ID, listSyncPluginMeta } from '@aurora/shared'
import type { LanPairFailureReason, LanPeerInfo, SyncConfig, SyncPluginMeta } from '@aurora/shared'
import { pairFailureText } from './lanPairMessages'

/**
 * 「设置 → 插件 → 歌单同步」的面板主体。
 *
 * 三块，自上而下：
 * 1. **同步目标**：这个插件下的每条配置一张卡片（增删改、立即同步、测试连接）；
 * 2. **本机服务**（只有局域网那条链路有）：开关、配对码、监听端口；
 * 3. **发现的设备**（同上）：扫描同网段设备，一键加为同步目标。
 *
 * 第 2、3 块只在 `LAN_SYNC_PLUGIN_ID` 这个插件下出现 —— 「本机监听 45871」是设备级
 * 而不是配置级的事实，挂在 WebDAV 那条配置下面只会让人以为它属于那个存储。
 */
export function PlaylistSyncPanel({ pluginId }: { pluginId: string }) {
  const t = useT()
  const supported = platform.supportsPlaylistSync === true

  const configs = useSyncStore((state) => state.configs)
  const addConfig = useSyncStore((state) => state.addConfig)
  const updateConfig = useSyncStore((state) => state.updateConfig)
  const removeConfig = useSyncStore((state) => state.removeConfig)
  const lan = useSyncStore((state) => state.lan)

  const [plugins, setPlugins] = useState<SyncPluginMeta[]>([])
  const [addOpen, setAddOpen] = useState(false)
  const [peerTarget, setPeerTarget] = useState<LanPeerInfo | null>(null)
  /** 待确认删除的配置：用对话框而不是 `window.confirm`（标题/说明都要走 i18n 键） */
  const [pendingRemove, setPendingRemove] = useState<SyncConfig | null>(null)
  /**
   * 正在配对的设备（null = 没有进行中的配对）。
   *
   * 用它而不是布尔：等待弹窗要显示「正在等哪台设备确认」，而 `pairStart` 是长轮询，
   * 用户可能同时看到多台设备，光一个 true 说不清。
   */
  const [pairingPeer, setPairingPeer] = useState<LanPeerInfo | null>(null)
  /** 用户是否主动关掉了等待框：是的话结果回来时不该再弹「配对失败」 */
  const pairCancelledRef = useRef(false)

  const isLanPlugin = pluginId === LAN_SYNC_PLUGIN_ID

  // 插件 meta 是纯数据快照：注册表在启动时装配完成，面板打开即读，不需要订阅
  useEffect(() => {
    if (!supported) return
    setPlugins(listSyncPluginMeta().filter((meta) => meta.available && meta.enabled))
  }, [supported])

  useEffect(() => {
    if (!supported || !isLanPlugin) return
    void refreshLanStatus()
  }, [supported, isLanPlugin])

  const mine = configs.filter((config) => config.pluginId === pluginId)

  /** 新增：配置进 store，口令直接送主进程（失败不静默，卡片会显示「未保存口令」） */
  const handleAdd = (draft: SyncConfigDraft, secrets: Record<string, string>) => {
    const config = newSyncConfig(draft)
    addConfig(config)
    if (Object.keys(secrets).length > 0) {
      void platform.sync?.saveCredential(config.id, secrets)
    }
  }

  /** 删除：先摘配置（界面立刻消失），再清主进程里的口令，最后清运行时状态 */
  const handleRemove = (config: SyncConfig) => {
    removeConfig(config.id)
    void platform.sync?.clearCredential(config.id)
    toast(t('sync.config.deleted'))
  }

  const status = lan.status

  const handleToggleService = () => {
    if (!status) return
    void setLanSyncEnabled(!status.running)
  }

  const handleRotate = () => {
    if (!window.confirm(t('sync.server.rotateWarn'))) return
    void rotateLanCode().then((next) => {
      if (next) toast(t('sync.server.rotated'))
    })
  }

  const [codeVisible, setCodeVisible] = useState(false)

  const handleCopyCode = () => {
    if (!status?.code) return
    void navigator.clipboard?.writeText(status.code).then(() => toast(t('sync.server.copied')))
  }

  const handleScan = () => {
    void scanLanPeers().then((peers) => {
      if (peers.length === 0) toast(t('sync.discover.empty'), { type: 'info' })
    })
  }

  /**
   * 一键配对：点一下 → 对端弹确认框 → 两端各自建一条双向目标。
   *
   * 这里不碰配对码：码在两端主进程之间用 ECDH 封装后传递，渲染层只拿「成没成」
   * 与失败原因（§16）。失败仍保留「手动填码」这条退路，所以不把失败弹成阻断式对话框。
   */
  const handlePair = (peer: LanPeerInfo) => {
    pairCancelledRef.current = false
    setPairingPeer(peer)
    void pairWithLanPeer(peer)
      .then((outcome) => {
        // 用户自己关掉了等待框：这是取消，不是失败，不弹任何提示
        if (!outcome.ok) {
          if (!pairCancelledRef.current && outcome.reason !== 'cancelled') {
            toast(pairFailureText(t, outcome.reason as LanPairFailureReason, peer), { type: 'error' })
          }
          return
        }
        toast(t('sync.pair.paired', { name: outcome.config.name }), { type: 'success' })
      })
      .finally(() => setPairingPeer(null))
  }

  /**
   * 把发现到的设备加成同步目标：host/port 已知，**配对码要用户抄**（不走广播）。
   *
   * 配对码**不进 settings**（那是 localStorage 的明文，验证报告 S-3）：走与 WebDAV
   * 口令同一条 `saveCredential` 通道进主进程 safeStorage。
   */
  const handleAddPeer = (peer: LanPeerInfo, code: string, name: string) => {
    const config: SyncConfig = {
      id: newSyncConfigId(),
      pluginId: LAN_SYNC_PLUGIN_ID,
      name,
      settings: { host: peer.host, port: peer.port },
      direction: 'bidirectional',
      autoSync: true,
      enabled: true,
    }
    addConfig(config)
    if (code) void platform.sync?.saveCredential(config.id, { code })
    toast(t('sync.discover.added', { name }))
  }

  if (!supported) {
    return <p className="font-text text-caption text-white/45 py-1.5">{t('sync.panel.unsupported')}</p>
  }

  return (
    <div className="space-y-3">
      {mine.length === 0 ? (
        <div className="inset-row px-3.5 py-3">
          <p className="font-text text-caption-strong text-white/80">{t('sync.panel.emptyTitle')}</p>
          <p className="font-text text-caption text-white/45 mt-0.5">{t('sync.panel.emptyDesc')}</p>
        </div>
      ) : (
        <div className="space-y-2">
          {mine.map((config) => (
            <SyncConfigCard
              key={config.id}
              config={config}
              plugin={plugins.find((meta) => meta.id === config.pluginId)}
              onUpdate={(updates) => updateConfig(config.id, updates)}
              onRemove={() => setPendingRemove(config)}
            />
          ))}
        </div>
      )}

      <div className="flex items-center gap-2">
        <Button variant="secondary" size="sm" className="h-8 px-3" onClick={() => setAddOpen(true)}>
          <Plus className="h-3.5 w-3.5 mr-1.5" strokeWidth={1.6} />
          {t('sync.panel.add')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 px-3 text-white/60 hover:text-white/90"
          onClick={() => void syncAllNow()}
        >
          <RefreshCw className="h-3.5 w-3.5 mr-1.5" strokeWidth={1.6} />
          {t('sync.card.syncNow')}
        </Button>
      </div>

      {/* 冲突与隐私各一句：这两件事用户不读文档也该知道 */}
      <p className="font-text text-caption text-white/35">{t('sync.panel.conflictNote')}</p>
      <p className="font-text text-caption text-white/35">{t('sync.panel.privacyNote')}</p>

      {/* ─── 本机服务 ─── */}
      {isLanPlugin && (
        <section className="space-y-2">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="font-text text-caption-strong text-white/85">{t('sync.server.title')}</p>
              <p className="font-text text-caption text-white/45 mt-0.5">{t('sync.server.enableHint')}</p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={status?.running ?? false}
              disabled={!status}
              onClick={handleToggleService}
              title={t('sync.server.enable')}
              className={`relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors duration-200 ease-mineradio disabled:opacity-40 ${
                status?.running ? 'bg-mint' : 'bg-white/[0.12]'
              }`}
            >
              <span
                className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow-sm transition-transform duration-200 ease-mineradio ${
                  status?.running ? 'translate-x-4.5' : 'translate-x-1'
                }`}
              />
            </button>
          </div>

          {status?.running && status.port ? (
            <p className="font-text text-caption text-mint/80">
              {t('sync.server.running', { port: status.port })}
            </p>
          ) : (
            <p className="font-text text-caption text-white/40">{t('sync.server.stopped')}</p>
          )}

          {status && (
            <div className="inset-row px-3 py-2.5">
              <p className="font-text text-caption text-white/60">{t('sync.server.codeLabel')}</p>
              <div className="mt-1 flex items-center gap-2">
                <code className="font-mono text-caption text-white/85 tracking-wider">
                  {codeVisible ? status.code : t('sync.server.codeHidden')}
                </code>
                {!codeVisible ? (
                  <button
                    type="button"
                    onClick={() => setCodeVisible(true)}
                    className="font-text text-caption text-white/40 hover:text-mint underline underline-offset-2"
                  >
                    {t('sync.server.codeHidden')}
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={handleCopyCode}
                      className="flex items-center gap-1 font-text text-caption text-white/40 hover:text-mint"
                    >
                      <Copy className="h-3 w-3" strokeWidth={1.6} />
                      {t('sync.server.copy')}
                    </button>
                    <button
                      type="button"
                      onClick={handleRotate}
                      className="font-text text-caption text-white/40 hover:text-coral underline underline-offset-2"
                    >
                      {t('sync.server.rotate')}
                    </button>
                  </>
                )}
              </div>
              <p className="font-text text-caption text-white/35 mt-1">{t('sync.server.codeHint')}</p>
              <p className="font-text text-caption text-white/30 mt-0.5">{t('sync.server.plaintextNote')}</p>
            </div>
          )}
        </section>
      )}

      {/* ─── 发现的设备 ─── */}
      {isLanPlugin && (
        <section className="space-y-2">
          <div className="flex items-start justify-between gap-3">
            <p className="font-text text-caption-strong text-white/85">{t('sync.discover.title')}</p>
            <Button variant="secondary" size="sm" className="h-8 px-3" disabled={lan.scanning} onClick={handleScan}>
              {lan.scanning ? (
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" strokeWidth={1.6} />
              ) : (
                <Radar className="h-3.5 w-3.5 mr-1.5" strokeWidth={1.6} />
              )}
              {lan.scanning ? t('sync.discover.scanning') : t('sync.discover.scan')}
            </Button>
          </div>
          <p className="font-text text-caption text-white/40">{t('sync.discover.pairHint')}</p>

          {lan.peers.length === 0 ? (
            <p className="font-text text-caption text-white/40 py-1.5">{t('sync.discover.empty')}</p>
          ) : (
            <div className="space-y-2">
              {lan.peers.map((peer) => {
                const online = Date.now() - peer.lastSeenAt < 60_000
                return (
                  <div key={`${peer.deviceId}:${peer.host}:${peer.port}`} className="inset-row px-3 py-2.5">
                    <div className="flex items-center gap-2">
                      <ShieldCheck
                        className={`h-4 w-4 flex-shrink-0 ${online ? 'text-mint' : 'text-white/30'}`}
                        strokeWidth={1.6}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="font-text text-caption-strong text-white/85 truncate">{peer.deviceName}</p>
                        <p className="font-text text-caption text-white/50 truncate">
                          {peer.host}:{peer.port} · {online ? t('sync.discover.online') : t('sync.discover.offline')}
                        </p>
                      </div>
                      <Button
                        size="sm"
                        className="h-8 px-3 bg-mint text-mint-fg font-semibold hover:bg-mint/90 disabled:opacity-40 disabled:hover:bg-mint"
                        disabled={!online || pairingPeer !== null}
                        onClick={() => handlePair(peer)}
                      >
                        {pairingPeer?.deviceId === peer.deviceId
                          ? t('sync.discover.pairing')
                          : t('sync.discover.pair')}
                      </Button>
                      {/* 手动填码退路：老版本对端、配对反复失败、或发现被防火墙挡掉时仍能配 */}
                      <button
                        type="button"
                        className="font-text text-caption text-white/40 hover:text-mint underline underline-offset-2 flex-shrink-0"
                        disabled={!online}
                        onClick={() => setPeerTarget(peer)}
                      >
                        {t('sync.discover.manualAdd')}
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </section>
      )}

      <SyncConfigAddDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        plugins={plugins}
        onSave={handleAdd}
      />

      <DeleteConfigDialog
        config={pendingRemove}
        onOpenChange={(open) => {
          if (!open) setPendingRemove(null)
        }}
        onConfirm={() => {
          if (!pendingRemove) return
          handleRemove(pendingRemove)
          setPendingRemove(null)
        }}
      />

      {/* 等待对端确认：配对是长轮询，必须给一个「正在进行」的可取消状态 */}
      <Dialog
        open={pairingPeer !== null}
        onOpenChange={(open) => {
          if (open) return
          // 用户自己关掉等待框 = 放弃这次配对：通知宿主停掉长轮询，
          // 否则对端屏幕上会一直挂着一个没人再等的请求，占着它的 pending 名额。
          pairCancelledRef.current = true
          void platform.lanSync?.pairCancel()
          setPairingPeer(null)
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-white text-tagline">{t('sync.pair.title')}</DialogTitle>
            <DialogDescription className="font-text text-caption text-white/60">
              {t('sync.pair.waiting', { name: pairingPeer?.deviceName ?? '' })}
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center justify-end">
            <Button variant="ghost" size="sm" className="h-9 px-4 text-white/60 hover:text-white/90" onClick={() => setPairingPeer(null)}>
              {t('sync.config.cancel')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <AddPeerDialog
        peer={peerTarget}
        onOpenChange={(open) => {
          if (!open) setPeerTarget(null)
        }}
        onAdd={(code, name) => {
          if (!peerTarget) return
          handleAddPeer(peerTarget, code, name)
          setPeerTarget(null)
        }}
      />
    </div>
  )
}

/** 与 `newSyncConfig` 同一套 id 生成；本地包一层避免把 `generateId` 也拖进这个文件 */
function newSyncConfigId(): string {
  return newSyncConfig({ pluginId: LAN_SYNC_PLUGIN_ID, name: '', settings: {}, direction: 'bidirectional', autoSync: true }).id
}

/**
 * 「加为同步目标」的小弹窗：已知地址与端口，只差**配对码**。
 *
 * 配对码刻意不走广播：拿到广播包的人只该知道「这儿有台设备」，不该拿到写歌单的权限。
 */
function AddPeerDialog({
  peer,
  onOpenChange,
  onAdd,
}: {
  peer: LanPeerInfo | null
  onOpenChange: (open: boolean) => void
  onAdd: (code: string, name: string) => void
}) {
  const t = useT()
  const [code, setCode] = useState('')
  const [name, setName] = useState('')

  // 每换一台设备就重置：留着上一台的配对码是最容易出错的一种「便利」
  useEffect(() => {
    setCode('')
    setName(peer?.deviceName ?? '')
  }, [peer])

  const inputCls = 'inset-field w-full px-2.5 py-1.5 font-text text-caption text-white/70'
  const canAdd = code.trim().length > 0 && name.trim().length > 0

  return (
    <Dialog open={peer !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-white text-tagline">{t('sync.discover.add')}</DialogTitle>
          <DialogDescription className="font-text text-caption text-white/60">
            {peer ? `${peer.deviceName} · ${peer.host}:${peer.port}` : ''}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <p className="font-text text-caption text-white/60 mb-1.5">{t('sync.config.nameLabel')}</p>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} className={inputCls} />
          </div>
          <div>
            <p className="font-text text-caption text-white/60 mb-1.5">{t('sync.lan.codeLabel')}</p>
            <input
              type="text"
              value={code}
              placeholder={t('sync.lan.codePlaceholder')}
              onChange={(e) => setCode(e.target.value)}
              className={inputCls}
              autoComplete="off"
            />
            <p className="font-text text-caption text-white/40 mt-1">{t('sync.lan.codeHint')}</p>
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="ghost"
            size="sm"
            className="h-9 px-4 text-white/60 hover:text-white/90"
            onClick={() => onOpenChange(false)}
          >
            {t('sync.config.cancel')}
          </Button>
          <Button
            size="sm"
            className="h-9 px-5 bg-mint text-mint-fg font-semibold hover:bg-mint/90 disabled:opacity-40 disabled:hover:bg-mint"
            disabled={!canAdd}
            onClick={() => onAdd(code.trim(), name.trim())}
          >
            {t('sync.discover.add')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * 删除确认：`window.confirm` 已经够用，但它的标题由浏览器给、文案进不了 i18n，
 * 而「删掉的是一条指向别的设备的同步目标」值得让用户看清是哪台设备。
 */
function DeleteConfigDialog({
  config,
  onOpenChange,
  onConfirm,
}: {
  config: SyncConfig | null
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}) {
  const t = useT()
  return (
    <Dialog open={config !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-white text-tagline">{t('sync.config.deleteTitle')}</DialogTitle>
          <DialogDescription className="font-text text-caption text-white/60">
            {config ? `${config.name} · ${t('sync.config.deleteDesc')}` : ''}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="ghost"
            size="sm"
            className="h-9 px-4 text-white/60 hover:text-white/90"
            onClick={() => onOpenChange(false)}
          >
            {t('sync.config.cancel')}
          </Button>
          <Button
            size="sm"
            className="h-9 px-5 bg-coral text-white font-semibold hover:bg-coral/90"
            onClick={onConfirm}
          >
            {t('sync.config.delete')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
