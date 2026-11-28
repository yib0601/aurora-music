import path from 'node:path'

/**
 * 已扫描目录白名单（主进程内存态）。
 *
 * 单独成模块的唯一理由：`handlers.ts` 一旦被 import 就会拉起扫描器、插件宿主、
 * 更新器一整套依赖（见 `libraryActions.ts` 顶部同样的说明），而「这个路径是不是
 * 用户授权的扫描目录之内」这条判断，现在有**两个**通道要用 ——
 * `fs:readFile` / `fs:readDir` 的读白名单，以及「批量替换」里清理原加密文件的
 * 写/删白名单。把它留在 handlers 里，后者就只能靠 import handlers 拿到，
 * 那条通道也就永远无法单独测试。
 *
 * 语义只有一条：**渲染层能碰的文件，只能是它自己扫过的目录里的文件**。
 * 白名单在扫描成功时登记、用户移除扫描目录时撤销。
 */
const allowedRoots = new Set<string>()

/** 登记一个扫描根（扫描开始时调用；重复登记无副作用） */
export function registerScanRoot(root: string): void {
  if (typeof root !== 'string' || !root) return
  allowedRoots.add(path.resolve(root))
}

/** 撤销一个扫描根（用户移除目录时调用） */
export function unregisterScanRoot(root: string): void {
  if (typeof root !== 'string' || !root) return
  allowedRoots.delete(path.resolve(root))
}

/**
 * 目标是否落在某个已登记扫描根之内。
 *
 * 用 `path.relative` 而不是字符串前缀比较：前缀比较在 `..` 段上会被绕过
 * （`/music/../../etc/passwd` 仍然以 `/music` 开头），而 relative 出来的结果
 * 只要以 `..` 开头或仍是绝对路径，就说明越界。
 */
export function isInsideScanRoot(target: string): boolean {
  if (typeof target !== 'string' || !target) return false
  const resolved = path.resolve(target)
  for (const root of allowedRoots) {
    const rel = path.relative(root, resolved)
    if (!rel) continue // 正好等于根目录本身：那是目录，不是文件
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue
    return true
  }
  return false
}
