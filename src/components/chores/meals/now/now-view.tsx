import Link from "next/link"
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  Baby,
  ChevronRight,
  CircleAlert,
  CircleHelp,
  Refrigerator,
  ScanSearch,
  SearchX,
} from "lucide-react"

import { AddToPlanButton } from "@/components/chores/meals/shared/add-to-plan-button"
import { ExclusionHoldNotice } from "@/components/chores/meals/shared/exclusion-hold-notice"
import {
  MEALS_PANTRY_HREF,
  MEALS_SETTINGS_HREF,
  mealRecipeHref,
} from "@/components/chores/meals/shared/meal-routes"
import { MealNotice } from "@/components/chores/meals/shared/meal-notices"
import { RecipeRow } from "@/components/chores/meals/shared/recipe-row"
import { EmptyState } from "@/components/chores/shared/empty-state"
import { MEAL_CONTEXT_PART_LABELS, type MealContextPart } from "@/lib/meals/server/context"
import { formatServings } from "@/lib/meals/server/format"
import { STAPLE_RULE_NOTE, type NowCandidateView, type NowLineView, type NowView as NowViewData } from "@/lib/meals/server/views"

const CARD = "glass flex flex-col gap-3 rounded-2xl p-4 shadow-lg shadow-black/[0.04]"
const ACTION_LINK =
  "inline-flex min-h-11 min-w-11 items-center gap-1 rounded-lg border border-border bg-background px-3 text-sm font-medium text-foreground transition-colors duration-200 hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring dark:border-input dark:bg-input/30"

/** 材料 1 行の表記（「玉ねぎ 1個」）。 */
function lineText(line: NowLineView): string {
  return `${line.name} ${line.required}`
}

function LineReasons({ line }: { line: NowLineView }) {
  if (line.reasons.length === 0) return null
  return <span className="text-muted-foreground">（{line.reasons.map((reason) => reason.label).join("・")}）</span>
}

/**
 * 候補 1 件。料理名（レシピ詳細へのリンク）・時間・充足の印、使う在庫、この順位の理由、
 * 枠ごとの内訳（確認が要る材料・買い足す材料と量）、年齢の注意、取り分け案内の有無。
 */
