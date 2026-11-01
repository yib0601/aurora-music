import React from 'react'
import ReactDOM from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import App from './App'
import './styles/globals.css'
import { platform } from '@/services/platform'
import { I18nProvider } from '@/i18n'
import { initRendererLogging } from '@/services/logging.service'

// Polyfill: music-metadata-browser 内部使用 Node.js 的 Buffer 和 global，
// 在移动端 WebView（无 Node 全局）下会 ReferenceError。注入 buffer 包作为 Buffer，
// 并把 global 指向 globalThis（vite 默认不注入 global）。
import { Buffer } from 'buffer'
if (typeof (window as any).global === 'undefined') (window as any).global = window
if (typeof (window as any).Buffer === 'undefined') (window as any).Buffer = Buffer

// 日志在渲染之前接管：首屏期间的报错（资源加载、数据拉取、样式）正是用户报得最多的一类，
// 晚一步就只能从第二次交互开始记。initRendererLogging 只做同步的内存配置（挂 sink、
// 接管 console），一个字节都没写盘，所以不会拖慢首屏 —— 真正的 I/O 在有记录要发时才发生。
initRendererLogging()

// 插件启停状态：把主进程的权威停用清单灌进渲染层这份 `@aurora/shared` 内存态。
//
// **只在桌面端做镜像**。桌面端有两个 shared 实例（主进程 / 渲染进程），执行门禁在
// 主进程那份上，渲染层这份默认为空 —— 不灌的话界面层的 `canBrowseHall` /
// `isSearchableSource` 会认为被停用的插件仍然可用，表现为"看得到入口、点了没结果"。
//
// 移动端不能走这条：它只有一个 shared 实例，权威状态就是下面 `loadPluginAvailability()`
// 从磁盘读出来的那份。两者都写会互相覆盖 —— 镜像读到"尚未加载"的空集合、再灌回去，
// 就把磁盘状态清空了，表现为"手机上停用的插件重启后又自己开了"。
if (platform.platform === 'desktop') {
  void import('@/services/pluginAvailability')
    .then((mod) => mod.syncPluginAvailability())
    .catch((err) => {
      console.warn('[plugin] 初始化插件启停状态失败，按全部启用处理:', err)
    })
}

// 移动端：把已安装插件挂载进本进程的注册表。
//
// 为什么必须在 render 之前发起而不是等某个页面 useEffect：渲染层首帧就会问
// "有哪些插件"（设置页 / 插件面板 / 音乐库的候选源），晚一步会让用户看到
// "刚装的插件不存在"、过一会儿又自己冒出来。
//
// 桌面端的挂载在主进程启动流程里做（main.ts 的 mountInstalledPlugins），
// 移动端没有独立主进程，只能在这里做。**不 await**：挂载是异步 I/O
// （Capacitor Filesystem），等它会拖慢首屏；而未挂载完成的窗口里，
// 插件列表只是少几条已安装项，内置插件与本地播放都不受影响。
if (platform.platform === 'mobile' && platform.plugins) {
  // 启停状态必须先灌入 shared 的内存态，再挂载插件：挂载会注册实现，而执行门禁
  // 读的就是这份状态。顺序颠倒会让被停用的插件在本次启动的头几秒照常工作。
  void import('@/services/platform/mobile/pluginAvailability')
    .then((mod) => mod.loadPluginAvailability())
    .catch((err) => {
      // 读不到启停状态就按全部启用（坏配置不该让插件集体消失）
      console.warn('[plugin] 移动端读取插件启停状态失败，按全部启用处理:', err)
    })
    .then(() => import('@/services/platform/mobile/pluginInstall'))
    .then((mod) => mod.mountInstalledPlugins())
    .catch((err) => {
      // 挂载失败不该阻止应用启动：内置插件仍可用，本地播放完全不受影响。
      // 但要留痕 —— 报告里没有这条记录，UI 就无从提示"插件没加载起来"。
      console.error('[plugin] 移动端插件挂载失败:', err)
      // 动态 import 才能拿到 shared：这里已是 catch 分支，多一次加载没有代价
      void import('@aurora/shared').then(({ notePluginFailure }) =>
        notePluginFailure('installed', '', err)
      )
    })
}

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
    {/* 语言 Provider 必须在路由外层：路由重挂载不该重建语言上下文 */}
    <I18nProvider>
      <HashRouter>
        <App />
      </HashRouter>
    </I18nProvider>
  </React.StrictMode>,
)
