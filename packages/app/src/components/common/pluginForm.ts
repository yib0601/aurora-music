/**
 * 插件表单的**字段布局**判定（纯逻辑，可单测）。
 *
 * ## 职责收窄过一次，这里说明为什么
 *
 * 改造前本文件还负责「列出所有可选插件 → 用户挑一个 → 渲染对应字段」：音源的新增
 * 弹窗顶部有一个「音源形态」选择器，选项由 `pluginFormRows()` 从注册表推导。
 *
 * 配置按插件归属之后，**那个选择器不存在了**：入口就是某个插件的设置面板，插件已经
 * 确定，不需要也无从选择。于是 `pluginFormRows()` 连带它产出的 `PluginFormRow`
 * 一起下线（留着它等于让「可选项从哪来」有两份说法）。
 *
 * 剩下的一件事：`formKindOf()` —— 同一个插件的字段布局是固定的
 * （服务地址 / 脚本链接 / 歌单 id），插件设置面板据它渲染表单。
 *
 * ## 「这个端跑不跑得起来」不归本文件管
 *
 * 这里原本还有一张按插件 id 硬编码的 `pluginAvailableOn()` 表（lx / qishui 在浏览器端
 * 不可用）。它已经下线，理由与 `pluginFormRows` 相同 —— **第二份真源**：
 *
 * 1. 插件自己声明依赖（`SourcePlugin.requires`，如 lx 的 `script.host`），注册期
 *    解析不到宿主能力就根本不进注册表（见 `lxPlugin.ts` 的 `requires` 注释）。
 *    于是「这个端有没有它」由**目录里出不出得来**回答，不需要另一张表再答一遍。
 * 2. 浏览器端整个「插件」分区都是隐藏的（`SettingsPage` 按 `pluginExecutionAvailable()`
 *    判定），所以"在 Web 上该不该给某个插件配入口"这个问题不成立。
 *
 * 判断依据：一张需要随新增插件同步维护的表，迟早与真实实现分叉；而分叉的表现是
 * 「用户填完才被告知不支持」，正是那张表当初想避免的体验。
 *
 * 与 `lxSourceForm.ts` 的关系：那个文件负责「洛雪脚本」这一种形态的链接校验与探测，
 * 属于形态私有逻辑；本文件只负责「字段长什么样」，不含形态私有规则。
 */

/**
 * 表单形态：决定插件设置面板渲染哪一套字段。
 *
 * - `service`：一条链接（服务地址 / 接口模板），端点由协议派生 → aurora
 * - `script`：一条脚本链接，脚本提供取址 → lx
 * - `playlist`：歌单定位串（链接或 id），可选登录 → qishui
 */
export type PluginFormKind = 'service' | 'script' | 'playlist'

/**
 * 插件 → 表单形态的映射。
 *
 * 为什么不放进插件契约里：`SourcePlugin` 是 shared 的领域契约，不该知道「设置页有几套
 * 输入框」这件事（那是渲染层的实现细节）。这里用一个显式映射表把两者隔开，
 * 未登记的插件回落到 `service`（最简单的「一条链接」形态）。
 */
const FORM_KIND_OF: Record<string, PluginFormKind> = {
  aurora: 'service',
  lx: 'script',
  qishui: 'playlist',
}

/** 取某个插件的表单形态（未登记回落 service） */
export function formKindOf(pluginId: string): PluginFormKind {
  return FORM_KIND_OF[pluginId] || 'service'
}
