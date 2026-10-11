import { describe, expect, it } from 'vitest'
import {
  DICTIONARIES,
  LOCALES,
  collectKeys,
  createAppTranslator,
  detectLocale,
  en,
  encodeErrorInfo,
  formatBytes,
  formatDuration,
  formatNumber,
  hasMessage,
  interpolate,
  matchLocale,
  normalizeLocale,
  parseErrorInfo,
  placeholdersOf,
  parseNativeMobileCode,
  stripIpcPrefix,
  toErrorInfo,
  translateError,
  zhCN,
} from '../index'
import type { Locale } from '../locale'

describe('locale 归一与探测', () => {
  it('把 zh 变体一律归到 zh-CN', () => {
    expect(normalizeLocale('zh')).toBe('zh-CN')
    expect(normalizeLocale('zh-Hans-CN')).toBe('zh-CN')
    expect(normalizeLocale('zh-Hant-TW')).toBe('zh-CN')
    expect(normalizeLocale('ZH_cn')).toBe('zh-CN')
  })

  it('把 en 变体一律归到 en', () => {
    expect(normalizeLocale('en')).toBe('en')
    expect(normalizeLocale('en-US')).toBe('en')
    expect(normalizeLocale('EN_gb')).toBe('en')
  })

  it('不支持的语言返回 null（交给调用方回退，而不是硬塞）', () => {
    expect(normalizeLocale('fr-FR')).toBeNull()
    expect(normalizeLocale('')).toBeNull()
    expect(normalizeLocale(undefined)).toBeNull()
    expect(normalizeLocale(42)).toBeNull()
  })

  it('按候选顺序取第一个能识别的语言', () => {
    expect(matchLocale(['fr-FR', 'en-GB', 'zh-CN'])).toBe('en')
    expect(matchLocale(['fr-FR', 'de'])).toBeNull()
  })

  it('全落空时退回默认语言', () => {
    expect(detectLocale(['fr-FR'])).toBe('en')
    expect(detectLocale(['en-AU'])).toBe('en')
  })
})

describe('翻译内核', () => {
  it('插值替换占位符，未提供的参数原样保留', () => {
    expect(interpolate('{a} 和 {b}', { a: '一', b: '二' })).toBe('一 和 二')
    expect(interpolate('{a} 和 {b}', { a: '一' })).toBe('一 和 {b}')
    expect(interpolate('无占位符')).toBe('无占位符')
  })

  it('复数：中文单形态、英文按 count 选形态', () => {
    const zh = createAppTranslator('zh-CN')
    const english = createAppTranslator('en')
    expect(zh('common.unit.songs', { count: 1 })).toBe('1 首歌')
    expect(zh('common.unit.songs', { count: 9 })).toBe('9 首歌')
    expect(english('common.unit.songs', { count: 1 })).toBe('1 song')
    expect(english('common.unit.songs', { count: 5 })).toBe('5 songs')
  })

  it('count 不是数字时不走复数分支（脏数据不把键查歪）', () => {
    const english = createAppTranslator('en')
    expect(english('common.unit.songs', { count: 'many' as unknown as number })).toBe('many songs')
  })

  it('缺键回退链：当前语言 → 另一种语言 → 键名', () => {
    const warned: string[] = []
    const translator = createAppTranslator('en', { onMissing: (key) => warned.push(key) })
    expect(translator('nav.item.settings')).toBe('Settings')
    // 越界键在类型层就被拦住，这里模拟运行时脏数据，验证不返回空串
    const outOfRange = (translator as unknown as (k: string) => string)('does.not.exist')
    expect(outOfRange).toBe('does.not.exist')
    expect(warned).toContain('does.not.exist')
  })

  it('hasMessage 能识别点号路径的存在性', () => {
    expect(hasMessage(zhCN as never, 'common.action.confirm')).toBe(true)
    expect(hasMessage(zhCN as never, 'common.action.nope')).toBe(false)
  })
})

