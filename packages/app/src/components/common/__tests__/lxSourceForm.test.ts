import { describe, expect, it } from 'vitest'
import {
  checkLxScriptLink,
  lxFormSupported,
  lxPlatformRows,
  lxProbeErrorText,
} from '@/components/common/lxSourceForm'
import type { LxSourceInspection } from '@aurora/shared'

const inspection = (over: Partial<LxSourceInspection> = {}): LxSourceInspection => ({
  ok: true,
  platforms: {},
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
  it('桌面端与移动端可用，纯浏览器不可用（入口即禁用洛雪形态）', () => {
    expect(lxFormSupported({ desktop: true, mobile: false })).toBe(true)
    expect(lxFormSupported({ desktop: false, mobile: true })).toBe(true)
    expect(lxFormSupported({ desktop: false, mobile: false })).toBe(false)
  })
})

describe('lxPlatformRows', () => {
  it('平台名走 shared 中文映射，能力按 actions 判定', () => {
    const rows = lxPlatformRows(
      inspection({
        platforms: {
          kw: { actions: ['musicUrl'], qualitys: ['128k', '320k', 'flac'] },
          tx: { actions: ['search', 'musicUrl'], qualitys: ['128k'] },
        },
      })
    )
    expect(rows).toEqual([
      { key: 'kw', label: '酷我', searchable: false, qualityCount: 3 },
      { key: 'tx', label: 'QQ', searchable: true, qualityCount: 1 },
    ])
  })

  it('musicSearch 也算搜索能力；未知平台回落脚本自报名', () => {
    const rows = lxPlatformRows(
      inspection({
        platforms: {
          wy: { actions: ['musicSearch'], qualitys: [] },
          xx: { name: '自报平台', actions: [], qualitys: ['flac24bit'] },
        },
      })
    )
    expect(rows).toEqual([
      { key: 'wy', label: '网易', searchable: true, qualityCount: 0 },
      { key: 'xx', label: '自报平台', searchable: false, qualityCount: 1 },
    ])
  })

  it('未探测 / 无平台时返回空数组，界面不渲染能力块', () => {
    expect(lxPlatformRows(undefined)).toEqual([])
    expect(lxPlatformRows(inspection({ platforms: {} }))).toEqual([])
  })
})

describe('lxProbeErrorText', () => {
  it('脚本自报错误优先，缺省给通用加载失败文案', () => {
    expect(lxProbeErrorText(inspection({ ok: false, error: '脚本语法错误：Unexpected token' }))).toBe(
      '脚本加载失败：脚本语法错误：Unexpected token'
    )
    expect(lxProbeErrorText(inspection({ ok: false }))).toBe('脚本加载失败：脚本未声明任何可用平台')
  })
})