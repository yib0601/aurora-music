import { RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { lxPlatformRows, runLxProbe, type LxProbeState } from './lxSourceForm'
import type { SourceProbeResult } from '@aurora/shared'

/**
 * 洛雪音源脚本源的探测 UI：脚本链接输入 + 「测试」+ 能力展示。
 * 添加弹窗与音源卡片共用这一块——平台中文名映射与能力标签只写一份；
 * 纯逻辑（链接校验 / 能力映射 / 探测调用）在 lxSourceForm.ts，便于单测。
 * 探测结论由平台适配器翻译成形态无关的 SourceProbeResult，这里只负责渲染。
 *
 * 纪律：脚本源码只存在于本次探测过程，绝不写进配置（配置里只留脚本链接）。
 */

export type { LxProbeState } from './lxSourceForm'

/** 探测结果展示：脚本自报的名称/版本 + 各平台能力 + 音质档位数 */
export function LxProbeResult({ result }: { result: SourceProbeResult }) {
  const rows = lxPlatformRows(result)
  if (!rows.length) return null
  const info = result.scriptInfo
  return (
    <div className="space-y-1">
      {(info?.name || info?.version) && (
        <p className="font-text text-caption text-white/50 truncate">
          {info?.name || '未命名脚本'}
          {info?.version ? ` · v${info.version}` : ''}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        {rows.map((row) => (
          <span
            key={row.key}
            className="inline-flex items-center gap-1.5 px-1.5 py-1 rounded-[6px] bg-white/[0.06] leading-none"
          >
            <span className="font-text text-[10px] text-white/80">{row.label}</span>
            <span className="font-text text-[10px] text-white/55">{row.searchable ? '搜索+取址' : '取址'}</span>
            {row.qualityCount > 0 && (
              <span className="font-text text-[10px] text-white/35">音质 {row.qualityCount} 档</span>
            )}
          </span>
        ))}
      </div>
      {info?.packed && (
        <p className="font-text text-caption text-white/35">脚本经 liscript 包装，已自动解包</p>
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
  error?: string | null
  placeholder?: string
  /** 卡片编辑态：字号与间距收紧一档 */
  compact?: boolean
}) {
  const handleProbe = async () => {
    onProbeChange({ loading: true })
    const state = await runLxProbe(instanceId, url, headers)
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
          {probe.loading ? '测试中…' : '测试'}
        </Button>
      </div>
      {probe.message && (
        <p
          className={`font-text text-caption mt-1 truncate ${probe.ok ? 'text-mint/80' : 'text-coral/80'}`}
          title={probe.message}
        >
          {probe.message}
        </p>
      )}
      {!probe.message && error && <p className="font-text text-caption text-coral/70 mt-1">{error}</p>}
      {probe.result?.ok && (
        <div className="mt-1.5">
          <LxProbeResult result={probe.result} />
        </div>
      )}
    </div>
  )
}