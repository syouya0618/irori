"use client"

import { useId, useState, useTransition } from "react"
import { CircleCheck, CircleHelp, Info, Loader2, X } from "lucide-react"

import { previewPantryText } from "@/app/(main)/chores/meals/pantry/actions"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { PANTRY_STORAGE_LABELS, formatQuantityJa } from "@/lib/meals/server/format"
import {
  PANTRY_BULK_MAX,
  PANTRY_INPUT_MESSAGES,
  PANTRY_NAME_MAX,
  PANTRY_PREVIEW_ISSUE_LABELS,
  PANTRY_STORAGES,
  PANTRY_TEXT_MAX,
  addPantryItemsIssue,
  type AddPantryItemsRequest,
  type PantryNewItem,
  type PantryPreviewIssue,
  type PantryPreviewItem,
  type PantryQuantityInput,
} from "@/lib/meals/server/pantry-requests"
import type { PantryStorage, UnitId } from "@/lib/meals/types"
import { newClientId } from "@/lib/utils/client-id"
import { OFFLINE_ERROR_MESSAGE, logOfflineError } from "@/lib/utils/offline-error"

import { NATIVE_SELECT_CLASS } from "../basics/field-classes"
import { PANTRY_UNIT_OPTIONS, isPantryUnit, parseAmountText } from "./pantry-fields"

/** まとめ入力の例（placeholder）。改行・読点のどちらでも区切れる。 */
export const PANTRY_BULK_PLACEHOLDER = "例:\n玉ねぎ 2個、にんじん 1本\n牛乳 500ml\n卵"

interface Draft {
  /** 行 ID。読み取った時点で 1 回だけ作り、登録・再送で同じ値を送る（二重に登録しない）。 */
  id: string
  /** 読み取った時点の名前（変えたかどうかの判定用）。 */
  parsedName: string
  name: string
  /** 読み取った時点で一致した、食材の一覧の表示名。一致しなければ null。 */
  catalogName: string | null
  /** 読み取れた数量（表示用）。 */
  parsedQuantity: PantryQuantityInput | null
  /** 数量として読もうとした部分の原文。 */
  quantityText: string | null
  issues: PantryPreviewIssue[]
  amountText: string
  unit: UnitId
  storage: PantryStorage | null
}

function isRenamed(draft: Draft): boolean {
  return draft.name.trim() !== draft.parsedName
}

/** 確認中の一覧の内訳。行を直す・外すたびに、今の一覧から数え直す。 */
function summarize(drafts: readonly Draft[]) {
  const kept = drafts.filter((draft) => !isRenamed(draft))
  return {
    total: drafts.length,
    resolved: kept.filter((draft) => draft.catalogName !== null).length,
    unresolved: kept.filter((draft) => draft.catalogName === null).length,
    renamed: drafts.length - kept.length,
    quantities: drafts.filter((draft) => draft.amountText.trim() !== "").length,
  }
}

function draftOf(item: PantryPreviewItem): Draft {
  return {
    id: newClientId(),
    parsedName: item.name,
    name: item.name,
    catalogName: item.ingredientId === null ? null : (item.ingredientName ?? null),
    parsedQuantity: item.quantity,
    quantityText: item.quantityText,
    issues: item.issues,
    amountText: item.quantity === null ? "" : String(item.quantity.amount),
    unit: item.quantity !== null && isPantryUnit(item.quantity.unit) ? item.quantity.unit : "piece",
    storage: null,
  }
}

/**
 * 食材のまとめ入力。文を書く → 「内容を確認」で読み取り結果（食材の一覧と一致した食材・
 * 一覧にない名前・読み取れた数量）を見る → 1 件ずつ直す → 登録、の順に進む。
 *
 * - 読み取り（`previewPantryText`）は**保存しない**。登録は親（`onSubmit`）が行う。
 * - 食材の一覧との照合は、登録のときにサーバーが名前の完全一致でやり直す（ここから ID を送らない。
 *   名前を直した後に、前の食材との結び付きが残らない）。一覧にない名前はそのまま登録でき、
 *   提案の材料には数えない。
 * - 単位の無い数字や「適量」は数量にしない（数量不明として扱い、その旨を示す）。
 * - 最終確認日は Server Component が渡した JST の今日を入れて固定する（端末の時計を使わない）。
 */
