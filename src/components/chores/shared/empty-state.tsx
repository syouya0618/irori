import type { ReactNode } from "react"
import type { LucideIcon } from "lucide-react"

/**
 * 未登録・0 件の表示（アイコン + 文 + 任意の次の操作）。
 *
 * **「読めなかった」時には使わぬこと**。取得に失敗したのに「ありません」と描くと、在る記録を
 * 無いと偽る。失敗は `SectionError`（区画）か error boundary（画面）で示す。
 *
 * 境界指令を持たぬ（Server Component からアイコンを渡せる）。
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: LucideIcon
  title: string
  description?: ReactNode
  /** 次の操作（登録への Link / Button）。44px 以上の部品を渡す */
  children?: ReactNode
}) {
  return (
    <div className="glass flex flex-col items-center gap-2 rounded-2xl px-4 py-8 text-center shadow-lg shadow-black/[0.04]">
      <Icon size={28} aria-hidden="true" className="text-muted-foreground" />
      <p className="text-base font-medium">{title}</p>
      {description != null && <p className="text-sm text-muted-foreground">{description}</p>}
      {children != null && <div className="mt-2 flex flex-wrap justify-center gap-2">{children}</div>}
    </div>
  )
}
