/**
 * 字段取值路径解释器（声明式插件清单里的 `map` 值）。
 *
 * ## 为什么不用现成的取值库，也不接受 JS 表达式
 *
 * 清单是**第三方内容**。一旦允许 `eval` / 模板表达式 / 函数，A 档（纯声明、不执行代码）
 * 就退化成了 B 档，安装一个"JSON 插件"就等于运行一段陌生人的代码 —— 那正是
 * docs/plugins.md 明确排除的信任模型。
 *
 * 所以这里只实现**三个语法成分**：属性、下标、点号连接。
 *
 *   `a`            → json.a
 *   `a.b.c`        → json.a.b.c
 *   `a[0].b`       → json.a[0].b
 *   `a[0][1]`      → json.a[0][1]
 *
 * 其余一切（`a?.b`、`a.b || c`、`$[0]`、函数调用）都是非法路径 —— 在清单校验期就报错，
 * 而不是等到运行期求值出一堆 `undefined` 才发现映射写错了。
 *
 * ## 为什么失败返回 `undefined` 而不是抛错
 *
 * 第三方接口的字段缺失是**常态**（不同实现、不同版本、不同曲目）。一条缺字段的响应
 * 不该让整条源抛错 —— 上层看到的应该是「这条源没搜到」，而不是「这条源坏了」。
 * 只有**映射本身写错**（路径语法不合法）才在**校验期**报错，那是作者的错，不是响应的错。
 */

/** 路径的一段：属性名或数组下标 */
export type PathSegment = string | number

/**
 * 合法属性名的字符集。
 *
 * 不允许点号、方括号、空白与任何表达式记号。**首字符不能是 `$`**：
 * `$` 开场是 jq / JSONPath 的记号（`$nodes` / `$.data`），本层不支持它，
 * 而"看起来像支持"是最坏的一种兼容 —— 作者写了 `$[]` 语法只会得到永远取不到值的映射。
 * 属性名里含 `$`（`a.b$c`、`_$x`）是允许的：那在真实 JSON 里存在，且不歧义。
 */
const PROP_RE = /^[A-Za-z_][A-Za-z0-9_$-]*$/

/**
 * 解析路径。非法返回 `null`（调用方在校验期转成 `ManifestIssue`，在运行期当"取不到"）。
 *
 * 刻意**不做**隐式容错（如把 `data[0]` 里的 `_` 当属性名以外的东西）：路径写错时
 * 静默容错会让作者永远不知道自己写错了，只看到"这个插件取不到数据"。
 */
export function parsePath(input: unknown): PathSegment[] | null {
  if (typeof input !== 'string') return null
  const text = input.trim()
  if (!text) return null

  const segments: PathSegment[] = []
  let index = 0
  /**
   * 上一步是不是刚吃掉一个分隔符（`.` 或 `[]` 的收尾）。
   *
   * 用它判"连续点号"而不是看 `segments` 的末项：`a..b` 里第一个 `.` 之后
   * `segments` 末项仍是 `a`，只看末项会两次都放行，最终解析出 `['a','b']` ——
   * 路径写错却被静默接受，正是本模块要避免的那类失败。
   */
  let afterSeparator = false

  while (index < text.length) {
    const char = text[index]

    if (char === '.') {
      // `.` 只能出现在"上一段之后"，且后面必须还有内容
      if (segments.length === 0 || afterSeparator) return null
      if (index === text.length - 1) return null
      afterSeparator = true
      index += 1
      continue
    }

    if (char === '[') {
      const close = text.indexOf(']', index)
      if (close < 0) return null
      const inner = text.slice(index + 1, close)
      // 只接受非负整数下标：`a[foo]` 是「按变量取值」，属于表达式，本层不支持
      if (!/^\d+$/.test(inner)) return null
      segments.push(Number(inner))
      afterSeparator = false
      index = close + 1
      continue
    }

    // 属性名：一直读到下一个 `.` 或 `[`
    let end = index
    while (end < text.length && text[end] !== '.' && text[end] !== '[') end += 1
    const name = text.slice(index, end)
    // 空名只会出现在 `[0]` 之后直接接属性（`a[0]b` 这类），同样判非法
    if (!name || !PROP_RE.test(name)) return null
    segments.push(name)
    afterSeparator = false
    index = end
  }

  // 以分隔符收尾（`a.` / `a..`）已经在循环里挡掉，这里只兜 segments 为空的情况
  return segments.length > 0 ? segments : null
}

/**
 * 按已解析的路径取值。
 *
 * 任何一步不存在 / 类型不符（在下标位置上遇到非数组、在属性位置上遇到非对象）都返回
 * `undefined`：这是"取不到"，不是"出错"。
 */
export function readAtPath(root: unknown, segments: readonly PathSegment[]): unknown {
  let current: unknown = root
  for (const segment of segments) {
    if (current == null) return undefined
    if (typeof segment === 'number') {
      if (!Array.isArray(current)) return undefined
      current = current[segment]
      continue
    }
    if (typeof current !== 'object' || Array.isArray(current)) return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

/** 一步到位：解析 + 取值。路径非法或取不到都返回 `undefined` */
export function valueAtPath(root: unknown, path: string | null | undefined): unknown {
  const segments = parsePath(path)
  if (!segments) return undefined
  return readAtPath(root, segments)
}

/**
 * 取字符串值：只接受非空字符串（数字与布尔**不做**隐式转换）。
 *
 * 理由：`id` 这类字段上游常给数字，隐式转换看着方便，但会让「字段不存在」与
 * 「字段是 0 / false」无法区分 —— 而映射作者恰恰靠"取不到"来决定要不要回落到别的键。
 * 真需要数字时用 `readNumber`。
 */
export function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/** 取数字值：接受数字或可解析的数字字符串；其余（含 NaN / 空串）返回 undefined */
export function readNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value)
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}

/** 取布尔值：只接受真布尔（字符串 "true" 不当真 —— 上游给什么就是什么） */
export function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}
