"use client"

import { useId, useRef, useState, useTransition } from "react"
import { CircleCheck, CircleHelp, Info, Loader2, Plus, X } from "lucide-react"

import { previewPantryText } from "@/app/(main)/chores/meals/pantry/actions"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { PANTRY_STORAGE_LABELS, formatQuantityJa } from "@/lib/meals/server/format"
import {
  matchingExistingPantry,
  samePantryIngredient,
  type PantryExistingItem,
  type PantryIdentity,
} from "@/lib/meals/pantry-guidance"
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
  parsedIngredientId: string | null
  suggestedNames: string[]
  isGeneric: boolean
  /** 同じ食材を別の在庫として登録することを明示したか。 */
  confirmSeparate: boolean
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

function draftIdentity(draft: Draft): PantryIdentity {
  const renamed = isRenamed(draft)
  return {
    name: draft.name.trim(),
    ingredientId: renamed ? null : draft.parsedIngredientId,
    catalogName: renamed ? null : draft.catalogName,
  }
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
    parsedIngredientId: item.ingredientId,
    suggestedNames: item.suggestedNames ?? [],
    isGeneric: item.isGeneric === true,
    confirmSeparate: false,
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
  existingItems = [],
  onEditExisting,
  hasUnreadable = false,
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
  /** 表示中の世帯の在庫。既存行の更新や削除はここでは行わない。 */
  existingItems?: readonly PantryExistingItem[]
  /** 既存行の編集を親の版付き編集シートに任せる。 */
  onEditExisting?: (id: string) => void
  /** 読めない行が在る間は、見えていない重複の可能性を確認する。 */
  hasUnreadable?: boolean
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
  const [confirmedUnreadable, setConfirmedUnreadable] = useState(false)
  const [reading, startReading] = useTransition()
  const previewingRef = useRef(false)

  const helpId = `${formId}-help`
  const errorId = `${formId}-error`

  /** 読み取りが確実な食材だけを直接登録。不明点は既存の確認画面へ送る。 */
  function quickAdd() {
    if (disabled || saving || previewingRef.current) return
    if (text.trim() === "") {
      setError("食材の名前を入力してください。")
      return
    }
    previewingRef.current = true
    setError(null)
    startReading(async () => {
      try {
        const result = await previewPantryText(text)
        if (!result.ok) {
          setError(result.error)
          return
        }
        if (result.items.length === 0) {
          setError("食材の名前を入力してください。")
          return
        }
        const needsReview = result.truncated || hasUnreadable || result.items.some(
          (item, index) =>
            item.ingredientId === null ||
            item.isGeneric === true ||
            item.issues.length > 0 ||
            item.name.trim() === "" ||
            (item.quantityText !== null && item.quantity === null) ||
            matchingExistingPantry(item, existingItems).length > 0 ||
            result.items.slice(0, index).some((earlier) => samePantryIngredient(earlier, item)),
        )
        if (needsReview) {
          // 辞書にない食材・読めない数量・件数超過を、黙って登録／切り捨てない。
          setDrafts(result.items.map(draftOf))
          setTruncated(result.truncated)
          setError("重複・種類・数量などを確認してください。確認が済むまでは登録しません。")
          onDraftChange?.(true)
          return
        }
        const request: AddPantryItemsRequest = {
          items: result.items.map((item) => ({
            id: newClientId(),
            // サーバーが登録直前に辞書照合し直す。推測の保管場所・期限は入れない。
            ingredientId: null,
            name: item.name.trim(),
            quantity: item.quantity,
            status: "have",
            useSoon: false,
            storage: null,
            expiresOn: null,
            confirmedOn: today,
          })),
        }
        const issue = addPantryItemsIssue(request)
        if (issue !== null) {
          setError(PANTRY_INPUT_MESSAGES[issue])
          return
        }
        if (!onSubmit(request)) setError("ほかの保存を確認中です。完了後にもう一度お試しください。")
      } catch (err) {
        logOfflineError("[pantry-bulk-form] quickAdd", err)
        setError(OFFLINE_ERROR_MESSAGE)
      } finally {
        previewingRef.current = false
      }
    })
  }

  function read() {
    if (previewingRef.current) return
    if (text.trim() === "") {
      setError("食材の名前を入力してください。")
      return
    }
    previewingRef.current = true
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
        logOfflineError("[pantry-bulk-form] previewPantryText", err)
        setError(OFFLINE_ERROR_MESSAGE)
      } finally {
        previewingRef.current = false
      }
    })
  }

  function patchDraft(id: string, patch: Partial<Draft>) {
    setDrafts((prev) =>
      prev === null
        ? prev
        : prev.map((draft) =>
            draft.id === id
              ? {
                  ...draft,
                  ...patch,
                  confirmSeparate: patch.name !== undefined && patch.name !== draft.name
                    ? false
                    : draft.confirmSeparate,
                }
              : draft,
          ),
    )
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
    setConfirmedUnreadable(false)
    setError(null)
    onDraftChange?.(false)
  }

  const summary = drafts === null ? null : summarize(drafts)
  // 「同じ食材」を照合するだけ。別の日に買った別在庫を自動合算しない。
  const duplicates = (drafts ?? []).map((draft, index) => {
    const identity = draftIdentity(draft)
    return {
      existing: matchingExistingPantry(identity, existingItems),
      earlier: (drafts ?? []).slice(0, index).find((other) => samePantryIngredient(draftIdentity(other), identity)),
    }
  })

  function register() {
    if (drafts === null || drafts.length === 0 || disabled || saving) return
    const unconfirmed = duplicates.findIndex((matched, index) =>
      (matched.existing.length > 0 || matched.earlier !== undefined) && !drafts[index].confirmSeparate,
    )
    if (unconfirmed >= 0) {
      setError(`${unconfirmed + 1}件目「${drafts[unconfirmed].name}」は同じ食材が登録済みです。既存の食材を編集するか、「別の在庫として登録する」を選んでください。`)
      return
    }
    if (hasUnreadable && !confirmedUnreadable) {
      setError("表示できない食材があります。重複の可能性を確認してから登録してください。")
      return
    }
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
          rows={2}
          maxLength={PANTRY_TEXT_MAX}
          placeholder={PANTRY_BULK_PLACEHOLDER}
          aria-describedby={error && drafts === null ? `${helpId} ${errorId}` : helpId}
          disabled={reading || saving || drafts !== null}
          onChange={(event) => {
            setText(event.target.value)
            setError(null)
          }}
        />
        <p id={helpId} className="text-xs text-muted-foreground">
          食材名だけでOK。改行・「、」でまとめて追加できます。数量・単位・保管場所は任意です（最大{PANTRY_BULK_MAX}件）。読めない食材は保存せず確認画面へ進みます。
        </p>
        {error && drafts === null && (
          <p id={errorId} role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {drafts === null && (
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" className="min-h-11 flex-1 sm:flex-none" disabled={disabled || reading} onClick={quickAdd}>
              {reading ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Plus aria-hidden="true" />}
              {reading ? "読み取り中…" : "そのまま登録"}
            </Button>
            <Button type="button" variant="ghost" disabled={reading} onClick={read}>
              内容を確認
            </Button>
          </div>
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
          {hasUnreadable && (
            <label className="flex items-start gap-2 rounded-xl border border-amber-500/40 px-3 py-3 text-sm">
              <input
                type="checkbox"
                className="mt-1 size-4 shrink-0"
                checked={confirmedUnreadable}
                onChange={(event) => { setConfirmedUnreadable(event.target.checked); setError(null) }}
              />
              表示できない在庫があります。重複の可能性を理解し、別在庫として登録する
            </label>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">{error}</p>
          )}
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

                  {duplicates[index] && (duplicates[index].existing.length > 0 || duplicates[index].earlier !== undefined) && (
                    <div className="flex flex-col gap-2 rounded-xl border border-amber-500/40 px-3 py-3 text-sm" data-testid="pantry-duplicate">
                      <p className="font-medium">同じ食材の在庫が見つかりました。数量を二重に数える可能性があります。</p>
                      {duplicates[index].existing.map((stock) => (
                        <div key={stock.id} className="flex flex-wrap items-center gap-2">
                          <span>
                            登録済み: {stock.name}（{formatQuantityJa(stock.quantity ?? null)}・
                            {stock.storage ? PANTRY_STORAGE_LABELS[stock.storage] : "保管場所未設定"}）
                          </span>
                          {onEditExisting && (
                            <Button type="button" variant="outline" className="min-h-11" disabled={disabled} onClick={() => onEditExisting(stock.id)}>
                              既存を編集
                            </Button>
                          )}
                        </div>
                      ))}
                      {duplicates[index].earlier !== undefined && <p>今回の入力内にも同じ食材があります。</p>}
                      <label className="flex min-h-11 items-center gap-2">
                        <input
                          type="checkbox"
                          className="size-4 shrink-0"
                          checked={draft.confirmSeparate}
                          onChange={(event) => patchDraft(draft.id, { confirmSeparate: event.target.checked })}
                        />
                        {position}を別の在庫として登録する
                      </label>
                    </div>
                  )}
                  {!renamed && draft.isGeneric && (
                    <p className="text-sm text-amber-700 dark:text-amber-300">
                      「{draft.name}」は総称です。部位・種類が不明なままでは料理の材料として確定できません。
                      分かる場合は具体的な食材を選んでください。
                    </p>
                  )}
                  {!renamed && draft.suggestedNames.length > 0 && (
                    <div role="group" aria-label={`${position}の食材名の候補`} className="flex flex-col gap-2">
                      <p className="text-sm text-muted-foreground">
                        {draft.isGeneric ? "具体的な種類の候補" : "辞書にある近い名前の候補"}（自動では選びません）
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {draft.suggestedNames.map((name) => (
                          <Button key={name} type="button" variant="outline" className="min-h-11" onClick={() => patchDraft(draft.id, { name })}>
                            {name}を選ぶ
                          </Button>
                        ))}
                      </div>
                    </div>
                  )}
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

                  <details className="rounded-xl border border-border/60">
                    <summary className="cursor-pointer px-3 py-3 text-sm font-medium">数量・単位・保管場所を編集（任意）</summary>
                    <div className="grid grid-cols-1 gap-2 px-3 pb-3 min-[360px]:grid-cols-2 sm:grid-cols-3">
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
                  </details>
                </li>
              )
            })}
          </ul>

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
