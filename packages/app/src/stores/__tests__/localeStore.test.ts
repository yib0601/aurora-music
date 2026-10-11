import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 语言偏好与首屏契约的回归锁。
 *
 * 三件事必须锁住（它们分散在三个文件里，最容易各自漂移）：
 *   1. 偏好 → 实际语言的解析规则（`system` 跟随系统；显式值直接生效）；
 *   2. 持久化 key 名（`index.html` 的首屏脚本按字面量读同一个 key，改名即断链）；
 *   3. store 对脏值的防御（localStorage 与设置页都可能写入非法值）。
 */

/** 最小 localStorage 实现：zustand persist 只用 getItem/setItem/removeItem */
function stubLocalStorage(initial?: Record<string, string>) {
  const map = new Map<string, string>(Object.entries(initial ?? {}))
  const storage = {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value)
    },
    removeItem: (key: string) => {
      map.delete(key)
    },
    clear: () => map.clear(),
    key: (index: number) => [...map.keys()][index] ?? null,
    get length() {
      return map.size
    },
  }
  vi.stubGlobal('localStorage', storage)
  return { storage, map }
}

function stubNavigator(languages: string[]) {
  vi.stubGlobal('navigator', { languages, language: languages[0] })
}

beforeEach(() => {
  vi.resetModules()
  vi.unstubAllGlobals()
})

describe('语言偏好解析', () => {
  it('显式语言直接生效，不查系统', async () => {
    stubLocalStorage()
    stubNavigator(['fr-FR'])
    const { resolveLocale } = await import('@/stores/localeStore')
    expect(resolveLocale('zh-CN')).toBe('zh-CN')
    expect(resolveLocale('en')).toBe('en')
  })

  it('system 跟随 navigator.languages 的首个可识别语言', async () => {
    stubLocalStorage()
    stubNavigator(['fr-FR', 'en-GB', 'zh-CN'])
    const { resolveLocale, detectSystemLocale } = await import('@/stores/localeStore')
    expect(detectSystemLocale()).toBe('en')
    expect(resolveLocale('system')).toBe('en')
  })

  it('系统语言无法识别时落到默认语言（英文兜底）', async () => {
    stubLocalStorage()
    stubNavigator(['fr-FR', 'de-DE'])
    const { resolveLocale } = await import('@/stores/localeStore')
    expect(resolveLocale('system')).toBe('en')
  })

  it('只有 navigator.language 没有 languages 时也能判定', async () => {
    stubLocalStorage()
    vi.stubGlobal('navigator', { language: 'en-US' })
    const { detectSystemLocale } = await import('@/stores/localeStore')
    expect(detectSystemLocale()).toBe('en')
  })
})

describe('语言偏好持久化', () => {
  it('持久化 key 与 index.html 首屏脚本约定的字面量一致', async () => {
    stubLocalStorage()
    stubNavigator(['zh-CN'])
    const mod = await import('@/stores/localeStore')
    expect(mod.LOCALE_STORAGE_KEY).toBe('aurora-locale')
  })

  it('默认偏好是 system（新用户跟随系统，不锁死源语言）', async () => {
    stubLocalStorage()
    stubNavigator(['en-US'])
    const { useLocaleStore } = await import('@/stores/localeStore')
    expect(useLocaleStore.getState().language).toBe('system')
  })

  it('从持久化数据恢复偏好', async () => {
    stubLocalStorage({
      'aurora-locale': JSON.stringify({ state: { language: 'en' }, version: 1 }),
    })
    stubNavigator(['zh-CN'])
    const { useLocaleStore } = await import('@/stores/localeStore')
    expect(useLocaleStore.getState().language).toBe('en')
  })

  it('持久化数据被写脏时回落到 system，而不是把脏值塞进界面', async () => {
    stubLocalStorage({
      'aurora-locale': JSON.stringify({ state: { language: 'klingon' }, version: 1 }),
    })
    stubNavigator(['zh-CN'])
    const { useLocaleStore } = await import('@/stores/localeStore')
    expect(useLocaleStore.getState().language).toBe('system')
  })

  it('setLanguage 拒绝非法值', async () => {
    stubLocalStorage()
    stubNavigator(['zh-CN'])
    const { useLocaleStore } = await import('@/stores/localeStore')
    useLocaleStore.getState().setLanguage('en')
    expect(useLocaleStore.getState().language).toBe('en')
    useLocaleStore.getState().setLanguage('de' as never)
    expect(useLocaleStore.getState().language).toBe('en')
  })

  it('写入后 syncStorage 里的值可被首屏脚本原样解析', async () => {
    const { storage } = stubLocalStorage()
    stubNavigator(['zh-CN'])
    const { useLocaleStore } = await import('@/stores/localeStore')
    useLocaleStore.getState().setLanguage('en')
    const raw = storage.getItem('aurora-locale')
    expect(raw).toBeTruthy()
    const parsed = JSON.parse(raw as string)
    expect(parsed.state.language).toBe('en')
  })
})

describe('翻译函数跟随当前语言', () => {
  it('appTranslate() 输出随语言偏好切换而切换', async () => {
    stubLocalStorage()
    stubNavigator(['zh-CN'])
    const { useLocaleStore } = await import('@/stores/localeStore')
    const { appTranslate } = await import('@/i18n')
    expect(appTranslate()('common.action.confirm')).toBe('确定')
    useLocaleStore.getState().setLanguage('en')
    expect(appTranslate()('common.action.confirm')).toBe('Confirm')
  })

  it('显式语言覆盖系统语言', async () => {
    stubLocalStorage()
    stubNavigator(['en-US'])
    const { useLocaleStore } = await import('@/stores/localeStore')
    const { appTranslate } = await import('@/i18n')
    expect(appTranslate()('nav.item.settings')).toBe('Settings')
    useLocaleStore.getState().setLanguage('zh-CN')
    expect(appTranslate()('nav.item.settings')).toBe('设置')
  })
})
