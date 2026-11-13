"use client"

import { useRef, useState, useTransition } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { AlertCircle, CircleCheck, ClipboardCheck, Loader2, ShoppingCart, Users } from "lucide-react"

import { ExclusionHoldNotice } from "@/components/chores/meals/shared/exclusion-hold-notice"
import { MealNotice } from "@/components/chores/meals/shared/meal-notices"
import { MEALS_SETTINGS_HREF, MEALS_SHOPPING_HREF } from "@/components/chores/meals/shared/meal-routes"
import { PendingChoreNotice } from "@/components/chores/shared/pending-chore-notice"
import { RefreshOnVisible } from "@/components/chores/shared/refresh-on-visible"
import { useChoreSave, type ChoreSaveOutcome } from "@/components/chores/shared/use-chore-save"
import { useChoresRefresh } from "@/components/chores/shared/use-chores-refresh"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import type { ChoreOwner } from "@/lib/domain/chore-pending"
import { formatMealDateShort, formatServings } from "@/lib/meals/server/format"
import {
  DINNER_ENTRY_PAST_DAYS,
  REPLACE_AVOID_MAX,
  type DinnerSaveSuccess,
  type MealAiStatusView,
} from "@/lib/meals/server/plan-requests"
import type { DinnerDayView, DinnerEntryView, DinnerPlanView } from "@/lib/meals/server/plan-views"
import { newClientId } from "@/lib/utils/client-id"
import { shiftYmd } from "@/lib/utils/date-jst"

import { OUTLINE_LINK, PRIMARY_LINK, TEXT_LINK } from "./link-styles"
import {
  OTHER_SCREEN_SAVE_TEXTS,
  isMealRequest,
  isPlanRequest,
  runMealRequest,
  type MealRequest,
  type MealSaveSuccess,
  type PlanRequest,
} from "./meal-request"
import { PlanCreateCard, type GenerateInput } from "./plan-create-card"
import { PlanCustomDishForm } from "./plan-custom-dish-form"
import { PlanDayCard } from "./plan-day-card"
import { PlanEntryPanel } from "./plan-entry-panel"
import { conflictTextOfDinner, labelOfDinnerRequest, successTextOfDinnerRequest } from "./plan-labels"
import { PLAN_VIEW_DAYS, planHref } from "./plan-query"
import type { PlanPageExtras } from "./plan-types"

/** 表示中の定期再取得の間隔（家族の変更を取り込む）。 */
const POLL_MS = 60_000

export interface PlanViewProps {
  owner: ChoreOwner
  view: DinnerPlanView
  extras: PlanPageExtras
  /** 画面を開いた時点の AI 補助の状態。 */
  ai: MealAiStatusView
}

interface Notice {
  text: string
  tone: "status" | "alert"
  /** 補足（不足枠と理由・採用しなかった固定・買い物の更新の失敗など）。 */
  details: string[]
  /** 確定の後に、買い物への導線を添える。 */
  toShopping: boolean
}

/**
 * 開いているシート。`seq` は開くたびに変わる通し番号 — 保存の応答が「どのシートから送った操作か」を
 * 見分けるのに使う（応答で閉じるのは、その操作を送ったシートだけ）。
 */
type SheetState = { kind: "entry"; entryId: string; seq: number } | { kind: "custom"; date: string; seq: number } | null

function pushAvoid(list: readonly string[], ids: readonly string[]): string[] {
  return [...new Set([...list, ...ids])].slice(-REPLACE_AVOID_MAX)
}

/**
 * 献立の画面。
 *
 * - 最初に「献立を作る」（開始日・日数・希望）。作成は 1 回の押下で、提案として保存する。
 * - 提案 →「この献立で確定」→ 買い物リスト。確定した料理だけが買い物の自動計算に入る。
 * - 作った／作らなかったは、その日が来てから記録する。作った後の食材の更新は利用者が選ぶ。
 * - 保存は `useChoreSave`（操作 ID と内容を送信の前に固定・結果不明は同じ操作で確認・自動再送なし）。
 *   献立を変える操作はどれも、画面が見ている献立の版（または枠の版）を送り、他の端末が先に変えていたら
 *   上書きせずに「他の端末で変更されました」と出す。
 * - 在庫の引当・不足・除外との衝突は、サーバーが計算した表示（`DinnerPlanView`）をそのまま出す。
 */
