import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  base: './',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      // music-metadata-browser 内部 import 'buffer' 时，vite 会优先解析为 node 内置模块，
      // 在移动端 WebView 无 node 全局，会报 "Buffer is not defined"。
      // 强制指向 feross/buffer 浏览器 polyfill 包。
      buffer: path.resolve(__dirname, 'node_modules/buffer/'),
    },
  },
  // music-metadata-browser 等老库依赖 Node 的 global，注入 globalThis。
  define: {
    global: 'globalThis',
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 600,
  },
  cacheDir: path.resolve(__dirname, 'node_modules/.vite'),
})
