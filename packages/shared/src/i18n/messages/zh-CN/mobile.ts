/**
 * 移动端原生桥（Android 原生插件回传的错误码文案）
 *
 * 本文件由**单一 owner** 独占编辑（另一语言版本在同名 en/ 目录下，同一人一起改），
 * 以免多人同时改同一个字典文件产生写冲突。
 *
 * 编写约定：
 * - 键名用英文小驼峰，按「页面/分组/词条」三层摆放，不要拍平成一层；
 * - 复数用键后缀：`xxx_one` / `xxx_other`（两种语言都要写，中文两份值相同）；
 * - 插值用 `{name}`，且**两种语言的占位符集合必须一致**（一致性测试会判红）；
 * - 这里只放**给人看的文案**。供匹配/比较用的领域数据（如 coverMatch 的
 *   繁简映射表、"未知艺术家" 这类参与匹配的占位值）不得进字典；
 * - 不要在这里写「{count} 首歌」以外的拼接式句子：需要拼接的用整句 + 占位符。
 *
 * 本域覆盖的是**原生侧给码、JS 侧出文案**这一段（Kotlin 抛出的中文句子已全部
 * 换成错误码）：
 * - 键路径 = `mobile.` + 码把 `_` 换成 `.`，段内小驼峰原样保留（这条映射**可逆**，
 *   不需要人工对照表）：`update_error_apkMissing` → `mobile.update.error.apkMissing`；
 * - 需要参数的码把参数以查询串附在码后（`?received=123&expected=456`，值已 URL 编码），
 *   JS 侧用 `URLSearchParams` 解出后传进 `t()`。
 *   两个插值示例：`update_error_httpStatus?status=404`、`media_error_serviceStartFailed?detail=...`。
 * - 解析实现与完整码清单见 `docs/development.md`「多语言开发」。
 *
 * 与 Android 资源的边界：原生**自己直接渲染**的文案（通知频道名、通知栏动作按钮）
 * 在 `packages/mobile/android/app/src/main/res/values{,-zh}/strings.xml`，
 * 与本文件互不重复——这里只处理「原生把码交给 JS、JS 渲染上屏」的那部分。
 */
const mobile = {
  /** 应用内更新（UpdatePlugin.kt 的 reject 与 progress().error） */
  update: {
    error: {
      /** 同一时刻只允许一个下载任务 */
      busy: '已有下载任务在进行中',
      /** 下载地址不是 https 白名单地址 */
      urlInvalid: '下载地址无效',
      /** 候选地址返回非 2xx（{status} 是 HTTP 状态码） */
      httpStatus: '服务器返回 HTTP {status}',
      /** 用户主动取消：是状态不是故障，JS 侧可原样透出 */
      canceled: '已取消',
      /** 收尾字节数校验失败（CDN 掐连接会把半截 APK 当成功） */
      incomplete: '下载不完整（{received}/{expected} 字节）',
      /** install() 未拿到可用的安装包路径 */
      pathInvalid: '安装包路径无效',
      /** 安装包已被清理或用户删除 */
      apkMissing: '安装包不存在，请重新下载',
      /** 调起系统安装器抛异常（{detail} 是异常原文，只进详情区） */
      launchFailed: '启动安装失败: {detail}',
      /** 「安装未知应用」授权页打不开（少数 ROM 不接受 deep link） */
      permissionSettings: '无法打开安装权限设置页: {detail}',
      /** 所有候选地址都失败且拿不到具体原因时的兜底 */
      downloadFailed: '下载失败',
    },
  },
  /** 原生播放引擎（MediaSessionPlugin.kt，引擎是 MediaPlaybackService） */
  media: {
    error: {
      /** 启动前台服务失败 */
      serviceStartFailed: '启动媒体服务失败: {detail}',
      /** 停止前台服务失败 */
      serviceStopFailed: '停止媒体服务失败: {detail}',
      /** 引擎尚未启动（Android 14+ 必须在用户触发播放后才允许启动） */
      serviceNotRunning: '媒体服务未启动',
      /** 下发队列并开播失败 */
      playQueueFailed: '设置播放队列失败: {detail}',
      /** 仅同步队列镜像（增删队列 / 切循环随机）失败 */
      syncQueueFailed: '同步队列失败: {detail}',
    },
  },
  /** 存储权限引导（PermissionPlugin.kt） */
  permission: {
    error: {
      /** 「所有文件访问」设置页打不开（deep link 与全局列表页都失败） */
      settingsUnavailable: '无法打开权限设置页: {detail}',
    },
  },
}

export default mobile
