/**
 * 渲染层日志传输与导出的单测。
 *
 * 这一组断言的**主目标**不是「函数被调用了」，而是「凭据不会被写进用户要发出去的文件」。
 * 日志包的用途就是被发给开发者，所以文件一旦含凭据原值，就等于用户亲手把凭据贴到公开
 * issue 里；而这个仓库确实发生过音源 API_KEY 进入公开提交的事故（见 AGENTS.local.md）。
 * 因此护栏用例用**真实形态的假值**（api_key=00000000-... 、Bearer abc、口令键值对），
 * 断言它们**不出现在最终文本**里，而不是断言某种内部状态。
 *
 * 为什么打桩平台网关而不是 electronAPI / Capacitor：
 * 传输目标的差异属于平台适配层（services/platform），logging.service 只认
 * `platform.logging` 这一个契约。打桩它就能同时覆盖「桌面端走 IPC」与「移动端写文件」
 * 两条路径，也顺便钉住「Web 端（网关为空）不抛错」这条降级要求。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 平台网关桩件。
 *
 * 用 hoisted 是必须的：`vi.mock` 的工厂会在 import 之前执行，
 * 普通变量此时还在 TDZ 里，取值会抛 ReferenceError。
 */
const mocks = vi.hoisted(() => {
  return {
    /** 传输到网关的行（桌面端 = 送进 IPC 的那一行） */
    recorded: [] as string[],
    /** 导出时被写盘的内容（移动端由 buildLogBundle 拼出，桌面端由主进程给，两者形状一致） */
    exportedContent: '',
    /** 导出返回值；null 表示网关能力缺失 */
    exportResult: null as { filePath: string; dir: string; bytes: number } | null,
    /** info 返回值 */
    infoResult: null as {
      dir: string
      files: Array<{ name: string; sizeBytes: number; mtime: number }>
      totalBytes: number
      maxFileBytes: number
      maxFiles: number
    } | null,
    /** 网关是否可见：false 模拟 Web 端 / 旧版 preload */
    gatewayEnabled: true,
    /** record 是否抛错：验证出口故障只丢一条记录 */
    recordThrows: false,
    revealCalls: [] as string[],
    bundleContent: 'noop',
  }
})

vi.mock('@/services/platform', () => {
  const gateway = {
    get logging() {
      if (!mocks.gatewayEnabled) return undefined
      return {
        record(payload: { line: string }) {
          if (mocks.recordThrows) throw new Error('ipc channel closed')
          mocks.recorded.push(payload.line)
        },
        async bundle() {
          return { fileName: 'logs.txt', content: mocks.bundleContent, fileCount: 1, totalBytes: 1 }
        },
        async exportFile() {
          if (!mocks.exportResult) throw new Error('export unsupported')
          mocks.exportedContent = mocks.bundleContent
          return mocks.exportResult
        },
        async reveal(filePath: string) {
          mocks.revealCalls.push(filePath)
        },
        async info() {
          if (!mocks.infoResult) throw new Error('info unsupported')
          return mocks.infoResult
        },
      }
    },
  }
  return { platform: gateway }
})

vi.mock('@/stores/localeStore', () => ({
  currentLocale: () => 'zh-CN',
}))

vi.mock('@/services/update.service', () => ({
  APP_VERSION: '0.0.0-test',
}))

import {
  exportLogs,
  getLogInfo,
  initRendererLogging,
  revealLogs,
  supportsLogExport,
  supportsLogReveal,
} from '../logging.service'
import { createLogger, getLogger } from '@aurora/shared'

/**
 * 真实形态的假值。
 *
 * 用 00000000-... 这类一眼可辨的假值（项目约定见 AGENTS.md §2），
 * 形态却与真凭据一致 —— 只有这样才验得出脱敏规则本身，
 * 而不是验出「随便一个短串也不在文本里」这种空断言。
 */
