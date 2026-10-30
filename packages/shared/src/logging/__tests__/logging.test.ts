/**
 * 日志内核单测：脱敏、级别过滤、投递韧性、排版。
 *
 * 这些断言守的是「日志包能不能安全地发给开发者」这条底线 ——
 * 脱敏一旦回退，凭据就会随用户发来的文件外泄，而这种事在真实日志里
 * 往往只出现一次（用户只发一次），没有第二次机会。
 */

import { describe, expect, it, vi } from 'vitest'
import { REDACTED, isSecretKey, redactText, redactValue, safeStringify } from '../redact'
import { formatRecord, formatTimestamp } from '../format'
import { addLogSink, createLogger, getLogger, initLogging, isLoggingReady, setLogLevel } from '../logger'
import { formatConsoleArgs, splitScopePrefix } from '../capture'
import { buildLogBundle, formatEnvironment, logBundleFileName } from '../bundle'
import type { LogRecord } from '../types'

/** 收集 sink：把记录攒进数组，断言时不必开文件 */
function collector(): { records: LogRecord[]; sink: (record: LogRecord) => void } {
  const records: LogRecord[] = []
  return { records, sink: (record) => records.push(record) }
}

describe('redactText', () => {
  it('打码 URL query 里的敏感参数，保留非敏感参数', () => {
    const out = redactText('请求 https://api.example.com/search?q=晴天&api_key=abcdef123&limit=10 失败')
    expect(out).not.toContain('abcdef123')
    expect(out).toContain('q=晴天')
    expect(out).toContain('limit=10')
    expect(out).toContain(`api_key=${REDACTED}`)
  })

  it('打码 URL userinfo（WebDAV 口令常见形态）', () => {
    const out = redactText('dav https://alice:s3cret@dav.example.com/music 连接失败')
    expect(out).not.toContain('s3cret')
    expect(out).toContain('dav.example.com')
  })

  it('打码键值对形态的凭据（含引号变体）', () => {
    expect(redactText('api_key=abc123')).toBe(`api_key=${REDACTED}`)
    expect(redactText('"token": "xyz789"')).not.toContain('xyz789')
    expect(redactText('Password: hunter2')).not.toContain('hunter2')
  })

  it('打码认证头值', () => {
    expect(redactText('Authorization: Bearer abc.def.ghi')).not.toContain('abc.def.ghi')
    expect(redactText('Basic dXNlcjpwYXNz')).not.toContain('dXNlcjpwYXNz')
  })

  /**
   * 裸 `key` 的**位置语义**：URL / k=v 里是凭据，对象字段名里不是。
   *
   * 这条曾经是真实阻塞缺陷：`SAFE_KEY` 为「对象字段 `key` 不是凭据」而把裸 key
   * 列进豁免，但它同时作用于 URL query 参数名判定 —— 结果 `?key=<凭据>` 完全不打码。
   * 而 `key=` 恰恰是本项目音源服务的凭据参数名（auroraPreset.ts 的 7 条回落模板全是
   * `&key=<API_KEY>`），仓库还发生过这个 key 进入公开提交的事故。
   */
  it('URL 里的裸 key= 必须打码（本项目音源服务的凭据参数名）', () => {
    expect(redactText('https://api.example.com/aurora?query=x&key=ABC123')).not.toContain('ABC123')
    expect(redactText('https://api.example.com/aurora?query=x&key=ABC123')).toContain(`key=${REDACTED}`)
    // 对照：api_key 一直都是好的，别在修 key 时把它弄坏
    expect(redactText('https://x?api_key=ABC123')).not.toContain('ABC123')
  })

  it('对象字段名里的裸 key 不被打码（KV 结构的名字，不是凭据）', () => {
    const out = redactValue({ key: 'primary', apiKey: 'secret-value' }) as Record<string, unknown>
    expect(out.key).toBe('primary')
    expect(out.apiKey).toBe(REDACTED)
  })

  it('isSecretKey 按位置区分裸 key', () => {
    expect(isSecretKey('key', 'url')).toBe(true)
    expect(isSecretKey('key', 'field')).toBe(false)
    // 不传 context 时从严（默认按 URL 语义）
    expect(isSecretKey('key')).toBe(true)
    expect(isSecretKey('keys', 'url')).toBe(false)
  })

  it('中文键名在自由文本里也打码（不只是对象字段）', () => {
    expect(redactText('口令：hunter2')).not.toContain('hunter2')
    expect(redactText('密码=abc999')).not.toContain('abc999')
    expect(redactText('私钥: someKeyMaterial')).not.toContain('someKeyMaterial')
    // 非凭据的中文键值不受影响
    expect(redactText('标题：晴天')).toBe('标题：晴天')
  })

  /**
   * 头部规则的 JSON 结构保全（独立验证 B-5）。
   *
   * 打码只该换「值」，不该把 JSON 改成非法结构 —— 否则读日志的人会以为应用吐出了
   * 畸形数据，把排查方向带偏。同时这条规则**必须允许值里有空格**：
   * `Authorization: Bearer abc` 的凭据在空格之后，排除空格会让令牌原样留下
   * （我在修 B-5 时当场又踩了一次这个坑，所以两条断言必须同时存在）。
   */
  it('头部规则的 JSON 引号保结构，且不因空格漏掉令牌', () => {
    expect(redactText('{"Authorization":"Bearer abc123"}')).toBe('{"Authorization":"***"}')
    expect(redactText('{"Cookie":"sid=abc"}')).toBe('{"Cookie":"***"}')
    // 空格形态：令牌必须被吃掉（回归护栏，防「排除空格」重现）
    expect(redactText('Authorization: Bearer abc.def')).toBe('Authorization: ***')
    expect(redactText('Cookie: sid=abc; x=y')).toBe('Cookie: ***; x=y')
  })

  it('常见短凭据名一律打码（auth / pass / jwt / sig / sessionid / privateKey）', () => {
    for (const name of ['auth', 'pass', 'passwd', 'jwt', 'sig', 'signature', 'sessionid', 'privateKey', 'access_key', 'client_secret']) {
      const out = redactText(`${name}=VALUE_${name}`)
      expect(out, `${name} 应被打码`).toBe(`${name}=${REDACTED}`)
    }
  })

  it('短凭据规则不误伤普通英文词（整词匹配而非子串）', () => {
    for (const token of ['author=张三', 'passing=90%', 'signal=weak', 'passenger=3']) {
      expect(redactText(token)).toBe(token)
    }
  })

  it('userinfo 口令里含 / 也要打码', () => {
    // 独立验证指出的缺口：字符集不含 `/` 时规则在分隔符处断掉，口令原样留下
    const out = redactText('fetch https://alice:p/w0rd@dav.example.com/music failed')
    expect(out).not.toContain('p/w0rd')
    expect(out).toContain(REDACTED)
    expect(out).toContain('dav.example.com')
  })

  it('打码只换值，不改结构（保留 JSON 引号）', () => {
    expect(redactText('{"token":"abc123"}')).toBe(`{"token":"${REDACTED}"}`)
    expect(redactText('token="abc123"')).toBe(`token="${REDACTED}"`)
  })

  it('不误伤曲目 ID、文件路径与普通文案', () => {
    const text = '播放 /home/user/Music/周杰伦 - 晴天.flac 失败，trackId=abc-123'
    expect(redactText(text)).toBe(text)
  })

  it('超长字符串截断并标注原长', () => {
    const out = redactText('x'.repeat(6000))
    expect(out.length).toBeLessThan(6000)
    expect(out).toContain('truncated')
  })

  /**
   * 性能回归护栏。
   *
   * 这几条规则的量词是贪婪的，曾经在「整行没有分隔符」的输入上退化成平方级回溯：
   * 实测 4K 字符 94ms、16K 字符 1.5s。渲染层单条记录可达几十 KB，
   * 一条这样的日志就能卡住主进程，播放与全部 IPC 一起停。
   *
   * 修复是「先 clip 再跑正则 + 量词有界」。这里用宽松的绝对上限（每个 200ms）而不是
   * 精确耗时：不同机器差异大，测的是**增长形态**而非某个常数。
   */
  it('无分隔超长输入不退化成平方级回溯', () => {
    for (const length of [16384, 65536, 262144]) {
      const started = Date.now()
      redactText('a'.repeat(length))
      expect(Date.now() - started).toBeLessThan(200)
    }
    // base64 形态：既长又没有可锚定的分隔符，同样走有界量词
    const base64 = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5'.repeat(4000)
    const started = Date.now()
    redactText(base64)
    expect(Date.now() - started).toBeLessThan(200)
  })

  it('裁剪不放松脱敏：超长输入里的凭据仍被打码', () => {
    // 凭据通常在行首附近，裁剪不会先把它丢掉；这里同时验证「裁剪后仍打码」
    const input = `api_key=00000000-0000-0000-0000-000000000000 ${'x'.repeat(8000)}`
    const out = redactText(input)
    expect(out).not.toContain('00000000-0000-0000-0000-000000000000')
    expect(out).toContain(REDACTED)
  })

  it('isSecretKey 认变体、放过白名单', () => {
    expect(isSecretKey('apiKey')).toBe(true)
    expect(isSecretKey('X-Auth-Token')).toBe(true)
    expect(isSecretKey('MASK_SECRET')).toBe(true)
    expect(isSecretKey('secretName')).toBe(false)
    expect(isSecretKey('title')).toBe(false)
    // 裸 `key` 的结论取决于位置语义，见「URL 里的裸 key=」一组的用例：
    // 曾经的断言写成 `toBe(false)`，把「?key= 不打码」这个缺陷固化成期望值了
    expect(isSecretKey('key', 'field')).toBe(false)
    expect(isSecretKey('key', 'url')).toBe(true)
  })
})