export function PlanView({ owner, view, extras, ai }: PlanViewProps) {
  const router = useRouter()
  // 取り直しは家事の共通の門を通す（`router.refresh()` を直に呼ばない。圏外・届かない時に画面を失わない）
  const { refresh } = useChoresRefresh()
  const [days, setDays] = useState(PLAN_VIEW_DAYS)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [sheet, setSheet] = useState<SheetState>(null)
  const [avoid, setAvoid] = useState<Record<string, string[]>>({})
  const [readingToken, setReadingToken] = useState(0)
  const [interpreting, startInterpret] = useTransition()
  // 作成カードの、釦だけで変わる未保存の選択（主食の枠）が在るか
  const [createDirty, setCreateDirty] = useState(false)
  const sheetSeqRef = useRef(0)
  // 送信中の操作を送ったシートの通し番号（シートの外から送った操作・控えの確かめ直しは null）
  const originSheetRef = useRef<number | null>(null)

  const entries = view.days.flatMap((day) => day.entries)
  const titleOf = (entryId: string) => entries.find((entry) => entry.id === entryId)?.title ?? ""

  function nextSheetSeq(): number {
    sheetSeqRef.current += 1
    return sheetSeqRef.current
  }

  /**
   * 応答が属するシートだけを閉じる（送信中に開いた別のシートの入力を消さない）。`onOutcome` は送信時点の
   * 描画の値を見るので、今のシートは更新関数の引数（最新の state）から読む。
   */
  function closeOriginSheet() {
    const origin = originSheetRef.current
    if (origin === null) return
    setSheet((current) => (current !== null && current.seq === origin ? null : current))
  }

  function onOutcome(outcome: ChoreSaveOutcome<MealRequest, MealSaveSuccess>) {
    const request = outcome.payload
    if (!isPlanRequest(request)) {
      // ほかの画面（買い物・食材・設定）で結果不明になった操作を、この画面から確かめ直した
      if (outcome.kind === "rejected") {
        setNotice({ text: outcome.error, tone: "alert", details: [], toShopping: false })
      } else if (outcome.kind === "unknown") {
        setNotice(null)
      } else {
        const conflict = outcome.status === "conflict"
        setNotice({
          text: conflict ? OTHER_SCREEN_SAVE_TEXTS.conflict : OTHER_SCREEN_SAVE_TEXTS.saved,
          tone: conflict ? "alert" : "status",
          details: [],
          toShopping: false,
        })
      }
      return
    }
    if (outcome.kind === "rejected") {
      // 保存されていないと確定。シートは開いたまま（入力を直して送り直せる）
      if (request.op === "replace_day") setAvoid((prev) => ({ ...prev, [`day:${request.date}`]: [] }))
      if (request.op === "replace_dish") setAvoid((prev) => ({ ...prev, [`dish:${request.entryId}`]: [] }))
      setNotice({ text: outcome.error, tone: "alert", details: [], toShopping: false })
      return
    }
    if (outcome.kind === "unknown") {
      // 結果不明。確定と偽らず、控えの一覧（同じ操作で確認）を見せる。
      // 閉じるのは、その操作を送ったシートだけ（送信中に開いた別のシートの入力は消さない）
      closeOriginSheet()
      setNotice(null)
      return
    }
    // 自分の操作で献立が変わった（または変わっていた）。読み取り済みの希望は古い献立のもの
    setReadingToken((value) => value + 1)
    const { status } = outcome
    // 献立の要求には献立の Action が応える（`runMealRequest` の振り分け）
    const result = outcome.result as DinnerSaveSuccess
    if (status === "conflict") {
      closeOriginSheet()
      setNotice({ text: conflictTextOfDinner(result), tone: "alert", details: result.notices, toShopping: false })
      return
    }
    const details = [...result.notices]
    if (result.grocery && !result.grocery.ok) details.push(result.grocery.message)
    if (request.op === "cooked") {
      // 「作った」の後は、そのまま食材の更新と評価へ進める。送信中に別のシートを開いていたら、
      // その入力を消さない（開いているシートを差し替えない）
      const origin = originSheetRef.current
      const seq = nextSheetSeq()
      setSheet((current) =>
        current === null || current.seq === origin ? { kind: "entry", entryId: request.entryId, seq } : current,
      )
    } else if (request.op !== "pantry_after_cooking" && request.op !== "feedback") {
      // 食材・評価の保存ではシートを閉じない
      closeOriginSheet()
    }
    // 差し替えで献立から外れた料理（主食を含む主菜へ替わった日の主食）は、補足に埋もれさせず本文で言う
    const dropped = result.droppedEntries ?? []
    const droppedText =
      dropped.length === 0
        ? ""
        : ` ${dropped.map((entry) => `「${entry.title}」`).join("")}を献立から外しました（理由は下に示します）。`
    // 手で入れた料理が使わない食材に「当たる」「未確認」: 保存は成立しているが、確定はできない。補足に埋もれさせず警告として言う
    const warning = result.exclusionWarning
    setNotice({
      text: `${successTextOfDinnerRequest(request, result, titleOf)}${droppedText}${warning ? ` ${warning.message}` : ""}`,
      tone: warning ? "alert" : "status",
      details: warning ? details.filter((detail) => detail !== warning.message) : details,
      toShopping: request.op === "confirm",
    })
  }

  const save = useChoreSave<MealRequest, MealSaveSuccess>({
    owner,
    kind: "meal",
    // ごはんの全画面の操作を受ける（ほかの画面で結果不明になった操作も、ここから確かめ直せる）
    run: runMealRequest,
    isPayload: isMealRequest,
    onOutcome,
  })

  /**
   * 操作を送る。受け付けたら true。`fromSheet` は、開いているシートの中から送ったとき true
   * （応答でそのシートを閉じる）。一覧から送った操作は、後から開いたシートを閉じない。
   */
  function send(request: PlanRequest, fromSheet = false): boolean {
    setNotice(null)
    const accepted = save.send(request, labelOfDinnerRequest(request, titleOf)) !== null
    if (accepted) originSheetRef.current = fromSheet && sheet !== null ? sheet.seq : null
    return accepted
  }
  const sendFromSheet = (request: PlanRequest) => send(request, true)
  // 控えの確かめ直しは、どのシートからの操作でもない（応答でシートを閉じない）
  const pendingSave = {
    ...save,
    retry: (entry: Parameters<typeof save.retry>[0]) => {
      originSheetRef.current = null
      save.retry(entry)
    },
  }

  const busy = save.blocked || interpreting

  function generate(input: GenerateInput): boolean {
    return send({
      op: "generate",
      operationId: newClientId(),
      expectedRevision: input.expectedRevision,
      startDate: view.from,
      days,
      constraints: input.constraints,
      mode: input.mode,
      ...(input.includeStaple ? { includeStaple: true } : {}),
    })
  }

  function replaceDay(day: DinnerDayView) {
    const key = `day:${day.date}`
    const before = avoid[key] ?? []
    const current = day.entries.flatMap((entry) =>
      entry.recipeId !== null && !entry.pinned && entry.status !== "cooked" ? [entry.recipeId] : [],
    )
    const accepted = send({
      op: "replace_day",
      operationId: newClientId(),
      expectedRevision: view.revision,
      date: day.date,
      // 直前に見送った料理へ戻らないようにする（今の料理はサーバーが常に候補から外す）
      ...(before.length > 0 ? { avoidRecipeIds: before } : {}),
    })
    if (accepted) setAvoid((prev) => ({ ...prev, [key]: pushAvoid(before, current) }))
  }

  function replaceDish(entry: DinnerEntryView) {
    const key = `dish:${entry.id}`
    const before = avoid[key] ?? []
    const accepted = send({
      op: "replace_dish",
      entryId: entry.id,
      version: entry.version,
      ...(before.length > 0 ? { avoidRecipeIds: before } : {}),
    })
    if (accepted && entry.recipeId !== null) {
      setAvoid((prev) => ({ ...prev, [key]: pushAvoid(before, [entry.recipeId as string]) }))
    }
  }

  const shown: Notice | null =
    notice ??
    (save.message ? { text: save.message, tone: save.messageTone, details: [], toShopping: false } : null)
  const message =
    shown === null ? null : (
      <div className="flex flex-col gap-2" data-testid="plan-notice">
        {shown.tone === "alert" ? (
          <p role="alert" className="flex items-start gap-2 text-sm text-foreground">
            <AlertCircle size={16} className="mt-0.5 shrink-0 text-destructive" aria-hidden="true" />
            <span className="min-w-0 break-words">{shown.text}</span>
          </p>
        ) : (
          <p role="status" className="flex items-start gap-2 text-sm text-foreground">
            <CircleCheck
              size={16}
              className="mt-0.5 shrink-0 text-emerald-700 dark:text-emerald-400"
              aria-hidden="true"
            />
            <span className="min-w-0 break-words">{shown.text}</span>
          </p>
        )}
        {shown.details.length > 0 && (
          <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-muted-foreground">
            {shown.details.map((detail) => (
              <li key={detail} className="break-words">
                {detail}
              </li>
            ))}
          </ul>
        )}
        {shown.toShopping && (
          <Link href={MEALS_SHOPPING_HREF} prefetch={false} className={`${PRIMARY_LINK} self-start`}>
            <ShoppingCart size={16} aria-hidden="true" />
            買い物リストを見る
          </Link>
        )}
      </div>
    )

  const openEntry = sheet?.kind === "entry" ? entries.find((entry) => entry.id === sheet.entryId) : undefined
  const openEntryDay = openEntry ? view.days.find((day) => day.date === openEntry.date) : undefined
  const customDay = sheet?.kind === "custom" ? view.days.find((day) => day.date === sheet.date) : undefined
  const sheetOpen = openEntry !== undefined || customDay !== undefined

  // 確定を止める料理（提案のうち、使わない食材に「当たる」か「未確認」のもの。固定・手動を含む）
  const heldForConfirm = entries.filter((entry) => entry.status === "proposed" && entry.conflict !== null)

  // 設定の人数と違う人数のままの、これからの未調理の枠の数（サーバーが数える。表示していない日も含む）
  const servingsMismatch = view.servings.mismatchCount ?? 0
  const isCurrentWindow = view.from === view.today
  const pastStart = shiftYmd(view.today, -DINNER_ENTRY_PAST_DAYS)

  return (
    <div className="flex flex-col gap-4">
      <section
        aria-labelledby="plan-create-heading"
        className="glass flex flex-col gap-3 rounded-2xl p-4 shadow-lg shadow-black/[0.04]"
      >
        <h2 id="plan-create-heading" className="text-base font-semibold">
          献立を作る
        </h2>
        <PlanCreateCard
          view={view}
          ai={ai}
          days={days}
          onDaysChange={setDays}
          disabled={save.blocked}
          interpreting={interpreting}
          startInterpret={startInterpret}
          readingToken={readingToken}
          onStartChange={(start) => router.replace(planHref(start, view.today), { scroll: false })}
          onGenerate={generate}
          // 読み取りの間に献立が変わっていた。利用者の操作（希望を反映）の続きなので、見送らずに読み直す
          onStale={() => refresh("manual")}
          onUnsavedChange={setCreateDirty}
        />
      </section>

      {save.saving && (
        <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 size={16} className="animate-spin" aria-hidden="true" />
          保存しています…
        </p>
      )}
      {!sheetOpen && message}
      <PendingChoreNotice save={pendingSave} showMessage={false} />

      {view.counts.conflicts > 0 && (
        <p role="alert" className="flex items-start gap-2 text-sm text-foreground" data-testid="plan-conflict-summary">
          <AlertCircle size={16} className="mt-0.5 shrink-0 text-destructive" aria-hidden="true" />
          <span>
            使わない食材の設定に当たる、または原材料を確かめられない料理が {view.counts.conflicts} 品あります。
            勝手には置き換えていません。該当の料理を選び直してください。
          </span>
        </p>
      )}
      {/* 判定できない「使わない食材」の登録のために、料理を自動では確定していない／何も除外できていない */}
      <ExclusionHoldNotice notice={view.exclusions} />
      {view.limitedExclusions.length > 0 && (
        <div className="flex flex-col gap-1">
          <MealNotice kind="customExclusion" />
          <p className="text-xs text-muted-foreground">
            名前で判定している設定: {view.limitedExclusions.join("、")}
          </p>
        </div>
      )}
      {view.ageRulesChecked === false && (
        <p className="text-sm text-foreground" data-testid="plan-age-unchecked">
          お子さんの年齢についての注意（1 歳未満のはちみつ等）は、この画面では確認できていません。料理名からレシピを開いて確認してください。
        </p>
      )}
      {servingsMismatch > 0 && (
        // 設定の人数を変えても、既に在る献立は書き換えない。ずれている件数を知らせ、そろえるかは利用者が選ぶ
        <section
          aria-labelledby="plan-servings-heading"
          data-testid="plan-servings-mismatch"
          className="glass flex flex-col items-start gap-2 rounded-2xl p-4 shadow-lg shadow-black/[0.04]"
        >
          <h2 id="plan-servings-heading" className="flex items-center gap-2 text-base font-semibold">
            <Users size={18} aria-hidden="true" className="shrink-0 text-primary" />
            人数が設定と違う料理があります
          </h2>
          <p className="text-sm">
            これからの献立のうち {servingsMismatch} 品が、設定の人数（{formatServings(view.servings.value)}
            ）と違う人数のままです。買い物の量は、料理ごとの人数で計算しています（設定を変えても、既に在る献立は自動では変えていません）。
          </p>
          <Button
            type="button"
            variant="outline"
            disabled={busy || view.unreadableEntries > 0}
            onClick={() => send({ op: "servings_upcoming", servings: view.servings.value })}
          >
            これからの献立を{formatServings(view.servings.value)}にそろえる
          </Button>
          <p className="text-xs text-muted-foreground">
            今日以降の提案・確定の料理が対象です（固定した料理も含みます）。作った料理・過ぎた日は変わりません。1 品だけ変えるときは、その料理の「移動・その他」から変えられます。
          </p>
        </section>
      )}
      {view.unreadableEntries > 0 && (
        <p role="alert" className="flex items-start gap-2 text-sm text-foreground">
          <AlertCircle size={16} className="mt-0.5 shrink-0 text-destructive" aria-hidden="true" />
          <span>
            表示できない献立の記録が {view.unreadableEntries} 件あります。記録は消えていません。この間は、献立の作り直しと確定を止めています。
          </span>
        </p>
      )}

      <section aria-labelledby="plan-days-heading" className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h2 id="plan-days-heading" className="text-sm font-semibold text-muted-foreground">
            {formatMealDateShort(view.from)}〜{formatMealDateShort(view.to)}の献立
          </h2>
          <p className="text-xs text-muted-foreground">
            提案 {view.counts.proposed} 品・確定 {view.counts.confirmed} 品・作った {view.counts.cooked} 品
          </p>
        </div>
        <ul className="flex flex-col gap-3">
          {view.days.map((day) => (
            <PlanDayCard
              key={day.date}
              day={day}
              householdServings={view.servings.value}
              disabled={busy}
              onTogglePin={(entry) =>
                send({ op: "pin", entryId: entry.id, version: entry.version, pinned: !entry.pinned })
              }
              onReplaceDish={replaceDish}
              onReplaceDay={replaceDay}
              onCooked={(entry) => send({ op: "cooked", entryId: entry.id, version: entry.version })}
              onSkipped={(entry) => send({ op: "skipped", entryId: entry.id, version: entry.version })}
              onOpenEntry={(entry) => setSheet({ kind: "entry", entryId: entry.id, seq: nextSheetSeq() })}
              onAddCustom={(target) => setSheet({ kind: "custom", date: target.date, seq: nextSheetSeq() })}
            />
          ))}
        </ul>
      </section>

      <section
        aria-labelledby="plan-confirm-heading"
        className="glass flex flex-col gap-2 rounded-2xl p-4 shadow-lg shadow-black/[0.04]"
      >
        <h2 id="plan-confirm-heading" className="text-base font-semibold">
          確定と買い物
        </h2>
        {view.counts.proposed > 0 ? (
          <>
            <p className="text-sm text-muted-foreground">
              提案の料理が {view.counts.proposed} 品あります。確定した料理だけが、買い物リストの自動計算に入ります。
            </p>
            {heldForConfirm.length > 0 && (
              // 「当たる」「未確認」の料理（固定・手で入れた料理を含む）は、除外を確かめ済みの献立へ混ぜない。
              // サーバー（`confirmDinnerPlan`）も止める。ここでは押す前に理由と料理を言う
              <p role="alert" data-testid="plan-confirm-held" className="flex items-start gap-2 text-sm text-foreground">
                <AlertCircle size={16} className="mt-0.5 shrink-0 text-destructive" aria-hidden="true" />
                <span className="min-w-0 break-words">
                  使わない食材に当たる、または原材料を確かめられない料理（
                  {heldForConfirm.map((item) => `「${item.title}」`).join("")}
                  ）があるため、確定できません。選び直すか、手で入れた料理に材料を登録してください。
                </span>
              </p>
            )}
            <Button
              type="button"
              className="min-h-12 w-full text-base"
              disabled={busy || view.unreadableEntries > 0 || heldForConfirm.length > 0}
              onClick={() =>
                send({ op: "confirm", expectedRevision: view.revision, startDate: view.from, days: PLAN_VIEW_DAYS })
              }
            >
              <ClipboardCheck aria-hidden="true" />
              この献立で確定
            </Button>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            {view.counts.confirmed + view.counts.cooked > 0
              ? "この期間の料理は、すべて確定済みです。"
              : "確定できる料理がありません。先に献立を作ってください。"}
          </p>
        )}
        {view.groceryStale && (
          <p className="text-sm">
            買い物リストが、今の献立より古い可能性があります。買い物の画面で「献立から更新」を押してください。
          </p>
        )}
        <Link href={MEALS_SHOPPING_HREF} prefetch={false} className={`${OUTLINE_LINK} self-start`}>
          <ShoppingCart size={16} aria-hidden="true" />
          買い物リストへ
        </Link>
      </section>

      <nav aria-label="表示する期間" className="flex flex-wrap gap-2">
        {isCurrentWindow ? (
          <Link href={planHref(pastStart, view.today)} prefetch={false} className={TEXT_LINK}>
            過去 {DINNER_ENTRY_PAST_DAYS} 日の記録を見る
          </Link>
        ) : (
          <Link href={planHref(null)} prefetch={false} className={TEXT_LINK}>
            今日からの献立に戻る
          </Link>
        )}
        <Link href={MEALS_SETTINGS_HREF} prefetch={false} className={TEXT_LINK}>
          使わない食材・人数の設定
        </Link>
      </nav>

      <div className="flex flex-col gap-2">
        <MealNotice kind="nutrition" />
        <MealNotice kind="planOrigin" />
        <MealNotice kind="stockEstimate" />
      </div>

      {/* 釦だけで変わる未保存の選択（主食の枠）は自動では検出されないので、ここから伝える */}
      <RefreshOnVisible pollMs={POLL_MS} paused={createDirty} />

      <Sheet
        open={sheetOpen}
        onOpenChange={(open) => {
          if (!open) setSheet(null)
        }}
      >
        <SheetContent side="bottom" className="max-h-[85dvh] overflow-hidden rounded-t-2xl safe-bottom">
          {openEntry !== undefined && (
            <>
              <SheetHeader className="pr-14 pb-0">
                <SheetTitle className="break-words [overflow-wrap:anywhere]">{openEntry.title}</SheetTitle>
                <SheetDescription>
                  {openEntryDay?.label ?? formatMealDateShort(openEntry.date)}・{openEntry.roleLabel}・
                  {openEntry.statusLabel}
                </SheetDescription>
              </SheetHeader>
              <div className="flex flex-col gap-4 overflow-y-auto px-4 pb-4">
                {message}
                <PlanEntryPanel
                  key={openEntry.id}
                  entry={openEntry}
                  dayLabel={openEntryDay?.label ?? formatMealDateShort(openEntry.date)}
                  today={view.today}
                  householdServings={view.servings.value}
                  pantry={extras.pantryByEntry[openEntry.id] ?? []}
                  feedback={extras.feedbackByEntry[openEntry.id] ?? null}
                  custom={openEntry.isCustom ? (extras.customByEntry[openEntry.id] ?? []) : null}
                  disabled={busy}
                  saving={save.saving}
                  send={sendFromSheet}
                  onClose={() => setSheet(null)}
                />
              </div>
            </>
          )}
          {customDay !== undefined && (
            <>
              <SheetHeader className="pr-14 pb-0">
                <SheetTitle>料理を手で追加</SheetTitle>
                <SheetDescription>一覧に無い料理を、名前で献立へ入れます。</SheetDescription>
              </SheetHeader>
              <div className="flex flex-col gap-4 overflow-y-auto px-4 pb-4">
                {message}
                <PlanCustomDishForm
                  key={customDay.date}
                  editing={null}
                  date={customDay.date}
                  dateLabel={customDay.label}
                  disabled={busy}
                  saving={save.saving}
                  onSubmit={sendFromSheet}
                  onCancel={() => setSheet(null)}
                />
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  )
}
