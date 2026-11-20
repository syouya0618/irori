"use client"

import { ChevronRight } from "lucide-react"
import { IngredientPhoto } from "@/components/chores/meals/shared/meal-photo"

import {
  PANTRY_STORAGE_LABELS,
  formatDaysLeft,
  formatMealDateShort,
  formatQuantityJa,
} from "@/lib/meals/server/format"
import type { PantryItemView } from "./pantry-item-view"

const GLYPHS: Readonly<Record<string, string>> = {
  onion: "🧅",
  carrot: "🥕",
  egg: "🥚",
  milk: "🥛",
  chicken_thigh: "🍗",
  chicken_breast: "🍗",
  pork_komagire: "🥩",
  beef_slice: "🥩",
  napa_cabbage: "🥬",
  cabbage: "🥬",
  tomato: "🍅",
  rice: "🍚",
  potato: "🥔",
  salmon: "🐟",
  bread: "🍞",
}

/** カンプの写真は現物写真と誤認しないよう、ここでは絵文字アイコンで表現する。 */
export function PantryCompactRow({
  item,
  today,
  disabled,
  onEdit,
}: {
  item: PantryItemView
  today: string
  disabled: boolean
  onEdit: () => void
}) {
  const quantity = formatQuantityJa(item.quantity)
  const expires = item.expiresOn === null ? null : formatDaysLeft(item.expiresOn, today)
  const storage = item.storage !== null ? PANTRY_STORAGE_LABELS[item.storage] : "保管場所未設定"
  const badge =
    item.expiry === "expired" ? "期限切れ" :
      item.status === "out" ? "使い切った" :
        item.status === "low" ? "残りわずか" : "在庫あり"
  const tone =
    item.expiry === "expired" ? "bg-destructive/10 text-destructive" :
      item.status === "low" ? "bg-amber-100 text-amber-900 dark:bg-amber-900/30 dark:text-amber-200" :
        item.status === "out" ? "bg-muted text-muted-foreground" :
          "bg-emerald-100 text-emerald-900 dark:bg-emerald-900/30 dark:text-emerald-200"

  return (
    <li data-testid="pantry-item" className="rounded-xl border border-border/60 bg-card shadow-sm">
      <button
        type="button"
        aria-label={`${item.name}の詳細を開く`}
        disabled={disabled}
        onClick={onEdit}
        className="flex min-h-18 w-full items-center gap-3 px-3 py-3 text-left focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50"
      >
        <IngredientPhoto ingredientId={item.ingredientId} fallback={GLYPHS[item.ingredientId ?? ""] ?? "🥗"} className="size-14" />
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="text-base font-semibold break-words">{item.name}</span>
          <span className="text-sm text-muted-foreground">
            {quantity}・{storage}
          </span>
          {item.expiresOn !== null && (
            <span className="text-xs text-muted-foreground">期限 {formatMealDateShort(item.expiresOn)}</span>
          )}
        </span>
        <span className="flex shrink-0 flex-col items-end gap-1.5">
          <span className={`rounded-full px-2 py-1 text-xs font-medium ${tone}`}>{badge}</span>
          <ChevronRight size={18} aria-hidden="true" className="text-muted-foreground" />
        </span>
      </button>
      {(item.expiry === "expired" || item.expiry === "soon" || item.stale || item.catalogName === null || item.generic !== null) && (
        <ul aria-label={`${item.name}の注意`} className="flex flex-wrap gap-x-3 gap-y-1 border-t border-border/60 px-3 py-2 text-xs text-muted-foreground">
          {item.expiry === "expired" && <li>期限切れ（{formatDaysLeft(item.expiresOn as string, today)}）・材料に数えません</li>}
          {item.expiry === "soon" && <li>期限が近い{expires !== null ? `（${expires}）` : ""}</li>}
          {item.stale && <li>確認から日が経っています</li>}
          {item.catalogName === null && <li>一覧にない名前（提案の材料に数えません）</li>}
          {item.generic !== null && <li>総称（部位・種類不明。提案の材料に数えません）</li>}
        </ul>
      )}
    </li>
  )
}
