import { cn } from '@/lib/utils'
import { assetUrl } from '@/lib/assetUrl'

/**
 * 品牌图形地址（public/favicon.svg，由 scripts/generate-icons.sh 从品牌 SVG 派生）。
 *
 * 地址必须按构建 base 拼成**相对**路径，不能写 `/favicon.svg`：生产端 Electron 以
 * `file://` loadFile 加载 index.html，根相对地址会被解析成 `file:///favicon.svg`
 * （文件系统根）→ 侧边栏品牌位裂图。0.7.4 打包版就是这样裂的。详见 lib/assetUrl.ts。
 */
const FAVICON_URL = assetUrl(
  (import.meta as ImportMeta & { env?: { BASE_URL?: string } }).env?.BASE_URL,
  'favicon.svg',
)

/** Aurora 品牌标识：与应用图标共用同一视觉资产，不再使用通用音符代替。 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <span className={cn('brand-mark', className)}>
      <img src={FAVICON_URL} alt="" draggable={false} />
    </span>
  )
}
