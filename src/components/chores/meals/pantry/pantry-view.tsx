"use client"

import { useId, useRef, useState } from "react"
import { AlertCircle, CircleCheck, Refrigerator } from "lucide-react"

import { EmptyState } from "@/components/chores/shared/empty-state"
import { PendingChoreNotice } from "@/components/chores/shared/pending-chore-notice"
import { RefreshOnVisible } from "@/components/chores/shared/refresh-on-visible"
import {
  CHORE_SAVE_MESSAGES,
  useChoreSave,
  type ChoreSaveOutcome,
} from "@/components/chores/shared/use-chore-save"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import type { ChoreOwner } from "@/lib/domain/chore-pending"
import { PANTRY_STATUS_LABELS, PANTRY_STORAGE_LABELS } from "@/lib/meals/server/format"
import type { AddPantryItemsRequest, PantryItemFields } from "@/lib/meals/server/pantry-requests"
import { segmentCn } from "@/lib/utils/segment-cn"

import { ChangedElsewhereNotice } from "../basics/changed-elsewhere-notice"
import { labelOfMealBasicsRequest, type MealBasicsRequest } from "../basics/meal-basics-request"
import {
  OTHER_SCREEN_SAVE_TEXTS,
  isMealRequest,
  runMealRequest,
  type MealRequest,
  type MealSaveSuccess,
} from "../plan/meal-request"
import { PantryBulkForm } from "./pantry-bulk-form"
import {
  PANTRY_STATUS_ORDER,
  PANTRY_STORAGE_ORDER,
  PANTRY_STORAGE_UNSET_LABEL,
  fieldsOfPantryItem,
} from "./pantry-fields"
import { PantryItemEditor } from "./pantry-item-editor"
import { PantryItemRow } from "./pantry-item-row"
import type { PantryItemView } from "./pantry-item-view"

/** 表示中の定期再取得の間隔（家族が直した食材を取り込む）。 */
const POLL_MS = 60_000

type Grouping = "storage" | "status"

const GROUPING_LABELS: Record<Grouping, string> = {
  storage: "保管場所別",
  status: "状態別",
}

interface Notice {
  text: string
  tone: "status" | "alert"
}

interface Group {
  key: string
  label: string
  items: PantryItemView[]
}

export interface PantryViewProps {
  owner: ChoreOwner
  /** サーバーの今日（JST）。期限・確認日はこの日付で扱う（端末の時計を使わない）。 */
  today: string
  items: PantryItemView[]
  /** 読めなかった食材の行の数（0 でなければ、全部は表示できていない）。 */
  unreadable: number
}

/** 注意が要る食材を先に（期限切れ → 期限が近い → 確認が古い → それ以外）。同じ段の中は登録順。 */
function attentionRank(item: PantryItemView): number {
  if (item.expiry === "expired") return 0
  if (item.expiry === "soon") return 1
  if (item.stale) return 2
  return 3
}

function groupItems(items: readonly PantryItemView[], grouping: Grouping): Group[] {
  const sorted = [...items].sort((a, b) => attentionRank(a) - attentionRank(b))
  const groups: Group[] =
    grouping === "storage"
      ? PANTRY_STORAGE_ORDER.map((storage) => ({
          key: storage ?? "none",
          label: storage === null ? PANTRY_STORAGE_UNSET_LABEL : PANTRY_STORAGE_LABELS[storage],
          items: sorted.filter((item) => item.storage === storage),
        }))
      : PANTRY_STATUS_ORDER.map((status) => ({
          key: status,
          label: PANTRY_STATUS_LABELS[status],
          items: sorted.filter((item) => item.status === status),
        }))
  return groups.filter((group) => group.items.length > 0)
}

/**
 * 食材（/chores/meals/pantry）の画面。まとめ入力 → 確認 → 登録と、登録した食材の一覧
 * （保管場所別・状態別。各行で「ある／残り少ない／使い切った」・早く使いたい・今日確認した・編集）。
 *
 * 保存は `useChoreSave`（操作 ID と内容を送信の前に固定・結果不明は同じ操作で確認・自動再送なし）。
 * 編集は開いた時点の版を送り、家族が先に直していれば上書きしない。楽観表示はしない
 * （保存が確定してから、サーバーの内容を取り直して描く）。
 */
