/**
 * 日志脱敏。
 *
 * 为什么必须有：日志整包是要发给开发者（也就是自己）的，而本项目的日志里天然会
 * 出现用户自己配置的音源地址、WebDAV 口令、请求头。仓库曾经发生过音源 API_KEY
 * 进入公开提交的事故，日志文件比代码更容易被随手贴到 issue 里，
 * 所以**脱敏放在记录创建时，而不是导出时** —— 落盘的那份就已经是安全的。
 *
 * 策略是「按名字认」而非「按长相认」：
 * - 命中敏感键名（api_key / token / secret / password / cookie / authorization …）的值一律打码；
 * - 字符串里的 URL query 参数、`key=value`、`Bearer xxx`、`https://user:pass@host` 逐处打码；
 * - 不按「长得像不像随机串」猜，否则曲目 ID、文件路径会被误伤，日志就没法排障了。
 */

/**
 * 键名判定：命中即整值打码。用「子串」而不是全等，覆盖 apiKey / maskSecret /
 * X-Auth-Token 这类变体。
 *
 * 后半段（auth / pass / jwt / sig / session …）是独立验证补出来的：这些短名
 * 同样是常见的凭据参数名，但「子串匹配」不能简单写成 `auth`/`pass` —— `author`
 * （作者）、`passing`（通过率）、`signal`（信号）都会被误伤。所以它们用
 * **完整词边界**单独列出，见 SHORT_SECRET_KEY。
 */
const SECRET_KEY = /(api[_-]?key|token|secret|password|passwd|pwd|cookie|authorization|credential|私钥|口令|密码|密钥)/i

/**
 * 短凭据名（必须整词匹配）。
 *
 * `auth` / `pass` / `jwt` / `sig` / `session` / `privateKey` 频繁出现于各路 API，
 * 但作为子串会误伤普通英文词。用 `^(...)$` 整词判定，代价是 `x-auth` 这类带前缀
 * 的写法要靠 SECRET_KEY 的 `authorization` 分支覆盖（够用：真实请求头基本是
 * Authorization 全称）。
 */
const SHORT_SECRET_KEY = /^(auth|pass|passwd|pwd|jwt|sig|signature|sessionid|session[_-]?id|private[_-]?key|access[_-]?key|app[_-]?key|client[_-]?secret)$/i

/**
 * 键名误伤排除：这些名字里含 secret/key 语义但本身不是凭据，脱掉反而妨碍排障。
 *
 * ⚠️ 这里**刻意不含裸 `key`**。它曾经在列表里，后果是 `?key=<凭据>` 完全不打码
 * （独立验证当场复现并端到端落盘确认）。原因是 `isSecretKey()` 同时服务两种语义：
 * 对象**字段名**（`{ key: 'primary' }` 确实不是凭据）与 **URL query 参数名**
 * （`?key=` 恰恰是凭据）。而本项目的音源服务凭据参数名就是 `key`
 * —— `auroraPreset.ts` 的 7 条回落模板全是 `&key=<API_KEY>`，
 * 仓库还发生过这个 key 进入公开提交的事故。放行 `key` 等于精准漏掉最该保护的那一个。
 *
 * 取舍：对象字段 `key` 会被误打码（例如 KV 结构里的键名）。这可以接受 ——
 * 少看到一处键名 vs 泄漏一次凭据，后者不可逆。
 */
const SAFE_KEY = /^(keys|secretName|tokenType|passwordPolicy|authorized|authorizationRequired)$/i

/** 打码后的统一占位符：一眼能看出「这里原本有值但被保护了」 */
export const REDACTED = '***'

/** 单个字符串的上限：一条日志几十 KB 的 base64 会把文件瞬间撑爆，超出即截断 */
const MAX_STRING = 4096
/** 单个对象展开的键数上限 */
const MAX_KEYS = 48
/** 数组元素上限 */
const MAX_ITEMS = 48
/** 递归深度上限：IPC 传来的结构可能很深，超过即记为占位符 */
const MAX_DEPTH = 4

/**
 * 裸 `key` 是否按凭据处理：**按位置区分**。
 *
 * - URL query / key=value 里的 `key=` → 是凭据（本项目音源服务就用它）
 * - 对象字段名里的 `key` → 不是凭据（KV 结构里的名字，打码会让人读不懂日志）
 *
 * 调用方通过 `context` 声明位置；不传时按「可能出现在 URL 里」从严处理。
 */
