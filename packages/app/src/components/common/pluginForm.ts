/**
 * 插件表单描述（纯逻辑，可单测）。
 *
 * 设置页的「添加音源」需要知道：哪些插件可供用户选择、选中后要填哪些字段、
 * 哪些插件在当前端不可用（如浏览器没有脚本宿主）。
 *
 * 这些信息过去写死在 `SettingsPage.tsx` 的一个两项数组里，加第三种形态就得改 JSX。
 * 现在它是**从注册表推导的数据**：新增插件不需要改设置页，只要插件自己声明
 * `formKind` 与可用性。
 *
 * 与 `lxSourceForm.ts` 的关系：那个文件负责「洛雪脚本」这一种形态的链接校验与探测，
 * 属于形态私有逻辑；本文件只负责「列出形态 + 描述字段」，不含任何形态私有规则。
 */

import type { MessageKey } from '@aurora/shared'
import type { SourcePlugin } from '@aurora/shared'

/**
 * 表单形态：决定设置页渲染哪一套字段。
 *
 * - `service`：一条链接（服务地址 / 接口模板），端点由协议派生 → aurora
 * - `script`：一条脚本链接，脚本提供取址 → lx
 * - `playlist`：歌单定位串（链接或 id），可选登录 → qishui
 */
export type PluginFormKind = 'service' | 'script' | 'playlist'

/** 表单行：设置页直接渲染的形状 */
export interface PluginFormRow {
  /** 插件 id（保存时写进 `pluginId`） */
  value: string
  /** 展示名文案键 */
  labelKey: MessageKey
  /** 副标题文案键 */
  hintKey: MessageKey
  /** 该插件在当前端是否可用 */
  enabled: boolean
  /** 不可用时的悬浮说明（文案键） */
  disabledTitleKey?: MessageKey
  formKind: PluginFormKind
}

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

/**
 * 插件在当前端是否可用。
 *
 * 判定依据是**插件依赖什么能力**，而不是插件 id：
 * - 需要脚本执行（lx）→ 浏览器端不可用，桌面/移动可用
 * - 需要原生网络 + 凭证存储（qishui）→ 浏览器端不可用
 * - 纯 HTTP 协议（aurora）→ 三端都可用
 *
 * 这个判定必须与真实实现一致，否则用户填完才被告知不支持（见 `lxFormSupported` 的教训）。
 */
export function pluginAvailableOn(
  pluginId: string,
  platform: { desktop: boolean; mobile: boolean }
): boolean {
  switch (pluginId) {
    case 'lx':
      // 脚本要拉取与执行：桌面端主进程、移动端原生 HTTP；浏览器两者都没有
      return platform.desktop || platform.mobile
    case 'qishui':
      // 上游对带 Origin 的请求返回 403，且凭证要 safeStorage 加密：
      // 两者都要求原生端，浏览器端只能用 aurora 协议源
      return platform.desktop || platform.mobile
    default:
      return true
  }
}

/**
 * 由注册表推导设置页的形态列表。
 *
 * 保持注册顺序（与 `listPlugins()` 一致），因此 UI 顺序稳定、不随刷新抖动。
 */
export function pluginFormRows(
  plugins: readonly SourcePlugin[],
  platform: { desktop: boolean; mobile: boolean }
): PluginFormRow[] {
  return plugins.map((plugin) => {
    const available = pluginAvailableOn(plugin.id, platform)
    return {
      value: plugin.id,
      labelKey: plugin.displayNameKey,
      hintKey: plugin.descriptionKey || plugin.displayNameKey,
      enabled: available,
      disabledTitleKey:
        available
          ? undefined
          : plugin.id === 'lx'
            ? 'sources.form.kindLxDisabledTitle'
            : 'sources.form.kindQishuiDisabledTitle',
      formKind: FORM_KIND_OF[plugin.id] || 'service',
    }
  })
}

/** 取某个插件的表单形态（未登记回落 service） */
export function formKindOf(pluginId: string): PluginFormKind {
  return FORM_KIND_OF[pluginId] || 'service'
}
