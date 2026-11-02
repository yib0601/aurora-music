import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'

/**
 * 渲染层（@aurora/app）的 lint 基线。
 *
 * 本仓库自首提交起就写着 `lint` 脚本，但 eslint 从未进过 devDependencies、也没有任何配置文件——
 * 脚本一直是空转的。这里补上真正可运行的配置，基线按「现有代码能全绿」来定，而不是一次性
 * 套上最严的规则集：
 *
 * - `@typescript-eslint/no-explicit-any` 关闭：存量代码与音源脚本 / 插件桥 / IPC 之间大量
 *   传递无类型数据，一次性收紧会牵动近两百处，属于独立的清理任务。新增代码仍自觉避免 any。
 * - `no-unused-vars` 放行 `_` 前缀：项目约定「确实不用的形参 / 变量 / 捕获错误」用下划线标记，
 *   存量 mock 签名大量依赖这个写法。
 * - hooks 两条规则全开：`rules-of-hooks` 抓条件调用（真实缺陷来源），`exhaustive-deps` 抓漏依赖；
 *   少数「故意只依赖原始字段」的 effect 用行内 `eslint-disable-next-line` + 理由注释说明。
 */
export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
    },
  },
  {
    // 洛雪脚本沙箱：跑在 Web Worker 里，没有 DOM，用 worker 全局而不是 browser 全局
    files: ['src/**/*.worker.js'],
    languageOptions: { globals: globals.worker },
  },
  {
    // Tailwind 配置由 jiti 加载，CJS 形式的插件只能 require 进来
    files: ['tailwind.config.ts'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  }
)