describe('字典一致性（语言覆盖度门禁）', () => {
  /** 复数形态后缀：只有需要区分单复数的语言才会多出这些键 */
  const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/

  it('两种语言的命名空间集合相同', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zhCN).sort())
  })

  it('英文覆盖中文的每一个键，且多出的键只能是复数形态', () => {
    for (const [name, tree] of Object.entries(zhCN)) {
      const zhKeys = new Set(collectKeys(tree as never))
      const enKeys = new Set(collectKeys((en as Record<string, unknown>)[name] as never))
      const missing = [...zhKeys].filter((key) => !enKeys.has(key))
      expect(missing, `命名空间 ${name} 英文缺失键`).toEqual([])
      const extra = [...enKeys].filter((key) => !zhKeys.has(key))
      for (const key of extra) {
        expect(PLURAL_SUFFIX.test(key), `${name}.${key} 是中文侧不存在的多余键，且不是复数形态`).toBe(true)
        const base = key.replace(PLURAL_SUFFIX, '')
        expect(zhKeys.has(base), `${name}.${key} 没有对应的中文基键 ${base}`).toBe(true)
      }
    }
  })

  it('同一条文案的插值占位符集合一致（复数形态按基键比对）', () => {
    for (const [name, tree] of Object.entries(zhCN)) {
      const enNs = (en as Record<string, unknown>)[name] as Record<string, unknown>
      for (const key of collectKeys(tree as never)) {
        const zhValue = getByPath(tree as never, key)
        const enValue = getByPath(enNs, key)
        if (typeof zhValue !== 'string' || typeof enValue !== 'string') continue
        expect(placeholdersOf(enValue), `${name}.${key} 的占位符与中文不一致`).toEqual(placeholdersOf(zhValue))
      }
      // 复数形态：与基键的占位符一致（否则 {count} 会被漏掉，界面上出现 "1 "）
      const zhKeys = new Set(collectKeys(tree as never))
      for (const key of collectKeys(enNs as never)) {
        if (!PLURAL_SUFFIX.test(key)) continue
        const base = key.replace(PLURAL_SUFFIX, '')
        if (!zhKeys.has(base)) continue
        const enValue = getByPath(enNs, key)
        const zhValue = getByPath(tree as never, base)
        if (typeof zhValue !== 'string' || typeof enValue !== 'string') continue
        expect(placeholdersOf(enValue), `${name}.${key} 的占位符与基键不一致`).toEqual(placeholdersOf(zhValue))
      }
    }
  })

  it('任何一条文案都不为空串', () => {
    for (const locale of LOCALES) {
      const tree = DICTIONARIES[locale]
      for (const [name, ns] of Object.entries(tree)) {
        for (const key of collectKeys(ns as never)) {
          const value = getByPath(ns as never, key)
          expect(typeof value === 'string' && value.trim().length > 0, `${locale}.${name}.${key} 为空`).toBe(true)
        }
      }
    }
  })

  it('中文侧不重复写英文才需要的复数形态（避免双真源漂移）', () => {
    for (const [name, tree] of Object.entries(zhCN)) {
      const zhKeys = collectKeys(tree as never)
      for (const key of zhKeys) {
        if (!PLURAL_SUFFIX.test(key)) continue
        const base = key.replace(PLURAL_SUFFIX, '')
        expect(zhKeys.includes(base), `${name}.${key} 有复数形态却没有基键`).toBe(true)
      }
    }
  })
})

describe('Intl 格式化', () => {
  it('数字按语言分千分位', () => {
    expect(formatNumber(1234567, 'zh-CN')).toBe('1,234,567')
    expect(formatNumber(1234567, 'en')).toBe('1,234,567')
  })

  it('字节按 1024 进制并带单位', () => {
    expect(formatBytes(0, 'zh-CN')).toBe('0 B')
    expect(formatBytes(1024, 'zh-CN')).toBe('1 KB')
    expect(formatBytes(1536, 'zh-CN')).toBe('1.5 KB')
    expect(formatBytes(1048576, 'en')).toBe('1 MB')
  })

  it('时长不跟随语言（时间码形态固定）', () => {
    expect(formatDuration(0)).toBe('0:00')
    expect(formatDuration(65)).toBe('1:05')
    expect(formatDuration(3725)).toBe('1:02:05')
    expect(formatDuration(Number.NaN)).toBe('0:00')
  })
})