describe('redactValue', () => {
  it('按键名整值打码', () => {
    const out = redactValue({ name: '源 A', apiKey: 'abcdef', headers: { Authorization: 'Bearer zzz' } }) as Record<string, any>
    expect(out.name).toBe('源 A')
    expect(out.apiKey).toBe(REDACTED)
    expect(out.headers.Authorization).toBe(REDACTED)
  })

  it('Error 保留 name/message/code 与堆栈', () => {
    const error = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3201'), { code: 'ECONNREFUSED' })
    const out = redactValue(error) as Record<string, unknown>
    expect(out.name).toBe('Error')
    expect(out.message).toContain('ECONNREFUSED')
    expect(out.code).toBe('ECONNREFUSED')
    expect(String(out.stack)).toContain('Error')
  })

  it('二进制只记类型与长度（不把音频字节写进日志）', () => {
    expect(redactValue(new Uint8Array(1024))).toBe('[Uint8Array 1024 bytes]')
    expect(redactValue(Buffer.from('hello'))).toBe('[Buffer 5 bytes]')
  })

  it('循环引用不抛错', () => {
    const node: Record<string, unknown> = { name: 'root' }
    node.self = node
    expect(() => safeStringify(node)).not.toThrow()
    expect(safeStringify(node)).toContain('Circular')
  })

  it('深层结构按深度截断', () => {
    const deep = { a: { b: { c: { d: { e: { f: 1 } } } } } }
    const out = safeStringify(deep)
    expect(out.length).toBeLessThan(200)
  })

  it('NaN / Infinity 显式标注，不静默变 null', () => {
    expect(safeStringify(Number.NaN)).toBe('"[NaN]"')
    expect(safeStringify(Number.POSITIVE_INFINITY)).toBe('"[Infinity]"')
  })

  it('toString 抛错的对象不使序列化崩溃', () => {
    const evil = { get boom() { throw new Error('getter exploded') } }
    expect(() => safeStringify(evil)).not.toThrow()
  })
})

