import { describe, expect, it } from 'vitest'
import { storageFieldValue, storageStringField } from '../fields'
import type { LibrarySourceConfig } from '../../../webdav'

/**
 * 字段取值是「插件化后读 settings、存量配置读顶层扁平字段」的唯一兼容层。
 * 它错了表现为「所有老来源在升级后变成空配置」，因此逐条钉住优先级与边界。
 */
function cfg(partial: Partial<LibrarySourceConfig>): LibrarySourceConfig {
  return { id: 'lib-1', kind: 'webdav', name: '测试 NAS', enabled: true, ...partial }
}

describe('storageFieldValue：settings 优先、顶层同名字段兜底', () => {
  it('新配置读 settings', () => {
    const c = cfg({ settings: { baseUrl: 'https://nas.example.com/dav' } })
    expect(storageFieldValue(c, 'baseUrl')).toBe('https://nas.example.com/dav')
    expect(storageStringField(c, 'baseUrl')).toBe('https://nas.example.com/dav')
  })

  it('老配置（只有顶层扁平字段）照常可读 —— 零迁移', () => {
    const c = cfg({ baseUrl: 'https://nas.example.com/dav', rootPath: 'Music' })
    expect(storageStringField(c, 'baseUrl')).toBe('https://nas.example.com/dav')
    expect(storageStringField(c, 'rootPath')).toBe('Music')
  })

  it('两处都有时 settings 胜出（迁移中途不会读到旧值）', () => {
    const c = cfg({ baseUrl: 'https://old.example.com/dav', settings: { baseUrl: 'https://new.example.com/dav' } })
    expect(storageStringField(c, 'baseUrl')).toBe('https://new.example.com/dav')
  })

  it('settings 里显式空串优先于顶层旧值（用户清空字段是有效意图）', () => {
    const c = cfg({ baseUrl: 'https://old.example.com/dav', settings: { baseUrl: '' } })
    expect(storageFieldValue(c, 'baseUrl')).toBe('')
    expect(storageStringField(c, 'baseUrl')).toBe('')
  })

  it('不读来源自身的保留字段（插件声明 key: name 不能读到来源展示名）', () => {
    const c = cfg({ name: '家里的群晖' })
    for (const key of ['id', 'kind', 'name', 'pluginId', 'settings', 'enabled']) {
      expect(storageFieldValue(c, key)).toBeUndefined()
    }
  })

  it('缺失 / 非字符串 / 非法入参一律给空串或 undefined，不抛错', () => {
    expect(storageFieldValue(null, 'baseUrl')).toBeUndefined()
    expect(storageFieldValue(undefined, 'baseUrl')).toBeUndefined()
    expect(storageFieldValue(cfg({}), '')).toBeUndefined()
    expect(storageStringField(cfg({}), 'baseUrl')).toBe('')
    // 顶层非字符串（如 enabled: boolean）不会被当成字段值读走
    expect(storageFieldValue(cfg({}), 'enabled')).toBeUndefined()
  })

  it('字符串值裁掉首尾空白（口误多打的空格不该让鉴权失败）', () => {
    const c = cfg({ settings: { username: '  bob  ', password: ' p@ss ' } })
    expect(storageStringField(c, 'username')).toBe('bob')
    // 口令内部空格要保留
    expect(storageStringField(c, 'password')).toBe('p@ss')
  })

  it('数字 / 布尔字段归一成字符串（settings 里可能存非字符串）', () => {
    const c = cfg({ settings: { port: 5006, secure: true } })
    expect(storageStringField(c, 'port')).toBe('5006')
    expect(storageStringField(c, 'secure')).toBe('true')
  })
})
