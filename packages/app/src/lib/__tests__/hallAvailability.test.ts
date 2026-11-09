import { describe, expect, it } from 'vitest'
import { Clock, Heart, Library, Radio } from 'lucide-react'
import type { OnlineSourceConfig } from '@aurora/shared'
import { hallAvailabilityOf } from '../hallAvailability'
import { homeRoute, isHallRoute, NAV_LABEL_KEYS, ROUTES, visibleNavItems, type NavItem } from '../routes'

/**
 * 「音乐库入口该不该出现」的判据是**一处**：`hallAvailabilityOf`。
 * 侧栏、移动端抽屉、主屏落点、音乐库页面空态都从它派生，所以这里把它
 * 当接口边界测：给定音源配置与平台能力，返回的枚举必须唯一且稳定。
 *
 * 用真 `canBrowseHall`（不 mock）：它判的是「当前注册的插件能不能发现内容」，
 * mock 掉就等于把被测口径换成了假会通过的常理，插件注册表一变这条测试却仍绿。
 * 内置 aurora 插件声明了 recommendPlaylists/toplists，所以无 pluginId 的
 * 老配置（回落 DEFAULT_PLUGIN_ID）应判可发现——这正是既有用户最常见的配置形态。
 */

/** 一条最普通的老配置：没有 pluginId，靠回落落到内置 aurora 插件 */
const auroraSource: OnlineSourceConfig = {
  id: '00000000-0000-0000-0000-000000000001',
  name: 'Test Source',
  sourceUrl: 'https://api.example.com',
  enabled: true,
} as OnlineSourceConfig

/** 只搜索不发现（lx 没有推荐/排行榜能力） */
const searchOnlySource = { ...auroraSource, id: '00000000-0000-0000-0000-000000000002', pluginId: 'lx' } as OnlineSourceConfig

describe('hallAvailabilityOf', () => {
  it('平台没有在线能力时直接判不支持，与音源配置无关', () => {
    expect(hallAvailabilityOf([auroraSource], false)).toBe('unsupportedEnv')
    expect(hallAvailabilityOf([], false)).toBe('unsupportedEnv')
    expect(hallAvailabilityOf(undefined, false)).toBe('unsupportedEnv')
  })

  it('没有任何音源 → noSource', () => {
    expect(hallAvailabilityOf([], true)).toBe('noSource')
    expect(hallAvailabilityOf(null, true)).toBe('noSource')
    expect(hallAvailabilityOf(undefined, true)).toBe('noSource')
  })

  it('音源全部停用 → allDisabled', () => {
    expect(hallAvailabilityOf([{ ...auroraSource, enabled: false }], true)).toBe('allDisabled')
    expect(
      hallAvailabilityOf(
        [
          { ...auroraSource, enabled: false },
          { ...searchOnlySource, enabled: false },
        ],
        true,
      ),
    ).toBe('allDisabled')
  })

  it('有启用的音源但都不支持在线发现 → sourceUnsupported', () => {
    // lx 只有搜索/解析能力，没有 recommendPlaylists/toplists
    expect(hallAvailabilityOf([searchOnlySource], true)).toBe('sourceUnsupported')
    // 停用的那条不参与判定：只要还有一条能发现就算 ok（下面），这里全部不能发现
    expect(hallAvailabilityOf([searchOnlySource, { ...searchOnlySource, id: 'x', enabled: false }], true)).toBe(
      'sourceUnsupported',
    )
  })

  it('启用且能发现内容 → ok', () => {
    expect(hallAvailabilityOf([auroraSource], true)).toBe('ok')
    // 一条不能发现 + 一条能发现：整体可用（用户仍能进音乐库）
    expect(hallAvailabilityOf([searchOnlySource, auroraSource], true)).toBe('ok')
  })

  it('enabled 缺省视为启用，与选源口径一致', () => {
    const legacy = { ...auroraSource } as OnlineSourceConfig
    delete (legacy as { enabled?: boolean }).enabled
    expect(hallAvailabilityOf([legacy], true)).toBe('ok')
  })
})

describe('homeRoute', () => {
  it('音乐库可用时主屏是音乐库', () => {
    expect(homeRoute(true)).toBe(ROUTES.hall)
  })

  it('音乐库不可用时主屏回落到我的音乐', () => {
    expect(homeRoute(false)).toBe(ROUTES.library)
  })
})

describe('isHallRoute', () => {
  it('发现页与两类详情页都算音乐库路由', () => {
    expect(isHallRoute(ROUTES.hall)).toBe(true)
    expect(isHallRoute('/hall/playlist/diss-123')).toBe(true)
    expect(isHallRoute('/hall/toplist/26')).toBe(true)
  })

  it('其他页面不算', () => {
    expect(isHallRoute(ROUTES.library)).toBe(false)
    expect(isHallRoute(ROUTES.liked)).toBe(false)
    expect(isHallRoute(ROUTES.settings)).toBe(false)
    expect(isHallRoute('/song/abc')).toBe(false)
    expect(isHallRoute('/playlist/abc')).toBe(false)
    expect(isHallRoute('/')).toBe(false)
  })

  it('多一层路径不算命中（交给 404，而不是误判成音乐库）', () => {
    expect(isHallRoute('/hall/playlist/diss-123/extra')).toBe(false)
    expect(isHallRoute('/hall/unknown')).toBe(false)
  })
})

describe('visibleNavItems', () => {
  const items: NavItem[] = [
    { to: ROUTES.hall, icon: Radio, labelKey: NAV_LABEL_KEYS.hall },
    { to: ROUTES.library, icon: Library, labelKey: NAV_LABEL_KEYS.library },
    { to: ROUTES.liked, icon: Heart, labelKey: 'nav.item.liked' },
    { to: ROUTES.recent, icon: Clock, labelKey: 'nav.item.recent' },
  ]

  it('可用时原样返回（含顺序）', () => {
    expect(visibleNavItems(items, true).map((item) => item.to)).toEqual([
      ROUTES.hall,
      ROUTES.library,
      ROUTES.liked,
      ROUTES.recent,
    ])
  })

  it('不可用时只隐藏音乐库，其余顺序不变', () => {
    expect(visibleNavItems(items, false).map((item) => item.to)).toEqual([
      ROUTES.library,
      ROUTES.liked,
      ROUTES.recent,
    ])
  })

  it('不改动传入的表（模块级常量被多处引用）', () => {
    const before = items.map((item) => item.to)
    visibleNavItems(items, false)
    expect(items.map((item) => item.to)).toEqual(before)
  })
})
