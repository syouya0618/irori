"use client"

import { ChevronDown, ChevronUp, CircleHelp, Hand, PackagePlus, SquarePen } from "lucide-react"

import { CheckButton } from "@/components/chores/shared/check-button"
import { Button } from "@/components/ui/button"
import type { ShoppingItemView } from "@/lib/meals/server/plan-views"

import { purchaseProgressText } from "./shopping-labels"

export interface ShoppingItemRowProps {
  item: ShoppingItemView
  /** 画面に出す購入済みの印（送信中は、押した後の値を先に出す）。 */
  checked: boolean
  /** この項目の購入の記録を送信中。 */
  busy: boolean
  /** 新しい操作を受けられない（保存中・確認待ち）。 */
  disabled: boolean
  /** 「どの日のどの料理に使うか」を開いているか。 */
  expanded: boolean
  onCheckedChange: (next: boolean) => void
  onToggleSources: () => void
  /** 詳細（量の調整・メモ・売場・在庫へ追加・削除）を開く。 */
  onOpen: () => void
  /** 詳細を、在庫へ追加の区画を先頭にして開く。 */
  onOpenRestock: () => void
}

/**
 * 買い物の 1 項目の行。
 *
 * 購入チェックは 44px の `CheckButton`（状態は `aria-checked` とチェックの印で示す）。
 * 数量で追える項目は「購入済み 300g・あと 200g」のように、買った量と残りを文で出す
 * （必要量が後から増えても、買った量は書き換えない）。
 * 「在庫量を確認」は、家にある量が分からず在庫を差し引いていない印。
 */
export function ShoppingItemRow({
  item,
  checked,
  busy,
  disabled,
  expanded,
  onCheckedChange,
  onToggleSources,
  onOpen,
  onOpenRestock,
}: ShoppingItemRowProps) {
  const progress = purchaseProgressText(item)
  const sourcesId = `shopping-sources-${item.id}`
  const canRestock = (item.restockableAmount ?? 0) > 0 || (item.checked && item.purchasedAmount === 0 && item.restockCount === 0)

  return (
    <li data-testid="shopping-item" data-item-id={item.id} className="flex flex-col gap-1 py-2">
      <div className="flex items-start gap-2">
        <CheckButton
          checked={checked}
          onCheckedChange={onCheckedChange}
          label={`${item.name}を購入済みにする`}
          disabled={disabled}
          busy={busy}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5 pt-2.5">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="min-w-0 text-base font-medium break-words">{item.name}</span>
            {item.requiredText !== "" && <span className="text-sm text-muted-foreground">必要 {item.requiredText}</span>}
            {item.origin === "manual" && (
              <span className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                <Hand size={12} aria-hidden="true" />
                手動
              </span>
            )}
          </p>
          {progress !== null && (
            <p className="text-sm" data-testid="shopping-progress">
              {progress}
            </p>
          )}
          {item.needsStockCheck && (
            <p className="inline-flex w-fit items-center gap-1 rounded-full bg-amber-100 px-2.5 py-0.5 text-sm font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
              <CircleHelp size={14} aria-hidden="true" />
              在庫量を確認
            </p>
          )}
          {item.note !== null && <p className="text-sm break-words text-muted-foreground">メモ: {item.note}</p>}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={`${item.name}の詳細を開く`}
          className="shrink-0"
          onClick={onOpen}
        >
          <SquarePen aria-hidden="true" />
        </Button>
      </div>

      <div className="flex flex-wrap gap-2 pl-13">
        {item.sources.length > 0 && (
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={sourcesId}
            onClick={onToggleSources}
            className="flex min-h-11 cursor-pointer items-center gap-1 rounded-lg px-2 text-sm text-muted-foreground transition-colors duration-200 hover:bg-muted/60 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
          >
            {expanded ? <ChevronUp size={16} aria-hidden="true" /> : <ChevronDown size={16} aria-hidden="true" />}
            使う料理（{item.sources.length}件）
          </button>
        )}
        {canRestock && (
          <Button type="button" variant="outline" aria-label={`${item.name}を在庫へ追加`} onClick={onOpenRestock}>
            <PackagePlus aria-hidden="true" />
            在庫へ追加
          </Button>
        )}
      </div>
      {expanded && item.sources.length > 0 && (
        <ul id={sourcesId} className="flex flex-col gap-0.5 pl-13 text-sm text-muted-foreground">
          {item.sources.map((source, index) => (
            <li key={`${source.date}:${source.title}:${index}`} className="break-words">
              {source.dateLabel} {source.title}（{source.quantityText}）
            </li>
          ))}
        </ul>
      )}
    </li>
  )
}
