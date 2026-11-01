import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import {
  parseRangeHeader,
  setSsh2Module,
  sftpConnectionOf,
  sftpRemotePathOf,
  sftpStoragePlugin,
  ssh2Available,
  type Ssh2FileEntry,
  type Ssh2Module,
} from '../sftpStoragePlugin'
import { parseSmbRangeHeader, setSmb2Module, smb2Available, smbPathOf, smbStoragePlugin } from '../smbStoragePlugin'
import { storageCapabilitiesOf } from '../types'
import type { LibrarySourceConfig } from '../../../webdav'

/**
 * SFTP / SMB 存储插件的测试。
 *
 * ## 只测能测的部分（如实说明）
 *
 * 真实的 SFTP/SMB 连接需要一台 NAS，**单测里做不到**。这里覆盖的是：
 * - 依赖**未注入**时的降级（`probe` 给可读原因而不是抛看不懂的模块错误）
 * - 配置到连接参数的映射（字段读取、默认端口、路径拼接）
 * - Range 头解析（三种形态；这是 seek 正确性的前提）
 * - 能力清单派生
 *
 * **不覆盖**：真实握手、目录遍历、读流。那些需要集成环境，
 * 属于 `docs/development.md` 里"需要真实运行时"的那类验证。
 */

const cfg = (settings: Record<string, string> = {}): LibrarySourceConfig =>
  ({
    id: 'src-1',
    name: 'Test Storage',
    kind: 'sftp',
    pluginId: 'sftp',
    enabled: true,
    settings,
  }) as unknown as LibrarySourceConfig

afterEach(() => {
  setSsh2Module(null)
  setSmb2Module(null)
})

describe('依赖注入：未注入时优雅降级', () => {
  it('未注入 ssh2 时 ssh2Available 为 false', () => {
    expect(ssh2Available()).toBe(false)
  })

  it('未注入时 probe 返回 false + 可读码（不是一个看不懂的模块错误）', async () => {
    const result = await sftpStoragePlugin.probe!(cfg({ host: 'nas.example.com' }))
    expect(result.ok).toBe(false)
    expect(result.message).toBe('SFTP_UNAVAILABLE')
  })

  it('未注入 smb2 时 smb2Available 为 false', () => {
    expect(smb2Available()).toBe(false)
  })

  it('未注入时 SMB probe 同样给可读码', async () => {
    const result = await smbStoragePlugin.probe!(cfg({ host: 'nas', share: 'music' }))
    expect(result.ok).toBe(false)
    expect(result.message).toBe('SMB_UNAVAILABLE')
  })

  it('注入后 available 变 true', () => {
    setSsh2Module({ Client: function Client() {} } as unknown as Ssh2Module)
    expect(ssh2Available()).toBe(true)
  })
})

describe('能力清单：由方法存在性派生', () => {
  it('SFTP 有 listAudio + openStream + probe，没有 openRange', () => {
    const caps = storageCapabilitiesOf(sftpStoragePlugin)
    expect(caps.sort()).toEqual(['listAudio', 'openStream', 'probe'].sort())
    // 只实现 openStream 是有意的：它的语义更完整（能处理 bytes=-N 尾段）
    expect(sftpStoragePlugin.openRange).toBeUndefined()
  })

  it('SMB 三种能力齐全（readFile 本身带 offset/length，能精确实现区间）', () => {
    const caps = storageCapabilitiesOf(smbStoragePlugin)
    expect(caps.sort()).toEqual(['listAudio', 'openRange', 'openStream', 'probe'].sort())
  })
})

describe('SFTP 配置映射', () => {
  it('默认端口 22', () => {
    expect(sftpConnectionOf(cfg({ host: 'nas.local' })).port).toBe(22)
  })

  it('自定义端口生效', () => {
    expect(sftpConnectionOf(cfg({ host: 'nas.local', port: '2222' })).port).toBe(2222)
  })

  it('非法端口回落 22（不让配置错误变成连接到一个随机端口）', () => {
    for (const port of ['abc', '-1', '0', '']) {
      expect(sftpConnectionOf(cfg({ host: 'nas.local', port })).port).toBe(22)
    }
  })

  it('口令与私钥都透传（两者可只填一个）', () => {
    const withPassword = sftpConnectionOf(cfg({ host: 'h', username: 'u', password: 'p' }))
    expect(withPassword).toMatchObject({ username: 'u', password: 'p' })
    expect(withPassword.privateKey).toBeUndefined()

    const withKey = sftpConnectionOf(cfg({ host: 'h', username: 'u', privateKey: '-----BEGIN' }))
    expect(withKey.privateKey).toBe('-----BEGIN')
    expect(withKey.password).toBeUndefined()
  })

  it('空字符串字段归一为 undefined（不让服务端收到空用户名）', () => {
    const conn = sftpConnectionOf(cfg({ host: 'h', username: '', password: '' }))
    expect(conn.username).toBeUndefined()
    expect(conn.password).toBeUndefined()
  })
})

