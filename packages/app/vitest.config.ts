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
    // 语言夹具（见 src/test/localeFixture.ts）：
    // 断言文案的用例必须知道自己跑在哪种语言下。Node 21 起全局 navigator 真实存在，
    // 不锁的话同一批断言会随 runner 的语言（en-US）与开发机（zh-CN）一个红一个绿。
    setupFiles: ['./src/test/localeFixture.ts'],
  },
})
