"use client"

import { useId, useRef, useState, type TransitionStartFunction } from "react"
import Link from "next/link"
import { AlertCircle, Bot, Loader2, Sparkles, Wand2 } from "lucide-react"

import { interpretDinnerWish } from "@/app/(main)/chores/meals/plan/actions"
import { MealNotice } from "@/components/chores/meals/shared/meal-notices"
import { MEALS_SETTINGS_HREF } from "@/components/chores/meals/shared/meal-routes"
import { CheckButton } from "@/components/chores/shared/check-button"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { formatMealDateShort, formatMealDateWithRelative, formatServings } from "@/lib/meals/server/format"
import {
  WISH_INPUT_MAX,
  type DinnerPlanMode,
  type InterpretWishResult,
  type MealAiStatusView,
  type WishSummaryItem,
} from "@/lib/meals/server/plan-requests"
import type { DinnerPlanView } from "@/lib/meals/server/plan-views"
import { MEAL_RANGE_MAX_DAYS, MEAL_RANGE_MIN_DAYS } from "@/lib/meals/server/today"
import type { WishConstraints } from "@/lib/meals/types"

import { NATIVE_SELECT, TEXT_LINK } from "./link-styles"
import { planStartOptions } from "./plan-query"

type InterpretOk = Extract<InterpretWishResult, { ok: true }>

/** 読み取った希望と、その前提（どの献立の版・どの期間・どの文から読んだか）。 */
interface Reading {
  result: InterpretOk
  wish: string
  startDate: string
  days: number
  /** 「希望を反映」を押した時に画面が見ていた献立の版。 */
  sentRevision: number
  /** 読み取りを始めた時の、献立の変更の通し番号（自分の操作で献立が変わると進む）。 */
  token: number
}

export interface GenerateInput {
  constraints: WishConstraints | null
  mode: DinnerPlanMode
  expectedRevision: number
  includeStaple: boolean
}

const READ_FAILED =
  "希望を読み取れませんでした。通信状況を確認して、もう一度お試しください。希望を使わない作成は、そのまま使えます。"

const DAY_OPTIONS = Array.from(
  { length: MEAL_RANGE_MAX_DAYS - MEAL_RANGE_MIN_DAYS + 1 },
  (_, index) => MEAL_RANGE_MIN_DAYS + index,
)

function summaryText(item: WishSummaryItem): string {
  if (item.kind === "pin") return `${item.dateLabel}は「${item.title}」に固定`
  if (item.kind === "prefer_recipe") return `「${item.title}」を優先`
  if (item.kind === "max_minutes") return `${item.minutes}分以内で作れる料理を優先`
  return item.kind === "prefer_tag" ? `「${item.label}」の料理を多めに` : `「${item.label}」の料理を控えめに`
}

function summaryKey(item: WishSummaryItem): string {
  if (item.kind === "pin") return `pin:${item.date}:${item.recipeId}`
  if (item.kind === "prefer_recipe") return `recipe:${item.recipeId}`
  if (item.kind === "max_minutes") return `minutes:${item.minutes}`
  return `${item.kind}:${item.tag}`
}

/**
 * 献立を作る操作（開始日・日数・希望）。
 *
 * - 「〇日分の献立を作る」は 1 回の押下で作る（希望は任意）。AI 補助が未設定・上限・停止中でも使える。
 * - 「希望を反映」は希望の文を読み取るだけで、**献立は変えない**。読み取った内容（固定する日と料理・
 *   反映できなかった部分）を見せ、利用者が「この内容で献立を作る」を押して初めて作成へ進む。
 * - 読み取りを待つ間・読み取った後に献立が変わっていたら、読み取った希望は適用しない
 *   （「他の端末で変更されました」。採用の釦を出さない）。サーバーも採用の直前に版と除外を検証し直す。
 * - 読み取りの経路（自動 = 規則 / AI 補助）と AI 補助の状態を、実際のとおりに出す。
 */