describe('SFTP 路径拼接', () => {
  it('无根目录时相对路径即目标', () => {
    expect(sftpRemotePathOf(cfg({}), 'a/b.mp3')).toBe('a/b.mp3')
  })

  it('有根目录时拼在前面', () => {
    expect(sftpRemotePathOf(cfg({ rootPath: 'music' }), 'a/b.mp3')).toBe('music/a/b.mp3')
  })

  it('根目录的首尾斜杠被去掉（用户写 /music/ 与 music 等价）', () => {
    expect(sftpRemotePathOf(cfg({ rootPath: '/music/' }), 'x.mp3')).toBe('music/x.mp3')
  })

  it('根目录为根时（/）退化为无根目录', () => {
    expect(sftpRemotePathOf(cfg({ rootPath: '/' }), 'x.mp3')).toBe('x.mp3')
  })

  it('空相对路径取根目录本身', () => {
    expect(sftpRemotePathOf(cfg({ rootPath: 'music' }), '')).toBe('music')
    // 都没有时给 '.'（SFTP 的当前目录）
    expect(sftpRemotePathOf(cfg({}), '')).toBe('.')
  })
})

describe('Range 头解析（seek 正确性的前提）', () => {
  it('闭区间 bytes=a-b', () => {
    expect(parseRangeHeader('bytes=100-199')).toEqual({ kind: 'closed', start: 100, end: 199 })
  })

  it('开区间 bytes=a-（到文件尾）', () => {
    expect(parseRangeHeader('bytes=100-')).toEqual({ kind: 'open', start: 100 })
  })

  it('尾段 bytes=-N（最后 N 字节）—— 这正是 openRange 表达不了、必须靠 openStream 的形态', () => {
    expect(parseRangeHeader('bytes=-500')).toEqual({ kind: 'suffix', length: 500 })
  })

  it('忽略大小写与首尾空格', () => {
    expect(parseRangeHeader('  BYTES=0-9  ')).toEqual({ kind: 'closed', start: 0, end: 9 })
  })

  it.each([
    [undefined, '无头'],
    ['', '空串'],
    ['bytes=', '两个数字都缺'],
    ['bytes=-', '两个数字都缺（带横）'],
    ['items=0-9', '非 bytes 单位'],
    ['bytes=abc-def', '非数字'],
    ['bytes=200-100', 'end < start'],
    ['bytes=-0', '尾段长度为 0'],
  ])('拒绝 %s（%s）', (input) => {
    expect(parseRangeHeader(input)).toBeNull()
  })

  it('单字节区间可用（bytes=0-0）', () => {
    expect(parseRangeHeader('bytes=0-0')).toEqual({ kind: 'closed', start: 0, end: 0 })
  })
})

describe('SMB 配置映射与路径', () => {
  it('共享路径拼成 UNC 形式', () => {
    // smbPathOf 只处理共享内路径；UNC 前缀在 optionsOf 里（不导出，通过 probe 间接覆盖）
    expect(smbPathOf(cfg({ rootPath: 'Music' }), 'a/b.mp3')).toBe('Music\\a\\b.mp3')
  })

  it('正斜杠转反斜杠（SMB 用反斜杠）', () => {
    expect(smbPathOf(cfg({}), 'dir/sub/x.mp3')).toBe('dir\\sub\\x.mp3')
  })

  it('根目录首尾斜杠与反斜杠都去掉', () => {
    expect(smbPathOf(cfg({ rootPath: '/Music/' }), 'x.mp3')).toBe('Music\\x.mp3')
    expect(smbPathOf(cfg({ rootPath: '\\Music\\' }), 'x.mp3')).toBe('Music\\x.mp3')
  })

  it('无根目录时相对路径即目标', () => {
    expect(smbPathOf(cfg({}), 'x.mp3')).toBe('x.mp3')
  })
})

describe('SMB Range 解析（与 SFTP 语义一致）', () => {
  it('三种形态都认', () => {
    expect(parseSmbRangeHeader('bytes=0-99')).toEqual({ kind: 'closed', start: 0, end: 99 })
    expect(parseSmbRangeHeader('bytes=100-')).toEqual({ kind: 'open', start: 100 })
    expect(parseSmbRangeHeader('bytes=-200')).toEqual({ kind: 'suffix', length: 200 })
  })

  it('非法输入为 null', () => {
    expect(parseSmbRangeHeader(undefined)).toBeNull()
    expect(parseSmbRangeHeader('bytes=x-y')).toBeNull()
    expect(parseSmbRangeHeader('bytes=10-5')).toBeNull()
  })

  it('与 SFTP 的解析结果对同一输入一致（两处实现不能漂移）', () => {
    for (const input of ['bytes=0-9', 'bytes=5-', 'bytes=-3', 'bytes=bad', undefined]) {
      expect(parseSmbRangeHeader(input)).toEqual(parseRangeHeader(input))
    }
  })
})

describe('注入后可构造真实连接对象（用桩验证调用形状）', () => {
  it('probe 在注入后不再返回 UNAVAILABLE（会真的尝试连接并失败在 test 环境）', async () => {
    // 桩一个必然失败的 ssh2：验证"注入后走真实路径"
    let connectCalled = false
    setSsh2Module({
      Client: function Client(this: Record<string, unknown>) {
        const handlers: Record<string, (err?: Error) => void> = {}
        this.on = (event: string, handler: (err?: Error) => void) => {
          handlers[event] = handler
        }
        this.connect = () => {
          connectCalled = true
          // 模拟连接失败
          setTimeout(() => handlers.error?.(new Error('connect refused')), 0)
        }
        this.end = () => {}
        this.sftp = () => {}
      },
    } as unknown as Ssh2Module)

    const result = await sftpStoragePlugin.probe!(cfg({ host: 'nas.local' }))
    expect(connectCalled).toBe(true)
    expect(result.ok).toBe(false)
    // 不再是"依赖不可用"，而是真实的连接错误
    expect(result.message).not.toBe('SFTP_UNAVAILABLE')
  })
})
