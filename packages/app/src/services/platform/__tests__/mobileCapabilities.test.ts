/**
 * 移动端平台能力契约测试。
 *
 * 设置页的缓存分区是按「平台对象上有没有这个方法」探测出来的
 * （SettingsPage: typeof platform.getAudioCacheUsage === 'function'），
 * 也就是说：手机上看不到缓存系统，等价于这里的断言失败。这条契约在真机上
 * 只能靠肉眼，容易在重构中静默丢掉，所以用测试钉住：Capacitor 原生容器环境下
 * createMobilePlatform() 必须暴露全部五个缓存方法，且 #/services/platform 导出
 * 的 platform 单例确实选了移动端实现。
 */
import { describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => {
  // createPlatform() 用 window.Capacitor.isNativePlatform() 判定是否走移动端实现，
  // 测试跑在 node 环境（无 window），这里补一个最小容器环境再加载模块。
  ;(globalThis as unknown as { window: unknown }).window = {
    Capacitor: {
      isNativePlatform: () => true,
      getPlatform: () => 'android',
      convertFileSrc: (p: string) => `https://localhost/_capacitor_file_${p.replace(/^file:\/\//, '')}`,
    },
  }
  return {
    files: new Map<string, { size: number; mtime: number; content?: string }>(),
  }
})

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => true,
    getPlatform: () => 'android',
    isPluginAvailable: () => false,
    convertFileSrc: (p: string) => `https://localhost/_capacitor_file_${p.replace(/^file:\/\//, '')}`,
  },
  CapacitorHttp: { get: async () => ({ status: 200, data: '' }) },
}))

vi.mock('@capacitor/filesystem', () => {
  const trim = (p: string) => p.replace(/\/+$/, '')
  const Filesystem = {
    async mkdir() {},
    async readdir({ path }: { path: string }) {
      const prefix = `${trim(path)}/`
      const names = new Set<string>()
      for (const file of state.files.keys()) {
        if (!file.startsWith(prefix)) continue
        const rest = file.slice(prefix.length)
        if (!rest || rest.includes('/')) continue
        names.add(rest)
      }
      return { files: [...names].map((name) => ({ name, type: 'file' as const })) }
    },
    async getUri({ path }: { path: string }) {
      return { uri: `file:///data/user/0/com.aurora.music/files/${trim(path)}` }
    },
    async stat({ path }: { path: string }) {
      const file = state.files.get(path)
      if (!file) throw new Error('File does not exist')
      return { type: 'file' as const, size: file.size, mtime: file.mtime, uri: `file://${path}` }
    },
    async readFile({ path }: { path: string }) {
      const file = state.files.get(path)
      if (!file || file.content === undefined) throw new Error('File does not exist')
      return { data: Buffer.from(file.content, 'utf8').toString('base64') }
    },
    async writeFile({ path, data }: { path: string; data: string }) {
      const text = Buffer.from(String(data), 'base64').toString('utf8')
      state.files.set(path, { size: Buffer.byteLength(text), mtime: Date.now(), content: text })
      return { uri: `file://${path}` }
    },
    async deleteFile({ path }: { path: string }) {
      state.files.delete(path)
    },
    async rename({ from, to }: { from: string; to: string }) {
      const file = state.files.get(from)
      if (!file) throw new Error('File does not exist')
      state.files.delete(from)
      state.files.set(to, file)
    },
    async rmdir() {},
    async downloadFile({ url, path }: { url: string; path: string }) {
      state.files.set(path, { size: 1024, mtime: Date.now() })
      return { path }
    },
  }
  return { Directory: { Data: 'DATA' }, Filesystem }
})

vi.mock('@capacitor-community/sqlite', () => ({
  CapacitorSQLite: {},
  SQLiteConnection: class {},
  SQLiteDBConnection: class {},
}))

vi.mock('music-metadata-browser', () => ({
  parseBlob: async () => ({ common: {}, format: {} }),
}))

vi.mock('@/services/permission', () => ({
  requestMediaPermissions: async () => true,
  checkAllFilesAccess: async () => true,
  openAllFilesAccessSettings: async () => {},
}))

