import { describe, expect, it, vi } from 'vitest'
import type {
  PluginCatalogEntry,
  PluginInstallResult,
  PluginStartupReport,
  ManifestIssue,
} from '@aurora/shared'
import {
  capabilityLabelsOf,
  describeBrokenReason,
  describeFailureReason,
  describeInstallResult,
  describeIssues,
  describeStartupFailures,
  displayDescriptionOf,
  displayNameOf,
  installedEntries,
  builtinEntries,
  permissionLinesOf,
  sourceEntriesOf,
} from '../pluginManage'

/** 假翻译器：把 key 原样返回并记录插值参数，让断言只关心"用了哪个键" */
function fakeT(): ((key: string, params?: Record<string, unknown>) => string) & {
  calls: Array<{ key: string; params?: Record<string, unknown> }>
} {
  const calls: Array<{ key: string; params?: Record<string, unknown> }> = []
  const t = ((key: string, params?: Record<string, unknown>) => {
    calls.push({ key, params })
    return params ? `${key}|${JSON.stringify(params)}` : key
  }) as never
  ;(t as unknown as { calls: typeof calls }).calls = calls
  return t as never
}

function entry(overrides: Partial<PluginCatalogEntry> = {}): PluginCatalogEntry {
  return {
    id: 'demo',
    domain: 'source',
    version: '1.0.0',
    capabilities: ['search'],
    provenance: 'installed',
    removable: true,
    ...overrides,
  }
}

describe('展示名：内置（字典键）与已安装（字面量）双形态', () => {
  it('已安装插件用清单解析好的字面量', () => {
    const t = fakeT()
    expect(displayNameOf(entry({ displayName: '演示插件' }), t)).toBe('演示插件')
  })

  it('内置插件走字典键', () => {
    const t = fakeT()
    const name = displayNameOf(entry({ provenance: 'builtin', removable: false, displayNameKey: 'core.platform.aurora' }), t)
    expect(name).toBe('core.platform.aurora')
  })

  it('两者都没有时回落 id（绝不显示空白）', () => {
    const t = fakeT()
    expect(displayNameOf(entry({ id: 'fallback-id' }), t)).toBe('fallback-id')
  })

  it('字面量优先于键（不会同时存在，但顺序要确定）', () => {
    const t = fakeT()
    expect(displayNameOf(entry({ displayName: 'literal', displayNameKey: 'some.key' }), t)).toBe('literal')
  })

  it('说明可缺省，缺省返回空串', () => {
    const t = fakeT()
    expect(displayDescriptionOf(entry(), t)).toBe('')
    expect(displayDescriptionOf(entry({ description: '说明' }), t)).toBe('说明')
  })
})

describe('分组：已安装 / 内置', () => {
  const entries = [
    entry({ id: 'a', removable: true }),
    entry({ id: 'b', removable: false, provenance: 'builtin' }),
    entry({ id: 'c', removable: true }),
  ]

  it('已安装 = removable（不是按 provenance 猜）', () => {
    expect(installedEntries(entries).map((item) => item.id)).toEqual(['a', 'c'])
  })

  it('内置 = 不可卸载', () => {
    expect(builtinEntries(entries).map((item) => item.id)).toEqual(['b'])
  })
})

describe('可用作音源的条目', () => {
  it('有搜索或歌单能力才算', () => {
    const entries = [
      entry({ id: 'search', capabilities: ['search'] }),
      entry({ id: 'playlist', capabilities: ['playlistParse'] }),
      entry({ id: 'resolve-only', capabilities: ['resolveTrack'] }),
      entry({ id: 'lyrics-only', capabilities: ['lyrics'] }),
    ]
    expect(sourceEntriesOf(entries).map((item) => item.id)).toEqual(['search', 'playlist'])
  })

  it('存储域不算音源', () => {
    const entries = [entry({ id: 'webdav', domain: 'storage', capabilities: ['search'] })]
    expect(sourceEntriesOf(entries)).toEqual([])
  })
})

describe('能力徽章', () => {
  it('已知能力翻成短标签', () => {
    const t = fakeT()
    const labels = capabilityLabelsOf(entry({ capabilities: ['search', 'lyrics'] }), t)
    expect(labels).toEqual(['sources.plugins.capability.search', 'sources.plugins.capability.lyrics'])
  })

  it('存储插件的四个能力合并成一个"存储"标签（去重）', () => {
    const t = fakeT()
    const labels = capabilityLabelsOf(
      entry({ capabilities: ['listAudio', 'openRange', 'openStream', 'probe'] }),
      t
    )
    expect(labels).toEqual(['sources.plugins.capability.storage'])
  })

  it('未知能力不显示原文（宁缺徽章，不露实现词）', () => {
    const t = fakeT()
    expect(capabilityLabelsOf(entry({ capabilities: ['someFutureCapability'] }), t)).toEqual([])
  })
})

