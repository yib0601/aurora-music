import { defineConfig } from 'vitest/config'
import path from 'node:path'

/**
 * 渲染层单测配置（与生产构建的 vite.config.ts 分离：这里不需要 React 插件，
 * 也不需要注入 __APP_VERSION__）。
 * 覆盖移动端媒体缓存的落盘逻辑：Capacitor Filesystem 以内存实现打桩，
 * 断言索引、驱逐、清空与命中地址拼接的行为。
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
