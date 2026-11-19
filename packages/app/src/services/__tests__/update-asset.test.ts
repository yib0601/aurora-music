import { describe, expect, it } from 'vitest'
import { assetPreferenceOrder, pickAsset } from '@/services/update-asset'

/**
 * 安装包按架构挑对的回归保护。
 *
 * 0.9.0 起桌面端每个平台都出两份产物，文件名统一带 `-x64` / `-arm64`
 * （macOS 本来就这样，Linux/Windows 由 release.yml 用 -c.artifactName 覆盖成同一套）。
 * 挑选逻辑一旦错，用户会下到「装不上/起不来」的包：
 *   - Linux arm64 装了 x64 AppImage → exec format error
 *   - Windows ARM 装了 x64 exe → 能跑但走模拟，性能与原生模块都可能出问题
 * 而 release 资产的顺序由上传顺序决定，不能依赖「第一个匹配的就是对的那份」。
 */

function assets(names: string[]) {
  return names.map((name) => ({
    name,
    browser_download_url: `https://github.com/yib0601/aurora-music/releases/download/v0.9.0/${name}`,
    size: 1024,
  }))
}

/** 两种架构的资产都给出，且故意让不匹配本机的那份排在前面 */
const linuxAssets = assets([
  'Aurora-Music-0.9.0-arm64.AppImage',
  'Aurora-Music-0.9.0-x64.AppImage',
  'Aurora-Music-0.9.0-arm64.deb',
  'Aurora-Music-0.9.0-x64.deb',
  'Aurora-Music-0.9.0-arm64.rpm',
  'Aurora-Music-0.9.0-x64.rpm',
])

const linuxEnv = (arch: string, pkgFamily: 'deb' | 'rpm' | 'unknown') => ({
  isMobile: false,
  userAgent: '',
  system: { platform: 'linux', arch, pkgFamily, installKind: 'system-package' as const },
})

describe('pickAsset：按 process.arch 挑本机架构的包', () => {
  it('Linux ARM64 装 deb 的系统包用户拿到 arm64.deb', () => {
    const order = assetPreferenceOrder(linuxEnv('arm64', 'deb'))
    expect(pickAsset(linuxAssets, order, 'arm64')?.url).toContain('-arm64.deb')
  })

  it('Linux x64 装 deb 的系统包用户拿到 x64.deb', () => {
    const order = assetPreferenceOrder(linuxEnv('x64', 'deb'))
    expect(pickAsset(linuxAssets, order, 'x64')?.url).toContain('-x64.deb')
  })

  it('Linux ARM64 便携形态优先 AppImage，且仍是 arm64 那份', () => {
    const order = assetPreferenceOrder({
      isMobile: false,
      userAgent: '',
      system: { platform: 'linux', arch: 'arm64', pkgFamily: 'unknown', installKind: 'portable' },
    })
    expect(order[0]).toBe('appimage')
    expect(pickAsset(linuxAssets, order, 'arm64')?.url).toContain('-arm64.AppImage')
  })

  it('rpm 用户同样按架构挑，不会跨格式串选', () => {
    const order = assetPreferenceOrder(linuxEnv('arm64', 'rpm'))
    const picked = pickAsset(linuxAssets, order, 'arm64')
    expect(picked?.kind).toBe('rpm')
    expect(picked?.url).toContain('-arm64.rpm')
  })

  it('Windows ARM 拿到 arm64.exe，x64 机器拿到 x64.exe', () => {
    const winAssets = assets(['Aurora-Music-0.9.0-x64.exe', 'Aurora-Music-0.9.0-arm64.exe'])
    const order = assetPreferenceOrder({
      isMobile: false,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; ARM64)',
      system: { platform: 'win32', arch: 'arm64' },
    })
    expect(pickAsset(winAssets, order, 'arm64')?.url).toContain('-arm64.exe')
    expect(pickAsset(winAssets, order, 'x64')?.url).toContain('-x64.exe')
  })

  it('旧 release 里没有架构后缀时仍能选中（升级路径不能断）', () => {
    const legacy = assets(['Aurora-Music-0.8.12.AppImage', 'Aurora-Music-0.8.12.deb'])
    const order = assetPreferenceOrder({
      isMobile: false,
      userAgent: '',
      system: { platform: 'linux', arch: 'x64', pkgFamily: 'unknown', installKind: 'appimage' },
    })
    expect(pickAsset(legacy, order, 'x64')?.url).toContain('Aurora-Music-0.8.12.AppImage')
  })

  it('只有另一架构的包时退回该格式（信息比没有强），不返回 null', () => {
    const onlyArm = assets(['Aurora-Music-0.9.0-arm64.AppImage'])
    const order = assetPreferenceOrder({
      isMobile: false,
      userAgent: '',
      system: { platform: 'linux', arch: 'x64', pkgFamily: 'unknown', installKind: 'appimage' },
    })
    expect(pickAsset(onlyArm, order, 'x64')?.kind).toBe('appimage')
  })
})
