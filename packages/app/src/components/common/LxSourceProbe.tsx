import { RefreshCw } from 'lucide-react'
import { type AuroraError } from '@aurora/shared'
import { Button } from '@/components/ui/button'
import { useT } from '@/i18n'
import { lxPlatformRows, renderError, runLxProbe, type LxProbeState } from './lxSourceForm'
import type { SourceProbeResult } from '@aurora/shared'

/**
 * 洛雪音源脚本源的探测 UI：脚本链接输入 + 「测试」+ 能力展示。
 * 添加弹窗与音源卡片共用这一块——平台中文名映射与能力标签只写一份；
 * 纯逻辑（链接校验 / 能力映射 / 探测调用）在 lxSourceForm.ts，便于单测。
 * 探测结论由平台适配器翻译成形态无关的 SourceProbeResult，这里只负责渲染。
 *
 * 文案全部在渲染期取（`useT()`）：校验错误以 AuroraError 传入，由 renderError
 * 按当前语言渲染，语言切换后无需重新校验即可换文案。
 *
 * 纪律：脚本源码只存在于本次探测过程，绝不写进配置（配置里只留脚本链接）。
 */

export type { LxProbeState } from './lxSourceForm'

/** 探测结果展示：脚本自报的名称/版本 + 各平台能力 + 音质档位数 */
export function LxProbeResult({ result }: { result: SourceProbeResult }) {
  const t = useT()
  const rows = lxPlatformRows(result)
  if (!rows.length) return null
  const info = result.scriptInfo
  const scriptName = info?.name || t('sources.probe.unnamedScript')
  return (
    <div className="space-y-1">
      {(info?.name || info?.version) && (
        <p className="font-text text-caption text-white/50 truncate">
          {info?.version
            ? t('sources.probe.scriptNameWithVersion', { name: scriptName, version: info.version })
            : t('sources.probe.scriptName', { name: scriptName })}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        {rows.map((row) => (
          <span
            key={row.key}
            className="inline-flex items-center gap-1.5 px-1.5 py-1 rounded-[6px] bg-white/[0.06] leading-none"
          >
            {/* 平台名：探测层给的是**文案键**（LX_PLATFORM_LABEL_KEYS），
                取值必须在渲染期做 —— 直接渲染会露出 `core.platform.kw`。
                能力描述走字典 */}
            <span className="font-text text-[10px] text-white/80">{t(row.labelKey)}</span>
            <span className="font-text text-[10px] text-white/55">
              {row.searchable ? t('sources.probe.searchAndResolve') : t('sources.probe.resolveOnly')}
            </span>
            {row.qualityCount > 0 && (
              <span className="font-text text-[10px] text-white/35">
                {t('sources.probe.qualityCount', { count: row.qualityCount })}
              </span>
            )}
          </span>
        ))}
      </div>
      {info?.packed && (
        <p className="font-text text-caption text-white/35">{t('sources.probe.packed')}</p>
      )}
    </div>
  )
}

/**
 * 脚本链接输入 + 测试按钮 + 结果。名称与请求头由调用方各自渲染：
 * 添加弹窗是完整表单，卡片编辑态是就地草稿，两者的字段排布不同。
 */
export function LxScriptProbe({
  url,
  headers,
  instanceId,
  probe,
  onUrlChange,
  onProbeChange,
  invalid,
  error,
  placeholder,
  compact,
}: {
  url: string
  /** 附加请求头：鉴权类脚本（私有源）探测时要用上 */
  headers?: Record<string, string>
  /** 探测实例名，用于脚本层缓存键：同一表单重复测试复用同一实例 */
  instanceId: string
  probe: LxProbeState
  onUrlChange: (value: string) => void
  onProbeChange: (state: LxProbeState) => void
  invalid?: boolean
  /** 链接校验结果：结构化错误，渲染期按当前语言取文案 */
  error?: AuroraError | null
  placeholder?: string
  /** 卡片编辑态：字号与间距收紧一档 */
  compact?: boolean
}) {
  const t = useT()
  const handleProbe = async () => {
    onProbeChange({ loading: true })
    const state = await runLxProbe(instanceId, url, headers, { t })
    onProbeChange(state)
  }

  return (
    <div>
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={url}
          placeholder={placeholder || 'https://raw.githubusercontent.com/xxx/lx-source/main/source.js'}
          onChange={(e) => {
            onUrlChange(e.target.value)
            // 链接一改，上次的探测结果立即失效（否则会张冠李戴）
            onProbeChange({ loading: false })
          }}
          className={`inset-field flex-1 px-2.5 py-1.5 font-text text-caption text-white/70 ${invalid ? 'is-invalid' : ''}`}
        />
        <Button
          variant="secondary"
          size="sm"
          className={`flex-shrink-0 ${compact ? 'h-8 px-3' : 'h-9 px-3.5'}`}
          disabled={probe.loading || !url.trim()}
          onClick={handleProbe}
        >
          <RefreshCw
            className={`h-3.5 w-3.5 mr-1.5 ${probe.loading ? 'animate-spin' : ''}`}
            strokeWidth={1.6}
          />
          {probe.loading ? t('sources.probe.testing') : t('sources.probe.test')}
        </Button>
      </div>
      {probe.message && (
        /* 探测结论是**结构化信封**（AURORA_ERR:{code,params}）或第三方自由文本：
           直接渲染会把 JSON 摊在界面上，必须过 renderError 按当前语言渲染 */
        <p
          className={`font-text text-caption mt-1 truncate ${probe.ok ? 'text-mint/80' : 'text-coral/80'}`}
          title={renderError(probe.message, t)}
        >
          {renderError(probe.message, t)}
        </p>
      )}
      {!probe.message && error && (
        <p className="font-text text-caption text-coral/70 mt-1">{renderError(error, t)}</p>
      )}
      {probe.result?.ok && (
        <div className="mt-1.5">
          <LxProbeResult result={probe.result} />
        </div>
      )}
    </div>
  )
}