export function PantryView({ owner, today, items, unreadable }: PantryViewProps) {
  const baseId = useId()
  const textareaId = `${baseId}-bulk`
  const [grouping, setGrouping] = useState<Grouping>("storage")
  // 開いている編集のシート。`seq` は開くたびに変わる通し番号（保存の応答が、どのシートから送った
  // 操作かを見分ける）。`version` は開いた時点の食材の版（送る版はこれに固定する）
  const [editingSheet, setEditingSheet] = useState<{ id: string; seq: number; version: string } | null>(null)
  const editingId = editingSheet?.id ?? null
  const sheetSeqRef = useRef(0)
  // 送信中の操作を送ったシートの通し番号（一覧の行から送った操作・控えの確かめ直しは null）
  const originSheetRef = useRef<number | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  // 登録が確定したら、まとめ入力を作り直して空に戻す（確定するまでは、同じ行 ID のまま残す）
  const [bulkKey, setBulkKey] = useState(0)
  // まとめ入力が、確認中の下書き（釦・選択で直す一覧）を持っているか
  const [bulkDrafting, setBulkDrafting] = useState(false)
  /** この画面のまとめ入力から最後に送った登録の、先頭の行 ID。 */
  const lastBulkFirstIdRef = useRef<string | null>(null)

  function onOutcome(outcome: ChoreSaveOutcome<MealRequest, MealSaveSuccess>) {
    if (outcome.kind === "rejected") {
      // 保存されていないと確定。入力は残す（直して送り直せる）
      setNotice({ text: outcome.error, tone: "alert" })
      return
    }
    // 閉じるのは、その操作を送ったシートだけ（一覧の行の操作の応答で、送信中に開いた編集の入力を
    // 消さない）。`onOutcome` は送信時点の描画の値を見るので、今のシートは更新関数の引数から読む
    const origin = originSheetRef.current
    if (origin !== null) setEditingSheet((current) => (current !== null && current.seq === origin ? null : current))
    if (outcome.kind === "unknown") {
      setNotice(null)
      return
    }
    const { result } = outcome
    if (!("op" in result)) {
      // 献立・買い物の画面で送った操作を、この画面から確かめ直したとき
      setNotice(
        result.status === "conflict"
          ? { text: OTHER_SCREEN_SAVE_TEXTS.conflict, tone: "alert" }
          : { text: OTHER_SCREEN_SAVE_TEXTS.saved, tone: "status" },
      )
      return
    }
    switch (result.op) {
      case "pantry_add": {
        // 空に戻すのは、この画面で確認して送った登録が確定したときだけ（前に開いた画面の控えを
        // 確かめ直した結果で、いま書いている途中の入力を消さない）
        const { payload } = outcome
        if (payload.op === "pantry_add" && payload.items[0]?.id === lastBulkFirstIdRef.current) {
          lastBulkFirstIdRef.current = null
          setBulkKey((key) => key + 1)
          setBulkDrafting(false)
        }
        setNotice({
          text:
            result.saved === 0
              ? `${result.items.length}件の食材は、既に登録されていました。`
              : `${result.items.length}件の食材を登録しました。`,
          tone: "status",
        })
        return
      }
      case "pantry_save": {
        if (result.deleted) {
          setNotice({ text: "この食材は、別の端末で削除されていました。保存していません。", tone: "alert" })
        } else if (result.status === "conflict") {
          setNotice({ text: CHORE_SAVE_MESSAGES.conflict, tone: "alert" })
        } else {
          setNotice({ text: `「${result.item?.name ?? "食材"}」を保存しました。`, tone: "status" })
        }
        return
      }
      case "pantry_delete": {
        setNotice(
          result.status === "conflict"
            ? {
                text: "別の端末が先に更新していたため、削除していません。最新の内容を確認してください。",
                tone: "alert",
              }
            : { text: "食材を削除しました。", tone: "status" },
        )
        return
      }
      default:
        // 設定の画面で送った操作を、この画面から確かめ直したとき
        setNotice(
          result.status === "conflict"
            ? { text: CHORE_SAVE_MESSAGES.conflict, tone: "alert" }
            : { text: "保存しました。内容は設定の画面で確認できます。", tone: "status" },
        )
    }
  }

  // 型ガードと振り分けは、ごはんの全画面で同じもの（献立・買い物・食材・設定の合併型）を使う。
  // 画面ごとに別の型ガードにすると、ほかの画面の結果不明の控えが「読めない控え」になり、
  // 確かめ直せないまま保存を塞ぐ
  const save = useChoreSave<MealRequest, MealSaveSuccess>({
    owner,
    kind: "meal",
    run: runMealRequest,
    isPayload: isMealRequest,
    onOutcome,
  })

  /**
   * 操作を送る。受け付けたら true。`fromSheet` は、開いている編集のシートから送ったとき true
   * （応答でそのシートを閉じる）。
   */
  function send(request: MealBasicsRequest, name?: string, fromSheet = false): boolean {
    setNotice(null)
    const accepted = save.send(request, labelOfMealBasicsRequest(request, name)) !== null
    if (accepted) originSheetRef.current = fromSheet && editingSheet !== null ? editingSheet.seq : null
    return accepted
  }
  // 控えの確かめ直しは、どのシートからの操作でもない（応答でシートを閉じない）
  const pendingSave = {
    ...save,
    retry: (entry: Parameters<typeof save.retry>[0]) => {
      originSheetRef.current = null
      save.retry(entry)
    },
  }

  /** 一覧の行の操作（状態の切替・今日確認した）。表示している今の値に、今の版を付けて送る。 */
  function saveItem(item: PantryItemView, fields: PantryItemFields): boolean {
    return send({ op: "pantry_save", id: item.id, version: item.version, item: fields })
  }

  function openEditor(item: PantryItemView) {
    setNotice(null)
    sheetSeqRef.current += 1
    setEditingSheet({ id: item.id, seq: sheetSeqRef.current, version: item.version })
  }

  // 送信中の印は、送った操作の場所にだけ出す（行の保存中に、登録の釦を回さない）
  const sending = save.pending.find((entry) => entry.phase === "sending")?.payload
  const sendingItemId = sending?.op === "pantry_save" || sending?.op === "pantry_delete" ? sending.id : null
  const sendingBulk = sending?.op === "pantry_add"

  const editing = editingId === null ? undefined : items.find((item) => item.id === editingId)
  // 編集を開いた時点の版と、開いた後に食材の版が進んだか
  const openedVersion = editingSheet?.version ?? ""
  const editorStale = editing !== undefined && editingSheet !== null && editing.version !== editingSheet.version
  const groups = groupItems(items, grouping)
  const expiredCount = items.filter((item) => item.expiry === "expired").length
  const staleCount = items.filter((item) => item.stale).length
  const unresolvedCount = items.filter((item) => item.catalogName === null).length
  // 総称で登録した食材（使い切ったものは、材料に数えないのが当たり前なので数えない）
  const genericCount = items.filter((item) => item.generic !== null && item.status !== "out").length

  const shown: Notice | null = notice ?? (save.message ? { text: save.message, tone: save.messageTone } : null)
  const message =
    shown === null ? null : shown.tone === "alert" ? (
      <p role="alert" className="flex items-start gap-2 text-sm text-foreground">
        <AlertCircle size={16} className="mt-0.5 shrink-0 text-destructive" aria-hidden="true" />
        <span className="min-w-0 break-words">{shown.text}</span>
      </p>
    ) : (
      <p role="status" className="flex items-start gap-2 text-sm text-foreground">
        <CircleCheck size={16} className="mt-0.5 shrink-0 text-emerald-700 dark:text-emerald-400" aria-hidden="true" />
        <span className="min-w-0 break-words">{shown.text}</span>
      </p>
    )

  return (
    <div className="flex flex-col gap-6">
      <section aria-labelledby={`${baseId}-bulk-heading`} className="flex flex-col gap-3">
        <h2 id={`${baseId}-bulk-heading`} className="text-sm font-semibold text-muted-foreground">
          まとめて入力
        </h2>
        <PantryBulkForm
          key={bulkKey}
          today={today}
          disabled={save.blocked}
          saving={sendingBulk}
          textareaId={textareaId}
          onSubmit={(request: AddPantryItemsRequest) => {
            const accepted = send({ op: "pantry_add", ...request })
            if (accepted) lastBulkFirstIdRef.current = request.items[0]?.id ?? null
            return accepted
          }}
          onDraftChange={setBulkDrafting}
        />
      </section>

      {editing === undefined && message}
      <PendingChoreNotice save={pendingSave} showMessage={false} />

      {unreadable > 0 && (
        <p role="alert" className="flex items-start gap-2 text-sm text-foreground">
          <AlertCircle size={16} className="mt-0.5 shrink-0 text-destructive" aria-hidden="true" />
          <span>
            表示できない食材が {unreadable} 件あります。アプリを更新すると表示できる場合があります。食材は消えていません。
          </span>
        </p>
      )}

      <section aria-labelledby={`${baseId}-list-heading`} className="flex flex-col gap-3">
        <h2 id={`${baseId}-list-heading`} className="text-sm font-semibold text-muted-foreground">
          登録した食材（{items.length}件）
        </h2>

        {items.length === 0 ? (
          <EmptyState
            icon={Refrigerator}
            // 読めない食材が在るときに「まだありません」と言わない（在る食材を無いと偽らない）
            title={unreadable > 0 ? "表示できる食材がありません" : "食材がまだ登録されていません"}
            description="家にある食材を上の「まとめて入力」に書くと、今あるもので作れる料理を探せます。数量は分かる範囲でかまいません。"
          >
            <Button type="button" variant="outline" onClick={() => document.getElementById(textareaId)?.focus()}>
              食材を入力する
            </Button>
          </EmptyState>
        ) : (
          <>
            <div role="group" aria-label="並べ方" className="flex gap-1 rounded-xl bg-muted/50 p-1">
              {(Object.keys(GROUPING_LABELS) as Grouping[]).map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={grouping === value}
                  onClick={() => setGrouping(value)}
                  className={`${segmentCn(grouping === value)} cursor-pointer focus-visible:outline-2 focus-visible:outline-ring`}
                >
                  {GROUPING_LABELS[value]}
                </button>
              ))}
            </div>

            {(expiredCount > 0 || staleCount > 0 || unresolvedCount > 0 || genericCount > 0) && (
              <ul className="flex flex-col gap-1 rounded-xl bg-muted/60 px-3 py-2 text-sm text-foreground">
                {genericCount > 0 && (
                  <li data-testid="pantry-generic-summary">
                    総称（「豚肉」「きのこ」など）で登録した食材が {genericCount} 件あります。部位・種類が分からないため、提案・献立・買い物の材料に数えていません。各食材の「具体的な名前に直す」から直せます。
                  </li>
                )}
                {expiredCount > 0 && <li>期限切れの食材が {expiredCount} 件あります（提案の材料に数えません）。</li>}
                {staleCount > 0 && (
                  <li>
                    確認から日が経った食材が {staleCount} 件あります（提案では「分量要確認」になります。「今日確認した」で更新できます）。
                  </li>
                )}
                {unresolvedCount > 0 && (
                  <li>食材の一覧にない名前が {unresolvedCount} 件あります（提案の材料に数えません）。</li>
                )}
              </ul>
            )}

            {groups.map((group) => {
              const headingId = `${baseId}-group-${group.key}`
              return (
                <section key={group.key} aria-labelledby={headingId} className="flex flex-col gap-2">
                  <h3 id={headingId} className="text-sm font-semibold">
                    {group.label}（{group.items.length}件）
                  </h3>
                  <ul
                    aria-labelledby={headingId}
                    className="glass flex flex-col divide-y divide-border/60 rounded-2xl px-4 shadow-lg shadow-black/[0.04]"
                  >
                    {group.items.map((item) => (
                      <PantryItemRow
                        key={item.id}
                        item={item}
                        today={today}
                        disabled={save.blocked}
                        busy={sendingItemId === item.id}
                        onPatch={(patch) => saveItem(item, { ...fieldsOfPantryItem(item), ...patch })}
                        onEdit={() => openEditor(item)}
                      />
                    ))}
                  </ul>
                </section>
              )
            })}
            <p className="text-xs text-muted-foreground">
              状態を切り替えるか「今日確認した」を押すと、最終確認日が今日になります。
            </p>
          </>
        )}
      </section>

      {/* 確認中の下書き（釦・選択で直す一覧）が在る間は、自動の取り直しを見送る（自動では検出されない） */}
      <RefreshOnVisible pollMs={POLL_MS} paused={bulkDrafting} />

      <Sheet
        open={editing !== undefined}
        onOpenChange={(open) => {
          if (!open) setEditingSheet(null)
        }}
      >
        <SheetContent side="bottom" className="max-h-[85dvh] overflow-hidden rounded-t-2xl safe-bottom">
          {editing !== undefined && (
            <>
              <SheetHeader className="pr-14 pb-0">
                <SheetTitle className="break-words [overflow-wrap:anywhere]">{editing.name}</SheetTitle>
                <SheetDescription>数量・保管場所・期限・最終確認日を変更できます。</SheetDescription>
              </SheetHeader>
              <div className="flex flex-col gap-3 overflow-y-auto px-4 pb-4">
                {message}
                {/*
                  編集は、開いた時点の版を固定して送る。開いたまま食材の版が進んでも（一覧の行の操作の
                  応答・定期の再取得）、入力を黙って作り直さず、古い入力に新しい版も付けない。
                  保存を止めて知らせ、最新の内容を読み込み直してから編集し直してもらう
                */}
                {editorStale && <ChangedElsewhereNotice what="この食材" ownChangePossible onReload={() => openEditor(editing)} />}
                <PantryItemEditor
                  // 開き直す・最新を読み込むたびに作り直す（入力は、その時点の内容から始める）
                  key={`${editing.id}:${editingSheet?.seq ?? 0}`}
                  item={editing}
                  today={today}
                  disabled={save.blocked || editorStale}
                  saving={sendingItemId === editing.id}
                  onSubmit={(fields) =>
                    !editorStale &&
                    send({ op: "pantry_save", id: editing.id, version: openedVersion, item: fields }, undefined, true)
                  }
                  onDelete={() => {
                    if (editorStale) return
                    send({ op: "pantry_delete", id: editing.id, version: openedVersion }, editing.name, true)
                  }}
                  onCancel={() => setEditingSheet(null)}
                />
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  )
}
