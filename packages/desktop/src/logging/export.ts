/**
 * 日志导出包里与文件系统无关的那部分逻辑（拼装、命名、落盘）。
 *
 * 之所以从 ipc/logging.ts 里分出来：IPC 层一旦 import electron 就无法在单测里跑，
 * 而「文件名重名不能覆盖用户文件」「分段顺序必须旧→新」恰恰是最容易出错、
 * 也最该被单测守住的两处。把纯逻辑放这里，测试直接调，不必 mock 整个 Electron。
 */

import fs from 'fs'
import path from 'path'
import {
  buildLogBundle,
  logBundleFileName,
  type LogBundleResult,
  type LogEnvironment,
  type LogExportResult,
  type LogFilePart,
} from '@aurora/shared'

/** 重名时最多试多少个后缀：足够避开同一秒内重复点击，又不会无限循环 */
const MAX_NAME_ATTEMPTS = 50

/**
 * 第 N 个候选文件名（N 从 0 起）。
 *
 * 后缀放在扩展名之前（`…-021500-2.txt`），而不是整名后面追加（`….txt-2`）：
 * 后者会让文件管理器不再按 .txt 识别，用户双击打不开。
 */
export function candidateFileName(fileName: string, attempt: number): string {
  if (attempt <= 0) return fileName
  const ext = path.extname(fileName)
  const stem = fileName.slice(0, fileName.length - ext.length)
  return `${stem}-${attempt + 1}${ext}`
}

/**
 * 拼装导出包（不落盘）。
 *
 * 覆盖范围与字节数从**实际拼出来的文本**算，而不是加总文件大小：
 * 环境头、分隔线、被补上的尾换行都会改变最终体积，两者差几百字节时，
 * 界面上「导出了 1.2 MB」与文件真实大小对不上会被当成 bug 报上来。
 */
export function composeLogBundle(env: LogEnvironment, files: LogFilePart[]): LogBundleResult {
  const content = buildLogBundle(env, files)
  return {
    // 文件名与 exportFile 用同一条规则生成：预览时显示的默认文件名要和真正落盘的一致
    fileName: logBundleFileName(env.appVersion, env.exportedAt),
    content,
    fileCount: files.length,
    totalBytes: Buffer.byteLength(content, 'utf8'),
  }
}

/**
 * 把导出包写到目录里，**绝不覆盖已有文件**。
 *
 * 用 `flag: 'wx'`（存在即失败）而不是先 exists 再 write：
 * 预检查与写入之间的竞态窗口里，用户完全可能刚拖进来一个同名文件，
 * 那一步就会把用户自己的文件冲掉。让内核来判「这个路径是不是空位」才是原子的。
 * 命中 EEXIST 就换下一个后缀重试，其它错误（磁盘满、目录只读）原样抛出交给上层处理 ——
 * 日志导出失败必须让用户看到，静默失败等于告诉他「导出了」但其实没有。
 */
export function writeLogBundle(dir: string, fileName: string, content: string): LogExportResult {
  fs.mkdirSync(dir, { recursive: true })
  const bytes = Buffer.byteLength(content, 'utf8')
  for (let attempt = 0; attempt < MAX_NAME_ATTEMPTS; attempt += 1) {
    const filePath = path.join(dir, candidateFileName(fileName, attempt))
    try {
      fs.writeFileSync(filePath, content, { encoding: 'utf8', flag: 'wx' })
      return { filePath, dir, bytes }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'EEXIST') continue
      throw err
    }
  }
  throw new Error('failed to allocate a unique log bundle file name')
}