describe('移动端平台能力', () => {
  it('原生容器环境下暴露全部缓存方法（设置页据此显示缓存分区）', async () => {
    const { createMobilePlatform } = await import('../mobile/index')
    const platform = createMobilePlatform()

    expect(platform.platform).toBe('mobile')
    for (const method of [
      'resolveCachedAudio',
      'resolveCachedCover',
      'configureAudioCache',
      'getAudioCacheUsage',
      'clearAudioCache',
    ] as const) {
      expect(typeof (platform as unknown as Record<string, unknown>)[method]).toBe('function')
    }
  })

  it('platform 单例在原生容器里选移动端实现，且缓存能力可用', async () => {
    const { platform } = await import('../index')
    expect(platform.platform).toBe('mobile')
    // 与 SettingsPage 的 supportsAudioCache 判定同一条表达式
    expect(typeof platform.getAudioCacheUsage === 'function').toBe(true)
    expect(typeof platform.resolveCachedAudio === 'function').toBe(true)
  })

  it('缓存方法可用：容量档位下发后能读到占用（不抛错）', async () => {
    const { platform } = await import('../index')
    await platform.configureAudioCache?.({ limitMB: 256 })
    const usage = await platform.getAudioCacheUsage?.()
    expect(usage).toEqual({ usedBytes: 0, count: 0 })
  })
})

/**
 * 曲库单条动作的平台能力契约。
 *
 * 两条能力的处置**刻意不同**，各自都容易被重构改坏：
 *   - `removeTrack`：移动端有实现（只删数据库记录 + 封面缓存，不动音频文件）；
 *   - `revealTrack`：移动端**没有**文件管理器桥（未安装 @capacitor/share 及同类插件，
 *     也不新增依赖），能力缺失用「方法不存在」表达。UI 依此隐藏「在文件夹中显示」，
 *     而不是显示一个点了没反应的菜单项（与 LoggingGateway.reveal 同一套约定）。
 */
describe('曲库单条动作的平台能力', () => {
  it('移动端有 removeTrack（只删记录），但没有 revealTrack', async () => {
    const { createMobilePlatform } = await import('../mobile/index')
    const platform = createMobilePlatform() as unknown as Record<string, unknown>

    expect(typeof platform.removeTrack).toBe('function')
    expect(platform.revealTrack).toBeUndefined()
  })

  it('removeTrack 存在即被 UI 视为可用能力（与方法存在性判定同源）', async () => {
    const { platform } = await import('../index')
    expect(typeof platform.removeTrack === 'function').toBe(true)
    expect(typeof platform.revealTrack === 'function').toBe(false)
  })
})

/**
 * 网络存储（媒体库来源）的平台能力契约。
 *
 * 判据链只有一条：`pluginConfigSurfaces` 与卡片齿轮都看
 * `typeof platform.scanLibrarySource === 'function'`（见 components/common/pluginConfig）。
 * 也就是说：**手机上插件卡片有没有"配置"齿轮，等价于这里断言失败**。
 *
 * 这条曾在真机上表现为"手机版这里没有配置的按钮"，而单测全绿 —— 因为没有测试
 * 钉住"移动端也实现了存储能力"。补齐实现的同时把这份契约固定下来。
 */
describe('网络存储的平台能力（决定插件卡片上有没有配置入口）', () => {
  it('移动端暴露完整的存储能力：探测 / 扫描 / 移除 / 口令 / 协议名单', async () => {
    const { createMobilePlatform } = await import('../mobile/index')
    const platform = createMobilePlatform() as unknown as Record<string, unknown>
    for (const method of [
      'syncLibrarySources',
      'listStoragePlugins',
      'probeLibrarySource',
      'scanLibrarySource',
      'removeLibrarySource',
      'saveStorageCredential',
      'storageCredentialState',
      'clearStorageCredential',
      'resolveStorageAudio',
    ] as const) {
      expect(typeof platform[method], method).toBe('function')
    }
  })

  it('协议名单里只有依赖已注入的协议可用（SFTP / SMB 依赖只在桌面端）', async () => {
    const { createMobilePlatform } = await import('../mobile/index')
    const platform = createMobilePlatform()
    const metas = await platform.listStoragePlugins()
    const byId = new Map(metas.map((meta) => [meta.id, meta]))
    expect(byId.get('webdav')?.available).toBe(true)
    expect(byId.get('sftp')?.available).toBe(false)
    expect(byId.get('smb')?.available).toBe(false)
  })
})
