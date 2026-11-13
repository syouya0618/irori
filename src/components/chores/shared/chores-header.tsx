import type { ReactNode } from "react"
import Link from "next/link"
import { ChevronLeft } from "lucide-react"

/**
 * 家事の下位ページ（ごみ・掃除・ごはん…）の見出し。戻るリンク + h1 + 任意の一行説明。
 *
 * 境界指令を持たぬ（Server Component からも Client Component からも描ける）。戻り先は
 * `router.back()` ではなく明示の href（直接 URL で開いた時・履歴が無い時も戻れる）。
 */
export function ChoresHeader({
  title,
  backHref = "/chores",
  backLabel = "家事",
  description,
  children,
}: {
  title: string
  backHref?: string
  backLabel?: string
  description?: ReactNode
  /** 見出しの下に置く補助（切替・操作など） */
  children?: ReactNode
}) {
  return (
    <div className="flex flex-col gap-2">
      <Link
        href={backHref}
        prefetch={false}
        className="touch-target -ml-2 inline-flex w-fit items-center gap-1 rounded-lg px-2 text-sm text-muted-foreground transition-colors duration-200 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
      >
        <ChevronLeft size={18} aria-hidden="true" />
        {backLabel}
      </Link>
      <h1 className="text-xl font-bold break-words">{title}</h1>
      {description != null && <p className="text-sm text-muted-foreground">{description}</p>}
      {children}
    </div>
  )
}
