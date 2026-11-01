/**
 * 宿主能力注册表。
 *
 * ## 解决什么
 *
 * 插件层现在只有「**我能做什么**」的声明（`SourcePlugin` 的可选方法 + `capabilities`），
 * 没有「**我需要宿主给我什么**」。宿主那侧靠三端各写一套装配（`setLxHostDeps` /
 * `installMobileLxHost` / web 端零注册），插件内部再用模块级单例现读，
 * 于是依赖是隐式的：只能靠读实现代码才知道某个插件要求宿主提供什么。
 *
 * 本模块把这件事变成显式的两半：
 *
 * - 插件侧声明 `requires: CapabilityRequirement[]`
 * - 宿主侧 `registerHostCapability(id, version, impl)`
 *
 * 由 `resolveRequirements()` 在**注册之前**给出结论：这个插件在当前平台到底能不能跑。
 *
 * ## 为什么是「能力 id + 主版本」而不是 semver
 *
 * 宿主能力是**进程内实现**，不是可独立升级的包：桌面端换个 `http.fetch` 就是改代码。
 * 用主版本整数做**精确匹配**已经足够表达「这个契约变了」，还省掉一个版本求解器
 * 和「同时装两个版本的同一能力」这种在宿主侧根本不成立的场景。
 *
 * ## 三条纪律
 *
 * 1. **缺失必须可见**。`optional: false` 的能力缺失 → 插件**不注册**，
 *    在 UI 里明确显示"当前平台缺少 X"。绝不能让它装上去、点播放才失败。
 * 2. **optional 缺失只能是 `undefined`**，不允许用 `?.` + 默认值伪装成"有，但值是空"。
 *    后者是本仓已经踩过的坑：`lxHost` 里 `utils.crypto.md5` 缺失时脚本拿到
 *    `undefined` 继续跑，签名串变成空字符串 —— 不报错，只是结果不对。
 * 3. **本模块零依赖**。它只认 `id / version / impl` 三个概念，不 import 任何插件
 *    或核心模块。宿主装配失败不该连累"判断能不能装配"这件事本身。
 *
 * ## 与 `PluginCapability` 的区别
 *
 * `PluginCapability`（`types.ts`）是**插件对外提供**的能力（search / resolveTrack…），
 * 供 UI 渲染徽章；本文件的 `HostCapabilityId` 是**宿主对插件提供**的能力。
 * 方向相反，不能混用同一个类型。
 */

/**
 * 宿主能力 id。
 *
 * 命名用 `域.对象` 形式：域相同的能力通常同一端提供/不提供，便于在装配代码里
 * 一眼看出"这一组是脚本宿主"。
 */
export type HostCapabilityId =
  /** 网络请求实现。桌面/移动给原生实现（不带 Origin），浏览器给 window.fetch */
  | 'http.fetch'
  /** 凭证安全存取（桌面 safeStorage；移动/浏览器没有） */
  | 'credential'
  /** 受限脚本宿主（request / evaluate / utils.*） */
  | 'script.host'
  /** 插件诊断日志出口 */
  | 'log'
  /** 插件文件读取（清单 / 脚本正文落盘读取） */
  | 'plugin.fs'
  /** 出网白名单策略（声明式插件的 hosts 强制） */
  | 'net.allowlist'

/**
 * 一条依赖声明。
 *
 * `version` 是主版本：宿主注册时给什么版本，插件就要什么版本，精确相等才通过。
 */
export interface CapabilityRequirement {
  id: HostCapabilityId
  version: number
  /**
   * 缺失时插件是否仍可注册。
   *
   * 缺省 `false`（必需）：这是安全的默认 —— 忘了标 optional 的代价是"插件不被注册，
   * 用户看到明确原因"；标错的代价是"插件注册了，运行到一半才失败"。
   */
  optional?: boolean
}

/** 一条已注册的宿主能力 */
export interface HostCapability<T = unknown> {
  id: HostCapabilityId
  version: number
  impl: T
}

/**
 * 一处依赖缺口。
 *
 * 区分 `missing` 与 `version-mismatch` 是为了让用户看到的话不同：
 * 前者是"这个端做不了这件事"（正常，如浏览器没有脚本宿主），
 * 后者是"版本对不上"（异常，通常意味着宿主与插件来自不同版本的应用）。
 */
export interface CapabilityGap {
  requirement: CapabilityRequirement
  reason: 'missing' | 'version-mismatch'
  /** 宿主实际注册的版本（仅 `version-mismatch` 时有值） */
  actualVersion?: number
}

