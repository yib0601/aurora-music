import { useState } from 'react'
import { CheckCircle2, Cloud, Pencil, RefreshCw, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useT } from '@/i18n'
import { toast } from '@/components/common/Toast'
import { platform } from '@/services/platform'
import { NAV_LABEL_KEYS } from '@/lib/routes'
import { compactEndpointUrl } from '@/lib/endpointPreview'
import { LxScriptProbe, type LxProbeState } from '@/components/common/LxSourceProbe'
import { checkLxScriptLink, renderError } from '@/components/common/lxSourceForm'
import { formKindOf, type PluginFormKind } from '@/components/common/pluginForm'
import { newConfigOwner, newSourceEnabled } from '@/components/common/pluginConfig'
import type { StorageCredentialState, StorageFieldDef, StoragePluginMeta } from '@/types'
import { buildAuroraEndpoints, checkSourceForm, storageStringField } from '@aurora/shared'
import type { AuroraEndpoints, LibrarySourceConfig, OnlineSourceConfig, PluginCatalogEntry } from '@aurora/shared'

/**
 * 插件配置的**表单件**：音源卡片 / 音源新增弹窗 / 存储卡片 / 存储新增弹窗。
 *
 * ## 为什么从设置页搬出来
 *
 * 这四块原先住在 `SettingsPage.tsx`（该文件已 2700 行），且与「配置归谁所有」无关 ——
 * 谁渲染它们就把所有插件的配置一起列出来。配置按插件归属之后，同一套表单要在
 * **每个插件的设置面板**里复用，留在页面里就只能靠复制。
 *
 * ## 与旧版的唯一区别：插件是**入参**，不再由用户选
 *
 * 旧的新增弹窗顶部有一个「音源形态 / 协议」选择器：进门先选插件，再填字段。
 * 现在入口本身就是某个插件的设置面板，插件已经确定，选择器整块去掉 ——
 * 少一步选择，也少一处「选了 A 却填了 B 的字段」的可能。
 * 表单形态仍由 `PluginFormKind` 决定（service / script / playlist），
 * 那是**字段布局**，与归属是两件事，仍走 `pluginForm.ts` 的推导。
 *
 * 口令纪律不变：`kind: 'password'` 的字段只进凭证 IPC，**不进 settings 持久化**，
 * 且渲染层永不回读（编辑时留空 = 不改）。
 */

/** 网络存储来源的探测/扫描状态（每个来源一条，互不干扰） */
export type LibrarySourceStatus = { loading?: boolean; ok?: boolean; message?: string }

/**
 * 单个音源配置卡片：默认只展示名称 + 能力徽章 + 启用开关；点编辑展开草稿表单，
 * 校验通过后点保存才写入 store。
 *
 * 三种形态共用这张卡片，字段布局由 `formKind` 决定：
 * - `service`（Aurora 协议源）：服务地址 / 接口模板，端点由软件派生；
 * - `script`（洛雪脚本）：脚本链接 + 可选请求头；
 * - `playlist`（汽水音乐这类）：歌单链接或 id，登录是面板里的另一段。
 *
 * 探测结论一律**不落库**：每次进编辑按需现探，配置里只留用户填的那条链接
 * （+ 服务端自描述的端点缓存）。
 */