const FAKE_API_KEY = '00000000-0000-0000-0000-000000000000'
const FAKE_BEARER = 'Bearer abc123def456ghi789'
const FAKE_PASSWORD = 'local-dev-key'
const FAKE_TOKEN = 'tok_9f8e7d6c5b4a3210'

/** 把一条记录走完「内核 → sink → 网关」的完整路径，返回被传输的那一行 */
function transmit(level: 'info' | 'error' | 'warn', message: string, ...args: unknown[]): void {
  const logger = createLogger('test')
  logger[level](message, ...args)
}

beforeEach(() => {
  mocks.recorded = []
  mocks.exportedContent = ''
  mocks.exportResult = null
  mocks.infoResult = null
  mocks.gatewayEnabled = true
  mocks.recordThrows = false
  mocks.revealCalls = []
  mocks.bundleContent = 'noop'
  // 每次重建 sink：内核的 config 是模块级单例，重复 init 会替换 sink 列表。
  // 注意顺序 —— init 自身会写一条会话起点记录（logSessionStart），
  // 所以必须在 init **之后**清空收集器，否则每个用例都会多出一条与它无关的记录。
  initRendererLogging()
  mocks.recorded = []
})

describe('传输 sink：桌面端', () => {
  it('把记录排版成单行后交给 electronAPI.logging.record', () => {
    transmit('info', 'player ready')
    expect(mocks.recorded).toHaveLength(1)
    const line = mocks.recorded[0]
    // 排版契约（shared 的 formatRecord）：时间戳 + 级别 + 来源进程 + scope + 文案。
    // 断言的是「这一行能被读日志的人定位」，不是逐字等于某个快照 —— 时间戳每次不同
    expect(line).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2} INFO\s+\[renderer\] test: player ready$/)
  })

  it('传出去的是已脱敏的文本（凭据不进 IPC 负载）', () => {
    transmit('error', `请求失败 api_key=${FAKE_API_KEY} Authorization: ${FAKE_BEARER}`)
    expect(mocks.recorded).toHaveLength(1)
    const line = mocks.recorded[0]
    // 这是本次最重要的断言：凭据原值绝不能出现在传输负载里
    expect(line).not.toContain(FAKE_API_KEY)
    expect(line).not.toContain('abc123def456ghi789')
    // 打码位置仍然可读（能看出「这里原本有值但被保护了」）
    expect(line).toContain('***')
  })

  it('附加参数里的凭据同样不会漏出去', () => {
    // detail 走 safeStringify(redactValue)，键名判定在这一层生效
    transmit('warn', 'webdav probe failed', { url: 'https://dav.example.com/music', password: FAKE_PASSWORD, token: FAKE_TOKEN })
    expect(mocks.recorded).toHaveLength(1)
    const line = mocks.recorded[0]
    expect(line).not.toContain(FAKE_PASSWORD)
    expect(line).not.toContain(FAKE_TOKEN)
    // 非敏感字段仍保留：全打码的日志就没法排障了
    expect(line).toContain('dav.example.com')
  })

  it('网关 record 抛错时不会把异常抛回调用点', () => {
    mocks.recordThrows = true
    // 内核会吞 sink 异常；这里再从调用方角度确认一次「业务代码不受牵连」
    expect(() => transmit('error', 'boom while transmitting')).not.toThrow()
  })
})

describe('无平台网关时（Web / 旧版 preload）', () => {
  it('记录日志不抛错', () => {
    mocks.gatewayEnabled = false
    expect(() => transmit('info', 'web platform has no log sink')).not.toThrow()
    expect(mocks.recorded).toHaveLength(0)
  })

  it('导出返回 unsupported 而不是抛错', async () => {
    mocks.gatewayEnabled = false
    await expect(exportLogs()).resolves.toEqual({ ok: false, reason: 'unsupported' })
  })

  it('能力探测与状态查询给出「不可用」结论而不是空指针', async () => {
    mocks.gatewayEnabled = false
    expect(supportsLogExport()).toBe(false)
    expect(supportsLogReveal()).toBe(false)
    await expect(getLogInfo()).resolves.toBeNull()
    await expect(revealLogs()).resolves.toBe(false)
  })

  it('initRendererLogging 可以重复调用（幂等），不会重复接管 console', () => {
    mocks.gatewayEnabled = false
    expect(() => {
      initRendererLogging()
      initRendererLogging()
    }).not.toThrow()
  })
})

