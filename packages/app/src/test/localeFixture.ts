import { beforeEach } from 'vitest'
import { useLocaleStore } from '@/stores/localeStore'

/**
 * 单测语言夹具：把界面语言锁在源语言（中文），不跟着跑测试的机器走。
 *
 * 不锁会怎样（2026-10-08 那次 i18n 提交之后 CI 一直红，根因就是这条）：
 * `messageOf()` / `appTranslate()` 在不传翻译器时按**当前语言快照**出文案，
 * 当前语言 = localeStore 的偏好（默认 `system`）经 `detectSystemLocale()`
 * 读 `navigator.languages` 解析。Node 21 起全局 `navigator` 真实存在：
 * CI runner 是 en-US、开发者机器是 zh-CN，于是同一批「断言中文文案」的用例
 * 在两种机器上一个绿一个红。断言本身没错，错在它把宿主语言当成了夹具，
 * 而本项目的字典真值本来就以中文为源语言。
 *
 * 为什么锁 store 偏好而不是 stub 全局 navigator：
 * stub navigator 会连带影响其它读它的判定（平台识别、媒体能力探测等），
 * 而这里只需要固定语言。专门验「system 跟随系统语言」的用例不受影响 ——
 * 它们在 localeStore.test.ts 里自己 stub navigator 并直接调 resolveLocale()，
 * 与 store 偏好无关。
 *
 * 每例复位：用例自己切语言（errorMessage 那条验「默认参数跟随实时快照」的用例
 * 会临时切到 en）也不会漏给下一个用例。
 */
beforeEach(() => {
  useLocaleStore.setState({ language: 'zh-CN' })
})