export type SecretKeyContext = 'url' | 'field'

/** 是否「长得像凭据的键名」 */
export function isSecretKey(key: string, context: SecretKeyContext = 'url'): boolean {
  if (!key) return false
  // 裸 key：URL 里一律认作凭据，对象字段名里放行
  if (/^key$/i.test(key)) return context === 'url'
  if (SAFE_KEY.test(key)) return false
  if (SHORT_SECRET_KEY.test(key)) return true
  return SECRET_KEY.test(key)
}

/** 截断 + 去掉控制字符（换行保留：堆栈与多行文案要靠它） */
function clip(text: string): string {
  const normalized = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
  return normalized.length > MAX_STRING ? `${normalized.slice(0, MAX_STRING)}…[truncated ${normalized.length} chars]` : normalized
}

/**
 * 头部类键名：值是**整行**凭据，必须吃到行尾/引号结束。
 *
 * 与普通 `k=v` 不同，`Authorization: Bearer xyz` 的值里含空格，
 * 通用键值规则只会吃掉 `Bearer`，把令牌留在后面 —— 这个坑实际踩过一次
 * （测试「打码认证头值」当场判红）。所以头部类单独成规则，优先级最高。
 */
const HEADER_KEY = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token|x-access-token)$/i

/**
 * 字符串脱敏。
 *
 * 顺序**必须**是：userinfo → 头部整行 → 认证方案词 → query → 通用键值。
 *
 * 反例（曾经的真实 bug）：若通用键值规则先跑，`Authorization: Bearer abc.def`
 * 会被切成 `Authorization: *** abc.def`，令牌原样留在日志里 —— 而这正是最该被打码的一类值。
 * 头部规则先跑就没有这个问题；最后的认证方案词规则兜住「没有头部名、只写了
 * `Bearer xxx`」的形态。
 *
 * ## 性能：为什么必须先裁剪再跑正则
 *
 * 这些规则里有贪婪量词（`[\w.-]` / `[^"',;&}\s]`）。在「一整行没有任何分隔符」的
 * 输入上（base64、压缩后的 JS、超长歌名），它们会退化成平方级回溯：实测未裁剪时
 * 4K 字符 94ms、**16K 字符 1.5s** —— 而渲染层的单条记录可达几十 KB，一条这样的日志
 * 就能把主进程卡住，播放与全部 IPC 一起停。
 *
 * 两道防线：
 * 1. **先 clip() 再做正则**：把正则的输入规模钉死在 MAX_STRING 以内。顺序不能反 ——
 *    裁剪放在脱敏之后，正则仍要先承受完整输入的回溯。
 * 2. **量词全部有界**（`{0,64}` 而不是 `*`）：即使在上限之内也是线性的。
 * 有界量词不会漏打码：凭据不会长到几百字符，超过上限的尾巴本来就已被 clip 丢弃。
 */