describe('结构化错误', () => {
  it('编码/解析往返保真', () => {
    const encoded = encodeErrorInfo({ code: 'sources.error.http', params: { status: 502 }, detail: 'HTTP 502' })
    expect(parseErrorInfo(encoded)).toEqual({ code: 'sources.error.http', params: { status: 502 }, detail: 'HTTP 502' })
  })

  it('剥掉 Electron 的 remote 前缀', () => {
    expect(stripIpcPrefix("Error invoking remote method 'hall:recommend': Error: boom")).toBe('Error: boom')
    expect(stripIpcPrefix('普通消息')).toBe('普通消息')
  })

  it('AbortError 归到超时（跨 IPC 后 name 已退化，只能靠 message）', () => {
    expect(toErrorInfo(new Error('The operation was aborted.')).code).toBe('errors.network.timeout')
    expect(
      toErrorInfo(new Error("Error invoking remote method 'hall:recommend': AbortError: The operation was aborted."))
        .code
    ).toBe('errors.network.timeout')
  })

  it('网络层英文错误归到不可达', () => {
    expect(toErrorInfo(new Error('TypeError: Failed to fetch')).code).toBe('errors.network.unreachable')
  })

  it('带编码载荷的错误按码还原', () => {
    const encoded = encodeErrorInfo({ code: 'sources.error.timeout', params: { name: 'QQ Music' } })
    const info = toErrorInfo(new Error(`Error invoking remote method 'lx:search': Error: ${encoded}`))
    expect(info.code).toBe('sources.error.timeout')
    expect(info.params).toEqual({ name: 'QQ Music' })
  })

  it('空消息落到通用失败文案', () => {
    expect(toErrorInfo(new Error(''))).toEqual({ code: 'errors.unknown' })
  })

  it('英文界面下渲染英文错误文案', () => {
    const t = createAppTranslator('en')
    expect(translateError(new Error('The operation was aborted.'), t)).toMatch(/timed out/i)
    expect(translateError(new Error('TypeError: Failed to fetch'), t)).toMatch(/Network unreachable/i)
    expect(translateError(new Error(''), t)).toBe('Operation failed')
  })

  it('中文界面下渲染中文错误文案', () => {
    const t = createAppTranslator('zh-CN')
    expect(translateError(new Error('The operation was aborted.'), t)).toMatch(/超时/)
    expect(translateError(new Error('TypeError: Failed to fetch'), t)).toMatch(/网络不可达/)
  })

  it('Android 原生码映射到 mobile.* 键，且优先于关键词表', () => {
    // 含 404 的原生码若走关键词表会被判成「文件或目录不存在」，与真实原因无关
    expect(toErrorInfo(new Error('update_error_httpStatus?status=404'))).toMatchObject({
      code: 'mobile.update.error.httpStatus',
      params: { status: '404' },
    })
    // Capacitor 常见形态：reject 的文本被包了一层 Error:
    expect(toErrorInfo(new Error('Error: update_error_apkMissing')).code).toBe('mobile.update.error.apkMissing')
    expect(toErrorInfo(new Error('media_error_serviceNotRunning')).code).toBe('mobile.media.error.serviceNotRunning')
    expect(toErrorInfo(new Error('permission_error_settingsUnavailable?detail=no%20handler'))).toMatchObject({
      code: 'mobile.permission.error.settingsUnavailable',
      params: { detail: 'no handler' },
    })
  })

  it('长得很像原生码但不是的文本不会被误判', () => {
    expect(parseNativeMobileCode('update_')).toBeNull()
    expect(parseNativeMobileCode('something_error_else')).toBeNull()
    expect(parseNativeMobileCode('update_error_a b')).toBeNull()
    expect(toErrorInfo(new Error('some other failure')).code).toBe('errors.raw')
  })

  it('原生码在两语言下都能渲染出整句', () => {
    const zh = createAppTranslator('zh-CN')
    const english = createAppTranslator('en')
    const err = new Error('update_error_httpStatus?status=503')
    expect(translateError(err, zh)).toContain('503')
    expect(translateError(err, english)).toContain('503')
    expect(translateError(err, zh)).not.toContain('AURORA_ERR')
  })

  it('未识别的历史中文错误原样透出（不吞信息）', () => {
    const t = createAppTranslator('en')
    const raw = '音源「QQ_Music」返回 HTTP 502'
    expect(translateError(new Error(raw), t)).toBe(raw)
  })

  it('字典缺失的错误码退回通用句 + 细节，而不是把键名炸上屏', () => {
    const t = createAppTranslator('en')
    const msg = translateError(new Error(encodeErrorInfo({ code: 'nope.missing', detail: 'HTTP 500' })), t)
    expect(msg).toContain('Operation failed')
    expect(msg).not.toContain('nope.missing')
  })
})

/** 取点号路径（测试内部用，字典一致性断言需要逐键取值） */
function getByPath(tree: unknown, key: string): unknown {
  let node: unknown = tree
  for (const segment of key.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined
    node = (node as Record<string, unknown>)[segment]
  }
  return node
}

// 类型层校验：Locale 只认两种语言（防止有人在这里悄悄放开）
const _localeCheck: Locale[] = ['zh-CN', 'en']
void _localeCheck
