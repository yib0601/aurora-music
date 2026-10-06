/**
 * 子进程入口（验证用）：由 lxVerifier.test.ts 用 esbuild 打包出**真实的 lxHost 源码**，
 * 这里在独立进程中加载它，用于证明「未注入 evaluate 时同步死循环会挂死」以及
 * 「callTimeoutMs 默认值确实是 20000」——这两件事在主进程里做会把测试自己搭进去。
 *
 * 用法：node lxVerifierChildrun.mjs <bundle.mjs> <scenario>
 *
 * 注：刻意用 .mjs 后缀（不是 .mts），避免被 vitest 的 include 规则当成测试文件收集。
 */
const [, , bundlePath, scenario] = process.argv

const { inspectLxSource, searchLxSource, setLxHostDeps } = await import(bundlePath)

const noNet = (url, options, cb) => {
  setTimeout(() => cb(new Error('child-no-network'), null), 0)
  return () => {}
}

/** 同步死循环：只有「没有 vm 执行器」时才会真的卡死 */
const HANG_BOOT = 'while (true) {}'

/** search 永不 resolve 的脚本，用于观测 call 级超时的实际毫秒数 */
const HANG_SEARCH = `
var lx = globalThis.lx
lx.on(lx.EVENT_NAMES.request, function (arg) {
  if (arg.action === 'search') return new Promise(function () {})
  return Promise.reject(new Error('no'))
})
lx.send(lx.EVENT_NAMES.inited, { sources: { kw: { name: '酷我', type: 'music', actions: ['musicUrl', 'search'], qualitys: ['128k'] } } })
`

if (scenario === 'hang') {
  setLxHostDeps(null)
  console.log('child-enter')
  const out = await inspectLxSource(
    { id: 'hang', name: 'hang', kind: 'lx', sourceUrl: 'x', enabled: true, script: HANG_BOOT },
    { request: noNet }
  )
  console.log('child-returned', JSON.stringify(out))
  process.exit(0)
}

if (scenario === 'timer') {
  const orig = globalThis.setTimeout
  globalThis.setTimeout = (fn, ms, ...rest) => {
    if (typeof ms === 'number' && ms >= 1000) console.log('TIMER=' + ms)
    return orig(fn, ms, ...rest)
  }
  const p = searchLxSource(
    { id: 't', name: 't', kind: 'lx', sourceUrl: 'x', enabled: true, script: HANG_SEARCH },
    { request: noNet }
  )
  p.then(
    () => console.log('RESOLVED'),
    (e) => console.log('REJ=' + e.message)
  ).finally(() => {
    orig(() => process.exit(0), 50)
  })
  console.log('child-enter')
} else {
  console.log('unknown-scenario')
  process.exit(2)
}