describe('formatTimestamp', () => {
  it('输出带时区偏移的 ISO 8601', () => {
    const out = formatTimestamp(new Date(2026, 9, 30, 2, 15, 11, 123).getTime())
    expect(out).toMatch(/^2026-10-30T02:15:11\.123[+-]\d{2}:\d{2}$/)
  })

  it('非法时间戳回退到纪元而不是抛错', () => {
    expect(formatTimestamp(Number.NaN)).toBe('1970-01-01T00:00:00.000+00:00')
  })
})

describe('logger', () => {
  it('未初始化时静默丢弃（不做脱敏开销）', () => {
    initLogging({ sinks: [], level: 'trace' })
    expect(isLoggingReady()).toBe(false)
    expect(() => getLogger('x').info('hello')).not.toThrow()
  })

  it('按门槛过滤低级别', () => {
    const { records, sink } = collector()
    initLogging({ sinks: [sink], level: 'warn' })
    const logger = createLogger('test')
    logger.debug('debug 不进')
    logger.warn('warn 进')
    logger.error('error 进')
    expect(records.map((r) => r.message)).toEqual(['warn 进', 'error 进'])
  })

  it('记录在创建时即脱敏', () => {
    const { records, sink } = collector()
    initLogging({ sinks: [sink], level: 'trace' })
    createLogger('net').info('fetch https://api.example.com/x?token=deadbeef failed')
    expect(records[0].message).not.toContain('deadbeef')
    expect(records[0].detail ?? '').not.toContain('deadbeef')
  })

  it('附加参数进 detail，Error 堆栈单独存放', () => {
    const { records, sink } = collector()
    initLogging({ sinks: [sink], level: 'trace' })
    createLogger('db').error('打开失败', new Error('SQLITE_CANTOPEN'), { path: '/data/db.sqlite' })
    expect(records[0].stack).toContain('SQLITE_CANTOPEN')
    expect(records[0].detail).toContain('/data/db.sqlite')
  })

  it('sink 抛错被吞掉，且其它 sink 仍收到记录', () => {
    const { records, sink } = collector()
    initLogging({ sinks: [() => { throw new Error('sink boom') }, sink], level: 'info' })
    expect(() => createLogger('x').info('still delivered')).not.toThrow()
    expect(records).toHaveLength(1)
  })

  it('child 拼出层级 scope', () => {
    const { records, sink } = collector()
    initLogging({ sinks: [sink], level: 'info' })
    createLogger('updater').child('download').info('msg')
    expect(records[0].scope).toBe('updater.download')
  })

  it('非字符串消息不被压成 [object Object]', () => {
    const { records, sink } = collector()
    initLogging({ sinks: [sink], level: 'info' })
    createLogger('x').info({ a: 1 } as unknown as string)
    expect(records[0].detail).toContain('"a":1')
  })

  /**
   * 畸形输入韧性：**日志系统自己绝不能成为崩溃源**。
   *
   * 真实事故（独立 verifier 报 exit code 7 后复现）：`installErrorCapture` 会把
   * 任何未捕获异常喂进来，当那个异常是「message/stack getter 抛错的 Error」时，
   * 记录构造阶段自己抛错 —— 崩溃处理器在崩溃处理中崩溃，进程直接退出，
   * 用户一条日志都拿不到。而这恰恰是日志系统最不该失败的时刻。
   */
  it('Error 的 message/stack getter 抛错时仍能记录，不向外抛', () => {
    const { records, sink } = collector()
    initLogging({ sinks: [sink], level: 'trace' })
    const evil = new Error('placeholder')
    Object.defineProperty(evil, 'message', { get() { throw new Error('getter boom') } })
    Object.defineProperty(evil, 'stack', { get() { throw new Error('getter boom') } })

    expect(() => createLogger('crash').fatal('uncaughtException', evil)).not.toThrow()
    // 记录仍然成立（降级为空的 message/stack 可以接受，丢一条才不可接受）
    expect(records).toHaveLength(1)
    expect(records[0].level).toBe('fatal')
  })

  it('Proxy 在 ownKeys / getOwnPropertyDescriptor 上抛错时不向外抛', () => {
    const { records, sink } = collector()
    initLogging({ sinks: [sink], level: 'trace' })
    const ownKeysEvil = new Proxy({}, { ownKeys() { throw new Error('ownKeys boom') } })
    const gopdEvil = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('gopd boom') } })

    expect(() => createLogger('x').info('proxy', ownKeysEvil, gopdEvil)).not.toThrow()
    expect(records).toHaveLength(1)
  })

  it('message 为 Symbol 等怪异值时仍能记录', () => {
    const { records, sink } = collector()
    initLogging({ sinks: [sink], level: 'trace' })
    expect(() => createLogger('x').info(Symbol('s'))).not.toThrow()
    expect(records).toHaveLength(1)
  })

  it('redactValue 面对抛错的 getter 返回可序列化结果而不抛', () => {
    const evil = new Error('x')
    Object.defineProperty(evil, 'message', { get() { throw new Error('boom') } })
    expect(() => redactValue(evil)).not.toThrow()
    expect(() => safeStringify(evil)).not.toThrow()
    // 普通对象上抛错的 getter 同样兜住
    const obj = { get bad() { throw new Error('boom') }, ok: 1 }
    expect(() => safeStringify(obj)).not.toThrow()
  })

  it('addLogSink 追加而不替换', () => {
    const first = collector()
    const second = collector()
    initLogging({ sinks: [first.sink], level: 'info' })
    addLogSink(second.sink)
    createLogger('x').info('both')
    expect(first.records).toHaveLength(1)
    expect(second.records).toHaveLength(1)
  })

  it('setLogLevel 生效于后续记录', () => {
    const { records, sink } = collector()
    initLogging({ sinks: [sink], level: 'error' })
    setLogLevel('debug')
    createLogger('x').debug('now visible')
    expect(records).toHaveLength(1)
  })
})