export function SourceConfigCard({
  source,
  formKind,
  onUpdate,
  onRemove,
}: {
  source: OnlineSourceConfig
  formKind: PluginFormKind
  onUpdate: (updates: Partial<Omit<OnlineSourceConfig, 'id'>>) => void
  onRemove: () => void
}) {
  const t = useT()
  const { name, sourceUrl, playlistUrl, endpoints, headers, enabled } = source
  const hasHeaders = headers != null && Object.keys(headers).length > 0
  const isLx = formKind === 'script'
  const isPlaylist = formKind === 'playlist'
  const [editing, setEditing] = useState(false)
  const [showHeaders, setShowHeaders] = useState(hasHeaders)
  const [nameDraft, setNameDraft] = useState(name)
  // 用户填的就是那条链接本身，输入框不做就地改写：形态解析只用于派生预览与保存，打字不会被打断
  const [linkDraft, setLinkDraft] = useState('')
  const [playlistDraft, setPlaylistDraft] = useState(playlistUrl || '')
  const [headersDraft, setHeadersDraft] = useState(() => (hasHeaders ? JSON.stringify(headers, null, 2) : ''))
  const [headersInvalid, setHeadersInvalid] = useState(false)
  const [parsedHeaders, setParsedHeaders] = useState<Record<string, string> | undefined>(headers)
  const [probe, setProbe] = useState<{ loading: boolean; ok?: boolean; message?: string }>({ loading: false })
  // 探测到的服务端端点自描述：存进配置后由执行时组装使用（服务端改路径，配置自动跟上）
  const [probeEndpoints, setProbeEndpoints] = useState<Partial<AuroraEndpoints> | undefined>(endpoints)
  // 洛雪形态的探测结果：只活在本次会话，不写进配置（配置里只留脚本链接）
  const [lxProbe, setLxProbe] = useState<LxProbeState>({ loading: false })

  // 形态与校验都收在 checkSourceForm：链接自身决定形态，不需要用户选
  const linkText = linkDraft.trim()
  const aurora = checkSourceForm({
    kind: 'music',
    link: linkDraft,
    playlistUrl: playlistDraft,
    headersInvalid,
  })
  // 校验错误由 checkSourceForm 直接给出结构化信封（code + 参数），渲染期按当前语言取文案
  const { parsed, isService, showPlaylist, canSave: auroraCanSave, linkError, playlistError } = aurora
  // 洛雪形态另走一条校验：脚本链接既不是服务地址也不是接口模板，checkSourceForm 那套判定对它无效
  const lxLinkError = isLx && linkText ? checkLxScriptLink(linkText) : null
  // 歌单形态只要求「有一条歌单链接或 id」，不做端点占位符校验
  const canSave = isPlaylist
    ? Boolean(linkText) && !headersInvalid
    : isLx
      ? Boolean(linkText) && !lxLinkError && !headersInvalid
      : auroraCanSave
  // 预览即执行时真正会用的端点：优先服务端自描述，其次默认约定
  const preview =
    !isLx && !isPlaylist && isService && parsed
      ? buildAuroraEndpoints(parsed.baseUrl, parsed.apiKey, probeEndpoints)
      : null

  // 进入编辑：链接就是配置里存的那条（端点不落库，没有需要还原的派生字段）
  const startEditing = () => {
    setNameDraft(name)
    setLinkDraft(sourceUrl)
    setPlaylistDraft(playlistUrl || '')
    setProbe({ loading: false })
    setProbeEndpoints(endpoints)
    setHeadersDraft(hasHeaders ? JSON.stringify(headers, null, 2) : '')
    setHeadersInvalid(false)
    setParsedHeaders(headers)
    setShowHeaders(hasHeaders)
    setLxProbe({ loading: false })
    setEditing(true)
  }

  // 测试连接：GET 根路径取端点自描述 + 用 /health 验密钥，只读不写配置（仅服务地址形态可探）
  const handleProbe = async () => {
    if (!parsed || parsed.kind !== 'service') return
    setProbe({ loading: true })
    // 探测走平台统一入口：服务形态直连取端点自描述并验密钥，形态差异不落到设置页
    const result = await platform.probeSource({
      kind: 'aurora',
      sourceUrl: parsed.baseUrl,
      apiKey: parsed.apiKey,
    })
    setProbe({ loading: false, ok: result.ok, message: result.message })
    setProbeEndpoints(result.endpoints)
  }

  // 端点预览里遮蔽密钥（密钥就在链接里，预览也不明文回显）
  const maskPreview = (url: string) => {
    const key = parsed?.apiKey || ''
    return key ? url.replace(encodeURIComponent(key), '•••') : url
  }

  // 请求头草稿实时解析：合法 JSON 对象才允许保存，否则标记错误
  const handleHeadersChange = (text: string) => {
    setHeadersDraft(text)
    const trimmed = text.trim()
    if (!trimmed) {
      setHeadersInvalid(false)
      setParsedHeaders(undefined)
      return
    }
    try {
      const parsedHeadersNext = JSON.parse(trimmed)
      if (parsedHeadersNext && typeof parsedHeadersNext === 'object' && !Array.isArray(parsedHeadersNext)) {
        setHeadersInvalid(false)
        setParsedHeaders(parsedHeadersNext)
      } else {
        setHeadersInvalid(true)
      }
    } catch {
      setHeadersInvalid(true)
    }
  }

  const handleSave = () => {
    if (!canSave) return
    const displayName = nameDraft.trim() || name
    if (isPlaylist) {
      // 歌单形态：只存歌单链接或 id。这类源没有「搜索」能力，
      // registeredPlugin 决定它能做什么；登录是面板里的另一段。
      onUpdate({ name: displayName, sourceUrl: linkText, headers: parsedHeaders, endpoints: undefined })
      setEditing(false)
      return
    }
    if (isLx) {
      // 洛雪形态：只存那条脚本链接与请求头，脚本源码不落库（运行时按链接现拉）
      onUpdate({
        name: displayName,
        sourceUrl: linkText,
        headers: parsedHeaders,
        playlistUrl: undefined,
        endpoints: undefined,
      })
      setEditing(false)
      return
    }
    if (isService) {
      // 服务地址形态：只存那条链接（+ 探测到的端点自描述），两个端点由执行时派生
      onUpdate({
        name: displayName,
        sourceUrl: linkText,
        endpoints: probeEndpoints,
        playlistUrl: undefined,
        headers: parsedHeaders,
      })
      setEditing(false)
      return
    }
    const trimmedPlaylist = playlistDraft.trim()
    const alreadyHad = (playlistUrl || '').trim()
    onUpdate({
      name: displayName,
      sourceUrl: linkText,
      // 只在确实有变化时带上歌单解析地址，避免把歌词源的字段写脏
      ...(trimmedPlaylist || alreadyHad ? { playlistUrl: trimmedPlaylist } : {}),
      headers: parsedHeaders,
      // 接口模板形态：清掉服务端端点缓存（它只对服务地址形态有意义）
      endpoints: undefined,
    })
    setEditing(false)
  }

  const inputCls = 'inset-field w-full px-2.5 py-1.5 font-text text-caption text-white/70'

  return (
    <div className={`inset-row px-3.5 py-3 ${enabled ? '' : 'opacity-55'}`}>
      <div className={`flex items-center gap-2 ${editing ? 'mb-2' : ''}`}>
        {editing ? (
          <input
            type="text"
            value={nameDraft}
            placeholder={t('sources.form.nameDraftPlaceholder')}
            onChange={(e) => setNameDraft(e.target.value)}
            className="flex-1 bg-transparent font-text text-caption-strong text-white/90 outline-none border-b border-transparent focus:border-white/[0.24] transition-colors duration-200 py-1"
          />
        ) : (
          <>
            <span className="flex-1 font-text text-caption-strong text-white/90 truncate py-1">
              {name || t('sources.form.unnamed')}
            </span>
            {/* 能力徽章：形态决定说法。歌单形态的源不参与搜索，写成「搜索」就是错的 */}
            <span className="flex items-center gap-1 flex-shrink-0">
              {isLx ? (
                <span className="font-text text-[10px] leading-none px-1.5 py-1 rounded-[6px] bg-mint/10 text-mint/80">
                  {t('sources.capability.lxScript')}
                </span>
              ) : isPlaylist ? (
                sourceUrl.trim() && (
                  <span className="font-text text-[10px] leading-none px-1.5 py-1 rounded-[6px] bg-mint/10 text-mint/80">
                    {t('sources.capability.playlist')}
                  </span>
                )
              ) : (
                <>
                  {sourceUrl.trim() && (
                    <span className="font-text text-[10px] leading-none px-1.5 py-1 rounded-[6px] bg-mint/10 text-mint/80">
                      {t('sources.capability.search')}
                    </span>
                  )}
                  {(playlistUrl || '').trim() && (
                    <span className="font-text text-[10px] leading-none px-1.5 py-1 rounded-[6px] bg-white/[0.06] text-white/55">
                      {t('sources.capability.playlist')}
                    </span>
                  )}
                </>
              )}
            </span>
          </>
        )}
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          onClick={() => onUpdate({ enabled: !enabled })}
          className={`relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors duration-200 ease-mineradio ${
            enabled ? 'bg-mint' : 'bg-white/[0.12]'
          }`}
        >
          <span
            className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow-sm transition-transform duration-200 ease-mineradio ${
              enabled ? 'translate-x-4.5' : 'translate-x-1'
            }`}
          />
        </button>
        {!editing && (
          <Button
            variant="ghost"
            size="icon"
            title={t('common.action.edit')}
            className="h-7 w-7 rounded-[8px] text-white/40 hover:text-mint hover:bg-mint/10 transition-colors duration-200 ease-mineradio"
            onClick={startEditing}
          >
            <Pencil className="h-4 w-4" strokeWidth={1.6} />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          title={t('common.action.remove')}
          className="h-7 w-7 rounded-[8px] text-white/40 hover:text-coral hover:bg-coral/10 transition-colors duration-200 ease-mineradio"
          onClick={onRemove}
        >
          <Trash2 className="h-4 w-4" strokeWidth={1.6} />
        </Button>
      </div>

      {editing && (
        <>
          {isPlaylist ? (
            <div>
              <p className="font-text text-caption text-white/50 mb-1">{t('sources.form.playlistUrlLabel')}</p>
              <input
                type="text"
                value={linkDraft}
                placeholder={t('sources.form.playlistUrlPlaceholder')}
                onChange={(e) => setLinkDraft(e.target.value)}
                className={inputCls}
              />
              <p className="font-text text-caption text-white/35 mt-1">{t('sources.form.playlistUrlHint')}</p>
            </div>
          ) : isLx ? (
            /* 洛雪脚本源：只有一条脚本链接 + 可选请求头，端点与密钥那套对它不适用 */
            <div>
              <p className="font-text text-caption text-white/50 mb-1">{t('sources.form.scriptLabel')}</p>
              <LxScriptProbe
                url={linkDraft}
                headers={parsedHeaders}
                instanceId={`lx-card-${name}-${sourceUrl}`}
                probe={lxProbe}
                onUrlChange={setLinkDraft}
                onProbeChange={setLxProbe}
                invalid={Boolean(lxLinkError)}
                error={lxLinkError}
                compact
              />
              <p className="font-text text-caption text-white/35 mt-1">{t('sources.form.scriptHint')}</p>
            </div>
          ) : (
            <>
              {/* 一条链接搞定：服务地址由软件组装两个端点，接口模板原样使用——形态由链接自身判定 */}
              <div>
                <p className="font-text text-caption text-white/50 mb-1">{t('sources.form.sourceLabel')}</p>
                <input
                  type="text"
                  value={linkDraft}
                  placeholder="https://music.lighthouses.top"
                  onChange={(e) => {
                    setLinkDraft(e.target.value)
                    setProbe({ loading: false })
                    setProbeEndpoints(undefined)
                  }}
                  className={`${inputCls} ${linkError ? 'is-invalid' : ''}`}
                />
                {linkError ? (
                  <p className="font-text text-caption text-coral/70 mt-1">{renderError(linkError, t)}</p>
                ) : isService ? (
                  <p className="font-text text-caption text-mint/70 mt-1">
                    {parsed?.apiKey ? t('sources.form.sourceDetectedWithKey') : t('sources.form.sourceDetected')}
                  </p>
                ) : parsed ? (
                  <p className="font-text text-caption text-white/35 mt-1">{t('sources.form.templateDetected')}</p>
                ) : (
                  <p className="font-text text-caption text-white/35 mt-1">{t('sources.form.sourceHint')}</p>
                )}
              </div>

              {/* 歌单解析接口只在接口模板形态下手填：服务地址形态的该端点由软件派生 */}
              {showPlaylist && (
                <div className="mt-2">
                  <p className="font-text text-caption text-white/50 mb-1">
                    {t('sources.form.playlistLabelRequired', { placeholder: '{url}' })}
                  </p>
                  <input
                    type="text"
                    value={playlistDraft}
                    placeholder="https://your-api.com/resolve?url={url}"
                    onChange={(e) => setPlaylistDraft(e.target.value)}
                    className={`${inputCls} ${playlistError ? 'is-invalid' : ''}`}
                  />
                  {playlistError ? (
                    <p className="font-text text-caption text-coral/70 mt-1">{renderError(playlistError, t)}</p>
                  ) : (
                    <p className="font-text text-caption text-white/35 mt-1">{t('sources.form.playlistHint')}</p>
                  )}
                </div>
              )}

              {/* 只有服务地址形态可探：根路径取端点自描述 + /health 验密钥 */}
              {isService && (
                <div className="mt-2 flex items-center gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    className="h-8 px-3 flex-shrink-0"
                    disabled={probe.loading || !linkText}
                    onClick={handleProbe}
                  >
                    <RefreshCw
                      className={`h-3.5 w-3.5 mr-1.5 ${probe.loading ? 'animate-spin' : ''}`}
                      strokeWidth={1.6}
                    />
                    {probe.loading ? t('sources.probe.testing') : t('sources.probe.testConnection')}
                  </Button>
                  {probe.message && (
                    <p className={`font-text text-caption truncate ${probe.ok ? 'text-mint/80' : 'text-coral/80'}`}>
                      {renderError(probe.message, t)}
                    </p>
                  )}
                </div>
              )}
              {preview && (
                <div className="mt-2 space-y-0.5">
                  {/* 先回显软件从这条链接里提取出的服务地址：用户填的可能是裸域名、
                      带 key 的域名，或一条完整端点地址，不写清楚他会以为判定错了 */}
                  <p className="font-text text-caption text-white/35 truncate">
                    {t('sources.form.previewService', { url: parsed?.baseUrl ?? '' })}
                  </p>
                  <p className="font-text text-caption text-white/35 truncate">
                    {t('sources.form.previewSearch', { url: maskPreview(compactEndpointUrl(preview.search)) })}
                  </p>
                  <p className="font-text text-caption text-white/35 truncate">
                    {t('sources.form.previewPlaylist', { url: maskPreview(compactEndpointUrl(preview.playlist)) })}
                  </p>
                </div>
              )}
            </>
          )}

          {/* 请求头：三种形态都可能有（脚本源用它带 Referer，协议源用它带 Token） */}
          <div className="mt-2">
            <button
              type="button"
              onClick={() => setShowHeaders((v) => !v)}
              className="font-text text-caption text-white/45 hover:text-white/70 transition-colors duration-200"
            >
              {t('sources.form.headersLabel')}
            </button>
            {showHeaders && (
              <>
                <textarea
                  value={headersDraft}
                  placeholder={'{"Authorization": "Bearer ..."}'}
                  onChange={(e) => handleHeadersChange(e.target.value)}
                  rows={2}
                  className={`${inputCls} resize-none mt-1 ${headersInvalid ? 'is-invalid' : ''}`}
                />
                {headersInvalid && (
                  <p className="font-text text-caption text-coral/70 mt-1">
                    {t('sources.error.headersJson', { example: '{"Authorization": "Bearer xxx"}' })}
                  </p>
                )}
              </>
            )}
          </div>

          <div className="mt-2.5 flex items-center justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="h-8 px-3 text-white/60 hover:text-white/90"
              onClick={() => setEditing(false)}
            >
              {t('common.action.cancel')}
            </Button>
            <Button
              size="sm"
              className="h-8 px-4 bg-mint text-mint-fg font-semibold hover:bg-mint/90 disabled:opacity-40 disabled:hover:bg-mint"
              disabled={!canSave}
              onClick={handleSave}
            >
              {t('common.action.save')}
            </Button>
          </div>
        </>
      )}
    </div>
  )
}

/**
 * 新增音源弹窗。
 *
 * 与旧版（`SourceAddDialog`）的唯一差别：**插件是入参**，顶部那个「音源形态」
 * 选择器整块去掉 —— 入口本身就是某个插件的设置面板，没什么可选的了。
 * 字段布局仍按 `formKind` 分三套（见 `pluginForm.ts`）。
 */
export function SourceConfigAddDialog({
  open,
  onOpenChange,
  entry,
  onSave,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /**
   * 归属插件（目录条目）。
   *
   * 收**条目**而不是裸 `pluginId` + `formKind` 两个参数：归属字段必须由
   * `newConfigOwner()` 产出（它保证只写 `pluginId`、不写 `kind`），字段布局由
   * `formKindOf()` 产出。两者都从同一个条目推导，调用点就不可能传成"A 插件的
   * 归属 + B 插件的表单"。
   */
  entry: PluginCatalogEntry
  onSave: (source: Omit<OnlineSourceConfig, 'id'>) => void
}) {
  const t = useT()
  const formKind = formKindOf(entry.id)
  // 归属方：只写 pluginId（不写 kind）。写入点只有这一处，避免四个分支各拼一次
  const owner = newConfigOwner(entry)
  const isLx = formKind === 'script'
  const isPlaylist = formKind === 'playlist'
  const [name, setName] = useState('')
  const [linkDraft, setLinkDraft] = useState('')
  const [playlistUrl, setPlaylistUrl] = useState('')
  const [headersDraft, setHeadersDraft] = useState('')
  const [headersInvalid, setHeadersInvalid] = useState(false)
  const [headers, setHeaders] = useState<Record<string, string> | undefined>(undefined)
  const [probe, setProbe] = useState<{ loading: boolean; ok?: boolean; message?: string }>({ loading: false })
  const [probeEndpoints, setProbeEndpoints] = useState<Partial<AuroraEndpoints> | undefined>(undefined)
  const [lxProbe, setLxProbe] = useState<LxProbeState>({ loading: false })

  const linkText = linkDraft.trim()
  const aurora = checkSourceForm({ kind: 'music', link: linkDraft, playlistUrl, headersInvalid })
  const { parsed, isService, showPlaylist, linkError, playlistError } = aurora
  const lxLinkError = isLx ? checkLxScriptLink(linkDraft) : null
  const canSave = isPlaylist
    ? Boolean(linkText) && !headersInvalid
    : isLx
      ? Boolean(linkText) && !lxLinkError && !headersInvalid
      : aurora.canSave
  const preview =
    !isLx && !isPlaylist && isService && parsed ? buildAuroraEndpoints(parsed.baseUrl, parsed.apiKey) : null

  // 每次打开重置表单：上一次的草稿与探测结论不该延续到下一次新增
  const resetForm = () => {
    setName('')
    setLinkDraft('')
    setPlaylistUrl('')
    setHeadersDraft('')
    setHeadersInvalid(false)
    setHeaders(undefined)
    setProbe({ loading: false })
    setProbeEndpoints(undefined)
    setLxProbe({ loading: false })
  }

  const handleProbe = async () => {
    if (!parsed || parsed.kind !== 'service') return
    setProbe({ loading: true })
    const result = await platform.probeSource({
      kind: 'aurora',
      sourceUrl: parsed.baseUrl,
      apiKey: parsed.apiKey,
    })
    setProbe({ loading: false, ok: result.ok, message: result.message })
    setProbeEndpoints(result.endpoints)
  }

  const maskKey = (url: string) =>
    parsed?.apiKey ? url.replace(encodeURIComponent(parsed.apiKey), '•••') : url

  const handleHeadersChange = (text: string) => {
    setHeadersDraft(text)
    const trimmed = text.trim()
    if (!trimmed) {
      setHeadersInvalid(false)
      setHeaders(undefined)
      return
    }
    try {
      const next = JSON.parse(trimmed)
      if (next && typeof next === 'object' && !Array.isArray(next)) {
        setHeadersInvalid(false)
        setHeaders(next)
      } else {
        setHeadersInvalid(true)
      }
    } catch {
      setHeadersInvalid(true)
    }
  }

  const handleSave = () => {
    if (!canSave) return
    const displayName =
      name.trim() ||
      (isLx
        ? t('sources.form.defaultNameLx')
        : isPlaylist
          ? t('sources.form.defaultNameQishui')
          : t('sources.form.defaultName'))
    // 「存下来之后默认启用还是停用」收在 newSourceEnabled 一处：
    // 脚本源看探测结果，其余两档恒启用。四个分支各写一遍曾让这条规则丢过一次。
    const enabled = newSourceEnabled(formKind, lxProbe.ok)

    if (isPlaylist) {
      // 歌单形态：只存歌单链接或 id；登录是可选的增强项（登录后才能列自己的歌单）
      onSave({ ...owner, name: displayName, sourceUrl: linkText, headers, enabled })
      resetForm()
      onOpenChange(false)
      return
    }
    if (isLx) {
      // 洛雪形态：只写脚本链接，脚本源码不落库（运行时按链接现拉）。
      //
      // 测试未通过也允许先存，但落 `enabled: false`：源不可用就不该默认参与搜索，
      // 否则每次搜索都要白等一轮脚本拉取失败。一次网络抖动不该把用户挡在门外，
      // 所以是"存下来但先别用"，不是"不许存"。
      // （这条保护来自改造前的 `SourceAddDialog`，搬家时漏掉了，回归测试见
      //   `__tests__/pluginSourceSave.test.ts` 的 formKind=script 用例）
      onSave({
        ...owner,
        name: displayName,
        sourceUrl: linkText,
        headers,
        enabled,
      })
      resetForm()
      onOpenChange(false)
      if (lxProbe.ok !== true) {
        toast(t('sources.form.savedDisabled'), { type: 'error', duration: 5000 })
      }
      return
    }
    if (isService) {
      onSave({ ...owner, name: displayName, sourceUrl: linkText, endpoints: probeEndpoints, enabled })
      resetForm()
      onOpenChange(false)
      return
    }
    const trimmedPlaylist = playlistUrl.trim()
    onSave({
      ...owner,
      name: displayName,
      sourceUrl: linkText,
      ...(trimmedPlaylist ? { playlistUrl: trimmedPlaylist } : {}),
      headers,
      enabled,
    })
    resetForm()
    onOpenChange(false)
  }

  const inputCls = 'inset-field w-full px-2.5 py-1.5 font-text text-caption text-white/70'

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) resetForm()
        onOpenChange(next)
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-white text-tagline">
            {isLx ? t('sources.form.titleLx') : isPlaylist ? t('sources.form.playlistUrlLabel') : t('sources.form.title')}
          </DialogTitle>
          <DialogDescription className="font-text text-caption text-white/60">
            {isLx
              ? t('sources.form.descLx')
              : isPlaylist
                ? t('sources.form.playlistUrlHint')
                : t('sources.form.desc')}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <p className="font-text text-caption text-white/60 mb-1.5">{t('sources.form.nameLabel')}</p>
            <input
              type="text"
              value={name}
              placeholder={
                isLx
                  ? t('sources.form.namePlaceholderLx')
                  : isPlaylist
                    ? t('sources.form.namePlaceholderQishui')
                    : t('sources.form.namePlaceholder')
              }
              onChange={(e) => setName(e.target.value)}
              className={inputCls}
            />
          </div>

          {isPlaylist ? (
            <div>
              <p className="font-text text-caption text-white/60 mb-1.5">{t('sources.form.playlistUrlLabel')}</p>
              <input
                type="text"
                value={linkDraft}
                placeholder={t('sources.form.playlistUrlPlaceholder')}
                onChange={(e) => setLinkDraft(e.target.value)}
                className={inputCls}
              />
              <p className="font-text text-caption text-white/35 mt-1">{t('sources.form.playlistUrlHint')}</p>
            </div>
          ) : isLx ? (
            <div>
              <p className="font-text text-caption text-white/60 mb-1.5">{t('sources.form.scriptLabel')}</p>
              <LxScriptProbe
                url={linkDraft}
                headers={headers}
                instanceId="lx-add-dialog"
                probe={lxProbe}
                onUrlChange={setLinkDraft}
                onProbeChange={setLxProbe}
                invalid={Boolean(lxLinkError)}
                error={lxLinkError}
              />
              {!lxLinkError && (
                <p className="font-text text-caption text-white/35 mt-1">{t('sources.form.scriptHint')}</p>
              )}
            </div>
          ) : (
            <>
              <div>
                <p className="font-text text-caption text-white/60 mb-1.5">{t('sources.form.sourceLabel')}</p>
                <input
                  type="text"
                  value={linkDraft}
                  placeholder="https://music.lighthouses.top"
                  onChange={(e) => {
                    setLinkDraft(e.target.value)
                    setProbe({ loading: false })
                    setProbeEndpoints(undefined)
                  }}
                  className={`${inputCls} ${linkError ? 'is-invalid' : ''}`}
                />
                {linkError ? (
                  <p className="font-text text-caption text-coral/70 mt-1">{renderError(linkError, t)}</p>
                ) : isService ? (
                  <p className="font-text text-caption text-mint/70 mt-1">
                    {parsed?.apiKey ? t('sources.form.sourceDetectedWithKey') : t('sources.form.sourceDetected')}
                  </p>
                ) : parsed ? (
                  <p className="font-text text-caption text-white/35 mt-1">{t('sources.form.templateDetected')}</p>
                ) : (
                  <p className="font-text text-caption text-white/35 mt-1">{t('sources.form.sourceHint')}</p>
                )}
              </div>
              {/* 歌单解析接口只在接口模板形态下手填：服务地址形态的该端点由软件派生 */}
              {showPlaylist && (
                <div>
                  <p className="font-text text-caption text-white/60 mb-1.5">{t('sources.form.playlistLabel')}</p>
                  <input
                    type="text"
                    value={playlistUrl}
                    placeholder="https://your-api.com/resolve?url={url}"
                    onChange={(e) => setPlaylistUrl(e.target.value)}
                    className={`${inputCls} ${playlistError ? 'is-invalid' : ''}`}
                  />
                  {playlistError ? (
                    <p className="font-text text-caption text-coral/70 mt-1">{renderError(playlistError, t)}</p>
                  ) : (
                    <p className="font-text text-caption text-white/35 mt-1">{t('sources.form.playlistHintDialog')}</p>
                  )}
                </div>
              )}
              {/* 只有服务地址形态可探：根路径取端点自描述 + /health 验密钥 */}
              {isService && (
                <>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      className="h-8 px-3 flex-shrink-0"
                      disabled={probe.loading || !linkText}
                      onClick={handleProbe}
                    >
                      <RefreshCw
                        className={`h-3.5 w-3.5 mr-1.5 ${probe.loading ? 'animate-spin' : ''}`}
                        strokeWidth={1.6}
                      />
                      {probe.loading ? t('sources.probe.testing') : t('sources.probe.testConnection')}
                    </Button>
                    {probe.message && (
                      <p className={`font-text text-caption truncate ${probe.ok ? 'text-mint/80' : 'text-coral/80'}`}>
                        {renderError(probe.message, t)}
                      </p>
                    )}
                  </div>
                  {preview && (
                    <div className="space-y-0.5">
                      <p className="font-text text-caption text-white/35 truncate">
                        {t('sources.form.previewService', { url: parsed?.baseUrl ?? '' })}
                      </p>
                      <p className="font-text text-caption text-white/35 truncate">
                        {t('sources.form.previewSearch', { url: maskKey(compactEndpointUrl(preview.search)) })}
                      </p>
                      <p className="font-text text-caption text-white/35 truncate">
                        {t('sources.form.previewPlaylist', { url: maskKey(compactEndpointUrl(preview.playlist)) })}
                      </p>
                    </div>
                  )}
                </>
              )}
            </>
          )}

          <div>
            <p className="font-text text-caption text-white/60 mb-1.5">{t('sources.form.headersLabel')}</p>
            <textarea
              value={headersDraft}
              placeholder={'{"Authorization": "Bearer ..."}'}
              onChange={(e) => handleHeadersChange(e.target.value)}
              rows={2}
              className={`${inputCls} resize-none ${headersInvalid ? 'is-invalid' : ''}`}
            />
            {headersInvalid && (
              <p className="font-text text-caption text-coral/70 mt-1">
                {t('sources.error.headersJson', { example: '{"Authorization": "Bearer xxx"}' })}
              </p>
            )}
          </div>
        </div>
        <DialogFooter className="sm:space-x-2">
          <Button variant="ghost" size="sm" className="h-9 px-3.5 text-white/70" onClick={() => onOpenChange(false)}>
            {t('common.action.cancel')}
          </Button>
          <Button
            size="sm"
            className="h-9 px-3.5 bg-mint text-mint-fg font-semibold hover:bg-mint/90 disabled:opacity-40 disabled:hover:bg-mint"
            disabled={!canSave}
            onClick={handleSave}
          >
            {t('common.action.add')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * 存储来源卡片：测试连接 / 扫描入库 / 编辑 / 移除。
 *
 * 字段来自插件的声明式 `fields`，本组件不知道任何协议细节。口令**不回读**——
 * 只知道「有没有存」，编辑时留空表示不改。
 */
export function StorageConfigCard({
  source,
  plugin,
  status,
  onUpdate,
  onProbe,
  onScan,
  onRemove,
  onClearCredential,
}: {
  source: LibrarySourceConfig
  /** 该来源对应的插件声明（决定渲染哪些字段）；查不到时只显示名称，不假装能编辑 */
  plugin?: StoragePluginMeta
  status: LibrarySourceStatus
  onUpdate: (updates: Partial<LibrarySourceConfig>) => void
  onProbe: () => void
  onScan: () => void
  onRemove: () => void
  onClearCredential: () => Promise<StorageCredentialState | undefined>
}) {
  const t = useT()
  const [editing, setEditing] = useState(false)
  const [nameDraft, setNameDraft] = useState(source.name)
  /** 非敏感字段草稿（键与 fields[].key 一致） */
  const [values, setValues] = useState<Record<string, string>>({})
  /** 口令草稿：只写不读，留空 = 保持原口令不变 */
  const [secretDraft, setSecretDraft] = useState<Record<string, string>>({})
  const [credential, setCredential] = useState<StorageCredentialState>({
    saved: false,
    encryptionAvailable: true,
  })

  const fields = plugin?.fields || []

  /** 从来源配置读出字段当前值（settings 优先，老配置顶层兜底——与 shared 同一口径） */
  const readField = (key: string): string => storageStringField(source, key)

  const refreshCredential = () => {
    void (async () => {
      const state = await platform.storageCredentialState?.(source.id)
      if (state) setCredential(state)
    })()
  }

  const startEditing = () => {
    setNameDraft(source.name)
    const next: Record<string, string> = {}
    for (const field of fields) {
      if (field.kind !== 'password') next[field.key] = readField(field.key)
    }
    setValues(next)
    // 口令永远是空：渲染层拿不到原文，留空表示不改
    setSecretDraft({})
    refreshCredential()
    setEditing(true)
  }

  const canSave = nameDraft.trim().length > 0

  const handleSave = () => {
    if (!canSave) return
    // 与添加弹窗同一分工：敏感字段单独走凭证 IPC，不进 settings
    const settings: Record<string, unknown> = {}
    for (const field of fields) {
      if (field.kind === 'password') continue
      const raw = (values[field.key] ?? '').trim()
      if (field.kind === 'url') settings[field.key] = raw.replace(/\/+$/, '')
      else if (field.kind === 'path') settings[field.key] = raw.replace(/^\/+|\/+$/g, '')
      else settings[field.key] = raw
    }
    onUpdate({ name: nameDraft.trim(), settings })

    // 只有用户真的填了口令才写：留空 = 不改（避免「编辑名称」把口令清掉）
    const secrets = Object.fromEntries(Object.entries(secretDraft).filter(([, v]) => v.trim().length > 0))
    if (Object.keys(secrets).length > 0) {
      void (async () => {
        const result = await platform.saveStorageCredential?.(source.id, secrets)
        setCredential((prev) => ({
          saved: result?.saved ?? prev.saved,
          encryptionAvailable: result?.encryptionAvailable ?? prev.encryptionAvailable,
        }))
      })()
    }
    setEditing(false)
  }

  const inputCls = 'inset-field w-full px-2.5 py-1.5 font-text text-caption text-white/70'

  /** 卡片副标题：插件展示名 + 各字段摘要（不含口令），用户一眼能分辨是哪台设备 */
  const subtitle = plugin
    ? [
        t(plugin.displayNameKey),
        ...fields
          .filter((f) => f.kind !== 'password')
          .map((f) => readField(f.key))
          .filter(Boolean),
      ].join(' · ')
    : source.name

  const credentialLabel = !credential.encryptionAvailable
    ? t('sources.webdav.credentialUnavailable')
    : credential.saved
      ? t('sources.webdav.credentialSaved')
      : t('sources.webdav.credentialMissing')

  return (
    <div className="inset-row px-3.5 py-3">
      <div className="flex items-center gap-2">
        <Cloud className="h-4 w-4 text-mint flex-shrink-0" strokeWidth={1.6} />
        <div className="min-w-0 flex-1">
          <p className="font-text text-caption-strong text-white/85 truncate">{source.name}</p>
          <p className="font-text text-caption text-white/50 truncate">{subtitle}</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={source.enabled}
          title={source.enabled ? t('sources.webdav.enabledTitle') : t('sources.webdav.disabledTitle')}
          onClick={() => onUpdate({ enabled: !source.enabled })}
          className={`relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors duration-200 ease-mineradio ${
            source.enabled ? 'bg-mint' : 'bg-white/[0.12]'
          }`}
        >
          <span
            className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow-sm transition-transform duration-200 ease-mineradio ${
              source.enabled ? 'translate-x-4.5' : 'translate-x-1'
            }`}
          />
        </button>
        {!editing && (
          <Button
            variant="ghost"
            size="icon"
            title={t('common.action.edit')}
            className="h-7 w-7 rounded-[8px] text-white/40 hover:text-mint hover:bg-mint/10 transition-colors duration-200 ease-mineradio"
            onClick={startEditing}
          >
            <Pencil className="h-4 w-4" strokeWidth={1.6} />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          title={t('sources.webdav.removeTitle', { library: t(NAV_LABEL_KEYS.library) })}
          className="h-7 w-7 rounded-[8px] text-white/40 hover:text-coral hover:bg-coral/10 transition-colors duration-200 ease-mineradio"
          onClick={onRemove}
        >
          <Trash2 className="h-4 w-4" strokeWidth={1.6} />
        </Button>
      </div>

      {editing ? (
        <div className="mt-3 space-y-2.5">
          <input
            type="text"
            value={nameDraft}
            placeholder={t('sources.webdav.nameDraftPlaceholder')}
            onChange={(e) => setNameDraft(e.target.value)}
            className={inputCls}
          />
          {fields.map((field: StorageFieldDef) =>
            field.kind === 'password' ? (
              <div key={field.key}>
                <input
                  type="password"
                  value={secretDraft[field.key] ?? ''}
                  placeholder={t(field.labelKey)}
                  onChange={(e) => setSecretDraft((prev) => ({ ...prev, [field.key]: e.target.value }))}
                  className={inputCls}
                  autoComplete="new-password"
                />
                <div className="flex items-center gap-2 mt-1">
                  <p
                    className={`font-text text-caption ${
                      credential.encryptionAvailable ? 'text-white/40' : 'text-coral/70'
                    }`}
                  >
                    {credentialLabel}
                  </p>
                  {credential.saved && (
                    <button
                      type="button"
                      onClick={() =>
                        void onClearCredential().then((state) => {
                          if (state) setCredential(state)
                        })
                      }
                      className="font-text text-caption text-white/40 hover:text-coral/80 underline underline-offset-2"
                    >
                      {t('sources.webdav.clearCredential')}
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <input
                key={field.key}
                type="text"
                value={values[field.key] ?? ''}
                placeholder={field.placeholderKey ? t(field.placeholderKey) : t(field.labelKey)}
                onChange={(e) => setValues((prev) => ({ ...prev, [field.key]: e.target.value }))}
                className={inputCls}
                autoComplete="off"
              />
            )
          )}
          <div className="flex items-center justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="h-8 px-3 text-white/60 hover:text-white/90"
              onClick={() => setEditing(false)}
            >
              {t('common.action.cancel')}
            </Button>
            <Button
              size="sm"
              className="h-8 px-4 bg-mint text-mint-fg font-semibold hover:bg-mint/90 disabled:opacity-40 disabled:hover:bg-mint"
              disabled={!canSave}
              onClick={handleSave}
            >
              {t('common.action.save')}
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-2.5 flex items-center gap-2">
          <Button variant="secondary" size="sm" className="h-8 px-3" disabled={status.loading} onClick={onProbe}>
            <CheckCircle2 className="h-3.5 w-3.5 mr-1.5" strokeWidth={1.6} />
            {t('sources.webdav.testConnection')}
          </Button>
          <Button variant="secondary" size="sm" className="h-8 px-3" disabled={status.loading} onClick={onScan}>
            <RefreshCw
              className={`h-3.5 w-3.5 mr-1.5 ${status.loading ? 'animate-spin' : ''}`}
              strokeWidth={1.6}
            />
            {t('sources.webdav.scan')}
          </Button>
          {status.message && (
            <p className={`font-text text-caption truncate ${status.ok ? 'text-mint/80' : 'text-coral/80'}`}>
              {status.message}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * 新增存储来源弹窗：按插件声明式 `fields` 通用渲染，本函数不含任何协议专有代码。
 *
 * 与旧版的差别同音源弹窗：协议不再是下拉选项，而是入参。旧版「只有一个插件时
 * 跳过选择器」的那条特例因此自然消失。
 */
export function StorageConfigAddDialog({
  open,
  onOpenChange,
  plugin,
  onSave,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 归属插件（含声明式字段）；查不到时不给入口，面板侧已按能力判定 */
  plugin: StoragePluginMeta | undefined
  /** secrets 只喂凭证 IPC，**不进 settings 持久化** */
  onSave: (source: Omit<LibrarySourceConfig, 'id' | 'enabled'>, secrets: Record<string, string>) => void
}) {
  const t = useT()
  const [name, setName] = useState('')
  /** 字段值：键与插件 `fields[].key` 一致（口令也先放这里，提交时再分流） */
  const [values, setValues] = useState<Record<string, string>>({})

  const fields = plugin?.fields || []

  const resetForm = () => {
    setName('')
    setValues({})
  }

  /** 必填与格式校验统一在此：UI 不写任何协议专有规则 */
  const fieldError = (field: StorageFieldDef, raw: string): string | null => {
    const value = raw.trim()
    if (field.required && !value) {
      return t('sources.webdav.fieldRequired', { field: t(field.labelKey) })
    }
    // 地址类字段只做「看起来是绝对地址」这一层，协议细节交给插件探测
    if (field.kind === 'url' && value && !/^https?:\/\/.+/i.test(value)) {
      return t('sources.webdav.fieldRequired', { field: t(field.labelKey) })
    }
    return null
  }

  const canSave = Boolean(plugin) && fields.every((f) => !fieldError(f, values[f.key] ?? ''))

  const handleSave = () => {
    if (!canSave || !plugin) return
    // 源头分流：口令类字段只进 secrets，其余进 settings。
    // partialize 的白名单是第二道闸，但从这里就该分开——敏感值不该先进一个
    // 「将要被持久化」的对象再被剥掉。
    const settings: Record<string, unknown> = {}
    const secrets: Record<string, string> = {}
    for (const field of fields) {
      const raw = (values[field.key] ?? '').trim()
      if (!raw) continue
      if (field.kind === 'password') {
        secrets[field.key] = raw
      } else if (field.kind === 'url') {
        settings[field.key] = raw.replace(/\/+$/, '')
      } else if (field.kind === 'path') {
        settings[field.key] = raw.replace(/^\/+|\/+$/g, '')
      } else {
        settings[field.key] = raw
      }
    }
    onSave(
      {
        kind: plugin.id,
        pluginId: plugin.id,
        name: name.trim() || t(plugin.displayNameKey),
        settings,
      },
      secrets
    )
    resetForm()
    onOpenChange(false)
  }

  const inputCls = 'inset-field w-full px-2.5 py-1.5 font-text text-caption text-white/70'

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) resetForm()
        onOpenChange(next)
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-white text-tagline">
            {plugin ? t(plugin.displayNameKey) : t('sources.webdav.title')}
          </DialogTitle>
          <DialogDescription className="font-text text-caption text-white/60">
            {plugin?.descriptionKey ? t(plugin.descriptionKey) : t('sources.webdav.desc')}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <p className="font-text text-caption text-white/60 mb-1.5">{t('sources.webdav.nameLabel')}</p>
            <input
              type="text"
              value={name}
              placeholder={t('sources.webdav.namePlaceholder')}
              onChange={(e) => setName(e.target.value)}
              className={inputCls}
            />
          </div>
          {fields.map((field) => {
            const raw = values[field.key] ?? ''
            const error = fieldError(field, raw)
            return (
              <div key={field.key}>
                <p className="font-text text-caption text-white/60 mb-1.5">{t(field.labelKey)}</p>
                <input
                  type={field.kind === 'password' ? 'password' : 'text'}
                  value={raw}
                  placeholder={field.placeholderKey ? t(field.placeholderKey) : undefined}
                  onChange={(e) => setValues((prev) => ({ ...prev, [field.key]: e.target.value }))}
                  className={`${inputCls} ${error ? 'is-invalid' : ''}`}
                  autoComplete={field.kind === 'password' ? 'new-password' : 'off'}
                />
                {field.hintKey && <p className="font-text text-caption text-white/40 mt-1">{t(field.hintKey)}</p>}
              </div>
            )
          })}
          {/* 口令去向的说明：与协议无关，由表单统一给出（不是某个字段的 hint） */}
          {fields.some((f) => f.kind === 'password') && (
            <p className="font-text text-caption text-white/40">{t('sources.webdav.credentialHint')}</p>
          )}
        </div>
        <DialogFooter>
          <Button
            variant="ghost"
            size="sm"
            className="h-9 px-4 text-white/60 hover:text-white/90"
            onClick={() => onOpenChange(false)}
          >
            {t('common.action.cancel')}
          </Button>
          <Button
            size="sm"
            className="h-9 px-5 bg-mint text-mint-fg font-semibold hover:bg-mint/90 disabled:opacity-40 disabled:hover:bg-mint"
            disabled={!canSave}
            onClick={handleSave}
          >
            {t('common.action.add')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
