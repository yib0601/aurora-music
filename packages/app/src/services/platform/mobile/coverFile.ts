/**
 * 封面临时文件的落盘工具（本地扫描与远端来源共用）。
 *
 * 两处封面来源形态不同 —— 本地扫描的字节来自 `Filesystem` 流式读出的整文件，
 * 远端来源的字节来自一次带 `Range` 的头段读取 —— 但**落盘这件事一模一样**：
 * 目录 `aurora-music/covers/`（应用私有目录，无需存储权限）、文件名 `<trackId><ext>`、
 * 写 base64、再把 `file://` 转成 WebView 可加载的地址存进 `coverPath`。
 *
 * 抽出来只有一个理由：三份拷贝（桌面端主进程一份、本地扫描一份、远端来源还要一份）
 * 迟早会走散。`coverPath` 的语义是"UI 层 `getCoverSrc` 原样返回即可"，
 * 一旦某一处忘了 `convertFileSrc`，症状是封面全空 —— 而那种 bug 很难从代码上看出来。
 */

import { Capacitor } from '@capacitor/core'
import { Directory, Filesystem } from '@capacitor/filesystem'

/** 封面缓存目录（相对 `Directory.Data`） */
export const COVERS_DIR = 'aurora-music/covers'

/**
 * 判断封面扩展名：以**真实字节**为准，声明类型仅作兜底。
 * 部分打标工具会把 PNG 封面声明成 image/jpeg，只信 `pic.format` 会存错扩展名。
 */
export function coverExtensionFor(data: Uint8Array, declaredFormat?: string): string {
  if (data && data.length >= 12) {
    if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return '.jpg'
    if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return '.png'
    if (
      data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46 &&
      data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50
    ) {
      return '.webp'
    }
    if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) return '.gif'
    if (data[0] === 0x42 && data[1] === 0x4d) return '.bmp'
  }
  const m = (declaredFormat || '').toLowerCase()
  if (m.includes('png')) return '.png'
  if (m.includes('webp')) return '.webp'
  if (m.includes('gif')) return '.gif'
  if (m.includes('bmp')) return '.bmp'
  return '.jpg'
}

/** trackId 同时是文件名：只允许字母数字与连字符，杜绝路径穿越 */
const TRACK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/

/** 封面缓存文件的相对路径（`Directory.Data` 下）；trackId 非法时抛错 */
async function coverCachePath(trackId: string, ext: string): Promise<string> {
  if (!TRACK_ID_PATTERN.test(trackId)) {
    // 开发者不变量（trackId 由内部生成），不是界面文案
    throw new Error(`非法 trackId: ${trackId}`) // i18n-exempt: 内部不变量，不进界面
  }
  try {
    await Filesystem.mkdir({ path: COVERS_DIR, directory: Directory.Data, recursive: true })
  } catch (err: any) {
    // 目录已存在不报错
    if (err?.message && !/exist/i.test(err.message)) throw err
  }
  return `${COVERS_DIR}/${trackId}${ext}`
}

/**
 * 把一张封面写进缓存目录，返回可直接塞进 `<img src>` 的地址。
 *
 * 返回值是 `coverPath` 的**唯一合法形态**（`Capacitor.convertFileSrc` 之后）：
 * `Filesystem.getUri` 给的是 `file:///data/data/<pkg>/files/...`，WebView 里不能直接读，
 * 必须转成 `https://localhost/_capacitor_file_/...`。
 * 写失败时抛错，由调用方决定这是"本曲无封面"还是"本次失败、下次重试"。
 */
export async function saveCoverImage(
  trackId: string,
  data: Uint8Array,
  declaredFormat?: string
): Promise<string> {
  const dest = await coverCachePath(trackId, coverExtensionFor(data, declaredFormat))
  let bin = ''
  const chunk = 0x8000
  for (let i = 0; i < data.length; i += chunk) {
    bin += String.fromCharCode.apply(null, data.subarray(i, i + chunk) as any)
  }
  await Filesystem.writeFile({
    path: dest,
    directory: Directory.Data,
    data: btoa(bin),
    recursive: true,
  })
  const { uri } = await Filesystem.getUri({ path: dest, directory: Directory.Data })
  return Capacitor.convertFileSrc(uri)
}