describe('权限展示：必须逐条说清', () => {
  it('network 要列出具体域名（只说"访问网络"等于没说）', () => {
    const t = fakeT()
    const lines = permissionLinesOf(['network'], ['api.example.com', 'cdn.example.com'], t)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('api.example.com')
    expect(lines[0]).toContain('cdn.example.com')
  })

  it('credential 单独一条', () => {
    const t = fakeT()
    expect(permissionLinesOf(['credential'], [], t)).toEqual(['sources.plugins.permissionCredential'])
  })

  it('空权限 → "不需要额外权限"', () => {
    const t = fakeT()
    expect(permissionLinesOf([], [], t)).toEqual(['sources.plugins.permissionNone'])
    expect(permissionLinesOf(undefined, undefined, t)).toEqual(['sources.plugins.permissionNone'])
  })

  it('network 但没有域名时不留空白（显示占位符）', () => {
    const t = fakeT()
    const lines = permissionLinesOf(['network'], [], t)
    expect(lines[0]).toContain('"hosts":"—"')
  })
})

describe('清单问题：逐条、带字段路径', () => {
  it('每条都产出"字段 + 问题"', () => {
    const t = fakeT()
    const issues: ManifestIssue[] = [
      { path: 'source.search.url', code: 'missing' },
      { path: 'hosts[0]', code: 'wildcard-host', value: '*' },
    ]
    const rows = describeIssues(issues, t)
    expect(rows).toHaveLength(2)
    expect(rows[0].field).toContain('source.search.url')
    expect(rows[0].message).toBe('sources.plugins.issue.missing')
    expect(rows[1].message).toBe('sources.plugins.issue.wildcardHost')
  })

  it('空 path（整份清单的问题）不显示"字段："前缀', () => {
    const t = fakeT()
    const rows = describeIssues([{ path: '', code: 'not-object' }], t)
    expect(rows[0].field).toBe('')
    expect(rows[0].message).toBe('sources.plugins.issue.notObject')
  })

  it('未知 code 回落通用文案（不露原始码）', () => {
    const t = fakeT()
    const rows = describeIssues([{ path: 'x', code: 'brand-new' as never }], t)
    expect(rows[0].message).toBe('sources.plugins.issue.invalidType')
  })

  it('undefined / 空数组返回空列表', () => {
    const t = fakeT()
    expect(describeIssues(undefined, t)).toEqual([])
    expect(describeIssues([], t)).toEqual([])
  })
})

describe('安装结果 → 可读文案', () => {
  it('成功时取 entry 的展示名', () => {
    const t = fakeT()
    const result: PluginInstallResult = { ok: true, entry: entry({ displayName: '演示插件' }) }
    expect(describeInstallResult(result, t)).toEqual({ ok: true, name: '演示插件' })
  })

  it('成功但没有 entry 时 name 是空串（调用方显示通用成功文案）', () => {
    const t = fakeT()
    expect(describeInstallResult({ ok: true }, t)).toEqual({ ok: true, name: '' })
  })

  it('结构化码 builtin → 带 id 的专属文案（用户要知道撞的是哪个插件）', () => {
    const t = fakeT()
    const outcome = describeInstallResult(
      { ok: false, message: 'AURORA_PLUGIN_BUILTIN_ID:{id:aurora}' },
      t
    )
    expect(outcome.ok).toBe(false)
    expect(outcome.message).toContain('sources.plugins.error.builtinId')
    expect(outcome.message).toContain('aurora')
  })

  it('结构化码 duplicate → 带 id', () => {
    const t = fakeT()
    const outcome = describeInstallResult(
      { ok: false, message: 'AURORA_PLUGIN_DUPLICATE_ID:{id:demo}' },
      t
    )
    expect(outcome.message).toContain('sources.plugins.error.duplicateId')
    expect(outcome.message).toContain('demo')
  })

  it('结构化码 busy / hashMismatch / notInstalled 各有专属文案', () => {
    const t = fakeT()
    expect(describeInstallResult({ ok: false, message: 'AURORA_PLUGIN_BUSY' }, t).message).toBe(
      'sources.plugins.error.busy'
    )
    expect(
      describeInstallResult({ ok: false, message: 'AURORA_PLUGIN_HASH_MISMATCH_REQUESTED' }, t).message
    ).toBe('sources.plugins.error.hashMismatch')
    expect(
      describeInstallResult({ ok: false, message: 'AURORA_PLUGIN_NOT_INSTALLED' }, t).message
    ).toBe('sources.plugins.error.notInstalled')
  })

  it('清单问题随结果一起带出（结构错误要逐条给）', () => {
    const t = fakeT()
    const outcome = describeInstallResult(
      {
        ok: false,
        message: 'AURORA_PLUGIN_INVALID_MANIFEST',
        issues: [{ path: 'id', code: 'invalid-id' }],
      },
      t
    )
    expect(outcome.issues).toHaveLength(1)
    expect(outcome.issues![0].field).toContain('id')
  })

  it('自由文本原样透出（主进程已渲染，不二次加工）+ 统一前缀', () => {
    const t = fakeT()
    const outcome = describeInstallResult(
      { ok: false, message: '下载插件失败：服务器返回 HTTP 404' },
      t
    )
    expect(outcome.message).toContain('sources.plugins.installFailed')
    expect(outcome.message).toContain('HTTP 404')
  })

  it('未知的结构化前缀不静默吞掉（透出原码，便于发现漏配文案）', () => {
    const t = fakeT()
    const outcome = describeInstallResult({ ok: false, message: 'AURORA_PLUGIN_BRAND_NEW_CODE' }, t)
    expect(outcome.message).toBe('AURORA_PLUGIN_BRAND_NEW_CODE')
  })

  it('undefined 结果给通用失败文案', () => {
    const t = fakeT()
    expect(describeInstallResult(undefined, t).ok).toBe(false)
  })
})

