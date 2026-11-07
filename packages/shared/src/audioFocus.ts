/**
 * 音频焦点：**其他应用出声时本应用怎么办**。
 *
 * 这个取值是跨端共用的（桌面主进程的互斥状态机、Android 原生引擎、渲染层设置页
 * 都认它），所以放在 shared 而不是各端各写一份字符串——两端一旦漂移，
 * 表现是「设置页选了继续播放，桌面生效、车机却照样暂停」这类只在单端复现的问题。
 *
 * 语义：
 *   'pause'    让位：暂停本应用，对方安静后（桌面端）自动续播。默认值，也是历史行为。
 *   'continue' 继续播放：别的应用出声不打断本应用（桌面端不抢占回来；Android 忽略
 *              焦点丢失）。代价是两边声音会叠加，或系统把本应用的输出压低/切走——
 *              这是用户显式选择的结果。
 */
export type AudioFocusYieldBehavior = 'pause' | 'continue'

/** 默认让位：保持与「互斥」开关上线时一致的行为，不改变老用户的听觉习惯 */
export const DEFAULT_AUDIO_FOCUS_YIELD_BEHAVIOR: AudioFocusYieldBehavior = 'pause'

/**
 * 把外部输入（持久化数据 / IPC / 插件参数）归一化成合法取值。
 *
 * 只认严格 'continue'，其余一律回落到 'pause'：设置项写坏时宁可回到「让位」
 * （有既定自愈逻辑：对方安静后自动续播），也不要进入一个没人验证过的第三态。
 */
export function normalizeAudioFocusYieldBehavior(value: unknown): AudioFocusYieldBehavior {
  return value === 'continue' ? 'continue' : 'pause'
}
