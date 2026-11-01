'use strict'

/**
 * 洛雪脚本执行 Worker（移动端沙箱）。
 *
 * 本文件**不用 TypeScript、不走模块**：它被 `sandbox.ts` 以 `?raw` 读成字符串，
 * 再经 `Blob` 建成 Worker。理由：
 * - Vite 的 `new Worker(new URL(...))` 需要构建配置配合，且桌面端构建也会为它产出 chunk
 * - Worker 里没有 `import`（经典 Worker），用纯脚本最直接
 *
 * ## 与主线程的协议
 *
 * in:  `{ type: 'run', script }`                    启动脚本
 * out: `{ type: 'inited', inspection }`             脚本声明能力（或失败原因）
 * out: `{ type: 'request', id, url, options }`      请求主线程代发（CapacitorHttp）
 * in:  `{ type: 'response', id, err, resp }`        主线程回请求结果
 * in:  `{ type: 'call', id, source, action, info }` 向脚本取一次结果
 * out: `{ type: 'callResult', id, ok, value, message }`
 * out: `{ type: 'fatal', message }`                 执行期抛错
 *
 * ## 为什么请求要转发给主线程
 *
 * Worker 里的 `fetch` 受 CORS 约束，而移动端能用第三方音源靠的是 `CapacitorHttp`
 * （原生 HTTP，不受 CORS 限制）。`CapacitorHttp` 是 Capacitor 桥，**只在主线程可用**，
 * 所以 Worker 内的脚本请求一律 postMessage 回主线程执行。
 */

/* global self, crypto, TextEncoder, TextDecoder, setTimeout, clearTimeout, Function */

var EVENT_NAMES = { request: 'request', inited: 'inited', updateAlert: 'updateAlert' }

/** 待主线程回应的请求：id → callback */
var pendingRequests = new Map()
var nextRequestId = 1

/** 宿主状态 */
var state = { inited: null, updateAlert: null }
var requestHandler = null

/** 被遮蔽的全局名（与 shared/lxHost.ts 的 SHADOWED_GLOBALS 同序同义） */
var SHADOWED_GLOBALS = [
  'globalThis',
  'window',
  'self',
  'document',
  'navigator',
  'location',
  'localStorage',
  'console',
  'process',
  'require',
  'module',
  'exports',
  'global',
  'setTimeout',
  'clearTimeout',
  'setInterval',
  'clearInterval',
  'queueMicrotask',
  'fetch',
  'Buffer',
  'URL',
  'URLSearchParams',
  'TextDecoder',
  'TextEncoder',
  'crypto',
]

function quietConsole() {
  function noop() {}
  return {
    log: noop,
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    trace: noop,
    group: noop,
    groupEnd: noop,
    table: noop,
    time: noop,
    timeEnd: noop,
  }
}

/** 经主线程发请求（主线程用 CapacitorHttp，不受 CORS 约束） */
function hostRequest(url, options, callback) {
  var id = nextRequestId++
  pendingRequests.set(id, callback)
  self.postMessage({ type: 'request', id: id, url: url, options: options || {} })
  // 洛雪协议允许调用方拿到取消函数；Worker 里没有真正的取消语义，忽略即可
  return function cancel() {
    pendingRequests.delete(id)
  }
}

/** 构造伪全局（与桌面端 new Function 版逐条对齐） */
function buildSandbox() {
  var fakeGlobal = { liscript: {} }
  var lx = {
    EVENT_NAMES: EVENT_NAMES,
    version: '2.0.0',
    env: 'mobile',
    currentScriptInfo: {
      name: '',
      description: '',
      version: '',
      author: '',
      homepage: '',
      rawScript: '',
    },
    on: function (name, handler) {
      if (name === EVENT_NAMES.request) {
        requestHandler = handler
        return Promise.resolve()
      }
      return Promise.reject(new Error('The event is not supported: ' + name))
    },
    send: function (name, data) {
      if (name === EVENT_NAMES.inited) {
        state.inited = data
        return Promise.resolve()
      }
      if (name === EVENT_NAMES.updateAlert) {
        state.updateAlert = data
        return Promise.resolve()
      }
      return Promise.reject(new Error('Unknown event name: ' + name))
    },
    request: function (url, options, callback) {
      return hostRequest(url, options, callback)
    },
    utils: {
      crypto: {
        // Worker 里有 WebCrypto，但 md5 / aes 不在标准库里（与移动端原本的实现一致：降级）
        md5: function () {
          return undefined
        },
        aesEncrypt: function () {
          return undefined
        },
        rsaEncrypt: function () {
          return undefined
        },
        randomBytes: function (size) {
          return crypto.getRandomValues(new Uint8Array(Math.max(0, size | 0)))
        },
      },
      buffer: {
        from: function () {
          var input = arguments[0]
          if (typeof input === 'string') return new TextEncoder().encode(input)
          if (input instanceof Uint8Array) return input
          if (input instanceof ArrayBuffer) return new Uint8Array(input)
          if (Array.isArray(input)) return new Uint8Array(input)
          return new Uint8Array(0)
        },
        bufToString: function (buf) {
          return new TextDecoder('utf-8').decode(buf || undefined)
        },
      },
      zlib: {
        // Worker 里没有 raw deflate 能力（DecompressionStream 只支持 gzip/deflate-raw 有限形态）
        inflate: function () {
          return Promise.reject(new Error('zlib unavailable in mobile sandbox'))
        },
        deflate: function () {
          return Promise.reject(new Error('zlib unavailable in mobile sandbox'))
        },
      },
    },
  }
  fakeGlobal.lx = lx
  fakeGlobal.globalThis = fakeGlobal
  fakeGlobal.window = fakeGlobal
  fakeGlobal.self = fakeGlobal
  return fakeGlobal
}

