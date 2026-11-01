import { describe, it, expect } from 'vitest'
import { formKindOf } from '../pluginForm'

/**
 * 插件表单现在只剩**一件事**：字段布局。
 *
 * 曾经还有过另外两条，都随「配置按插件归属」一起下线，这里记录理由，
 * 免得后来人又把它们加回来：
 *
 * - `pluginFormRows()`（从注册表推导**可选项列表**）：新增弹窗顶部的「音源形态」
 *   选择器随改造消失 —— 入口已经是某个插件的设置面板，插件已确定，没什么可选。
 * - `pluginAvailableOn()`（按插件 id 硬编码的**端可用性表**）：真正的答案由插件
 *   自己声明依赖（`SourcePlugin.requires`）+ 注册期能力解析给出，那张表是第二份
 *   真源；而浏览器端整个「插件」分区本就隐藏，这个问题在 Web 上不成立。
 *
 * 因此本文件只钉字段布局：它决定同一个插件的表单长什么样，且与归属无关。
 */

describe('插件表单：字段布局', () => {
  it('三种内置插件各有自己的字段形态', () => {
    expect(formKindOf('aurora')).toBe('service')
    expect(formKindOf('lx')).toBe('script')
    expect(formKindOf('qishui')).toBe('playlist')
  })

  it('未知插件回落 service（不会崩在未登记的表单形态上）', () => {
    // 防回归：已安装的第三方插件不在 FORM_KIND_OF 里。若这里返回 undefined，
    // 插件设置面板会渲染出一个既没有链接框也没有脚本框的空表单 —— 装来的插件
    // 等于配不了。回落到「一条链接」是最小可用形态。
    expect(formKindOf('some-future-plugin')).toBe('service')
  })

  it('空 id 同样回落 service，不抛错', () => {
    expect(formKindOf('')).toBe('service')
  })
})
