import { describe, expect, it } from 'vitest'
import { isStorageTransportError, markTransportError, storageErrorStatus } from '../errors'
import { TimeoutError } from '../../../fetchWithTimeout'
import { WebdavError } from '../../../webdav'

/**
 * 这两个判据取代了散落在播放代理与扫描管线里的 `err instanceof WebdavError`。
 * 判据错了后果不对称：误判成「内容问题」会让一次网络抖动把曲库清空；
 * 误判成「传输层失败」会让读不到的文件永远不进库。所以两种方向都要钉住。
 */
describe('storageErrorStatus：结构化取状态码，不用 instanceof', () => {
  it('WebdavError 带的状态照常取到', () => {
    expect(storageErrorStatus(new WebdavError('boom', 404))).toBe(404)
    expect(storageErrorStatus(new WebdavError('boom'))).toBeUndefined()
  })

  it('任意对象只要有数字 status 就认（未来插件抛自己的错误类也兼容）', () => {
    expect(storageErrorStatus({ status: 500 })).toBe(500)
    expect(storageErrorStatus({ status: 401.9 })).toBe(401)
    const custom = new Error('smb failure')
    ;(custom as Error & { status?: number }).status = 503
    expect(storageErrorStatus(custom)).toBe(503)
  })

  it('非数字 / 非有限 / 缺失 / 非对象一律 undefined', () => {
    expect(storageErrorStatus({ status: '404' })).toBeUndefined()
    expect(storageErrorStatus({ status: NaN })).toBeUndefined()
    expect(storageErrorStatus({ status: Infinity })).toBeUndefined()
    expect(storageErrorStatus({})).toBeUndefined()
    expect(storageErrorStatus(null)).toBeUndefined()
    expect(storageErrorStatus('500')).toBeUndefined()
  })
})

describe('isStorageTransportError：可重试的网络失败', () => {
  it('WebdavError 一律算传输层失败（带不带状态都一样）', () => {
    expect(isStorageTransportError(new WebdavError('timeout'))).toBe(true)
    expect(isStorageTransportError(new WebdavError('forbidden', 403))).toBe(true)
  })

  it('超时类错误算传输层失败（TimeoutError / AbortError）', () => {
    expect(isStorageTransportError(new TimeoutError(30000))).toBe(true)
    const aborted = new Error('aborted')
    aborted.name = 'AbortError'
    expect(isStorageTransportError(aborted)).toBe(true)
  })

  it('只有 status 的普通对象也算（新插件不必复用 WebdavError）', () => {
    expect(isStorageTransportError({ status: 502 })).toBe(true)
    // 200 也算：openRange 收到 200 表示服务器不支持 Range，是能力缺失不是内容错误
    expect(isStorageTransportError({ status: 200 })).toBe(true)
  })

  it('内容 / 格式错误不算传输层失败（扫描时应按文件名兜底入库）', () => {
    expect(isStorageTransportError(new Error('moov atom not found'))).toBe(false)
    expect(isStorageTransportError(new SyntaxError('bad json'))).toBe(false)
    expect(isStorageTransportError(undefined)).toBe(false)
    expect(isStorageTransportError(null)).toBe(false)
    expect(isStorageTransportError('oops')).toBe(false)
  })

  it('markTransportError 给平台层自造的错误挂标记，且返回同一对象', () => {
    const err = new Error('remote 404')
    expect(isStorageTransportError(err)).toBe(false)
    const marked = markTransportError(err)
    expect(marked).toBe(err)
    expect(isStorageTransportError(err)).toBe(true)
    // 不可枚举：不该污染日志/序列化输出
    expect(Object.keys(err)).not.toContain('transport')
    expect(JSON.stringify({ status: 'x', ...err })).not.toContain('transport')
  })

  it('markTransportError 对冻结对象 / 非对象安全（不抛错）', () => {
    const frozen = Object.freeze(new Error('frozen') as Error & { transport?: boolean })
    expect(() => markTransportError(frozen)).not.toThrow()
    expect(markTransportError('plain string')).toBe('plain string')
    expect(markTransportError(null)).toBeNull()
  })
})