/** 解析结论 */
export type PluginAvailability =
  | { ok: true; resolved: ReadonlyMap<HostCapabilityId, unknown> }
  /** `missing` 只含**必需**能力的缺口；optional 缺失不进这里（那是正常降级） */
  | { ok: false; missing: readonly CapabilityGap[] }

/** id → 已注册能力。Map 的插入序即注册序 */
const REGISTRY = new Map<HostCapabilityId, HostCapability>()

/**
 * 注册一条宿主能力。
 *
 * 同 id 重复注册视为**替换实现**（宿主启动流程可能先装占位实现、later 换成真实现，
 * 如移动端从 `new Function` 回退换到 Worker 沙箱）。替换**保留原位置**，
 * 与两个插件注册表（`plugin/registry.ts`、`plugin/storage/registry.ts`）同一语义。
 */
export function registerHostCapability<T>(
  id: HostCapabilityId,
  version: number,
  impl: T
): void {
  if (typeof id !== 'string' || !id) {
    throw new Error(`[host-capability] invalid capability id: ${String(id)}`)
  }
  if (!Number.isInteger(version) || version < 1) {
    // 版本参与相等判定，非法值会让"匹配"永远失败且原因难以追溯
    throw new Error(`[host-capability] "${id}" needs a positive integer version, got ${String(version)}`)
  }
  REGISTRY.set(id, { id, version, impl })
}

/** 撤销一条能力（**仅供端切换 / 单测**：正常启动流程没有"卸载宿主能力"的需求） */
export function unregisterHostCapability(id: HostCapabilityId): boolean {
  return REGISTRY.delete(id)
}

/** 取一条能力；未注册返回 undefined（调用方据此降级，不抛错） */
export function getHostCapability<T = unknown>(id: HostCapabilityId): HostCapability<T> | undefined {
  return REGISTRY.get(id) as HostCapability<T> | undefined
}

/** 全部已注册能力，按注册顺序（诊断 / UI 展示"当前平台支持什么"） */
export function listHostCapabilities(): HostCapability[] {
  return [...REGISTRY.values()]
}

/**
 * 解析一组依赖声明。
 *
 * 这是**唯一**的"插件能不能跑"判定入口。注册插件前必须先过这里：
 *
 * ```ts
 * const avail = resolveRequirements(plugin.requires ?? [])
 * if (!avail.ok) return { registered: false, missing: avail.missing }
 * ```
 *
 * optional 缺失**不进** `missing`：那是正常降级，由插件运行时自己分支处理。
 */
export function resolveRequirements(
  requirements: readonly CapabilityRequirement[]
): PluginAvailability {
  const resolved = new Map<HostCapabilityId, unknown>()
  const missing: CapabilityGap[] = []

  for (const requirement of requirements || []) {
    if (!requirement || typeof requirement.id !== 'string') continue
    const registered = REGISTRY.get(requirement.id)

    if (!registered) {
      // optional 缺失是正常降级：不记缺口，插件自己处理 undefined
      if (!requirement.optional) missing.push({ requirement, reason: 'missing' })
      continue
    }

    if (registered.version !== requirement.version) {
      // 版本不匹配**即使 optional 也算方案不成立**：插件按 v1 写的用法喂给 v2 实现，
      // 比"完全没有"更危险（可能静默产出错误结果，而不是报错）
      missing.push({
        requirement,
        reason: 'version-mismatch',
        actualVersion: registered.version,
      })
      continue
    }

    resolved.set(requirement.id, registered.impl)
  }

  return missing.length > 0 ? { ok: false, missing } : { ok: true, resolved }
}

/** 一份「这个端当前缺什么」的可读清单（诊断用）。
 *
 * 不参与判定：判定只看 `resolveRequirements`。这里只是给日志 / 设置页用的投影。
 */
export function describeMissingCapabilities(gaps: readonly CapabilityGap[]): string[] {
  // 开发者诊断串：只进日志与「为什么这个插件没注册」的排查输出，不进界面。
  // 能力 id 与版本号本身是技术标识，翻译它会让排查更困难
  // （用户报「缺少 http.fetch@1」时能直接搜到代码里的能力常量）。
  return (gaps || []).map((gap) => {
    const { id, version } = gap.requirement
    return gap.reason === 'version-mismatch'
      ? `${id}@${version}（宿主提供 @${gap.actualVersion}）` // i18n-exempt: 开发者诊断串
      : `${id}@${version}（未提供）` // i18n-exempt: 开发者诊断串
  })
}

