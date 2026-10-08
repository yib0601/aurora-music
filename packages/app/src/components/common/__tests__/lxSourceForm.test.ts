import { describe, expect, it } from 'vitest'
import {
  checkLxScriptLink,
  lxFormSupported,
  lxPlatformRows,
  lxProbeErrorText,
} from '@/components/common/lxSourceForm'
import type { SourceProbeResult } from '@aurora/shared'

const probe = (over: Partial<SourceProbeResult> = {}): SourceProbeResult => ({
  ok: true,
  kind: 'lx',
  capabilities: [],
  ...over,
})

describe('checkLxScriptLink', () => {
  it('空链接报缺填', () => {
    expect(checkLxScriptLink('')).toBe('请填写脚本链接')
    expect(checkLxScriptLink('   ')).toBe('请填写脚本链接')
  })

  it('非 http(s) 一律拒绝', () => {
    expect(checkLxScriptLink('ftp://x/source.js')).toBe('脚本链接需以 http:// 或 https:// 开头')
    expect(checkLxScriptLink('/local/source.js')).toBe('脚本链接需以 http:// 或 https:// 开头')
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
  it('能力行直通渲染：中文名与可检索性由探测层翻译好，界面不再解释源的数据结构', () => {
    const rows = lxPlatformRows(
      probe({
        capabilities: [
          { key: 'kw', label: '酷我', searchable: false, qualityCount: 3 },
          { key: 'tx', label: 'QQ', searchable: true, qualityCount: 1 },
        ],
      })
    )
    expect(rows).toEqual([
      { key: 'kw', label: '酷我', searchable: false, qualityCount: 3 },
      { key: 'tx', label: 'QQ', searchable: true, qualityCount: 1 },
    ])
  })

  it('缺 qualityCount 时按 0 档处理', () => {
    const rows = lxPlatformRows(probe({ capabilities: [{ key: 'mg', label: '咪咕', searchable: true }] }))
    expect(rows).toEqual([{ key: 'mg', label: '咪咕', searchable: true, qualityCount: 0 }])
  })

  it('未探测 / 无能力时返回空数组，界面不渲染能力块', () => {
    expect(lxPlatformRows(undefined)).toEqual([])
    expect(lxPlatformRows(probe({ capabilities: [] }))).toEqual([])
  })
})

describe('lxProbeErrorText', () => {
  it('源自报的失败原因优先，缺省给通用加载失败文案', () => {
    expect(lxProbeErrorText(probe({ ok: false, error: '脚本语法错误：Unexpected token' }))).toBe(
      '脚本加载失败：脚本语法错误：Unexpected token'
    )
    expect(lxProbeErrorText(probe({ ok: false }))).toBe('脚本加载失败：脚本未声明任何可用平台')
  })
})
