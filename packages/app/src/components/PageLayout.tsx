import { cn } from '@/lib/utils'
import { PageTitle } from '@/components/PageHeading'
import { useT } from '@/i18n'
import type { MessageKey } from '@aurora/shared'

interface PageLayoutProps {
  /**
   * 页头标题（**文案键**，渲染期取译文）。
   *
   * 为什么是键而不是字符串：调用方多是页面组件，字符串一旦在模块级或父组件顶部
   * 拼好，语言就被冻在那一刻；存键、在渲染期 t() 才能随语言切换刷新。
   * 页面名一律取 `nav.item.*`（见 lib/routes.ts 的 NAV_LABEL_KEYS）。
   */
  titleKey?: MessageKey
  /** 已本地化的标题字符串。仅保留给极端场景（标题来自运行时数据），新代码用 titleKey */
  title?: string
  header?: React.ReactNode
  children: React.ReactNode
  className?: string
}

/**
 * 统一页面布局组件
 * 所有页面共用，确保间距、内边距完全一致
 *
 * 用法：
 * 1. 简单标题：<PageLayout titleKey={NAV_LABEL_KEYS.library}>
 * 2. 自定义标题：<PageLayout header={<CustomHeader />}>
 *
 * 页头只放标题：全站已撤掉标题下的说明性副标题，需要解释的页面把信息交给
 * 空态或内容区首行，不在页头重复一遍。
 */
export function PageLayout({ titleKey, title, header, children, className }: PageLayoutProps) {
  const t = useT()
  return (
    // pb 需为底部悬浮播放条让位（移动端约 84px+safe-area / 桌面约 102px），
    // 否则滚动到底时内容会被播放条永久遮挡
    // 移动端收窄左右内边距、缩小大标题字号，避免小屏上内容拥挤
    // 全屏/超宽屏限宽居中：内容列拉满到 1400px+ 时表格行过宽、阅读松散，
    // max-w 让内容保持舒适行宽并与居中悬浮播放条形成一致的视觉轴
    // ⚠️ 比例维度（见 lib/viewportTiers）：
    //   - 矮屏（高 ≤780：车机 720p / 窗口最小高度 / 手机横屏）把上内边距与页头下间距
    //     各收一档，一屏多出约 20px 内容高度；宽档间距一分不动；
    //   - 超宽屏（比例 ≥2:1）内容列从 1200 放宽到 1440：21:9 上 1200 的列两侧会各空
    //     出 500px 以上，留白比行宽本身还宽；article 仍保持单列阅读宽度上限。
    //     唱片的详情页另有自己的 2xl/ultrawide 档（1160/1400/1560），两者互不影响。
    // 间距对齐 DS 阶梯（4/8/12/16/24/32/40/56/80）
    // 页头字号/字重/字距一律取 PageTitle（PageHeading.tsx 是唯一事实源），
    // 此处不再写裸字号类——否则又会漂出与页头不一致的第二档
    // ⚠️ 底部让位（pb）的分档只看**播放条档位**，不看「矮屏」：
    //   完整档播放条约 130px，加上贴底间距要 ~142px；紧凑档单行 ~62px，72px 就够。
    //   矮屏≠紧凑档 —— 桌面 1280×600 仍然是完整档（宽 640px）。若按「矮屏就收 pb」
    //   处理，1280×600 上内容底部会被播放条压住 30px（实测差一点就溢出到条子背后）。
    //   所以这里只在**极矮屏**（<560，播放条必为紧凑档，见 PlayerBar）收 pb，
    //   其余尺寸沿用原值。
    <div className={cn('flex flex-col h-full px-4 pt-4 md:px-8 md:pt-8 short:md:pt-5 pb-[calc(100px+env(safe-area-inset-bottom))] squat:pb-[calc(88px+env(safe-area-inset-bottom))] lg:pb-32 squat:lg:pb-28 mx-auto w-full max-w-[1200px] ultrawide:max-w-[1440px]', className)}>
      {header ?? ((titleKey || title) && (
        <div className="mb-6 md:mb-8 short:mb-5 short:md:mb-6">
          <PageTitle>{titleKey ? t(titleKey) : title}</PageTitle>
        </div>
      ))}
      {children}
    </div>
  )
}
