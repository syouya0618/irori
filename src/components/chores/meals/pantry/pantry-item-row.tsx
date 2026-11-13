"use client"

import { Check, CircleAlert, CircleHelp, Clock, History, Loader2, Pencil, Zap } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  PANTRY_STATUS_LABELS,
  PANTRY_STORAGE_LABELS,
  formatDaysLeft,
  formatMealDateShort,
  formatQuantityJa,
} from "@/lib/meals/server/format"
import type { PantryItemFields } from "@/lib/meals/server/pantry-requests"
import type { PantryStatus } from "@/lib/meals/types"
import { cn } from "@/lib/utils"
import { segmentCn } from "@/lib/utils/segment-cn"

import {
  MARK_ALERT_TONE as ALERT_TONE,
  MARK_BADGE_CLASS as BADGE,
  MARK_NEUTRAL_TONE as NEUTRAL_TONE,
  MARK_WARN_TONE as WARN_TONE,
  chipClass,
} from "../basics/field-classes"
import { PANTRY_STATUS_ORDER, PANTRY_STORAGE_UNSET_LABEL } from "./pantry-fields"
import { GENERIC_STOCK_TEXT, genericFixText, type PantryItemView } from "./pantry-item-view"

/**
 * 食材 1 件の行。名前・数量・保管場所・最終確認日と、期限切れ・古い確認・一覧にない名前の印、
 * 「ある／残り少ない／使い切った」の 3 択、早く使いたい、今日確認した、編集を持つ。
 *
 * - 印は**アイコン + 文字**で示す（色は補助）。数量を登録していない食材は「数量不明」と出す
 *   （空欄にしない。空欄は「十分ある」と読まれる）。
 * - 状態の切替・「今日確認した」は、その食材を今日見たという操作なので、最終確認日を今日にして送る。
 *   「今日」は Server Component が渡した JST の日付（端末の時計を使わない）。
 * - 保存はここでは行わない。変える項目だけを `onPatch` で親へ渡す（親が版と一緒に送る）。
 */
export function PantryItemRow({
  item,
  today,
  disabled,
  busy,
  onPatch,
  onEdit,
}: {
  item: PantryItemView
  /** サーバーの今日（JST）。 */
  today: string
  /** 新しい操作を受けられない（送信中・確認待ち）。 */
  disabled: boolean
  /** この食材の保存を送信中。 */
  busy: boolean
  onPatch: (patch: Partial<PantryItemFields>) => void
  onEdit: () => void
}) {
  const confirmedToday = item.confirmedOn === today
  const daysLeft = item.expiresOn === null ? null : formatDaysLeft(item.expiresOn, today)
  const storageLabel = item.storage === null ? PANTRY_STORAGE_UNSET_LABEL : (PANTRY_STORAGE_LABELS[item.storage] ?? PANTRY_STORAGE_UNSET_LABEL)

  function changeStatus(status: PantryStatus) {
    if (status === item.status) return
    onPatch({ status, confirmedOn: today })
  }

  return (
    <li data-testid="pantry-item" className="flex flex-col gap-2 py-3">
      <div className="flex items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p className="flex items-center gap-2 text-base font-medium">
            <span className="min-w-0 break-words [overflow-wrap:anywhere]">{item.name}</span>
            {busy && (
              <span role="status" className="inline-flex shrink-0 items-center">
                <Loader2 size={16} className="animate-spin text-muted-foreground" aria-hidden="true" />
                <span className="sr-only">保存中</span>
              </span>
            )}
          </p>
          <p className="text-sm break-words text-muted-foreground">
            {formatQuantityJa(item.quantity)}・{storageLabel}・確認 {formatMealDateShort(item.confirmedOn)}
            {item.expiry === "fresh" && item.expiresOn !== null && `・期限 ${formatMealDateShort(item.expiresOn)}`}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label={`${item.name}を編集`}
          disabled={disabled}
          onClick={onEdit}
        >
          <Pencil size={18} aria-hidden="true" />
        </Button>
      </div>

      {(item.expiry === "expired" || item.expiry === "soon" || item.stale || item.catalogName === null) && (
        <ul aria-label={`${item.name}の注意`} className="flex flex-wrap gap-1.5">
          {item.expiry === "expired" && (
            <li className={cn(BADGE, ALERT_TONE)}>
              <CircleAlert size={14} className="shrink-0" aria-hidden="true" />
              期限切れ{daysLeft !== null && `（${daysLeft}）`}・材料に数えません
            </li>
          )}
          {item.expiry === "soon" && (
            <li className={cn(BADGE, WARN_TONE)}>
              <Clock size={14} className="shrink-0" aria-hidden="true" />
              期限が近い{daysLeft !== null && `（${daysLeft}）`}
            </li>
          )}
          {item.stale && (
            <li className={cn(BADGE, WARN_TONE)}>
              <History size={14} className="shrink-0" aria-hidden="true" />
              確認から日が経っています
            </li>
          )}
          {item.catalogName === null && (
            <li className={cn(BADGE, NEUTRAL_TONE)}>
              <CircleHelp size={14} className="shrink-0" aria-hidden="true" />
              一覧にない名前（提案の材料に数えません）
            </li>
          )}
        </ul>
      )}

      {item.generic !== null && (
        // 総称（「豚肉」など）は、正しく登録できたように見えて材料に数えられない。理由と直し方を言う
        <div data-testid="pantry-generic" className="flex flex-col items-start gap-1">
          <p className={cn(BADGE, WARN_TONE)}>
            <CircleHelp size={14} className="shrink-0" aria-hidden="true" />
            総称（材料に数えていません）
          </p>
          <p className="text-sm break-words text-foreground">
            {GENERIC_STOCK_TEXT}
            {genericFixText(item.generic.examples)}
          </p>
          <Button
            type="button"
            variant="outline"
            aria-label={`${item.name}を具体的な名前に直す`}
            disabled={disabled}
            onClick={onEdit}
          >
            <Pencil aria-hidden="true" />
            具体的な名前に直す
          </Button>
        </div>
      )}

      <div role="group" aria-label={`${item.name}の状態`} className="flex gap-1 rounded-xl bg-muted/50 p-1">
        {PANTRY_STATUS_ORDER.map((status) => {
          const active = item.status === status
          return (
            <button
              key={status}
              type="button"
              aria-pressed={active}
              disabled={disabled}
              onClick={() => changeStatus(status)}
              className={cn(
                segmentCn(active),
                "inline-flex cursor-pointer items-center justify-center gap-1 focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-60",
              )}
            >
              {active && <Check size={14} className="shrink-0" aria-hidden="true" />}
              {PANTRY_STATUS_LABELS[status]}
            </button>
          )
        })}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          aria-pressed={item.useSoon}
          aria-label={`${item.name}を早く使いたい`}
          disabled={disabled}
          onClick={() => onPatch({ useSoon: !item.useSoon })}
          className={chipClass(item.useSoon)}
        >
          {item.useSoon ? (
            <Check size={14} className="shrink-0" aria-hidden="true" />
          ) : (
            <Zap size={14} className="shrink-0" aria-hidden="true" />
          )}
          早く使いたい
        </button>
        {confirmedToday ? (
          <p className="inline-flex min-h-11 items-center gap-1 text-sm text-muted-foreground">
            <Check size={14} className="shrink-0" aria-hidden="true" />
            今日確認済み
          </p>
        ) : (
          <Button
            type="button"
            variant="outline"
            aria-label={`${item.name}を今日確認した`}
            disabled={disabled}
            onClick={() => onPatch({ confirmedOn: today })}
          >
            今日確認した
          </Button>
        )}
      </div>
    </li>
  )
}
