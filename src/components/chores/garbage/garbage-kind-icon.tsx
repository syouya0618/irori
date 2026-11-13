import {
  CupSoda,
  Flame,
  Newspaper,
  Package,
  Recycle,
  Sofa,
  Trash,
  Wine,
  Wrench,
  type LucideIcon,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { garbageKindVisual, type GarbageIconKey } from "@/lib/domain/garbage"

/**
 * ごみの種別の見た目（アイコン + 名称）。境界指令を持たぬ（Server / Client のどちらからも描ける）。
 *
 * - **色だけで区別せぬ**: 必ずアイコンと名称（文字）を併せて出す。色は補助
 * - 「削除」に使う `Trash2` とは別のアイコンにする（予定のシートで削除釦と紛れぬよう）
 * - プリセットに無い名称（自由入力・将来の値）は汎用のアイコンへ退化する（`Record` で全鍵を網羅）
 */
const ICONS: Record<GarbageIconKey, LucideIcon> = {
  burnable: Flame,
  "non-burnable": Wrench,
  plastic: Package,
  resource: Recycle,
  "bottle-can": Wine,
  "pet-bottle": CupSoda,
  paper: Newspaper,
  bulky: Sofa,
  generic: Trash,
}

/** 種別のアイコンだけ（装飾。名称は呼び出し側が文字で出すこと）。 */
export function GarbageKindIcon({
  label,
  size = 14,
  className,
}: {
  label: string | null | undefined
  size?: number
  className?: string
}) {
  const visual = garbageKindVisual(label)
  const Icon = ICONS[visual.icon]
  return <Icon size={size} aria-hidden="true" className={cn("shrink-0", visual.tone.text, className)} />
}

/**
 * 一覧の補足行に置く「ごみ・燃えるごみ」。文字で種別を言うゆえ、行のアクセシブル名にそのまま入る。
 * 押下要素ではない（カード全体がリンクの中にも置ける）。
 */
export function GarbageKindLabel({
  label,
  className,
}: {
  label: string
  className?: string
}) {
  return (
    <span
      data-garbage-kind={label}
      className={cn("flex min-w-0 items-center gap-1 text-foreground", className)}
    >
      <GarbageKindIcon label={label} size={12} />
      <span className="min-w-0 break-words">ごみ・{label}</span>
    </span>
  )
}

/** 丸い地にアイコン（ごみの画面の一覧の先頭に置く）。 */
export function GarbageKindAvatar({ label }: { label: string | null | undefined }) {
  const visual = garbageKindVisual(label)
  const Icon = ICONS[visual.icon]
  return (
    <span
      aria-hidden="true"
      className={cn("flex size-9 shrink-0 items-center justify-center rounded-full", visual.tone.bg)}
    >
      <Icon size={18} className={visual.tone.text} />
    </span>
  )
}

/**
 * 月のマスに出す印（アイコン + 短い名称）。マスは狭いゆえ短い名称を切り詰めて出し、
 * 正確な名称はマスの読み上げ（`aria-label`）が言う。ここは `aria-hidden`。
 */
export function GarbageCellMark({ labels }: { labels: readonly string[] }) {
  if (labels.length === 0) return null
  const first = labels[0]
  const visual = garbageKindVisual(first)
  const Icon = ICONS[visual.icon]
  const extra = labels.length - 1
  return (
    <span
      // `data-mark` は予定の印（丸・帯）の数え上げに使われておる。別の属性にして混ぜぬ
      data-garbage-mark={first}
      aria-hidden="true"
      className="mt-0.5 flex max-w-full items-center justify-center gap-0.5 overflow-hidden px-0.5 text-[10px] leading-none text-foreground"
    >
      <Icon size={10} className={cn("shrink-0", visual.tone.text)} />
      <span className="overflow-hidden whitespace-nowrap">{visual.short}</span>
      {extra > 0 && <span className="shrink-0 text-muted-foreground">+{extra}</span>}
    </span>
  )
}
