import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * 插件启停落盘层的测试。
 *
 * userData 指到临时目录（与 `pluginStore.test.ts` / 原 `pluginTrust.test.ts` 同一隔离方式）：
 * 真跑在用户目录上会覆盖用户真实的启停设置，而那是"我的插件为什么突然不工作了"的
 * 唯一线索 —— 覆盖它比覆盖别的配置更难自查。
 *
 * 这里重点测两类东西，它们都是**装配**而不是纯逻辑，故不能在 shared 的
 * `availability.test.ts` 里覆盖：
 * 1. 落盘往返（写进去的与读出来的是同一个集合）
 * 2. 写盘失败时**回滚内存态**（否则界面说"已停用"、磁盘说"启用"，重启后开关自己弹回去）
 */
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-plugin-availability-'))

vi.mock('electron', () => ({
  app: { getPath: () => tempRoot },
  ipcMain: { handle: vi.fn() },
}))

/** 落盘文件路径（与实现同一约定，供用例直接校验磁盘内容） */
const filePath = () => path.join(tempRoot, 'aurora-music', 'plugin-availability.json')

let mod: typeof import('../pluginAvailability')
let shared: typeof import('@aurora/shared')

beforeEach(async () => {
  fs.rmSync(path.join(tempRoot, 'aurora-music'), { recursive: true, force: true })
  vi.resetModules()
  mod = await import('../pluginAvailability')
  // shared 与实现同一实例：@aurora/shared 是 workspace 依赖，vitest 里解析到同一模块
  shared = await import('@aurora/shared')
  shared.setDisabledPluginIds([])
})

afterEach(() => {
  fs.rmSync(path.join(tempRoot, 'aurora-music'), { recursive: true, force: true })
  shared.setDisabledPluginIds([])
  vi.restoreAllMocks()
})

describe('loadPluginAvailability：读盘灌入内存态', () => {
  it('文件不存在 = 全部启用，且不创建文件（没停用过就不该在磁盘上留空配置）', () => {
    mod.loadPluginAvailability()
    expect(shared.disabledPluginIds()).toEqual([])
    expect(fs.existsSync(filePath())).toBe(false)
  })

  it('读回已停用的 id', () => {
    fs.mkdirSync(path.dirname(filePath()), { recursive: true })
    fs.writeFileSync(filePath(), JSON.stringify({ version: 1, disabled: ['lx', 'qishui'] }))
    mod.loadPluginAvailability()
    expect(shared.disabledPluginIds().sort()).toEqual(['lx', 'qishui'])
  })

  it('文件损坏时按全部启用处理（坏配置不能让插件集体消失）', () => {
    fs.mkdirSync(path.dirname(filePath()), { recursive: true })
    fs.writeFileSync(filePath(), '{ this is not json')
    expect(() => mod.loadPluginAvailability()).not.toThrow()
    expect(shared.disabledPluginIds()).toEqual([])
  })

  it('裸数组形态也接受（用户手改配置文件时最省事的写法）', () => {
    fs.mkdirSync(path.dirname(filePath()), { recursive: true })
    fs.writeFileSync(filePath(), JSON.stringify(['lx']))
    mod.loadPluginAvailability()
    expect(shared.disabledPluginIds()).toEqual(['lx'])
  })

  it('重新加载会全量替换，而不是累加（用户在别处删掉一条后不该继续残留）', () => {
    fs.mkdirSync(path.dirname(filePath()), { recursive: true })
    fs.writeFileSync(filePath(), JSON.stringify({ version: 1, disabled: ['lx'] }))
    mod.loadPluginAvailability()
    fs.writeFileSync(filePath(), JSON.stringify({ version: 1, disabled: [] }))
    mod.loadPluginAvailability()
    expect(shared.disabledPluginIds()).toEqual([])
  })
})

describe('applyPluginEnabled：改内存态并落盘', () => {
  it('停用后写盘，且盘上内容能被重新读回', () => {
    const result = mod.applyPluginEnabled('lx', false)
    expect(result).toEqual({ ok: true, enabled: false })
    expect(shared.isPluginEnabled('lx')).toBe(false)
    expect(fs.existsSync(filePath())).toBe(true)
    // 重新灌入一次，确认落盘形状能被自己的解析器读回（写读契约闭环）
    shared.setDisabledPluginIds([])
    mod.loadPluginAvailability()
    expect(shared.isPluginEnabled('lx')).toBe(false)
  })

  it('重新启用会把它从盘上移除', () => {
    mod.applyPluginEnabled('lx', false)
    const result = mod.applyPluginEnabled('lx', true)
    expect(result).toEqual({ ok: true, enabled: true })
    expect(shared.isPluginEnabled('lx')).toBe(true)
    const parsed = JSON.parse(fs.readFileSync(filePath(), 'utf8'))
    expect(parsed.disabled).toEqual([])
  })

  it('重复设置同一个值不产生额外写盘（连点开关不该变成写放大）', () => {
    mod.applyPluginEnabled('lx', false)
    const first = fs.statSync(filePath()).mtimeMs
    // 让它明显不同：若实现仍写盘，mtime 会变
    const result = mod.applyPluginEnabled('lx', false)
    expect(result).toEqual({ ok: true, enabled: false })
    expect(fs.statSync(filePath()).mtimeMs).toBe(first)
  })

  it('写盘失败时回滚内存态（否则重启后开关会自己弹回去）', () => {
    // 让 mkdirSync 抛错：模拟磁盘只读 / 权限不足
    vi.spyOn(fs, 'mkdirSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
    })
    const result = mod.applyPluginEnabled('lx', false)
    expect(result.ok).toBe(false)
    // 关键断言：内存态已回滚，界面与磁盘都停在"启用"
    expect(result.enabled).toBe(true)
    expect(shared.isPluginEnabled('lx')).toBe(true)
  })

  it('非法 id 不改状态（入参来自 UI 与配置文件两条路，都不是可信来源）', () => {
    const result = mod.applyPluginEnabled('', false)
    expect(result.ok).toBe(false)
    expect(shared.disabledPluginIds()).toEqual([])
  })
})

describe('pluginAvailabilitySnapshot：诊断用快照', () => {
  it('给出停用清单与计数', () => {
    mod.applyPluginEnabled('lx', false)
    mod.applyPluginEnabled('qishui', false)
    const snapshot = mod.pluginAvailabilitySnapshot()
    expect(snapshot.disabledCount).toBe(2)
    expect(snapshot.disabled.sort()).toEqual(['lx', 'qishui'])
  })
})
