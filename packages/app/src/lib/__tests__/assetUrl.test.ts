import { describe, expect, it } from 'vitest'
import { assetUrl } from '@/lib/assetUrl'

/**
 * 回归锁（2026-10-30，0.7.4 打包版侧边栏品牌图裂图）：
 * 生产端是 Electron `loadFile()` + `file://`，根相对地址 `/favicon.svg` 被解析成
 * `file:///favicon.svg` → naturalWidth 为 0，侧边栏品牌位显示破图图标。
 * 因此 public/ 资源地址一律经 assetUrl 按 vite base 拼接。
 */
describe('assetUrl', () => {
  it('生产 base（./）拼出相对地址，不会落到文件系统根', () => {
    expect(assetUrl('./', 'favicon.svg')).toBe('./favicon.svg')
    expect(assetUrl('./', 'favicon.svg').startsWith('/')).toBe(false)
  })

  it('dev base（/）拼出根相对地址（http 下正常）', () => {
    expect(assetUrl('/', 'favicon.svg')).toBe('/favicon.svg')
  })

  it('自定义子路径 base 补齐结尾斜杠', () => {
    expect(assetUrl('/aurora/', 'favicon.svg')).toBe('/aurora/favicon.svg')
    expect(assetUrl('/aurora', 'favicon.svg')).toBe('/aurora/favicon.svg')
  })

  it('空 / 未定义 base 退化为相对（file:// 下仍可加载）', () => {
    expect(assetUrl(undefined, 'favicon.svg')).toBe('./favicon.svg')
    expect(assetUrl('', 'favicon.svg')).toBe('./favicon.svg')
  })

  it('传入带前导斜杠的文件名不会拼出双斜杠', () => {
    expect(assetUrl('./', '/favicon.svg')).toBe('./favicon.svg')
    expect(assetUrl('/', '/favicon.svg')).toBe('/favicon.svg')
  })
})
