import { useCallback, useEffect, useState } from 'react'
import { KeyRound, Loader2, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useT } from '@/i18n'
import type { PluginTrustSnapshot, TrustedKeyInfo } from '@/services/platform'
import {
  addTrustedKey,
  canRemoveKey,
  keyCategoryOf,
  loadTrustTable,
  removeTrustedKey,
  shortKeyOf,
  trustManagementAvailable,
} from './pluginTrust'

/**
 * 签名信任根面板。
 *
 * 只出现在支持管理信任表的端（桌面端）：导入公钥要落盘到 userData，
 * 移动端与 Web 没有这条通道，入口在那里整块隐藏而不是点了才失败。
 *
 * ## 界面上必须说清的两件事
 *
 * 1. 导入公钥**不会**让插件变安全 —— 它只表达"我认识这个发布者"。
 *    所以说明文案里明确写「公钥本身不是秘密，可以分享」，
 *    避免用户误以为"没泄露公钥 = 安全"。
 * 2. 删除后插件**不会被卸载**，只是来源不再被验证。
 *    这条不写清楚，用户会以为删除 = 卸载。
 */
export function PluginTrustPanel() {
  const t = useT()
  const [snapshot, setSnapshot] = useState<PluginTrustSnapshot | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({ keyId: '', publicKey: '', note: '' })
  /** 待确认删除的 key */
  const [confirmRemove, setConfirmRemove] = useState<TrustedKeyInfo | null>(null)

  const refresh = useCallback(async () => {
    setSnapshot(await loadTrustTable())
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const handleAdd = async () => {
    setBusy(true)
    setMessage(null)
    const outcome = await addTrustedKey(form)
    setBusy(false)
    if (outcome.ok) {
      // 成功后清空表单：用户可能接着导入下一条
      setForm({ keyId: '', publicKey: '', note: '' })
      setShowForm(false)
      setMessage({ ok: true, text: outcome.message || '' })
      await refresh()
      return
    }
    setMessage({ ok: false, text: outcome.message || '' })
  }

  const handleRemove = async () => {
    if (!confirmRemove) return
    const target = confirmRemove
    setBusy(true)
    setMessage(null)
    const outcome = await removeTrustedKey(target.keyId)
    setBusy(false)
    setConfirmRemove(null)
    setMessage({ ok: outcome.ok, text: outcome.message || '' })
    if (outcome.ok) await refresh()
  }

  // 本端无能力：整块隐藏
  if (!trustManagementAvailable()) return null
  if (snapshot === null) {
    return (
      <div className="flex items-center gap-2 font-text text-caption text-white/45 py-2">
        <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.6} />
        {t('common.state.loading')}
      </div>
    )
  }

  const all = [...snapshot.builtin, ...snapshot.user]

  return (
    <div className="space-y-3">
      <p className="font-text text-caption text-white/50">{t('sources.plugins.trust.desc')}</p>

      {all.length === 0 ? (
        <p className="font-text text-caption text-white/40 py-1.5">{t('sources.plugins.trust.empty')}</p>
      ) : (
        <div className="space-y-2">
          {all.map((key) => {
            const category = keyCategoryOf(key, snapshot)
            const removable = canRemoveKey(key, snapshot)
            return (
              <div
                key={key.keyId}
                className="bg-white/[0.03] border border-white/[0.06] rounded-[10px] px-3.5 py-2.5"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <KeyRound className="h-3.5 w-3.5 text-white/40 shrink-0" strokeWidth={1.6} />
                      <p className="font-text text-caption-strong text-white/90 truncate">{key.keyId}</p>
                      <span className="font-text text-[10px] text-white/35 px-1.5 py-0.5 rounded bg-white/[0.06]">
                        {category === 'user'
                          ? t('sources.plugins.trust.userTag')
                          : t('sources.plugins.trust.builtinTag')}
                      </span>
                    </div>
                    {key.note && (
                      <p className="font-text text-caption text-white/50 mt-0.5">{key.note}</p>
                    )}
                    {/* 截断展示：前后各 8 位够用户核对"这是我抄的那串" */}
                    <p className="font-text text-[10px] text-white/30 mt-1 font-mono break-all">
                      {shortKeyOf(key.publicKey)}
                    </p>
                    {!removable && (
                      <p className="font-text text-[10px] text-white/30 mt-0.5">
                        {t('sources.plugins.trust.builtinHint')}
                      </p>
                    )}
                  </div>
                  {removable && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 px-2 text-white/45 hover:text-coral shrink-0"
                      title={t('sources.plugins.trust.remove')}
                      disabled={busy}
                      onClick={() => setConfirmRemove(key)}
                    >
                      <Trash2 className="h-3.5 w-3.5" strokeWidth={1.6} />
                    </Button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      <div>
        <Button
          variant="secondary"
          size="sm"
          className="h-9 px-3.5"
          onClick={() => setShowForm((value) => !value)}
          disabled={busy}
        >
          <Plus className="h-4 w-4 mr-2" strokeWidth={1.6} />
          {t('sources.plugins.trust.add')}
        </Button>
      </div>

      {showForm && (
        <div className="bg-white/[0.03] border border-white/[0.06] rounded-[10px] px-3.5 py-3 space-y-2.5">
          <div>
            <p className="font-text text-caption text-white/60 mb-1">{t('sources.plugins.trust.keyIdLabel')}</p>
            <input
              value={form.keyId}
              onChange={(event) => setForm((prev) => ({ ...prev, keyId: event.target.value }))}
              placeholder={t('sources.plugins.trust.keyIdPlaceholder')}
              className="inset-field w-full px-2.5 py-1.5 font-text text-caption text-white/70"
              autoComplete="off"
              spellCheck={false}
            />
            <p className="font-text text-[10px] text-white/35 mt-1">{t('sources.plugins.trust.keyIdHint')}</p>
          </div>
          <div>
            <p className="font-text text-caption text-white/60 mb-1">
              {t('sources.plugins.trust.publicKeyLabel')}
            </p>
            <input
              value={form.publicKey}
              onChange={(event) => setForm((prev) => ({ ...prev, publicKey: event.target.value }))}
              placeholder={t('sources.plugins.trust.publicKeyPlaceholder')}
              className="inset-field w-full px-2.5 py-1.5 font-text text-caption text-white/70 font-mono"
              autoComplete="off"
              spellCheck={false}
            />
            <p className="font-text text-[10px] text-white/35 mt-1">
              {t('sources.plugins.trust.publicKeyHint')}
            </p>
          </div>
          <div>
            <p className="font-text text-caption text-white/60 mb-1">{t('sources.plugins.trust.noteLabel')}</p>
            <input
              value={form.note}
              onChange={(event) => setForm((prev) => ({ ...prev, note: event.target.value }))}
              placeholder={t('sources.plugins.trust.notePlaceholder')}
              className="inset-field w-full px-2.5 py-1.5 font-text text-caption text-white/70"
              autoComplete="off"
            />
          </div>
          <div className="flex justify-end">
            <Button
              variant="primary"
              size="sm"
              className="h-8 px-3.5"
              disabled={busy || !form.keyId.trim() || !form.publicKey.trim()}
              onClick={() => void handleAdd()}
            >
              {busy ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" strokeWidth={1.6} />
              ) : (
                <Plus className="h-4 w-4 mr-2" strokeWidth={1.6} />
              )}
              {busy ? t('sources.plugins.trust.adding') : t('sources.plugins.trust.add')}
            </Button>
          </div>
        </div>
      )}

      {message && (
        <div
          className={`rounded-[10px] px-3.5 py-2.5 border ${
            message.ok ? 'bg-mint/[0.06] border-mint/20' : 'bg-coral/[0.06] border-coral/20'
          }`}
        >
          <p className={`font-text text-caption ${message.ok ? 'text-mint/90' : 'text-coral/90'}`}>
            {message.text}
          </p>
        </div>
      )}

      {/* 删除确认：必须说清"不会卸载插件" */}
      {confirmRemove && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          role="dialog"
          aria-modal="true"
          onClick={(event) => {
            if (event.target === event.currentTarget) setConfirmRemove(null)
          }}
        >
          <div className="w-full max-w-md bg-[#16181d] border border-white/[0.08] rounded-[14px] p-4 space-y-3">
            <p className="font-text text-caption-strong text-white/90">
              {t('sources.plugins.trust.removeConfirmTitle', { keyId: confirmRemove.keyId })}
            </p>
            <p className="font-text text-caption text-white/60">
              {t('sources.plugins.trust.removeConfirmBody')}
            </p>
            <div className="flex items-center justify-end gap-2 pt-1">
              <Button
                variant="ghost"
                size="sm"
                className="h-9 px-3.5 text-white/60"
                onClick={() => setConfirmRemove(null)}
                disabled={busy}
              >
                {t('common.action.cancel')}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                className="h-9 px-3.5 text-coral"
                onClick={() => void handleRemove()}
                disabled={busy}
              >
                {busy ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" strokeWidth={1.6} />
                ) : (
                  <Trash2 className="h-4 w-4 mr-2" strokeWidth={1.6} />
                )}
                {t('sources.plugins.trust.remove')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