export function PlanCreateCard({
  view,
  ai,
  days,
  onDaysChange,
  disabled,
  interpreting,
  startInterpret,
  readingToken,
  onStartChange,
  onGenerate,
  onStale,
  onUnsavedChange,
}: {
  view: DinnerPlanView
  /** 画面を開いた時点の AI 補助の状態。 */
  ai: MealAiStatusView
  days: number
  onDaysChange: (days: number) => void
  /** 保存中・確認待ちで新しい操作を受けられない。 */
  disabled: boolean
  interpreting: boolean
  startInterpret: TransitionStartFunction
  /** 自分の操作で献立が変わるたびに進む番号（進んだら、読み取った希望を捨てる）。 */
  readingToken: number
  onStartChange: (start: string) => void
  /** 受け付けたら true。 */
  onGenerate: (input: GenerateInput) => boolean
  /** 読み取りの間に献立が変わっていた（最新を読み直す）。 */
  onStale: () => void
  /**
   * 釦だけで変わる未保存の選択（主食の枠）が在るかを伝える。文字の入力と違い、自動の取り直しの
   * 見送りに自動では数えられないので、画面が `RefreshOnVisible` の `paused` へ渡す。
   */
  onUnsavedChange?: (dirty: boolean) => void
}) {
  const formId = useId()
  const [wish, setWish] = useState("")
  const [includeStaple, setIncludeStaple] = useState(false)
  const [reading, setReading] = useState<Reading | null>(null)
  const [readError, setReadError] = useState<string | null>(null)
  const [latestAi, setLatestAi] = useState<MealAiStatusView | null>(null)
  const sequence = useRef(0)

  const canCreate = view.from >= view.today
  const trimmed = wish.trim()
  // 期間・希望の文・献立（自分の操作）が読み取りの後で変わっていたら、その読み取りは使わない
  const current =
    reading !== null &&
    reading.token === readingToken &&
    reading.startDate === view.from &&
    reading.days === days &&
    reading.wish === trimmed
      ? reading
      : null
  // 読み取りを待つ間、または読み取った後に、献立が変わった（別の端末の操作）
  const stale =
    current !== null && (current.result.revision !== view.revision || current.sentRevision !== current.result.revision)
  const shownAi = latestAi ?? ai
  const busy = disabled || interpreting

  function interpret() {
    if (busy || trimmed === "") return
    sequence.current += 1
    const mine = sequence.current
    const sent = { wish: trimmed, startDate: view.from, days }
    const sentRevision = view.revision
    const token = readingToken
    setReadError(null)
    setReading(null)
    startInterpret(async () => {
      try {
        const result = await interpretDinnerWish(sent)
        // 後から押した読み取りが在れば、古い応答は捨てる
        if (sequence.current !== mine) return
        if (!result.ok) {
          setReadError(result.error)
          return
        }
        setLatestAi(result.ai)
        setReading({ result, ...sent, sentRevision, token })
        // 待つ間に献立が変わっていた。自動では適用せず、最新の献立を読み直す
        if (result.revision !== sentRevision) onStale()
      } catch (err) {
        console.error("[plan-create-card] 希望の読み取りに失敗", {
          message: err instanceof Error ? err.message : String(err),
        })
        if (sequence.current === mine) setReadError(READ_FAILED)
      }
    })
  }

  function adopt() {
    if (current === null || stale || busy) return
    onGenerate({
      constraints: current.result.constraints,
      mode: current.result.via === "ai" ? "ai_assisted" : "auto",
      expectedRevision: current.result.revision,
      includeStaple,
    })
  }

  const startId = `${formId}-start`
  const daysId = `${formId}-days`
  const wishId = `${formId}-wish`
  const wishHelpId = `${formId}-wish-help`

  if (!canCreate) {
    return (
      <p className="text-sm text-muted-foreground">
        過ぎた日を含む期間を表示しています。ここでは献立を作らず、「作った」「作らなかった」の記録だけができます。
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-3 min-[360px]:grid-cols-2">
        <div className="flex flex-col gap-1">
          <label htmlFor={startId} className="text-sm font-medium">
            開始日
          </label>
          <select
            id={startId}
            className={NATIVE_SELECT}
            value={view.from}
            disabled={busy}
            onChange={(event) => onStartChange(event.target.value)}
          >
            {planStartOptions(view.today).map((date) => (
              <option key={date} value={date}>
                {formatMealDateWithRelative(date, view.today)}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={daysId} className="text-sm font-medium">
            作る日数
          </label>
          <select
            id={daysId}
            className={NATIVE_SELECT}
            value={String(days)}
            disabled={busy}
            onChange={(event) => onDaysChange(Number(event.target.value))}
          >
            {DAY_OPTIONS.map((value) => (
              <option key={value} value={String(value)}>
                {value}日分
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="flex flex-col gap-1 text-sm">
        <p>
          人数: <span className="font-medium">{formatServings(view.servings.value)}</span>
          {view.servings.isStandard && "（標準）"}
          {view.includeSoup && "・汁物あり"}
          {view.maxCookMinutes !== null && `・${view.maxCookMinutes}分以内を優先`}
        </p>
        {view.servings.isStandard && <MealNotice kind="defaultServings" />}
        <Link href={MEALS_SETTINGS_HREF} prefetch={false} className={`${TEXT_LINK} w-fit`}>
          人数や条件を設定で変える
        </Link>
      </div>

      <div className="flex items-center gap-2">
        <CheckButton
          checked={includeStaple}
          onCheckedChange={(next) => {
            setIncludeStaple(next)
            onUnsavedChange?.(next)
          }}
          label="主食の枠も作る"
          disabled={busy}
        />
        <span className="text-sm">
          主食（ごはんなど）の枠も作る
          <span className="block text-xs text-muted-foreground">丼・カレーなど主食を含む料理の日には足しません。</span>
        </span>
      </div>

      <Button
        type="button"
        className="min-h-12 w-full text-base"
        disabled={busy}
        onClick={() =>
          onGenerate({ constraints: null, mode: "auto", expectedRevision: view.revision, includeStaple })
        }
      >
        <Sparkles aria-hidden="true" />
        {days}日分の献立を作る
      </Button>
      <p className="text-xs text-muted-foreground">
        {formatMealDateShort(view.from)}から{days}日分を、提案として作ります。固定した料理・作った料理はそのまま残します。
      </p>

      <div className="flex flex-col gap-2 border-t border-border/60 pt-4">
        <label htmlFor={wishId} className="text-sm font-medium">
          希望（任意）
        </label>
        <Textarea
          id={wishId}
          value={wish}
          maxLength={WISH_INPUT_MAX}
          placeholder="例: 金曜はカレー、魚多め、30分以内"
          aria-describedby={wishHelpId}
          disabled={interpreting}
          onChange={(event) => {
            setWish(event.target.value)
            setReadError(null)
          }}
        />
        <div id={wishHelpId}>
          <MealNotice kind="aiWish" />
        </div>
        <Button
          type="button"
          variant="outline"
          className="self-start"
          disabled={busy || trimmed === ""}
          onClick={interpret}
        >
          {interpreting ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Wand2 aria-hidden="true" />}
          {interpreting ? "希望を読み取っています…" : "希望を反映"}
        </Button>
        <p className="flex items-start gap-2 text-xs text-muted-foreground" data-testid="meal-ai-status">
          <Bot size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>{shownAi.message}</span>
        </p>

        {readError !== null && (
          <p role="alert" className="flex items-start gap-2 text-sm text-foreground">
            <AlertCircle size={16} className="mt-0.5 shrink-0 text-destructive" aria-hidden="true" />
            <span>{readError}</span>
          </p>
        )}

        {current !== null && (
          <section
            aria-labelledby={`${formId}-reading`}
            className="flex flex-col gap-2 rounded-xl border border-border/60 bg-muted/40 px-3 py-3"
          >
            <h3 id={`${formId}-reading`} className="text-sm font-semibold">
              希望の読み取り結果
            </h3>
            <p className="text-xs text-muted-foreground">
              読み取り: {current.result.via === "ai" ? "AI 補助" : "自動（決まった規則による読み取り）"}
              。この時点では、献立は変わっていません。
            </p>
            {current.result.summary.length === 0 ? (
              <p className="text-sm">読み取れた条件はありませんでした。希望を使わない作成は、そのまま使えます。</p>
            ) : (
              <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
                {current.result.summary.map((item) => (
                  <li key={summaryKey(item)}>{summaryText(item)}</li>
                ))}
              </ul>
            )}
            {current.result.unparsed.length > 0 && (
              <p className="text-sm">
                反映できなかった部分: {current.result.unparsed.map((part) => `「${part}」`).join("")}
              </p>
            )}
            {(current.result.pinConflicts ?? []).length > 0 && (
              // 同じ日・同じ区分への 2 つ目の固定は採らなかった。どれを残し、どれを採らなかったかを言う
              <ul data-testid="wish-pin-conflicts" className="flex flex-col gap-1 text-sm">
                {(current.result.pinConflicts ?? []).map((conflict) => (
                  <li key={`${conflict.date}:${conflict.recipeId}`} className="flex items-start gap-2">
                    <AlertCircle size={16} className="mt-0.5 shrink-0 text-destructive" aria-hidden="true" />
                    <span className="min-w-0 break-words">
                      {conflict.message !== ""
                        ? conflict.message
                        : `${conflict.dateLabel}は「${conflict.keptTitle}」を固定しました。同じ日の「${conflict.title}」は固定していません。`}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {current.result.truncated && (
              <p className="text-sm text-muted-foreground">希望の文が長いため、途中までを読み取りました。</p>
            )}
            {current.result.pinNotices.map((text) => (
              <p key={text} className="text-sm text-muted-foreground">
                {text}
              </p>
            ))}
            {stale ? (
              <p role="alert" className="flex items-start gap-2 text-sm text-foreground">
                <AlertCircle size={16} className="mt-0.5 shrink-0 text-destructive" aria-hidden="true" />
                <span>
                  他の端末で変更されました。読み取った希望は適用していません。最新の献立を確認してから、もう一度「希望を反映」を押してください。
                </span>
              </p>
            ) : (
              current.result.summary.length > 0 && (
                <Button type="button" className="self-start" disabled={busy} onClick={adopt}>
                  この内容で献立を作る
                </Button>
              )
            )}
            <Button type="button" variant="ghost" className="self-start" onClick={() => setReading(null)}>
              読み取りを取り消す
            </Button>
          </section>
        )}
      </div>
    </div>
  )
}
