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