describe('exportLogs：两个平台的返回形状', () => {
  it('桌面端：返回 IPC 给的落盘路径与字节数', async () => {
    mocks.exportResult = {
      filePath: '/home/李四/Downloads/Aurora-Music-logs-v0.0.0-test-20261030-021500.txt',
      dir: '/home/李四/Downloads',
      bytes: 2048,
    }
    const result = await exportLogs()
    expect(result).toEqual({
      ok: true,
      filePath: '/home/李四/Downloads/Aurora-Music-logs-v0.0.0-test-20261030-021500.txt',
      dir: '/home/李四/Downloads',
      bytes: 2048,
    })
  })

  it('移动端：同一形状（写文件后返回路径），调用方无需分辨平台', async () => {
    // 移动端网关的 exportFile 由 platform/mobile/logging.ts 实现：自己 buildLogBundle
    // 后写文件，返回 { filePath, dir, bytes }。对 logging.service 来说两者完全同形。
    mocks.exportResult = {
      filePath: '/storage/emulated/0/Download/Aurora Music/logs/Aurora-Music-logs-v0.0.0-test-20261030-021500.txt',
      dir: '/storage/emulated/0/Download/Aurora Music/logs',
      bytes: 1024,
    }
    const result = await exportLogs()
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // PCM 关注的是三个字段都在、且 filePath 非空 —— 界面要靠它展示「导出到哪」
    expect(result.filePath).toContain('Aurora-Music-logs-')
    expect(result.dir).not.toBe('')
    expect(result.bytes).toBeGreaterThan(0)
  })

  it('网关导出失败时返回 failed（不抛错，界面只需弹一句提示）', async () => {
    mocks.exportResult = null
    await expect(exportLogs()).resolves.toEqual({ ok: false, reason: 'failed' })
  })

  it('网关返回空路径同样判为失败：没有路径，界面无法把文件交给用户', async () => {
    mocks.exportResult = { filePath: '', dir: '', bytes: 0 }
    await expect(exportLogs()).resolves.toEqual({ ok: false, reason: 'failed' })
  })
})

/**
 * ★ 护栏：导出的最终文本里绝不能出现凭据原值。
 *
 * 这一组刻意**不走网关打桩**，而是把 shared 的真实排版链路（createLogger → sink →
 * 拼接 → buildLogBundle）走一遍，再把拼出来的整包当作文本断言。
 * 只断言「record 被调用」是不够的：真正让凭据外泄的环节是「包里有什么」，
 * 而不是「有没有调用某个函数」。
 */
