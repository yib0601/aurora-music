import { toErrorInfo, translateError, type TFunction } from '@aurora/shared'
import { appTranslate } from '@/i18n'
import { pickDownloadUrl } from '@/lib/onlineTrack'
import type { Track, DownloadQuality, OnlineSourceConfig } from '@/types'

/**
 * 「用户主动中止」的判据：既不算失败、也不报错。
 *
 * 主判据是**结构化错误的码**——主进程（保存对话框取消）与移动端（未授予存储权限）
 * 现在抛的都是 `AuroraError`，跨 IPC 后仍能解析出码，且码不随语言变化。
 * 另两条字面量是**旧 IPC 形态**的兼容（老版本主进程直接抛中文 message），
 * 用 Unicode 转义书写：它们参与比较而非上屏，写成明文会被 i18n 扫描
 * 误判成「未国际化的界面文案」。
 */
const CANCELED_CODES: readonly string[] = [
  'desktop.error.download.canceled',
  'runtime.error.storagePermissionMissing',
]
// '\u5df2\u53d6\u6d88\u4fdd\u5b58' = 已取消保存；'\u7f3a\u5c11\u5b58\u50a8\u6743\u9650' = 缺少存储权限
const LEGACY_CANCELED_MESSAGES: readonly string[] = ['\u5df2\u53d6\u6d88\u4fdd\u5b58', '\u7f3a\u5c11\u5b58\u50a8\u6743\u9650']

function isCanceledError(err: unknown): boolean {
  if (CANCELED_CODES.includes(toErrorInfo(err).code)) return true
  const raw = err instanceof Error ? err.message : String(err ?? '')
  return LEGACY_CANCELED_MESSAGES.some((sentinel) => raw.includes(sentinel))
}

/** 下载结果：saved 已保存 / no-source 取不到地址 / cancelled 用户取消 / failed 下载失败 */
export type OnlineDownloadOutcome = 'saved' | 'no-source' | 'cancelled' | 'failed'

export interface OnlineDownloadDeps {
  /** 按需取址（同 ensurePlayableTrack）；取不到返回 null */
  resolveTrack: (track: Track) => Promise<Track | null>
  /** 实际下载，返回保存路径 */
  downloadFile: (
    payload: { audioUrl: string; title: string; artist?: string; album?: string; coverUrl?: string },
    headers: Record<string, string> | undefined,
    downloadDir: string | undefined
  ) => Promise<{ savedPath: string }>
  /** 读取下载相关配置（音源表 / 默认下载目录 / 下载音质） */
  config: () => { sources: OnlineSourceConfig[]; downloadDir: string | null; quality: DownloadQuality }
  /** 桌面端：未设默认目录时下载走保存对话框，完成后给「设为默认下载目录」入口 */
  isDesktop: boolean
  /** 终态提示（进行中的「正在下载…」由调用方自己发） */
  notify: (
    message: string,
    options?: { type?: 'success' | 'error'; action?: { label: string; onClick: () => void } }
  ) => void
  setDownloadDir: (dir: string) => void
}

/**
 * 下载一首在线歌曲的完整流程（与 UI 解耦，依赖注入便于单测）。
 *
 * 关键点：**下载前必须重新取址**。曲目对象可能来自「最近播放 / 导入歌单 / 重启后的
 * 播放队列」，这些快照按约定剥离了 onlineUrl——歌源直链几十分钟即过期，落盘必失效。
 * 老实现拿 track.onlineUrl 当开关，导致这类在线歌曲既没有下载入口、也下不了；
 * 现在判据（isDownloadableOnlineTrack）与取址都不依赖 track 上是否已有地址。
 *
 * 取到的地址命中别的音源时，完成提示里如实标注，避免用户以为下载的是列表里那一条。
 */
export async function runOnlineDownload(track: Track, deps: OnlineDownloadDeps): Promise<OnlineDownloadOutcome> {
  // 文案在**显示地**渲染：本函数没有渲染周期（下载完成时组件可能早已卸载），
  // 所以用 appTranslate() 读当前语言快照——不是模块级求值，切语言后立刻生效。
  const t = appTranslate()
  let resolved = track
  try {
    resolved = (await deps.resolveTrack(track)) || track
  } catch {
    // 取址本身失败（网络/源异常）不阻断：已有地址时直接下载，没有地址则走下面的提示
    resolved = track
  }

  if (!resolved.onlineUrl) {
    deps.notify(t('hall.download.noSource'), { type: 'error' })
    return 'no-source'
  }

  const { sources, downloadDir, quality } = deps.config()
  const source = sources.find((s) => s.id === resolved.onlineSource)
  const sourceSwitched =
    !!track.onlineSourceName &&
    !!resolved.onlineSourceName &&
    resolved.onlineSourceName !== track.onlineSourceName

  try {
    const { savedPath } = await deps.downloadFile(
      // 带上专辑与封面地址：下载完成后封面随文件嵌入（源直链的音频大多无内嵌封面）
      {
        audioUrl: pickDownloadUrl(resolved, quality),
        title: resolved.title,
        artist: resolved.artist,
        album: resolved.album,
        coverUrl: resolved.coverUrl,
      },
      source?.headers,
      downloadDir || undefined
    )

    // 实际取到的地址来自别的音源时，整句换成带「音源：」的那一条。
    // 刻意不做「主句 + 备注」的拼接：英文语序与标点都不同，拼出来的句子迟早翻车。
    const savedMessage = sourceSwitched
      ? t('hall.download.savedWithSource', { path: savedPath, name: resolved.onlineSourceName ?? '' })
      : t('hall.download.saved', { path: savedPath })

    if (downloadDir || !deps.isDesktop) {
      deps.notify(savedMessage)
    } else {
      // 桌面端本次走了保存对话框：提供「设为默认下载目录」操作，点击后不再每次询问。
      // 移动端没有这个快捷入口——移动端的下载目录是手机存储内的相对路径，
      // 从绝对保存路径反推会存成绝对路径，配置统一走「设置 → 下载 → 默认下载目录」。
      const dir = savedPath.replace(/[\\/][^\\/]*$/, '')
      deps.notify(savedMessage, {
        action: {
          label: t('hall.download.setDefaultDir'),
          onClick: () => {
            deps.setDownloadDir(dir)
            deps.notify(t('hall.download.defaultDirSaved', { dir }))
          },
        },
      })
    }
    return 'saved'
  } catch (err) {
    // 用户在保存对话框点了取消、或没给存储权限，都不算失败，不报错
    if (isCanceledError(err)) return 'cancelled'
    // 没识别出来的错误交给内核渲染：结构化错误按码出文案，其余原样透出（不吞信息）。
    // 断言说明：translateError 的形参是内核的通配 `TFunction`（键类型是 string），
    // AppTranslator 的键类型是具体字面量联合，函数参数逆变导致窄键翻译器传不进宽键形参；
    // 运行期完全一致（键的合法性已在各自调用点由 AppTranslator 守住）。
    deps.notify(translateError(err, t), { type: 'error' })
    return 'failed'
  }
}