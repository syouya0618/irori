import {
  Bot,
  CircleAlert,
  CircleCheck,
  CircleHelp,
  Hand,
  Lock,
  ScanSearch,
  ShoppingCart,
  Sparkles,
  type LucideIcon,
} from "lucide-react"

import type { DishVerdict } from "@/lib/meals/exclusions"
import type { Sufficiency } from "@/lib/meals/pantry-match"
import {
  PLAN_ORIGIN_LABELS,
  QUANTITY_UNKNOWN_LABEL,
  SUFFICIENCY_LABELS,
  formatQuantityJa,
} from "@/lib/meals/server/format"
import type { PlanEntry, Quantity } from "@/lib/meals/types"
import { cn } from "@/lib/utils"

/**
 * ごはんの画面が共有する小さな印（充足・出所・除外・固定・数量）。
 *
 * 境界指令を持たない（Server Component からも Client Component からも描ける）。
 * どの印も**アイコン + 文字**で示し、色は補助（色だけで区別しない）。明暗は対で指定する。
 * 未知の値（型の外から届いた値）は throw せず、中立の表示へ退化させる。
 */

const BADGE = "inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-0.5 text-sm font-medium"
const NEUTRAL_TONE = "bg-muted text-foreground ring-1 ring-border ring-inset"

interface MarkDef {
  icon: LucideIcon
  tone: string
}

const SUFFICIENCY_MARKS: Readonly<Record<Sufficiency, MarkDef>> = {
  ready: {
    icon: CircleCheck,
    tone: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
  },
  check: {
    icon: CircleHelp,
    tone: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  },
  buy: {
    icon: ShoppingCart,
    tone: "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300",
  },
}

function own<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined
}

/**
 * 在庫との突き合わせの印: 「揃う」「分量要確認」「買い足し」。
 * 3 段を混ぜて見せない（買い足しが要る料理を「揃う」に並べない）ための共通の語彙。
 */
export function SufficiencyMark({ level, className }: { level: Sufficiency; className?: string }) {
  const def = own(SUFFICIENCY_MARKS, level)
  if (!def) {
    return (
      <span className={cn(BADGE, NEUTRAL_TONE, className)}>
        <CircleHelp size={14} aria-hidden="true" />
        在庫を確認できません
      </span>
    )
  }
  const Icon = def.icon
  return (
    <span className={cn(BADGE, def.tone, className)}>
      <Icon size={14} aria-hidden="true" />
      {SUFFICIENCY_LABELS[level]}
    </span>
  )
}

const ORIGIN_ICONS: Readonly<Record<PlanEntry["origin"], LucideIcon>> = {
  auto: Sparkles,
  ai_assisted: Bot,
  manual: Hand,
}

/**
 * 献立の枠を作った経路: 「自動」（規則ベースの自動献立）・「AI 補助」（生成 AI の補助を経た）・「手動」。
 * 実際の経路どおりに出す（AI を使っていない結果を「AI」と見せない）。
 */
export function OriginLabel({ origin, className }: { origin: PlanEntry["origin"]; className?: string }) {
  const label = own(PLAN_ORIGIN_LABELS, origin)
  // 未知の経路は名乗らせない（何も出さない）
  if (label === undefined) return null
  const Icon = ORIGIN_ICONS[origin]
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground", className)}>
      <Icon size={12} aria-hidden="true" />
      <span className="sr-only">作成: </span>
      {label}
    </span>
  )
}

export const VERDICT_LABELS: Readonly<Record<Exclude<DishVerdict, "ok">, string>> = {
  blocked: "使わない食材を含む",
  label_check: "原材料の確認が必要",
}

/**
 * 必須除外の判定の印。問題が無い（`ok`）ときは何も出さない
 * （「安全」「不使用」とは表示しない — 判定は食材辞書の一般的な原材料にもとづく）。
 */
export function VerdictMark({ verdict, className }: { verdict: DishVerdict; className?: string }) {
  if (verdict === "ok") return null
  if (verdict === "blocked") {
    return (
      <span
        className={cn(BADGE, "bg-destructive/10 text-destructive ring-1 ring-destructive/30 ring-inset", className)}
      >
        <CircleAlert size={14} aria-hidden="true" />
        {VERDICT_LABELS.blocked}
      </span>
    )
  }
  // label_check と、未知の判定（確かめられていない側へ倒す）
  return (
    <span className={cn(BADGE, "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300", className)}>
      <ScanSearch size={14} aria-hidden="true" />
      {VERDICT_LABELS.label_check}
    </span>
  )
}

/** 固定した枠の印（作り直し・差替えで変えない枠）。 */
export function PinnedMark({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1 text-xs font-medium text-foreground", className)}>
      <Lock size={12} aria-hidden="true" />
      固定
    </span>
  )
}

/**
 * 数量の表示。数量を登録していない・量が分からないときは「数量不明」と出す
 * （空欄にしない。空欄は「0」や「十分ある」と読まれる）。
 */
export function QuantityText({
  quantity,
  className,
}: {
  quantity: Quantity | null | undefined
  className?: string
}) {
  const text = formatQuantityJa(quantity)
  return (
    <span className={cn(text === QUANTITY_UNKNOWN_LABEL ? "text-muted-foreground" : undefined, className)}>
      {text}
    </span>
  )
}
