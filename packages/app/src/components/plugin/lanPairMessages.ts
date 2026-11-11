import type { AppTranslator, LanPairFailureReason } from '@aurora/shared'

/**
 * 配对失败的枚举 → 一句人话（`sync.pair.*`）。
 *
 * 单独一处而不是散在两个组件里：发起方（同步面板底部的「配对」）与应答方
 * （全局确认框）都会报同一种失败，两处各写一份 switch 必然走散。
 *
 * `unreachable` 要带 host:port、`unsupported` 要指向「手动填码」这条路，
 * 这两条是用户唯一能自己动手修的两种；其余只需要说清「发生了什么」。
 */
export function pairFailureText(
  t: AppTranslator,
  reason: LanPairFailureReason,
  peer?: { deviceName?: string; host?: string; port?: number }
): string {
  switch (reason) {
    case 'denied':
      return t('sync.pair.denied')
    case 'timeout':
      return t('sync.pair.timeout')
    case 'unreachable':
      return t('sync.pair.unreachable', {
        host: peer?.host ?? '',
        port: String(peer?.port ?? ''),
      })
    case 'unsupported':
      return t('sync.pair.unsupported')
    case 'self':
      return t('sync.pair.self')
    case 'busy':
      return t('sync.pair.busy')
    case 'invalid':
      return t('sync.pair.invalid')
    case 'cancelled':
      return t('sync.pair.cancelled')
    case 'auth':
    default:
      return t('sync.pair.auth')
  }
}
