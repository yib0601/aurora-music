import { useCallback, useEffect, useState } from 'react'
import { LogIn, LogOut, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useT } from '@/i18n'
import type { MessageKey, PluginAuthState } from '@aurora/shared'
import type { PluginMetaInfo } from '@/services/platform'
import {
  authStateText,
  authStateTone,
  initialAuthPanelState,
  loadPluginMeta,
  logoutPlugin,
  pluginLayerAvailable,
  pluginsNeedingAuth,
  refreshAuthState,
  submitCredential,
} from './pluginAuth'

/**
 * 插件登录面板。
 *
 * 只渲染「声明了 auth 能力的插件」——判定按能力而不是按 id，
 * 将来任何插件声明 auth 都自动出现在这里。
 *
 * 凭证纪律：输入框内容提交后**立即清空**；本组件从不读回凭证原文
 * （跨进程接口只回登录态，见 desktop 的 pluginHost）。
 */

/**
 * 单个插件的登录行。
 *
 * 入参刻意只要求**它真正用到的两项**（id 与展示名键），而不是完整的 `PluginMetaInfo`：
 * 插件设置面板（`components/plugin/PluginSettingsDialog`）手里只有目录条目，
 * 没有执行侧的元信息，硬凑一个 `PluginMetaInfo` 会让字段全是编的。
 * 在 `PluginAuthPanel` 里传完整 meta 仍然合法（结构类型），调用点无需改动。
 */
export function PluginAuthRow({ plugin }: { plugin: { id: string; displayNameKey: string } }) {
  const t = useT()
  const [input, setInput] = useState('')
  const [auth, setAuth] = useState<PluginAuthState | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  const refresh = useCallback(async () => {
    setBusy(true)
    const state = await refreshAuthState(plugin.id)
    setAuth(state)
    setBusy(false)
  }, [plugin.id])

  // 首次渲染时查一次登录态：已登录的用户不该看到「未登录」
  useEffect(() => {
    void refresh()
  }, [refresh])

  const handleSubmit = async () => {
    setBusy(true)
    const result = await submitCredential(plugin.id, input)
    // 无论成败都清空输入框：明文凭证不该留在界面上
    setInput('')
    setMessage({ ok: result.ok, text: result.message })
    if (result.ok) await refresh()
    setBusy(false)
  }

  const handleLogout = async () => {
    setBusy(true)
    const result = await logoutPlugin(plugin.id)
    setMessage({ ok: result.ok, text: result.message })
    await refresh()
    setBusy(false)
  }

  const tone = authStateTone(auth)
  const toneCls =
    tone === 'ok'
      ? 'text-mint'
      : tone === 'warn'
        ? 'text-coral/80'
        : 'text-white/45'

  return (
    <div className="bg-white/[0.03] border border-white/[0.06] rounded-[10px] px-3.5 py-3 space-y-2.5">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          {/* displayNameKey 在 shared 层是 MessageKey；经 IPC 后是裸字符串，
              转回 MessageKey 供 t() 取值（翻译器查不到键会原样透出，天然兜底） */}
          <p className="font-text text-caption-strong text-white/90">
            {t(plugin.displayNameKey as MessageKey)}
          </p>
          <p className={`font-text text-caption mt-0.5 ${toneCls}`}>{authStateText(auth)}</p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <Button
            variant="ghost"
            size="sm"
            className="h-8 px-2 text-white/55"
            title={t('sources.auth.refresh')}
            onClick={() => void refresh()}
            disabled={busy}
          >
            <RefreshCw className={`h-3.5 w-3.5 ${busy ? 'animate-spin' : ''}`} strokeWidth={1.6} />
          </Button>
          {auth?.loggedIn && (
            <Button
              variant="ghost"
              size="sm"
              className="h-8 px-2 text-white/55"
              title={t('sources.auth.logout')}
              onClick={() => void handleLogout()}
              disabled={busy}
            >
              <LogOut className="h-3.5 w-3.5" strokeWidth={1.6} />
            </Button>
          )}
        </div>
      </div>

      <div>
        <p className="font-text text-caption text-white/60 mb-1.5">{t('sources.auth.inputLabel')}</p>
        <div className="flex items-center gap-1.5">
          <input
            type="password"
            value={input}
            autoComplete="off"
            onChange={(e) => setInput(e.target.value)}
            className="inset-field flex-1 min-w-0 px-2.5 py-1.5 font-text text-caption text-white/70"
          />
          <Button
            variant="secondary"
            size="sm"
            className="h-8 px-3 shrink-0"
            onClick={() => void handleSubmit()}
            disabled={busy || !input.trim()}
          >
            <LogIn className="h-3.5 w-3.5 mr-1.5" strokeWidth={1.6} />
            {t('sources.auth.submit')}
          </Button>
        </div>
        <p className="font-text text-caption text-white/35 mt-1">{t('sources.auth.inputHint')}</p>
        {message && (
          <p className={`font-text text-caption mt-1 ${message.ok ? 'text-mint/80' : 'text-coral/80'}`}>
            {message.text}
          </p>
        )}
      </div>
    </div>
  )
}

/**
 * 登录面板容器：列出所有需要登录的插件。
 *
 * 无插件需要登录时整块隐藏（返回 null），而不是显示一个空区块——
 * 设置页已经有太多「空态占位」了。
 */
export function PluginAuthPanel() {
  const t = useT()
  const [metas, setMetas] = useState<PluginMetaInfo[] | null>(null)

  useEffect(() => {
    let alive = true
    void loadPluginMeta().then((list) => {
      if (alive) setMetas(list)
    })
    return () => {
      alive = false
    }
  }, [])

  // 浏览器端没有插件层：静默隐藏，不显示「不支持」打扰用户
  if (!pluginLayerAvailable()) return null
  if (!metas) return null

  const needAuth = pluginsNeedingAuth(metas)
  if (needAuth.length === 0) return null

  return (
    <div className="space-y-2">
      {needAuth.map((plugin) => (
        <PluginAuthRow key={plugin.id} plugin={plugin} />
      ))}
    </div>
  )
}

export { initialAuthPanelState }