export function redactText(input: string): string {
  if (!input) return input
  // 先裁剪：正则的规模上限（超过 MAX_STRING 的部分本就要丢弃）
  let text = clip(input)

  // 1) URL userinfo：`https://u:p@h` 里的 `p` 不含敏感键名，只能按形态认。
  //    字符集**含** `/`：口令里出现路径分隔符时（`https://u:p/w0rd@host`）若不收进来，
  //    规则在 `/` 处就断了，口令会原样留在日志里 —— 独立验证实测确认过这个缺口。
  //    收进来的风险是误伤「URL 后面跟正文、中间恰好有 @」，但 `://` 锚点已经把它限制在
  //    紧跟协议头的位置，现实中只可能是 userinfo。
  text = text.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s@]{0,512}@/gi, `$1${REDACTED}@`)

  // 2) 头部类键名：值取到引号结束或行尾（JSON 形态的 `"Authorization": "…"` 也要吃对）。
  //    两条硬约束：
  //    a) 值的**引号要原样回填**，否则 `{"Authorization":"Bearer x"}` 会被改成
  //       `{"Authorization":***}` —— 安全上没问题（值已打码），但结构坏掉的 JSON 会让人
  //       以为是应用吐出了畸形数据，把排查方向带偏。规则 5/6 一直这么做，本规则此前漏了
  //       （独立验证以 B-5 指出）。
  //    b) 值**必须允许含空格**：`Authorization: Bearer abc` 的凭据就在空格之后。
  //       若把空格排除在值字符集外，规则只吃掉 `Bearer`、令牌原样留下 —— 这正是本项目
  //       最初踩过的坑（我修 B-5 时把空格加进排除集，当场把这个坑又踩了一遍）。
  text = text.replace(
    /("?)([A-Za-z-]{1,64})\1(\s*[:=]\s*)("[^"\n]{0,2048}"|[^\n,;)}\]]{0,2048})/g,
    (whole, quote: string, name: string, mid: string, value: string) => {
      if (!HEADER_KEY.test(name)) return whole
      // 值的引号原样回填（保住 JSON 结构），值本身整段换成 ***。
      // 整段替换也顺带吃掉 `Bearer` 之后的令牌 —— 真实凭据在那一刻，不能只留 `*** <令牌>`
      const valueQuote = value.startsWith('"') ? '"' : ''
      return `${quote}${name}${quote}${mid}${valueQuote}${REDACTED}${valueQuote}`
    }
  )

  // 3) 认证方案词：Bearer abc / Basic YWJj（含没有头部名的情况）
  text = text.replace(/\b(Bearer|Basic)(\s+)[A-Za-z0-9._~+/=-]{1,2048}/gi, `$1$2${REDACTED}`)

  // 4) URL query 参数：?api_key=xxx&token=yyy
  text = text.replace(
    /([?&])([^=&#\s]{1,128})=([^&#\s]{0,1024})/g,
    // URL query 参数名：走 'url' 语义，裸 `key=` 也算凭据（本项目音源服务就用它）
    (whole, sep: string, name: string) => (isSecretKey(name, 'url') ? `${sep}${name}=${REDACTED}` : whole)
  )

  // 5) 通用键值对（英文键名）：api_key=xxx / "token": "xxx" / password: xxx
  //    引号要**原样保留**：日志里常有 JSON 片段，把 `"token":"x"` 改写成 `token:***`
  //    会让读者以为原文结构就是坏的（而原文其实完好）。打码只替换值，不动结构。
  text = text.replace(
    /("?)([A-Za-z_][\w.-]{0,64})\1(\s*[:=]\s*)("?)([^"',;&}\s]{1,1024})\4/g,
    // 自由文本里的 k=v 无法判断是在 URL 还是对象里，**从严**按 url 处理
    (whole, quote: string, name: string, mid: string, valueQuote: string) =>
      isSecretKey(name, 'url')
        ? `${quote}${name}${quote}${mid}${valueQuote}${REDACTED}${valueQuote}`
        : whole
  )

  // 6) 通用键值对（**中文键名**）：`口令：xxx` / `密码=x` / `私钥: yyy`
  //
  // 单独成一条规则：SECRET_KEY 里列了「口令 / 密码 / 私钥 / 密钥」，但上面的英文规则
  // 键名字符集是 `[A-Za-z_]`，中文键名一个都匹配不到 —— 词表在自由文本路径上是死代码
  // （对象字段名路径正常，因为那条走 Object.entries）。中文界面/中文日志里这几个词很常见，
  // 所以这里补上，并把全角冒号也认成键值分隔符。
  text = text.replace(
    /([\u4e00-\u9fff]{1,8})(\s*[:：=]\s*)("?)([^"',;&}\s]{1,1024})\3/g,
    (whole, name: string, mid: string, quote: string) =>
      isSecretKey(name, 'url') ? `${name}${mid}${quote}${REDACTED}${quote}` : whole
  )

  // clip 已在入口做过，这里不再重复（重复调用会把已有的 truncated 标记再截一次）
  return text
}

/**
 * 安全读属性：getter 可能抛错。
 *
 * 脱敏要遍历用户/上游的对象，而 ES 允许任意属性装 getter、任意对象被 Proxy 代理 ——
 * 读取本身就是可抛错的操作。日志路径必须假设输入是恶意的，读不到就当没有。
 */
function safeRead<T>(read: () => T): T | undefined {
  try {
    return read()
  } catch {
    return undefined
  }
}

/** 循环引用的判定标记 */
const CIRCULAR = '[Circular]'

/** 对象构造名：Buffer/Uint8Array 等要靠它判断「二进制不展开」 */
function ctorName(value: object): string {
  const name = (value as { constructor?: { name?: string } }).constructor?.name
  return name || 'Object'
}

/**
 * 值脱敏与序列化（返回可直接 JSON.stringify 的结构）。
 *
 * 与 `redactText` 的分工：键名在这里判（有结构信息可用），值里的自由文本交给
 * `redactText` 兜底。二进制一律只记类型+长度 —— 音频/封面字节对排障没有价值，
 * 但会把日志文件撑爆。
 */
export function redactValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value
  const type = typeof value
  if (type === 'string') return redactText(value as string)
  if (type === 'number') {
    const num = value as number
    // NaN/Infinity 走 JSON 会变成 null，这里显式标出来，免得读日志的人误解
    if (Number.isNaN(num)) return '[NaN]'
    if (!Number.isFinite(num)) return num > 0 ? '[Infinity]' : '[-Infinity]'
    return num
  }
  if (type === 'boolean') return value
  if (type === 'bigint') return `${(value as bigint).toString()}n`
  if (type === 'function') return `[Function ${(value as { name?: string }).name || 'anonymous'}]`
  if (type === 'symbol') return String(value)

  const obj = value as object

  if (obj instanceof Error) {
    // 属性一律按「可能抛错的 getter」读：Error 子类与上游 SDK 常重写 message/stack，
    // 而这里紧挨着日志路径，读崩了就丢掉整条记录（过去真实发生过：崩溃处理器在
    // 处理一个 message getter 抛错的 Error 时自己崩掉，进程直接退出、一条日志都没留下）
    const name = safeRead(() => obj.name)
    const message = safeRead(() => obj.message)
    const stack = safeRead(() => obj.stack)
    // code 是 Node 的系统错误码（ENOENT/ECONNREFUSED），排障价值最高，单独保留
    const code = safeRead(() => (obj as unknown as { code?: unknown }).code)
    return {
      name: typeof name === 'string' ? name : 'Error',
      message: typeof message === 'string' ? redactText(message) : '',
      ...(typeof stack === 'string' && stack ? { stack: redactText(stack) } : {}),
      ...(typeof code === 'string' ? { code } : {}),
    }
  }

  if (obj instanceof Date) return redactText(obj.toISOString())

  const name = ctorName(obj)
  if (obj instanceof Uint8Array || /Buffer|ArrayBuffer|Uint8|Int8|Uint16|Int16|Uint32|Int32|Float32|Float64|DataView/.test(name)) {
    const length = obj instanceof Uint8Array ? obj.byteLength : (obj as ArrayBuffer).byteLength
    return `[${name} ${length} bytes]`
  }

  if (obj instanceof Map) {
    const entries = [...obj.entries()].slice(0, MAX_ITEMS)
    return Object.fromEntries(entries.map(([k, v]) => [String(k), redactValue(v, depth + 1, seen)]))
  }
  if (obj instanceof Set) {
    return [...obj.values()].slice(0, MAX_ITEMS).map((item) => redactValue(item, depth + 1, seen))
  }

  if (seen.has(obj)) return CIRCULAR
  if (depth >= MAX_DEPTH) return `[${name}]`
  seen.add(obj)

  if (Array.isArray(obj)) {
    const items = obj.slice(0, MAX_ITEMS).map((item) => redactValue(item, depth + 1, seen))
    if (obj.length > MAX_ITEMS) items.push(`…[${obj.length - MAX_ITEMS} more]`)
    return items
  }

  // Object.entries 在 Proxy 上会触发 ownKeys/getOwnPropertyDescriptor，两者都可能抛错
  const entries = safeRead(() => Object.entries(obj))
  if (!entries) return `[${name}]`

  const out: Record<string, unknown> = {}
  let count = 0
  for (const [key, item] of entries) {
    if (count >= MAX_KEYS) {
      // 用已取到的 entries 算余数：再调一次 Object.keys 会对 Proxy 再触发一次 ownKeys（可能抛）
      out['…'] = `[${entries.length - MAX_KEYS} more keys]`
      break
    }
    count += 1
    // 对象字段名走 'field' 语义：裸 `key` 在这里是 KV 的名字，不是凭据
    // （URL 里的 `?key=` 才按凭据处理，见 isSecretKey 的说明）
    out[key] = isSecretKey(key, 'field') ? REDACTED : redactValue(item, depth + 1, seen)
  }
  return out
}

/** JSON.stringify 的兜底版本：序列化失败（循环、getter 抛错）时退化成 String() */
export function safeStringify(value: unknown): string {
  try {
    const json = JSON.stringify(redactValue(value))
    return json === undefined ? String(value) : json
  } catch {
    try {
      return String(value)
    } catch {
      return '[unserializable]'
    }
  }
}
