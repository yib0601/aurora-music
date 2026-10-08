import { describe, expect, it } from 'vitest'
import { createAppTranslator } from '@aurora/shared'
import {
  checkLxScriptLink,
  lxFormSupported,
  lxPlatformRows,
  lxProbeErrorText,
  renderError,
} from '@/components/common/lxSourceForm'
import type { SourceProbeResult } from '@aurora/shared'

/**
 * 文案来源说明（i18n 改造后）：
 * 校验失败不再返回中文句子，而是**结构化错误**（AuroraError，code 即消息树里的完整键路径），
 * 由渲染端 `translateError(err, t)` 按当前语言取值。因此这里断言两件事：
 *   1) 错误码（语言无关的契约）；
 *   2) 中文侧渲染结果（保证字典里确实有这句人话）。
 * 需要「按语言渲染」的断言一律显式注入翻译器，不依赖测试运行环境的系统语言。
 */
const zh = createAppTranslator('zh-CN')

const probe = (over: Partial<SourceProbeResult> = {}): SourceProbeResult => ({
  ok: true,
  kind: 'lx',
  capabilities: [],
  ...over,
})

describe('checkLxScriptLink', () => {
  it('空链接报缺填', () => {
    expect(checkLxScriptLink('')?.code).toBe('sources.error.scriptUrlRequired')
    expect(checkLxScriptLink('   ')?.code).toBe('sources.error.scriptUrlRequired')
  })

  it('非 http(s) 一律拒绝', () => {
    expect(checkLxScriptLink('ftp://x/source.js')?.code).toBe('sources.error.scriptUrlScheme')
    expect(checkLxScriptLink('/local/source.js')?.code).toBe('sources.error.scriptUrlScheme')
  })

  it('错误码即文案键：显示端按语言渲染成人话', () => {
    expect(renderError(checkLxScriptLink(''), zh)).toBe('请填写脚本链接')
    expect(renderError(checkLxScriptLink('ftp://x/source.js'), zh)).toBe(
      '脚本链接需以 http:// 或 https:// 开头'
    )
  })

  it('不强制 .js 后缀：任意路径的脚本都能填', () => {
    expect(checkLxScriptLink('https://example.com/lx/source')).toBeNull()
    expect(checkLxScriptLink('http://127.0.0.1:9000/src')).toBeNull()
    expect(checkLxScriptLink('HTTPS://example.com/a.js')).toBeNull()
  })
})

describe('lxFormSupported', () => {
  it('桌面端与移动端可用，纯浏览器不可用（入口即禁用脚本形态）', () => {
    expect(lxFormSupported({ desktop: true, mobile: false })).toBe(true)
    expect(lxFormSupported({ desktop: false, mobile: true })).toBe(true)
    expect(lxFormSupported({ desktop: false, mobile: false })).toBe(false)
  })
})

describe('lxPlatformRows', () => {
  it('能力行直通渲染：平台名以**文案键**透出，译文留给渲染期取', () => {
    const rows = lxPlatformRows(
      probe({
        capabilities: [
          { key: 'kw', label: 'core.platform.kw', searchable: false, qualityCount: 3 },
          { key: 'tx', label: 'core.platform.tx', searchable: true, qualityCount: 1 },
        ],
      })
    )
    // 键而不是译文：本层在模块加载期求值，若在此 t() 会把语言冻死
    expect(rows).toEqual([
      { key: 'kw', labelKey: 'core.platform.kw', searchable: false, qualityCount: 3 },
      { key: 'tx', labelKey: 'core.platform.tx', searchable: true, qualityCount: 1 },
    ])
  })

  it('缺 qualityCount 时按 0 档处理', () => {
    const rows = lxPlatformRows(probe({ capabilities: [{ key: 'mg', label: 'core.platform.mg', searchable: true }] }))
    expect(rows).toEqual([{ key: 'mg', labelKey: 'core.platform.mg', searchable: true, qualityCount: 0 }])
  })

  it('未探测 / 无能力时返回空数组，界面不渲染能力块', () => {
    expect(lxPlatformRows(undefined)).toEqual([])
    expect(lxPlatformRows(probe({ capabilities: [] }))).toEqual([])
  })
})

describe('lxProbeErrorText', () => {
  it('源自报的失败原因优先，缺省给通用加载失败文案', () => {
    expect(lxProbeErrorText(probe({ ok: false, error: '脚本语法错误：Unexpected token' }), zh)).toBe(
      '脚本加载失败：脚本语法错误：Unexpected token'
    )
    expect(lxProbeErrorText(probe({ ok: false }), zh)).toBe('脚本加载失败：脚本未声明任何可用平台')
  })

  it('英文界面下同一份结论按英文渲染（语言由渲染端决定，不在产生地烧死）', () => {
    const en = createAppTranslator('en')
    expect(lxProbeErrorText(probe({ ok: false }), en)).toBe(
      'Script failed to load: the script declared no usable platform'
    )
  })
})
