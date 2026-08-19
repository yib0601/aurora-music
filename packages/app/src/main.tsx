import React from 'react'
import ReactDOM from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import App from './App'
import './styles/globals.css'
import { platform } from './services/platform'

// Polyfill: music-metadata-browser 内部使用 Node.js 的 Buffer 和 global，
// 在移动端 WebView（无 Node 全局）下会 ReferenceError。注入 buffer 包作为 Buffer，
// 并把 global 指向 globalThis（vite 默认不注入 global）。
import { Buffer } from 'buffer'
if (typeof (window as any).global === 'undefined') (window as any).global = window
if (typeof (window as any).Buffer === 'undefined') (window as any).Buffer = Buffer

console.log('Aurora Music platform:', platform.platform)

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </React.StrictMode>,
)