describe('formatRecord', () => {
  it('单行记录含时间/级别/来源/scope/文案', () => {
    const line = formatRecord({
      ts: new Date(2026, 9, 30, 2, 15, 11, 123).getTime(),
      level: 'warn',
      origin: 'renderer',
      scope: 'player',
      message: '取址失败',
    })
    expect(line).toContain('2026-10-30T02:15:11.123')
    expect(line).toContain('WARN')
    expect(line).toContain('[renderer]')
    expect(line).toContain('player: 取址失败')
    expect(line).not.toContain('\n')
  })

  it('堆栈缩进两格，不破坏「一条一行」的定位', () => {
    const line = formatRecord({
      ts: 0,
      level: 'error',
      origin: 'main',
      scope: 'crash',
      message: 'boom',
      stack: 'Error: boom\n    at foo (a.js:1:1)',
    })
    const lines = line.split('\n')
    expect(lines[0]).toContain('boom')
    expect(lines[1].startsWith('  ')).toBe(true)
  })
})

describe('captureConsole helpers', () => {
  it('从 [Foo] 前缀取 scope 并剥离', () => {
    expect(splitScopePrefix('[Updater] 下载失败')).toEqual({ scope: 'Updater', rest: '下载失败' })
    expect(splitScopePrefix('没有前缀')).toEqual({ scope: '', rest: '没有前缀' })
  })

  it('处理 %s/%d 格式串', () => {
    expect(formatConsoleArgs(['值 %s 与 %d', 'a', 3.7])).toEqual({ message: '值 a 与 3', rest: [] })
  })

  it('%o 结构化参数进 detail，消息只留占位', () => {
    const out = formatConsoleArgs(['状态 %o', { a: 1 }])
    expect(out.message).toBe('状态 [object]')
    expect(out.rest).toEqual([{ a: 1 }])
  })

  it('占位符多于实参时原样保留', () => {
    expect(formatConsoleArgs(['值 %s']).message).toBe('值 %s')
  })

  it('%c 样式参数被丢弃', () => {
    expect(formatConsoleArgs(['文案 %c', 'color:red'])).toEqual({ message: '文案 ', rest: [] })
  })

  it('无格式串时保留全部参数', () => {
    expect(formatConsoleArgs(['文案', { a: 1 }])).toEqual({ message: '文案', rest: [{ a: 1 }] })
  })
})

