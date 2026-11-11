import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['src/**/*.test.ts'],
    /**
     * 5s（默认）对这批用例偏紧：多个测试文件真实跑 `node:http` 服务器、真实读写
     * tmpdir，`pluginHost.test.ts` 还会 `vi.resetModules()` 后重新 import 整条依赖
     * 链。并行 worker 一起跑时，模块重新求值的耗时会被放大到秒级，5s 线偶发踩中
     * （表现为「凭证边界」两条用例超时，单独跑必绿）。这里的断言都不依赖真实时间，
     * 只是等待 IO 与模块求值，放宽到 15s 不会掩盖逻辑问题，只吸收调度抖动。
     */
    testTimeout: 15_000,
  },
})