function CandidateCard({ candidate }: { candidate: NowCandidateView }) {
  const used = candidate.lines.filter((line) => !line.optional && (line.state === "enough" || line.state === "staple"))
  return (
    <li data-testid="now-candidate" className={CARD}>
      <RecipeRow
        title={candidate.title}
        role={candidate.role}
        minutes={candidate.minutes}
        sufficiency={candidate.level}
        href={mealRecipeHref(candidate.recipeId)}
      />

      {candidate.missing.length > 0 && (
        <div className="flex flex-col gap-1">
          <p className="text-sm font-semibold">買い足す食材</p>
          <ul className="flex flex-col gap-1 text-sm">
            {candidate.missing.map((line) => (
              <li key={line.ingredientId} className="break-words">
                {/* 足りない量が分かればその量と必要量、分からなければレシピの必要量だけを示す */}
                {line.shortBy !== null ? (
                  <>
                    {line.name} あと {line.shortBy}
                    <span className="text-muted-foreground">（必要量 {line.required}）</span>
                  </>
                ) : (
                  lineText(line)
                )}{" "}
                <LineReasons line={line} />
              </li>
            ))}
          </ul>
        </div>
      )}

      {candidate.toCheck.length > 0 && (
        <div className="flex flex-col gap-1">
          <p className="text-sm font-semibold">分量を確認する食材</p>
          <ul className="flex flex-col gap-1 text-sm">
            {candidate.toCheck.map((line) => (
              <li key={line.ingredientId} className="break-words">
                {lineText(line)} <LineReasons line={line} />
                {/* 総称で登録した食材（「豚肉」）が当たりうる材料。同一視はしていない — 確認が要る理由を言う */}
                {line.genericStock !== null && line.genericStock !== undefined && (
                  <span data-testid="now-generic-line" className="block text-muted-foreground">
                    {line.genericStock.text}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {used.length > 0 && (
        <p className="text-sm break-words">
          <span className="font-semibold">使う在庫: </span>
          {used.map((line) => `${lineText(line)}${line.state === "staple" ? "（常備品）" : ""}`).join("、")}
        </p>
      )}

      {candidate.reasons.length > 0 && (
        <ul aria-label={`${candidate.title}の理由`} className="flex flex-col gap-1 text-sm">
          {candidate.reasons.map((reason, index) => (
            <li key={`${reason.kind}-${reason.recordId ?? index}`} className="flex items-start gap-2">
              {reason.tone === "plus" ? (
                <ArrowUp size={16} className="mt-0.5 shrink-0 text-emerald-700 dark:text-emerald-400" aria-hidden="true" />
              ) : (
                <ArrowDown size={16} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              )}
              <span className="min-w-0 break-words">
                <span className="sr-only">{reason.tone === "plus" ? "順位を上げた理由: " : "順位を下げた理由: "}</span>
                {reason.text}
              </span>
            </li>
          ))}
        </ul>
      )}

      {candidate.ageWarnings.map((warning) => (
        <p
          key={`${warning.childId}-${warning.ingredientName}`}
          role="note"
          className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-foreground"
        >
          <CircleAlert size={16} className="mt-0.5 shrink-0 text-destructive" aria-hidden="true" />
          <span className="min-w-0 break-words">{warning.text}</span>
        </p>
      ))}

      {candidate.servingChildren.length > 0 && (
        <p className="flex items-start gap-2 text-sm text-muted-foreground">
          <Baby size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span className="min-w-0 break-words">
            {candidate.servingChildren.map((child) => child.childName).join("・")}
            の取り分け案内があります（料理名からレシピを開くと確認できます）。
          </span>
        </p>
      )}

      {/* 選んだ料理を献立へ入れる（献立を読めた画面でだけ出る。入れた後は、献立で「作った」・評価へ進める） */}
      <AddToPlanButton recipeId={candidate.recipeId} title={candidate.title} role={candidate.role} />
    </li>
  )
}

function countLabel(shown: number, total: number): string {
  return total > shown ? `${total}件中 ${shown}件を表示` : `${total}件`
}

function unreadableParts(unreadable: NowViewData["unreadable"]): { part: MealContextPart; count: number }[] {
  return (Object.entries(unreadable) as [MealContextPart, number | undefined][])
    .filter((entry): entry is [MealContextPart, number] => (entry[1] ?? 0) > 0)
    .map(([part, count]) => ({ part, count }))
}

/**
 * 「今あるもので」（/chores/meals/now）の表示。`buildNowView` の結果をそのまま描く。
 *
 * - **3 つの枠を別の区画にする**: 揃う（基本 3 案）／分量を確認／買い足せば作れる。
 *   買い足しが要る料理を「揃う」に並べない。揃う候補が 0 件なら 0 件と書き、別の枠で埋めない。
 * - 理由は、ロジックが実在する在庫・設定・評価の記録から作った文だけを出す（ここで文を足さない）。
 * - 総称で登録した食材（「豚肉」「きのこ」）は材料に数えていないこと、判定できない「使わない食材」の
 *   登録のために料理を自動では確定していないことを、理由と直す場所と一緒に出す。
 * - 境界指令を持たない（Server Component から描く）。操作は、リンクと「献立に入れる」の釦
 *   （釦は、page が `AddToPlanProvider` で包んだときだけ出る。保存の手順は Provider が持ち、
 *   ここは Server Action を import しない）。
 */
export function NowView({ view }: { view: NowViewData }) {
  const pantryEmpty = view.pantry.total === 0
  const unreadable = unreadableParts(view.unreadable)
  const genericItems = view.genericItems ?? []
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <p className="text-sm text-muted-foreground">
          登録した食材から、今日作れる料理を探します。{formatServings(view.servings)}で計算しています
          {view.maxCookMinutes !== null && `（調理時間の上限 ${view.maxCookMinutes}分）`}。
        </p>
        {view.usingDefaultServings && <MealNotice kind="defaultServings" />}
      </div>

      <ExclusionHoldNotice notice={view.exclusions} />

      {genericItems.length > 0 && (
        <div
          data-testid="now-generic-items"
          className="flex flex-col items-start gap-2 rounded-2xl border border-amber-500/40 bg-amber-50 p-4 text-sm text-foreground dark:bg-amber-950/30"
        >
          <p className="flex items-start gap-2">
            <CircleHelp size={16} className="mt-0.5 shrink-0 text-amber-700 dark:text-amber-300" aria-hidden="true" />
            <span className="min-w-0 break-words">
              <span className="font-semibold">総称で登録した食材は、材料に数えていません。</span>
              {[...new Set(genericItems.map((item) => item.name))].map((name) => `「${name}」`).join("")}
              は部位・種類が分からないため、材料が揃っているとは数えていません（当たりそうな料理は「分量を確認」に入れています）。食材の画面で具体的な名前（部位・種類）に直すと、候補に数えます。
            </span>
          </p>
          <Link href={MEALS_PANTRY_HREF} prefetch={false} className={ACTION_LINK}>
            食材の画面で直す
            <ChevronRight size={16} aria-hidden="true" />
          </Link>
        </div>
      )}

      {unreadable.length > 0 && (
        <p role="alert" className="flex items-start gap-2 text-sm text-foreground">
          <AlertCircle size={16} className="mt-0.5 shrink-0 text-destructive" aria-hidden="true" />
          <span>
            読み取れない記録があります（
            {unreadable.map(({ part, count }) => `${MEAL_CONTEXT_PART_LABELS[part] ?? part} ${count}件`).join("・")}
            ）。その分は提案に反映できていません。
          </span>
        </p>
      )}

      <section aria-labelledby="now-ready-heading" className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h2 id="now-ready-heading" className="text-sm font-semibold text-muted-foreground">
            食材と量が揃う料理
          </h2>
          <p data-testid="now-ready-count" className="text-sm">
            {view.readyTotal === 0 ? "揃う候補は 0 件です。" : `揃う候補: ${countLabel(view.ready.length, view.readyTotal)}`}
          </p>
        </div>

        {view.readyTotal > 0 ? (
          <ul aria-labelledby="now-ready-heading" className="flex flex-col gap-3">
            {view.ready.map((candidate) => (
              <CandidateCard key={candidate.recipeId} candidate={candidate} />
            ))}
          </ul>
        ) : pantryEmpty ? (
          <EmptyState
            icon={Refrigerator}
            title="食材がまだ登録されていません"
            description="家にある食材を登録すると、今あるもので作れる料理を探せます。"
          >
            <Link href={MEALS_PANTRY_HREF} prefetch={false} className={ACTION_LINK}>
              食材を登録する
              <ChevronRight size={16} aria-hidden="true" />
            </Link>
          </EmptyState>
        ) : (
          <div className={CARD}>
            <p className="flex items-start gap-2 text-sm">
              <SearchX size={18} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span>
                必要な食材と量がすべて揃う料理は見つかりませんでした。下の「分量を確認」「買い足せば作れる」は、揃っていない料理を別の枠で示したものです。
              </span>
            </p>
            {view.hints.length > 0 && (
              <div className="flex flex-col gap-1">
                <p className="text-sm font-semibold">入力を見直すと、候補が増えることがあります</p>
                <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
                  {view.hints.map((hint) => (
                    <li key={hint.code}>{hint.text}</li>
                  ))}
                </ul>
              </div>
            )}
            {view.pantry.unresolved.length > 0 && (
              <p className="text-sm break-words text-muted-foreground">
                食材の一覧にない名前: {view.pantry.unresolved.map((item) => `「${item.name}」`).join("")}
              </p>
            )}
            <p className="text-sm text-muted-foreground">{STAPLE_RULE_NOTE}</p>
            <div className="flex flex-wrap gap-2">
              <Link href={MEALS_PANTRY_HREF} prefetch={false} className={ACTION_LINK}>
                食材を見直す
                <ChevronRight size={16} aria-hidden="true" />
              </Link>
              <Link href={MEALS_SETTINGS_HREF} prefetch={false} className={ACTION_LINK}>
                常備品を設定する
                <ChevronRight size={16} aria-hidden="true" />
              </Link>
            </div>
          </div>
        )}

        {view.readyTotal > 0 && view.stapleCount === 0 && (
          <p className="text-xs text-muted-foreground">{STAPLE_RULE_NOTE}</p>
        )}
      </section>

      <section aria-labelledby="now-check-heading" className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h2 id="now-check-heading" className="text-sm font-semibold text-muted-foreground">
            分量を確認
          </h2>
          <p className="text-sm">
            食材はありますが、数量が分からない・残り少ない・確認から日が経っているものを含む料理です。
            {view.checkTotal === 0 ? "該当は 0 件です。" : countLabel(view.check.length, view.checkTotal)}
          </p>
        </div>
        {view.check.length > 0 && (
          <ul aria-labelledby="now-check-heading" className="flex flex-col gap-3">
            {view.check.map((candidate) => (
              <CandidateCard key={candidate.recipeId} candidate={candidate} />
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="now-buy-heading" className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h2 id="now-buy-heading" className="text-sm font-semibold text-muted-foreground">
            買い足せば作れる
          </h2>
          <p className="text-sm">
            必要な食材が欠けている料理です。足りない食材と量を示します。
            {view.buyTotal === 0 ? "該当は 0 件です。" : countLabel(view.buy.length, view.buyTotal)}
          </p>
        </div>
        {view.buy.length > 0 && (
          <ul aria-labelledby="now-buy-heading" className="flex flex-col gap-3">
            {view.buy.map((candidate) => (
              <CandidateCard key={candidate.recipeId} candidate={candidate} />
            ))}
          </ul>
        )}
      </section>

      {view.labelCheck.length > 0 && (
        <section aria-labelledby="now-label-heading" className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <h2 id="now-label-heading" className="text-sm font-semibold text-muted-foreground">
              原材料の確認が必要な料理
            </h2>
            <p className="text-sm">
              アレルギーの設定があり、原材料を確かめられないため、候補に入れていない料理です（{view.labelCheck.length}件）。
            </p>
          </div>
          <ul aria-labelledby="now-label-heading" className="flex flex-col gap-3">
            {view.labelCheck.map((dish) => (
              <li key={dish.recipeId} className={CARD}>
                <RecipeRow
                  title={dish.title}
                  role={dish.role}
                  minutes={dish.minutes}
                  verdict="label_check"
                  href={mealRecipeHref(dish.recipeId)}
                />
                <ul className="flex flex-col gap-1 text-sm">
                  {dish.reasons.map((reason, index) => (
                    <li key={`${reason.code}-${index}`} className="flex items-start gap-2">
                      <ScanSearch size={16} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                      <span className="min-w-0 break-words">{reason.text}</span>
                    </li>
                  ))}
                  {/* 料理の材料には確認の要るものが無い。判定できないアレルギーの登録のためだけに外している */}
                  {dish.undeterminedHold === true && (
                    <li className="flex items-start gap-2">
                      <ScanSearch size={16} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                      <span className="min-w-0 break-words">
                        判定できないアレルギーの登録があるため、この料理が該当するかを見分けられません（料理そのものの材料の問題ではありません）。
                      </span>
                    </li>
                  )}
                </ul>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="flex flex-col gap-2">
        {view.excludedCount > 0 && (
          <p className="text-sm text-muted-foreground">
            「使わない食材」の設定に当たる料理 {view.excludedCount} 件は、どの枠にも入れていません。
          </p>
        )}
        {view.exclusions.hasAllergy && <MealNotice kind="allergyJudgement" />}
        {view.exclusions.limited.length > 0 && <MealNotice kind="customExclusion" />}
        <MealNotice kind="stockEstimate" />
      </div>
    </div>
  )
}