describe('bundle', () => {
  const env = {
    appVersion: '0.7.3',
    origin: 'main',
    platform: 'linux',
    arch: 'x64',
    exportedAt: new Date(2026, 9, 30, 2, 0, 0).getTime(),
  }

  // 排版层一律英文：读者是开发者，而中文字面量会被 check-i18n 门禁判红（界面文案必须走字典）
  it('环境头含版本与脱敏提示，缺失值写成短横线', () => {
    const text = formatEnvironment(env)
    expect(text).toContain('0.7.3')
    expect(text).toContain('redacted')
    expect(text).toMatch(/Distro\s+:\s+-/)
    expect(text).toContain('Exported at')
  })

  it('文件按 mtime 升序拼装（旧在前、新在后）', () => {
    const text = buildLogBundle(env, [
      { name: 'new.log', mtime: 200, content: '新记录\n' },
      { name: 'old.log', mtime: 100, content: '旧记录\n' },
    ])
    expect(text.indexOf('旧记录')).toBeLessThan(text.indexOf('新记录'))
  })

  it('无文件时给出可读说明而不是空包', () => {
    expect(buildLogBundle(env, [])).toContain('no log files')
  })

  it('文件内容末尾缺换行时补齐，避免与下一段粘行', () => {
    const text = buildLogBundle(env, [{ name: 'a.log', mtime: 1, content: 'no trailing newline' }])
    expect(text).toContain('no trailing newline\n')
  })

  it('导出文件名带版本与时间戳且不含冒号（Windows 兼容）', () => {
    const name = logBundleFileName('0.7.3', new Date(2026, 9, 30, 2, 15, 11).getTime())
    expect(name).toBe('Aurora-Music-logs-v0.7.3-20261030-021511.txt')
    expect(name).not.toContain(':')
  })
})