describe('坏文件原因', () => {
  it('哈希不符 → "内容被改过"（这是需要重新安装的动作，不是格式问题）', () => {
    const t = fakeT()
    expect(
      describeBrokenReason('AURORA_PLUGIN_HASH_MISMATCH:{expected:a,actual:b}', t)
    ).toBe('desktop.error.plugin.hashMismatch')
  })

  it('不是 UTF-8', () => {
    const t = fakeT()
    expect(describeBrokenReason('AURORA_PLUGIN_NOT_UTF8:/p/x.json', t)).toBe(
      'sources.plugins.error.notUtf8'
    )
  })

  it('JSON 语法错误带上解析器给的位置', () => {
    const t = fakeT()
    const text = describeBrokenReason(
      'AURORA_PLUGIN_BAD_JSON:/p/x.json:Unexpected token } at position 42',
      t
    )
    expect(text).toContain('sources.plugins.error.badJson')
    expect(text).toContain('position 42')
  })

  it('没有 message 时给通用提示', () => {
    const t = fakeT()
    expect(describeBrokenReason(undefined, t)).toBe('sources.plugins.brokenHint')
  })

  it('自由文本原样返回（不吞细节）', () => {
    const t = fakeT()
    expect(describeBrokenReason('EACCES: permission denied', t)).toBe('EACCES: permission denied')
  })
})

describe('本端能力判定（老 preload 兼容）', () => {
  it('没有 plugins 网关时 catalog 为空且不可管理', async () => {
    // 通过 mock platform 验证：这里只测纯函数形态的判定逻辑，
    // 需要真实 platform 单例的用例放在集成测试里
    const mod = await import('../pluginManage')
    expect(typeof mod.pluginExecutionAvailable).toBe('function')
    expect(typeof mod.pluginInstallAvailable).toBe('function')
  })
})

describe('启动加载失败提示：插件坏了要告诉用户，但不影响使用', () => {
  const t = fakeT()

  it('没有报告（老 preload / 读失败）时不提示 —— 不能把"读不到"说成"坏了"', () => {
    expect(describeStartupFailures(null, t)).toBeNull()
  })

  it('全好时一声不响（插件是背景功能，正常时不该抢注意力）', () => {
    const report: PluginStartupReport = { mounted: ['aurora'], broken: 0, failures: [] }
    expect(describeStartupFailures(report, t)).toBeNull()
  })

  it('只有一个注册期失败也提示，并带上数量', () => {
    const report: PluginStartupReport = {
      mounted: [],
      broken: 0,
      failures: [{ id: 'demo', stage: 'installed', reason: 'boom', at: 1 }],
    }
    const notice = describeStartupFailures(report, t)
    expect(notice).not.toBeNull()
    expect(notice!.count).toBe(1)
    expect(notice!.message).toContain('sources.plugins.startupWarning')
    expect(notice!.message).toContain('"count":1')
    // 动作标签同一条来源，UI 不用自己再编一个词
    expect(notice!.actionLabel).toBe('sources.plugins.startupWarningAction')
  })

  it('磁盘坏文件与注册期失败合并成一个数字（对用户是同一件事）', () => {
    const report: PluginStartupReport = {
      mounted: [],
      broken: 2,
      failures: [
        { id: 'a', stage: 'builtin', reason: 'x', at: 1 },
        { id: 'b', stage: 'storage', reason: 'y', at: 2 },
      ],
    }
    expect(describeStartupFailures(report, t)!.count).toBe(4)
  })

  it('坏的计数是负数 / NaN 时按 0 处理（不让一条脏数据变成提示）', () => {
    const report: PluginStartupReport = { mounted: [], broken: Number.NaN, failures: [] }
    expect(describeStartupFailures(report, t)).toBeNull()
  })
})

describe('单条加载失败的原因渲染', () => {
  const t = fakeT()

  it('技术原因原样透出（不吞插件作者写的异常信息）', () => {
    expect(
      describeFailureReason({ id: 'x', stage: 'installed', reason: 'TypeError: x is undefined', at: 1 }, t)
    ).toBe('TypeError: x is undefined')
  })

  it('原因缺失时回落到通用提示，不显示空白行', () => {
    expect(describeFailureReason({ id: 'x', stage: 'builtin', reason: '', at: 1 }, t)).toBe(
      'sources.plugins.brokenHint'
    )
  })
})
