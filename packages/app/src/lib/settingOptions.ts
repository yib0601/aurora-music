import type { AudioFocusYieldBehavior } from '@aurora/shared'
import type { DownloadQuality } from '@/types'

/**
 * 设置页选项组的「默认值 + 展示顺序」单一来源。
 *
 * ## 顺序约定：默认档恒排最左
 *
 * 每个选项组的**默认选项一律是数组第 0 项**（设置页里即最左边那一格）。
 * 理由有两条：
 *   1. 用户扫读一组胶囊时，左起第一格天然被当成"出厂状态"，默认值藏在最右
 *      等于让最常用的那一档最难找（本轮之前的主题就是这样：默认深色，却把
 *      「跟随系统」排在第三格）；
 *   2. 默认值散落在 store 初值、首屏脚本、i18n 文案几处时，改默认只改一半
 *      就会「默认值」与「最左那一格」打架。这里把两者钉在一起，顺序数组的
 *      首项必须等于对应的默认值，由 `__tests__/settingOptions.test.ts` 守护。
 *
 * 非默认档保持原有相对顺序（只把默认档提到最前），避免一次改动顺带重排
 * 用户已经记住的位置。
 */

/** 主题档位（深色 / 浅色 / 跟随系统） */
export type ThemePreference = 'light' | 'dark' | 'system'

/**
 * 主题默认档：跟随系统。
 *
 * 为什么不锁死深色：应用外观应当跟着系统走——用户晚上切到深色、白天切回浅色时，
 * 播放器不必再去设置里手动改一遍。用户显式选过深/浅之后才偏离这个默认。
 */
export const DEFAULT_THEME: ThemePreference = 'system'

/** 主题档位展示顺序：默认（跟随系统）在最左，其余保持深色 → 浅色的原顺序 */
export const THEME_OPTION_ORDER: readonly ThemePreference[] = ['system', 'dark', 'light']

/**
 * 下载音质默认档：无损 FLAC。
 *
 * 与歌源协议的 `{quality}` 占位符、`qualityUrls` 的键同名（`'128' | '320' | 'flac'`）。
 * v4 起即为默认值；这里收进常量后，store 初值与设置页顺序不会再各写一份。
 */
export const DEFAULT_DOWNLOAD_QUALITY: DownloadQuality = 'flac'

/** 下载音质档位展示顺序：默认（无损 FLAC）在最左，其余保持标准 → 高品质的原顺序 */
export const DOWNLOAD_QUALITY_OPTION_ORDER: readonly DownloadQuality[] = ['flac', '128', '320']

/**
 * 「其他应用播放声音时」档位顺序：默认（暂停本应用 = 让位）在最左。
 *
 * 默认值本身在 `@aurora/shared` 的 `DEFAULT_AUDIO_FOCUS_YIELD_BEHAVIOR`：
 * 它是跨端契约（桌面主进程 / Android 原生引擎都按它归一化），不能只住在前端常量里。
 * 这里只负责「展示顺序」，并由 settingOptions.test.ts 钉住「首项 === 默认值」。
 */
export const AUDIO_FOCUS_YIELD_OPTION_ORDER: readonly AudioFocusYieldBehavior[] = ['pause', 'continue']
