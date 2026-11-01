/**
 * 插件加载健康登记表。
 *
 * ## 为什么需要这一层
 *
 * 插件是**可失败的外部输入**：清单来自磁盘、脚本来自网络、内置实现也可能在某一版里
 * 引入一个求值期异常。一条插件出错绝不该让播放器起不来 —— 这条纪律此前只在
 * `mountInstalled` 的注释里写着，但真正 throw 的路径（内置注册、清单 → 插件构造、
 * 存储插件注册）没有一处被包住：任意一处抛错都会沿 `app.whenReady()` 的 promise 链
 * 冒出去，最坏的情况是窗口根本没被创建。
 *
 * 所以这里提供两件东西：
 *
 * 1. `isolatePluginStep` —— **唯一的**"跑一步插件逻辑，出错只记账"落点。
 *    启动链路里任何"一条插件"的粒度都必须经过它，而不是各写一遍 try/catch
 *    （那样迟早会漏掉一处，而漏掉的那处正好是启动路径）。
 * 2. `pluginFailures` —— 失败清单，供 UI 在启动后**告知**用户。
 *    用户的要求很朴素：插件坏了可以，别影响启动，但得让我知道。
 *
 * ## 容量的取舍
 *
 * 只留最近 `MAX_FAILURES` 条：正常情况下永远是 0 条，异常时也极少超过个位数。
 * 无上限的记忆会让一个"每次调用都失败的插件"把内存慢慢吃掉，而它诊断价值并不随
 * 条数增长。超限时丢**最旧**的（与日志缓冲同一策略：最近的现场更有用）。
 */

/**
 * 出错的阶段。
 *
 * 只用来让 UI 说清"哪一步出的问题"，不参与任何判定 —— 判定一律按插件 id。
 */
export type PluginFailureStage =
  /** 内置插件注册（`builtins.ts`） */
  | 'builtin'
  /** 已安装清单 → 插件实现（`installed.ts`） */
  | 'installed'
  /** 内置存储插件注册（`storage/index.ts`） */
  | 'storage'

/** 一条插件加载失败记录 */
export interface PluginFailure {
  /** 插件 id；连 id 都取不到时是空串（那种情况只能靠 reason 定位） */
  id: string
  stage: PluginFailureStage
  /**
   * 技术原因原文（不翻译）。
   *
   * 与全仓既有纪律一致：错误的技术细节不吞（`renderErrorMessage` 同此）。
   * 翻译层拿不到插件作者写下的异常信息，硬翻只会翻出一句更没用的话。
   */
  reason: string
  /** 记录时刻（epoch ms，仅用于排序与"本次启动"判断，不是业务时间） */
  at: number
}

/**
 * 启动期插件状态快照（经 IPC / 平台网关送到渲染层的形状）。
 *
 * 三个字段合起来才够 UI 说清现状：**挂载成功几个**（安静时什么都不用说）、
 * **磁盘上有几个读不出来**（旧行为，此前只在插件页里体现）、
 * **哪几个在注册期出错**（本次新增）。
 */
export interface PluginStartupReport {
  /** 启动时成功挂载进运行期的插件 id（诊断用） */
  mounted: string[]
  /** 磁盘上读不出来 / 校验不通过 / 启动时被跳过的条目数 */
  broken: number
  /** 注册或加载阶段抛错的插件 */
  failures: PluginFailure[]
}

/** 最多保留的失败条数 */
const MAX_FAILURES = 50

const FAILURES: PluginFailure[] = []

/** 从任意抛出物里取一句可读原因；空串是不允许的（UI 会显示成空白） */
function reasonOf(err: unknown): string {
  if (err instanceof Error) return err.message || err.name || 'Error'
  const text = typeof err === 'string' ? err : String(err ?? '')
  return text || 'unknown error'
}

/**
 * 记一条失败。
 *
 * 返回记下的记录，便于调用方就地打日志（`console.error` 会被主进程的日志内核接管，
 * 落盘与 UI 提示是两条并行的通道，都需要）。
 */
export function notePluginFailure(
  stage: PluginFailureStage,
  id: unknown,
  err: unknown,
  at = Date.now()
): PluginFailure {
  const failure: PluginFailure = {
    id: typeof id === 'string' ? id : '',
    stage,
    reason: reasonOf(err),
    at,
  }
  if (FAILURES.length >= MAX_FAILURES) FAILURES.shift()
  FAILURES.push(failure)
  return failure
}

/**
 * 跑一步插件逻辑；抛错时记录并返回 `undefined`。
 *
 * `run` 的返回值**不落账**（success 无需记忆）—— 调用方自己决定 undefined 意味着什么
 * （注册失败 / 构造失败 / 什么也不用做）。
 *
 * 刻意不使用 `catch (err) { ... }` 之外的任何手段（不重试、不降级成别的插件）：
 * 一个插件失败就是这一条失败，换别的实现去执行只会在另一处产生更难懂的现象。
 */
export function isolatePluginStep<T>(
  stage: PluginFailureStage,
  id: unknown,
  run: () => T
): T | undefined {
  try {
    return run()
  } catch (err) {
    const failure = notePluginFailure(stage, id, err)
    console.error(`[plugin] ${stage} 插件「${failure.id || '?'}」加载失败:`, failure.reason)
    return undefined
  }
}

/** 当前失败清单（拷贝：调用方改数组不该改到登记表） */
export function pluginFailures(): PluginFailure[] {
  return FAILURES.map((failure) => ({ ...failure }))
}

/** 组装启动期报告。平台层把自己那侧的挂载结果传进来，失败清单从登记表取 */
export function pluginStartupReport(partial?: {
  mounted?: readonly string[]
  broken?: number
}): PluginStartupReport {
  const broken = Number(partial?.broken ?? 0)
  return {
    mounted: [...(partial?.mounted ?? [])],
    broken: Number.isFinite(broken) && broken > 0 ? Math.floor(broken) : 0,
    failures: pluginFailures(),
  }
}

/** **仅供单测**：清空失败登记（生产代码没有"忘掉插件坏了"的需求） */
export function clearPluginFailuresForTest(): void {
  FAILURES.length = 0
}
