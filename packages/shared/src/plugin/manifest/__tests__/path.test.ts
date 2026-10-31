import { describe, expect, it } from 'vitest'
import { parsePath, readAtPath, valueAtPath, readString, readNumber, readBoolean } from '../path'

describe('parsePath：只接受三种语法成分', () => {
  it('属性、点号连接、下标', () => {
    expect(parsePath('a')).toEqual(['a'])
    expect(parsePath('a.b.c')).toEqual(['a', 'b', 'c'])
    expect(parsePath('a[0].b')).toEqual(['a', 0, 'b'])
    expect(parsePath('a[0][1]')).toEqual(['a', 0, 1])
    expect(parsePath('data.songs[3].artist')).toEqual(['data', 'songs', 3, 'artist'])
  })

  it('容忍首尾空白（作者常从 JSON 里带过来）', () => {
    expect(parsePath('  a.b  ')).toEqual(['a', 'b'])
  })

  it.each([
    ['', '空串'],
    ['   ', '纯空白'],
    ['.a', '开头点号'],
    ['a.', '结尾点号'],
    ['a..b', '连续点号'],
    ['a[', '未闭合下标'],
    ['a[]', '空下标'],
    ['a[foo]', '变量下标（这是表达式）'],
    ['a[-1]', '负数下标'],
    ['a?.b', '可选链'],
    ['a.b || c', '逻辑或'],
    ['$nodes', '$ 前缀（jq 风格，不是我们的语法）'],
    ['a.b()', '函数调用'],
    ["a['b']", '引号下标'],
  ])('拒绝 %s（%s）', (input) => {
    expect(parsePath(input)).toBeNull()
  })

  it('非字符串一律拒绝（清单来自 JSON，字段可能是任意类型）', () => {
    expect(parsePath(undefined)).toBeNull()
    expect(parsePath(null)).toBeNull()
    expect(parsePath(42)).toBeNull()
    expect(parsePath({ a: 1 })).toBeNull()
  })
})

describe('readAtPath：取不到就是 undefined，不抛错', () => {
  const data = { data: { songs: [{ title: 'A', artist: { name: 'B' } }] } }

  it('正常取值', () => {
    expect(readAtPath(data, ['data', 'songs', 0, 'title'])).toBe('A')
    expect(readAtPath(data, ['data', 'songs', 0, 'artist', 'name'])).toBe('B')
  })

  it('中途缺失 / 越界 / 类型不符都返回 undefined', () => {
    expect(readAtPath(data, ['data', 'nope'])).toBeUndefined()
    expect(readAtPath(data, ['data', 'songs', 9])).toBeUndefined()
    // 在非数组上下标：不是错误，是"取不到"
    expect(readAtPath(data, ['data', 0])).toBeUndefined()
    // 在数组上取属性
    expect(readAtPath(data, ['data', 'songs', 'title'])).toBeUndefined()
  })

  it('null / undefined 根对象安全', () => {
    expect(readAtPath(null, ['a'])).toBeUndefined()
    expect(readAtPath(undefined, ['a'])).toBeUndefined()
  })

  it('空路径返回根对象本身（调用方不该用它，但不制造意外）', () => {
    expect(readAtPath(data, [])).toBe(data)
  })
})

describe('valueAtPath：一步到位', () => {
  it('路径非法与取不到都返回 undefined（运行期同一种语义）', () => {
    expect(valueAtPath({ a: 1 }, 'a')).toBe(1)
    expect(valueAtPath({ a: 1 }, 'a?.b')).toBeUndefined()
    expect(valueAtPath({ a: 1 }, undefined)).toBeUndefined()
    expect(valueAtPath({ a: 1 }, '')).toBeUndefined()
  })
})

describe('标量读取：不做隐式转换', () => {
  it('readString 只认非空字符串', () => {
    expect(readString(' x ')).toBe('x')
    expect(readString('')).toBeUndefined()
    expect(readString('   ')).toBeUndefined()
    // 数字 0 是"有值"，但 readString 不隐式转换 —— 调用方靠这个区分"字段不存在"与"字段是 0"
    expect(readString(0)).toBeUndefined()
    expect(readString(123)).toBeUndefined()
    expect(readString(null)).toBeUndefined()
  })

  it('readNumber 接受数字与数字字符串', () => {
    expect(readNumber(42)).toBe(42)
    expect(readNumber('42')).toBe(42)
    expect(readNumber('3.5')).toBe(3.5)
    expect(readNumber('')).toBeUndefined()
    expect(readNumber('abc')).toBeUndefined()
    expect(readNumber(NaN)).toBeUndefined()
    expect(readNumber(Infinity)).toBeUndefined()
    expect(readNumber(true)).toBeUndefined()
  })

  it('readBoolean 只认真布尔（字符串 "true" 不当真）', () => {
    expect(readBoolean(true)).toBe(true)
    expect(readBoolean(false)).toBe(false)
    expect(readBoolean('true')).toBeUndefined()
    expect(readBoolean(1)).toBeUndefined()
  })
})
