/**
 * Android Keystore 加密通道（Capacitor 原生插件 `SecureStorage` 的 JS 侧）。
 *
 * ## 为什么需要它
 *
 * 网络存储的口令必须落盘（否则每次启动都要重输），而手机上没有桌面端
 * `safeStorage` 那样的 keyring。此前的做法是"写进应用私有目录、不加密"，
 * 并且如实告诉用户"未加密"。要真正加密，只有一条路：Android Keystore ——
 * 密钥由系统 TEE/StrongBox 持有、只对本应用可用、不可导出，密文落盘也没有意义。
 *
 * ## 能力缺失用「方法不存在」表达（与项目其余处一致）
 *
 * 插件没注册（老包、iOS、单测的 node 环境）时 `plugin()` 返回 null，
 * 调用方退回"明文落盘 + 标注未加密"的老行为，**不抛错**：
 * 一条加密能力缺失不该让"保存口令"整件事失败。
 *
 * ## 明文只在本进程内存里出现
 *
 * `encrypt` / `decrypt` 的入参出参都是字符串，经 Capacitor 桥过 JNI；
 * JS 侧不缓存任何解密结果，调用方拿到的配置副本用后即弃（见 `storage.ts`：
 * 口令只在调用插件前的一瞬间并进配置，不进 localStorage、不进日志）。
 */

/** 原生插件暴露的方法集合形状（`window.Capacitor.Plugins.SecureStorage`） */
interface SecureStoragePlugin {
  isAvailable(): Promise<{ available?: boolean }>
  encrypt(options: { plaintext: string }): Promise<{ value?: string }>
  decrypt(options: { value: string }): Promise<{ plaintext?: string }>
}

function secureStoragePlugin(): SecureStoragePlugin | null {
  // 单测跑在 node 环境（没有 window）：这里必须容忍它缺失，
  // 否则一次 `window is not defined` 会把口令读写整条路打挂
  if (typeof window === 'undefined') return null
  const cap = (window as unknown as { Capacitor?: { Plugins?: Record<string, unknown> } }).Capacitor
  const plugin = cap?.Plugins?.SecureStorage as SecureStoragePlugin | undefined
  if (!plugin || typeof plugin.encrypt !== 'function' || typeof plugin.decrypt !== 'function') {
    return null
  }
  return plugin
}

/** 能力探测结果缓存：`isAvailable` 首次调用要碰 KeyStore，不值得每次读写都问一遍 */
let availablePromise: Promise<boolean> | null = null

/**
 * 本机是否具备 Keystore 加密能力。
 *
 * 判据全在原生侧（API 级别 ≥ 23、KeyStore 可用、密钥可创建），JS 不做版本推断：
 * 版本判断写两处必然走散，而真正会失败的是原生调用本身。
 */
export function keystoreAvailable(): Promise<boolean> {
  if (!availablePromise) {
    const plugin = secureStoragePlugin()
    if (!plugin || typeof plugin.isAvailable !== 'function') {
      availablePromise = Promise.resolve(false)
    } else {
      availablePromise = plugin
        .isAvailable()
        .then((result) => result?.available === true)
        .catch((err) => {
          console.warn('[SecureStorage] 能力探测失败，按不可用处理:', err)
          return false
        })
    }
  }
  return availablePromise
}

/** 加密一段明文，返回可直接落盘的密文串（`iv||ciphertext` 的 base64） */
export async function keystoreEncrypt(plaintext: string): Promise<string | null> {
  const plugin = secureStoragePlugin()
  if (!plugin) return null
  try {
    const result = await plugin.encrypt({ plaintext })
    const value = typeof result?.value === 'string' ? result.value : ''
    return value || null
  } catch (err) {
    console.warn('[SecureStorage] 加密失败:', err)
    return null
  }
}

/**
 * 解密一段密文；失败返回 null（调用方按"口令不可用"处理）。
 *
 * 失败的真实来源通常是**密钥已失效**：用户恢复备份、清数据、换机后重新安装，
 * 密文还在而 Keystore 里的密钥已经没了。这时唯一正确的做法是让用户重填口令 ——
 * 所以这里不抛错、也不假装成功，把决定权交给调用方。
 */
export async function keystoreDecrypt(value: string): Promise<string | null> {
  const plugin = secureStoragePlugin()
  if (!plugin) return null
  try {
    const result = await plugin.decrypt({ value })
    const plaintext = typeof result?.plaintext === 'string' ? result.plaintext : ''
    return plaintext || null
  } catch (err) {
    console.warn('[SecureStorage] 解密失败:', err)
    return null
  }
}

/** 仅供单测重置能力缓存（生产路径不需要：能力在进程生命周期内不变） */
export function resetKeystoreProbe(): void {
  availablePromise = null
}