/** 编译并执行脚本（遮蔽规则与桌面端 compileScript 一致） */
function runScript(script, fakeGlobal) {
  var body = '"use strict";\n' + script + '\n;return globalThis.__lx_exports__ || undefined'
  var fn = Function.apply(null, SHADOWED_GLOBALS.concat([body]))
  var args = SHADOWED_GLOBALS.map(function (name) {
    switch (name) {
      case 'globalThis':
      case 'window':
      case 'self':
        return fakeGlobal
      case 'console':
        return quietConsole()
      case 'document':
      case 'navigator':
      case 'location':
      case 'localStorage':
      case 'process':
      case 'require':
      case 'module':
      case 'exports':
      case 'global':
        return undefined
      default:
        return self[name]
    }
  })
  return fn.apply(null, args)
}

/**
 * 从 inited 数据提炼平台能力。
 *
 * 与 shared 的 `inspectInited` 同口径（白名单收窄）：Worker 里不能 import 那个函数，
 * 所以这里复刻了一份 —— **两份必须同步**，改动时一起改。
 */
function inspectInited(evalError, packed) {
  var inspection = { ok: false, platforms: {}, packed: !!packed }
  if (evalError) {
    inspection.error = evalError
    return inspection
  }
  var inited = state.inited
  if (!inited || typeof inited !== 'object') {
    inspection.error = 'script did not send inited event'
    return inspection
  }
  var sources = inited.sources
  if (!sources || typeof sources !== 'object') {
    inspection.error = 'inited event has no sources'
    return inspection
  }
  for (var platform in sources) {
    if (!Object.prototype.hasOwnProperty.call(sources, platform)) continue
    var item = sources[platform]
    if (!item || typeof item !== 'object') continue
    inspection.platforms[platform] = {
      name: typeof item.name === 'string' ? item.name : undefined,
      type: typeof item.type === 'string' ? item.type : undefined,
      actions: Array.isArray(item.actions)
        ? item.actions.filter(function (a) {
            return typeof a === 'string'
          })
        : [],
      qualitys: Array.isArray(item.qualitys)
        ? item.qualitys.filter(function (q) {
            return typeof q === 'string'
          })
        : [],
    }
  }
  inspection.ok = true
  return inspection
}

/** 等脚本异步 send(inited) 的窗口（与 shared 的 bootLxScript 一致：4s） */
var INITED_WAIT_MS = 4000

function waitForInited() {
  return new Promise(function (resolve) {
    var deadline = Date.now() + INITED_WAIT_MS
    var tick = function () {
      if (state.inited || Date.now() >= deadline) return resolve()
      setTimeout(tick, 20)
    }
    tick()
  })
}

self.onmessage = function (event) {
  var msg = event.data
  if (!msg || typeof msg !== 'object') return

  if (msg.type === 'response') {
    var callback = pendingRequests.get(msg.id)
    if (callback) {
      pendingRequests.delete(msg.id)
      callback(msg.err || null, msg.resp || null)
    }
    return
  }

  if (msg.type === 'run') {
    var fakeGlobal = buildSandbox()
    var evalError = null
    try {
      runScript(msg.script, fakeGlobal)
    } catch (err) {
      evalError = (err && err.message) || String(err)
    }
    // 脚本可能异步 send(inited)
    waitForInited().then(function () {
      self.postMessage({ type: 'inited', inspection: inspectInited(evalError, false) })
    })
    return
  }

  if (msg.type === 'call') {
    if (!requestHandler) {
      self.postMessage({
        type: 'callResult',
        id: msg.id,
        ok: false,
        message: 'script registered no request handler',
      })
      return
    }
    try {
      var result = requestHandler({ source: msg.source, action: msg.action, info: msg.info })
      Promise.resolve(result).then(
        function (value) {
          self.postMessage({ type: 'callResult', id: msg.id, ok: true, value: value })
        },
        function (err) {
          self.postMessage({
            type: 'callResult',
            id: msg.id,
            ok: false,
            message: (err && err.message) || String(err),
          })
        }
      )
    } catch (err) {
      self.postMessage({
        type: 'callResult',
        id: msg.id,
        ok: false,
        message: (err && err.message) || String(err),
      })
    }
  }
}