/** 各能力 id 当前的主版本。集中在一处，避免调用点各写一个魔法数字 */
export const HOST_CAPABILITY_VERSION = {
  'http.fetch': 1,
  credential: 1,
  'script.host': 1,
  log: 1,
  'plugin.fs': 1,
  'net.allowlist': 1,
} as const satisfies Record<HostCapabilityId, number>

// ─── 默认能力 ───────────────────────────────────────────────────
//
// 三端**都有**、且不依赖任何平台 API 的那部分能力在这里兜底注册。
// 目的只有一个：让 `resolveRequirements` 不会因为"宿主还没跑起来"就把所有插件
// 判成不可用 —— 那会让应用在启动早期出现"一个插件都没有"的假象。
//
// 平台层随后会用真实实现**覆盖**它们（`registerHostCapability` 同 id 是替换）：
// 例如移动端把 `http.fetch` 换成 CapacitorHttp 包装版（绕 CORS），
// 桌面端注册 `script.host` / `credential`。
const installDefaultCapabilities = (): void => {
  registerHostCapability('http.fetch', HOST_CAPABILITY_VERSION['http.fetch'], globalThis.fetch)
  // 默认日志出口：不引 logging 层，保持本模块零依赖。
  // 宿主装好 logger 后会覆盖成带 sink 的实现。
  registerHostCapability(
    'log',
    HOST_CAPABILITY_VERSION.log,
    (scope: string) => (message: string, detail?: unknown) => {
      if (detail === undefined) console.warn(`[${scope}] ${message}`)
      else console.warn(`[${scope}] ${message}`, detail)
    }
  )
}

installDefaultCapabilities()

/**
 * **仅供单测**：清空注册表并装回默认能力。
 *
 * 装回默认能力而不是留空：默认能力（http.fetch / log）是模块不变量，不是"某个端注册的"。
 * 留空会让所有用例都得先手工装一遍，而漏装的表现是"插件全部不可用"——
 * 一个与测试意图无关的失败，排查成本高。
 */
export function clearHostCapabilitiesForTest(): void {
  REGISTRY.clear()
  installDefaultCapabilities()
}

// ─── 清单 → 依赖推导 ─────────────────────────────────────────────
//
// **这是唯一一处映射**。任何"作者也可以手写 requires"的设计都会重蹈
// `capabilities` 与「方法存在性」两份真源的覆辙：声明的依赖与实际用的能力一旦
// 分叉，就会出现"插件声明不需要 X、实际调用了 X"这种只能靠读代码发现的问题。

/** 推导所需的最小输入：只有清单里决定依赖的那两个字段 */
export interface ManifestDependencyInput {
  /** 清单申请的能力项 */
  permissions?: readonly string[]
  /** 是否有脚本块（B 档） */
  hasScript?: boolean
}

/**
 * 由清单字段推导依赖声明。
 *
 * 规则（**不提供手写入口**）：
 *
 * | 清单里有什么 | 推导出的 requires |
 * |---|---|
 * | `permissions: ['network']` | `http.fetch` |
 * | `permissions: ['credential']` | `credential` |
 * | `script: {...}` | `script.host` |
 * | 总是（清单本身从磁盘读 / 出网受白名单约束） | `net.allowlist` |
 *
 * `net.allowlist` 是**无条件必需**的：已安装插件的每一次出网都应当经过白名单强制
 * （见 `manifest/host.ts` 的存在理由）。把它标 optional 等于让"没有白名单的端"
 * 静默放行所有请求 —— 那正是这层要防的事。
 */
export function requirementsOfManifest(
  input: ManifestDependencyInput | null | undefined
): CapabilityRequirement[] {
  const permissions = Array.isArray(input?.permissions) ? input!.permissions! : []
  const out: CapabilityRequirement[] = []
  const seen = new Set<HostCapabilityId>()

  const add = (id: HostCapabilityId) => {
    if (seen.has(id)) return
    seen.add(id)
    out.push({ id, version: HOST_CAPABILITY_VERSION[id] })
  }

  // 任何声明式端点都要发 HTTP
  if (permissions.includes('network')) add('http.fetch')
  if (permissions.includes('credential')) add('credential')
  if (input?.hasScript) add('script.host')
  add('net.allowlist')

  return out
}
