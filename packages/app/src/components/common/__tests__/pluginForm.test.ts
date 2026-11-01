import { describe, it, expect } from 'vitest'
import { pluginFormRows, pluginAvailableOn, formKindOf } from '../pluginForm'
import type { SourcePlugin } from '@aurora/shared'

/**
 * 形态列表必须由注册表推导，而不是设置页里写死的数组。
 * 这些断言就是「新增插件不改设置页」这条承诺的守门人。
 */

const plugin = (id: string, extra?: Partial<SourcePlugin>): SourcePlugin => ({
  id,
  displayNameKey: 'core.platform.aurora',
  version: '1.0.0',
  capabilities: ['search'],
  ...extra,
})

const DESKTOP = { desktop: true, mobile: false }
const MOBILE = { desktop: false, mobile: true }
const BROWSER = { desktop: false, mobile: false }

describe('插件表单：由注册表推导形态列表', () => {
  it('列表顺序与注册顺序一致（UI 不随刷新抖动）', () => {
    const rows = pluginFormRows([plugin('aurora'), plugin('lx'), plugin('qishui')], DESKTOP)
    expect(rows.map((r) => r.value)).toEqual(['aurora', 'lx', 'qishui'])
  })

  it('新增插件自动出现在列表里（设置页无需改动）', () => {
    const rows = pluginFormRows([plugin('aurora'), plugin('brand-new')], DESKTOP)
    expect(rows.map((r) => r.value)).toContain('brand-new')
    // 未登记表单形态的插件回落到最简单的一套字段
    expect(rows.find((r) => r.value === 'brand-new')?.formKind).toBe('service')
  })

  it('每个形态都带展示名与副标题的文案键（不在数据层烧中文）', () => {
    const rows = pluginFormRows([plugin('aurora')], DESKTOP)
    expect(typeof rows[0].labelKey).toBe('string')
    expect(typeof rows[0].hintKey).toBe('string')
  })
})

/**
 * 插件启停与「本端没有该能力」是**两种不同的不可选**：
 * 前者用户点一下开关就能恢复，后者换设备才行。若两种都落成一句"不可用"，
 * 用户会去换设备，而不是去打开那个开关。
 */
describe('插件表单：停用的插件不可选，且原因与本端不支持区分开', () => {
  it('停用的插件被标为不可选，并给出"去插件里启用"的原因', () => {
    const rows = pluginFormRows([plugin('aurora')], DESKTOP, ['aurora'])
    expect(rows[0].enabled).toBe(false)
    expect(rows[0].disabledTitleKey).toBe('sources.form.kindDisabledByUser')
  })

  it('停用优先于本端不支持：两者同时成立时报"已停用"（那是用户能动的那个）', () => {
    // lx 在浏览器端本来就不支持，同时它又被用户停用了
    const rows = pluginFormRows([plugin('lx')], BROWSER, ['lx'])
    expect(rows[0].enabled).toBe(false)
    expect(rows[0].disabledTitleKey).toBe('sources.form.kindDisabledByUser')
  })

  it('不传停用清单时行为不变（既有调用点零改动，默认全部可选）', () => {
    const rows = pluginFormRows([plugin('aurora')], DESKTOP)
    expect(rows[0].enabled).toBe(true)
    expect(rows[0].disabledTitleKey).toBeUndefined()
  })

  it('停用清单里无关的 id 不影响其他插件', () => {
    const rows = pluginFormRows([plugin('aurora'), plugin('qishui')], DESKTOP, ['someone-else'])
    expect(rows.every((r) => r.enabled)).toBe(true)
  })

  it('内置插件也能被停用（可卸载与否不影响启停）', () => {
    const rows = pluginFormRows([plugin('aurora'), plugin('lx')], DESKTOP, ['lx'])
    expect(rows.find((r) => r.value === 'aurora')?.enabled).toBe(true)
    expect(rows.find((r) => r.value === 'lx')?.enabled).toBe(false)
  })
})

describe('插件表单：端能力判定', () => {
  it('桌面端三种插件都可用', () => {
    expect(pluginAvailableOn('aurora', DESKTOP)).toBe(true)
    expect(pluginAvailableOn('lx', DESKTOP)).toBe(true)
    expect(pluginAvailableOn('qishui', DESKTOP)).toBe(true)
  })

  it('移动端同样可用（原生 HTTP + WebView 宿主）', () => {
    expect(pluginAvailableOn('lx', MOBILE)).toBe(true)
    expect(pluginAvailableOn('qishui', MOBILE)).toBe(true)
  })

  it('浏览器端只有协议源可用：脚本宿主与凭证存储都没有', () => {
    expect(pluginAvailableOn('aurora', BROWSER)).toBe(true)
    expect(pluginAvailableOn('lx', BROWSER)).toBe(false)
    expect(pluginAvailableOn('qishui', BROWSER)).toBe(false)
  })

  it('不可用的形态带禁用说明，可用的不带（不让用户填完才知道不支持）', () => {
    const browserRows = pluginFormRows([plugin('aurora'), plugin('lx')], BROWSER)
    const aurora = browserRows.find((r) => r.value === 'aurora')!
    const lx = browserRows.find((r) => r.value === 'lx')!
    expect(aurora.enabled).toBe(true)
    expect(aurora.disabledTitleKey).toBeUndefined()
    expect(lx.enabled).toBe(false)
    expect(lx.disabledTitleKey).toBe('sources.form.kindLxDisabledTitle')
  })

  it('汽水在浏览器端给出自己的禁用说明（不借用洛雪的文案）', () => {
    const rows = pluginFormRows([plugin('qishui')], BROWSER)
    expect(rows[0].disabledTitleKey).toBe('sources.form.kindQishuiDisabledTitle')
  })
})

describe('插件表单：表单形态映射', () => {
  it('三种内置插件各有自己的字段形态', () => {
    expect(formKindOf('aurora')).toBe('service')
    expect(formKindOf('lx')).toBe('script')
    expect(formKindOf('qishui')).toBe('playlist')
  })

  it('未知插件回落 service（不会崩在未登记的表单形态上）', () => {
    expect(formKindOf('some-future-plugin')).toBe('service')
  })
})