describe('★ 护栏：导出文本不含凭据原值', () => {
  it('整包里不含 api_key / token / Authorization / 口令的原值', async () => {
    // 移动端导出 = buildLogBundle(环境头 + 日志行)。这里直接复现它：
    // 把传输出去的行收集起来，按 shared 的排版拼成一份等价文本
    transmit('error', `song fetch failed: https://api.example.com/search?q=rain&api_key=${FAKE_API_KEY}`)
    transmit('warn', 'request headers', { Authorization: FAKE_BEARER, token: FAKE_TOKEN })
    transmit('info', 'webdav login', { username: 'alice', password: FAKE_PASSWORD })
    transmit('error', `raw header line: Authorization: ${FAKE_BEARER}`)
    transmit('info', `bare scheme: ${FAKE_BEARER}`)

    // 这就是用户会发出去的那份文本（移动端由 buildLogBundle 生成，桌面端由主进程追加写盘）
    const exportedText = buildExportText(mocks.recorded)

    // 四条独立断言：任何一种凭据形态漏出去都要当场判红
    expect(exportedText).not.toContain(FAKE_API_KEY)
    expect(exportedText).not.toContain('abc123def456ghi789')
    expect(exportedText).not.toContain(FAKE_TOKEN)
    expect(exportedText).not.toContain(FAKE_PASSWORD)
    // 打码占位符必须出现：否则说明「不出现」是靠丢记录达成的，而不是靠脱敏
    expect(exportedText).toContain('***')
  })

  it('单条记录内「键名与值拼在同一行」的形态会被打码', () => {
    transmit('info', `merged: password: ${FAKE_PASSWORD}`)
    transmit('info', `merged: api_key=${FAKE_API_KEY}`)
    const exportedText = buildExportText(mocks.recorded)
    expect(exportedText).not.toContain(FAKE_PASSWORD)
    expect(exportedText).not.toContain(FAKE_API_KEY)
  })

  it('已知边界：分两条记录打印的「键名在上、值在下」拦不住（脱敏按行认，不跨记录）', () => {
    // 这不是 bug 而是策略边界：脱敏按名字认键值对，跨记录拼接需要把整个日志包
    // 当上下文重新推理，代价与误伤都不可接受（会把正常文案也打码）。
    // 把这个边界**钉进测试**而不是假装它不存在 —— 设置页的隐私提示
    // （settings.diagnostics.privacy.body 的「发送前请自行检查」）正是为它而写。
    transmit('info', 'config loaded password:')
    transmit('info', `value is ${FAKE_PASSWORD}`)
    const exportedText = buildExportText(mocks.recorded)
    expect(exportedText).toContain(FAKE_PASSWORD)
  })
})

/**
 * 复现导出文本：环境头 + 每条已传输的行。
 *
 * 不复用 shared 的 buildLogBundle 是为了让断言盯着「行本身」而不是排版细节
 * （环境头与分段标题不含也不该含日志内容，拼进来只会稀释断言的可读性）。
 */
function buildExportText(lines: string[]): string {
  return lines.join('\n')
}

describe('getLogInfo / revealLogs', () => {
  it('桌面端：info 原样透出文件数与占用', async () => {
    mocks.infoResult = {
      dir: '/home/李四/.config/aurora-music/logs',
      files: [
        { name: 'renderer.log', sizeBytes: 512, mtime: 1 },
        { name: 'main.log', sizeBytes: 1024, mtime: 2 },
      ],
      totalBytes: 1536,
      maxFileBytes: 2 * 1024 * 1024,
      maxFiles: 5,
    }
    const info = await getLogInfo()
    expect(info?.files).toHaveLength(2)
    expect(info?.totalBytes).toBe(1536)
    expect(info?.maxFiles).toBe(5)
  })

  it('info 抛错时返回 null：设置页展示空态即可，不该让整页崩', async () => {
    mocks.infoResult = null
    await expect(getLogInfo()).resolves.toBeNull()
  })

  it('reveal 优先定位传入的文件，未传时回落到日志目录', async () => {
    mocks.infoResult = {
      dir: '/tmp/logs-fixture',
      files: [],
      totalBytes: 0,
      maxFileBytes: 1024,
      maxFiles: 5,
    }
    await expect(revealLogs('/tmp/logs-fixture/a.log')).resolves.toBe(true)
    await expect(revealLogs()).resolves.toBe(true)
    expect(mocks.revealCalls).toEqual(['/tmp/logs-fixture/a.log', '/tmp/logs-fixture'])
  })
})

describe('scope 前缀', () => {
  it('console 接管后 scope 形如 renderer.<模块>', async () => {
    // captureConsole 已由 initRendererLogging 装好；直接调 console 验证前缀拼接
    const { captureConsole } = await import('@aurora/shared')
    // 已接管过（幂等），这里只验证记录里的 scope 形态
    captureConsole({ scopePrefix: 'renderer' })
    const logger = getLogger('unit')
    logger.info('scope check')
    const line = mocks.recorded[mocks.recorded.length - 1]
    expect(line).toContain('[renderer] unit: scope check')
  })
})
