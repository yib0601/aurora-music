import React from 'react'
import ReactDOM from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import App from './App'
import './styles/globals.css'
import { platform } from '@/services/platform'

// Polyfill: music-metadata-browser 内部使用 Node.js 的 Buffer 和 global，
// 在移动端 WebView（无 Node 全局）下会 ReferenceError。注入 buffer 包作为 Buffer，
// 并把 global 指向 globalThis（vite 默认不注入 global）。
import { Buffer } from 'buffer'
if (typeof (window as any).global === 'undefined') (window as any).global = window
if (typeof (window as any).Buffer === 'undefined') (window as any).Buffer = Buffer

console.log('Aurora Music platform:', platform.platform)

// 全局抑制原生拖拽（HTML5 drag-and-drop）。
// 起因：侧边栏导航项由 NavLink 渲染成真实 <a href="#/liked">，Chromium 默认把 <a>/<img>
// 当拖拽源；长按（触屏）或按住拖动（鼠标）会触发原生的「链接/图片拖拽预览」气泡，
// 气泡内容是解析后的绝对 URL —— 桌面端生产环境即
// file:///C:/Users/<用户名>/.../app-dist/index.html#/liked，视觉突兀且泄露本机路径。
// 样式层已用 `-webkit-user-drag: none` 关掉 <a>/<img> 两个源头，这里在启动入口再兜一层：
// 应用内没有把元素拖出窗口的用法，任何漏网的 dragstart 一律取消，后续新增元素也不会复现该气泡。
// 注意：这是页面内拖拽（drag out）的兜底，不影响从系统拖文件进窗口（外部拖入走的是 dragenter/drop）。
document.addEventListener('dragstart', (e) => e.preventDefault(), true)

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </React.StrictMode>,
)