export function PantryBulkForm({
  today,
  disabled,
  saving,
  textareaId,
  onSubmit,
  onDraftChange,
}: {
  /** サーバーの今日（JST）。登録する食材の最終確認日になる。 */
  today: string
  /** 新しい保存を受けられない（送信中・確認待ち）。 */
  disabled: boolean
  saving: boolean
  /** 入力欄の id（空の案内から入力欄へ移るため、親が決める）。 */
  textareaId: string
  /** 受け付けたら true（塞がれていれば false。入力は残す）。 */
  onSubmit: (request: AddPantryItemsRequest) => boolean
  /**
   * 確認中の下書き（釦・選択で直す一覧）を持っているかを伝える。文字の入力と違い、自動の取り直しの
   * 見送りに自動では数えられないので、画面が `RefreshOnVisible` の `paused` へ渡す。
   */
  onDraftChange?: (hasDraft: boolean) => void
}) {
  const formId = useId()
  const [text, setText] = useState("")
  const [drafts, setDrafts] = useState<Draft[] | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reading, startReading] = useTransition()

  const helpId = `${formId}-help`
  const errorId = `${formId}-error`

  function read() {
    if (text.trim() === "") {
      setError("食材の名前を入力してください。")
      return
    }
    setError(null)
    startReading(async () => {
      try {
        const result = await previewPantryText(text)
        if (!result.ok) {
          setError(result.error)
          return
        }
        setDrafts(result.items.map(draftOf))
        setTruncated(result.truncated)
        onDraftChange?.(true)
      } catch (err) {
        // 読み取りは保存を伴わない。届かなかっただけなので、もう一度押せばよい
        logOfflineError("[pantry-bulk-form] previewPantryText", err)
        setError(OFFLINE_ERROR_MESSAGE)
      }
    })
  }

  function patchDraft(id: string, patch: Partial<Draft>) {
    setDrafts((prev) => (prev === null ? prev : prev.map((draft) => (draft.id === id ? { ...draft, ...patch } : draft))))
    setError(null)
  }

  function removeDraft(id: string) {
    if (drafts === null) return
    const next = drafts.filter((draft) => draft.id !== id)
    setDrafts(next.length === 0 ? null : next)
    if (next.length === 0) onDraftChange?.(false)
    setError(null)
  }

  function cancel() {
    setDrafts(null)
    setTruncated(false)
    setError(null)
    onDraftChange?.(false)
  }

  const summary = drafts === null ? null : summarize(drafts)

  function register() {
    if (drafts === null || drafts.length === 0) return
    const items: PantryNewItem[] = []
    for (const [index, draft] of drafts.entries()) {
      const name = draft.name.trim()
      const amount = parseAmountText(draft.amountText)
      if (!amount.ok) {
        setError(`${index + 1}件目「${name}」: ${amount.message}`)
        return
      }
      items.push({
        id: draft.id,
        // 照合はサーバーが名前の完全一致で行う
        ingredientId: null,
        name,
        quantity: amount.amount === null ? null : { amount: amount.amount, unit: draft.unit },
        status: "have",
        useSoon: false,
        storage: draft.storage,
        expiresOn: null,
        confirmedOn: today,
      })
    }
    const request: AddPantryItemsRequest = { items }
    const issue = addPantryItemsIssue(request)
    if (issue !== null) {
      setError(PANTRY_INPUT_MESSAGES[issue])
      return
    }
    setError(null)
    onSubmit(request)
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="glass flex flex-col gap-3 rounded-2xl p-4 shadow-lg shadow-black/[0.04]">
        <label htmlFor={textareaId} className="text-sm font-medium">
          家にある食材
        </label>
        <Textarea
          id={textareaId}
          value={text}
          rows={4}
          maxLength={PANTRY_TEXT_MAX}
          placeholder={PANTRY_BULK_PLACEHOLDER}
          aria-describedby={error && drafts === null ? `${helpId} ${errorId}` : helpId}
          disabled={reading || drafts !== null}
          onChange={(event) => {
            setText(event.target.value)
            setError(null)
          }}
        />
        <p id={helpId} className="text-xs text-muted-foreground">
          改行か「、」で区切って、まとめて入力できます（1 回に{PANTRY_BULK_MAX}件まで）。数量は「2個」「500ml」のように単位を付けると読み取ります。数量は書かなくても登録できます。
        </p>
        {error && drafts === null && (
          <p id={errorId} role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {drafts === null && (
          <Button type="button" className="self-start" disabled={reading} onClick={read}>
            {reading && <Loader2 className="animate-spin" aria-hidden="true" />}
            {reading ? "読み取り中…" : "内容を確認"}
          </Button>
        )}
      </div>

      {drafts !== null && summary !== null && (
        <section
          aria-labelledby={`${formId}-preview`}
          className="glass flex flex-col gap-3 rounded-2xl p-4 shadow-lg shadow-black/[0.04]"
        >
          <h3 id={`${formId}-preview`} className="text-sm font-semibold">
            読み取った内容（まだ登録していません）
          </h3>
          <div role="status">
            <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-sm">
              <dt>食材の一覧と一致した食材</dt>
              <dd data-testid="pantry-preview-resolved" className="text-right font-medium">
                {summary.resolved}件
              </dd>
              <dt>一覧にない名前</dt>
              <dd data-testid="pantry-preview-unresolved" className="text-right font-medium">
                {summary.unresolved}件
              </dd>
              {summary.renamed > 0 && (
                <>
                  <dt>名前を変えた食材（登録するときに照合）</dt>
                  <dd data-testid="pantry-preview-renamed" className="text-right font-medium">
                    {summary.renamed}件
                  </dd>
                </>
              )}
              <dt>数量が入っている食材</dt>
              <dd data-testid="pantry-preview-quantities" className="text-right font-medium">
                {summary.quantities}件（{summary.total}件中）
              </dd>
            </dl>
          </div>
          {summary.unresolved > 0 && (
            <p className="flex items-start gap-2 text-sm text-muted-foreground">
              <Info size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
              <span>一覧にない名前は、そのまま登録できますが、提案の材料には数えません。</span>
            </p>
          )}
          {truncated && (
            <p role="alert" className="text-sm text-foreground">
              件数が多いため、最初の{PANTRY_BULK_MAX}件だけを読み取りました。残りは分けて入力してください。
            </p>
          )}

          <ul className="flex flex-col">
            {drafts.map((draft, index) => {
              const position = `${index + 1}件目`
              const renamed = isRenamed(draft)
              return (
                <li
                  key={draft.id}
                  data-testid="pantry-draft"
                  className="flex flex-col gap-2 border-t border-border/60 py-3 first:border-t-0 first:pt-0"
                >
                  <div className="flex items-start gap-2">
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      <label htmlFor={`${formId}-${draft.id}-name`} className="text-xs text-muted-foreground">
                        {position}の名前
                      </label>
                      <Input
                        id={`${formId}-${draft.id}-name`}
                        className="h-11"
                        value={draft.name}
                        maxLength={PANTRY_NAME_MAX * 2}
                        onChange={(event) => patchDraft(draft.id, { name: event.target.value })}
                      />
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      className="mt-5"
                      aria-label={`${position}「${draft.name}」を登録しない`}
                      onClick={() => removeDraft(draft.id)}
                    >
                      <X size={18} aria-hidden="true" />
                    </Button>
                  </div>

                  {renamed ? (
                    <p className="flex items-start gap-2 text-sm text-muted-foreground">
                      <Info size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
                      <span>名前を変えました。登録するときに、食材の一覧と照合します。</span>
                    </p>
                  ) : draft.catalogName !== null ? (
                    <p className="flex items-start gap-2 text-sm">
                      <CircleCheck
                        size={16}
                        className="mt-0.5 shrink-0 text-emerald-700 dark:text-emerald-400"
                        aria-hidden="true"
                      />
                      <span className="min-w-0 break-words">食材の一覧と一致: {draft.catalogName}</span>
                    </p>
                  ) : (
                    <p className="flex items-start gap-2 text-sm">
                      <CircleHelp size={16} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                      <span>一覧にない名前です（提案の材料に数えません）</span>
                    </p>
                  )}

                  <p className="text-sm break-words text-muted-foreground">
                    読み取れた数量:{" "}
                    {draft.parsedQuantity !== null
                      ? formatQuantityJa(draft.parsedQuantity)
                      : draft.quantityText !== null
                        ? `読み取れませんでした（「${draft.quantityText}」）`
                        : "なし（数量不明）"}
                  </p>
                  {draft.issues.length > 0 && (
                    <ul className="flex flex-col gap-0.5 text-sm text-foreground">
                      {draft.issues.map((issue) => (
                        <li key={issue} className="flex items-start gap-2">
                          <Info size={16} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                          <span>{PANTRY_PREVIEW_ISSUE_LABELS[issue] ?? "内容を確認してください"}</span>
                        </li>
                      ))}
                    </ul>
                  )}

                  <div className="grid grid-cols-3 gap-2">
                    <div className="flex min-w-0 flex-col gap-1">
                      <label htmlFor={`${formId}-${draft.id}-amount`} className="text-xs text-muted-foreground">
                        数量
                      </label>
                      <Input
                        id={`${formId}-${draft.id}-amount`}
                        className="h-11"
                        inputMode="decimal"
                        placeholder="不明"
                        aria-label={`${position}の数量`}
                        value={draft.amountText}
                        onChange={(event) => patchDraft(draft.id, { amountText: event.target.value })}
                      />
                    </div>
                    <div className="flex min-w-0 flex-col gap-1">
                      <label htmlFor={`${formId}-${draft.id}-unit`} className="text-xs text-muted-foreground">
                        単位
                      </label>
                      <select
                        id={`${formId}-${draft.id}-unit`}
                        className={NATIVE_SELECT_CLASS}
                        aria-label={`${position}の単位`}
                        value={draft.unit}
                        onChange={(event) => {
                          if (isPantryUnit(event.target.value)) patchDraft(draft.id, { unit: event.target.value })
                        }}
                      >
                        {PANTRY_UNIT_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="flex min-w-0 flex-col gap-1">
                      <label htmlFor={`${formId}-${draft.id}-storage`} className="text-xs text-muted-foreground">
                        保管場所
                      </label>
                      <select
                        id={`${formId}-${draft.id}-storage`}
                        className={NATIVE_SELECT_CLASS}
                        aria-label={`${position}の保管場所`}
                        value={draft.storage ?? ""}
                        onChange={(event) => {
                          const value = event.target.value
                          patchDraft(draft.id, {
                            storage: PANTRY_STORAGES.find((candidate) => candidate === value) ?? null,
                          })
                        }}
                      >
                        <option value="">なし</option>
                        {PANTRY_STORAGES.map((value) => (
                          <option key={value} value={value}>
                            {PANTRY_STORAGE_LABELS[value]}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            登録すると「ある」として一覧に入ります。期限・早く使いたい印は、登録の後に一覧から付けられます。
          </p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" disabled={disabled} onClick={register}>
              {saving && <Loader2 className="animate-spin" aria-hidden="true" />}
              {drafts.length}件を登録
            </Button>
            <Button type="button" variant="outline" disabled={saving} onClick={cancel}>
              入力に戻る
            </Button>
          </div>
        </section>
      )}
    </div>
  )
}
