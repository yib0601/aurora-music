/**
 * Vite 资源导入的类型声明。
 *
 * 本文件只声明**实际用到的**那一项：`?raw`（把文件内容读成字符串）。
 * 不引入 `vite/client` 的整套声明，因为那会把 `import.meta.env`、
 * 各种静态资源类型等一起放进来，掩盖"某个导入其实没有类型"的问题。
 *
 * 当前唯一用途：`services/platform/mobile/sandbox.ts` 把
 * `lxSandbox.worker.js` 读成字符串，再经 Blob 建成 Worker。
 */

declare module '*?raw' {
  const content: string
  export default content
}
