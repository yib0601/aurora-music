import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { validatePluginManifest } from '../plugin/manifest/validate'
import { buildSourcePlugin } from '../plugin/manifest/source'
import { buildLyricsRunner } from '../plugin/manifest/lyrics'
import { buildPluginCatalog } from '../plugin/manifest/catalog'

/**
 * 仓库内随文档发布的示例清单必须**始终可用**。
 *
 * 为什么值得一条测试：示例清单是用户第一次接触插件格式时抄的那份东西。
 * 它一旦与校验器漂移（字段改了、占位符规则变了），复制它的人会得到一堆
 * 看不懂的安装错误 —— 而错误信息指向的是他自己的清单，不是我们的示例。
 *
 * 路径用 `__dirname` 推导（不从 cwd 起算）：CI 与本地从不同目录跑测试时都能找到。
 */
const EXAMPLE_PATH = path.resolve(__dirname, '../../../../docs/examples/example-plugin.json')

describe('docs/examples/example-plugin.json', () => {
  it('文件存在', () => {
    expect(fs.existsSync(EXAMPLE_PATH)).toBe(true)
  })

  it('能通过安装期校验', () => {
    const bytes = fs.readFileSync(EXAMPLE_PATH)
    const json = JSON.parse(bytes.toString('utf8'))
    const result = validatePluginManifest(json)
    if (!result.ok) {
      throw new Error(`示例清单校验失败: ${JSON.stringify(result.issues, null, 2)}`)
    }
    expect(result.manifest.id).toBe('example-source')
    // 三种音源能力 + 歌词都声明了：示例应当展示完整形态
    expect(result.manifest.source?.search).toBeDefined()
    expect(result.manifest.source?.resolveTrack).toBeDefined()
    expect(result.manifest.source?.playlistTracks).toBeDefined()
    expect(result.manifest.lyrics).toBeDefined()
  })

  it('能构造成可执行插件（不是只有形状合法）', () => {
    const json = JSON.parse(fs.readFileSync(EXAMPLE_PATH, 'utf8'))
    const result = validatePluginManifest(json)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const plugin = buildSourcePlugin(result.manifest)
    expect(plugin).not.toBeNull()
    expect(typeof plugin!.search).toBe('function')
    expect(typeof plugin!.resolveTrack).toBe('function')
    expect(typeof plugin!.getPlaylistTracks).toBe('function')

    const lyrics = buildLyricsRunner(result.manifest)
    expect(typeof lyrics).toBe('function')
  })

  it('能进插件目录（显示名 / 权限 / 域名都在）', () => {
    const json = JSON.parse(fs.readFileSync(EXAMPLE_PATH, 'utf8'))
    const result = validatePluginManifest(json)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const entries = buildPluginCatalog([{ manifest: result.manifest, record: { sha256: 'a'.repeat(64) } }])
    const entry = entries.find((item) => item.id === 'example-source')!
    expect(entry.kind ?? entry.domain).toBe('source')
    expect(entry.displayName).toBe('示例音源')
    expect(entry.hosts).toEqual(['api.example.com'])
    expect(entry.permissions).toEqual(['network'])
    expect(entry.capabilities.sort()).toEqual(['lyrics', 'playlistParse', 'resolveTrack', 'search'].sort())
  })

  it('示例里的域名是明显的假值（不是真实服务）', () => {
    // 仓库公开：示例里绝不能出现真实可用的服务地址（docs/development.md 的隐私约束）
    const text = fs.readFileSync(EXAMPLE_PATH, 'utf8')
    expect(text).toContain('api.example.com')
    expect(text).not.toMatch(/lighthouses|qishui\.com|douyin\.com|qq\.com|netease/i)
  })
})
