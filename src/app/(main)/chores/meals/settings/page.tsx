import { childStageHint } from "@/components/chores/meals/settings/child-stage-hint"
import { buildExclusionLexicon } from "@/components/chores/meals/settings/exclusion-lexicon"
import type { FeedbackEditSeed } from "@/components/chores/meals/settings/settings-preferences"
import { MealSettingsView } from "@/components/chores/meals/settings/settings-view"
import { WeaningGuide } from "@/components/chores/meals/settings/weaning-guide"
import { WEANING_GENERAL_NOTES, WEANING_STAGE_GUIDES, getGuidanceSource } from "@/lib/meals/catalog/child-guidance"
import { childAgeMonths } from "@/lib/meals/child-serving"
import { KeepLastGood } from "@/components/chores/shared/keep-last-good"
import { MealContextError, loadMealContext } from "@/lib/meals/server/context"
import type { PlanConflictReport } from "@/lib/meals/server/settings-requests"
import { mealToday } from "@/lib/meals/server/today"
import {
  PLAN_CONFLICT_PARTS,
  SETTINGS_VIEW_PARTS,
  buildPlanConflictReport,
  buildSettingsView,
  type GuidanceSourceView,
} from "@/lib/meals/server/views"
import { getAuthContext } from "@/lib/supabase/auth-context"
import { shiftYmd } from "@/lib/utils/date-jst"

/**
 * 献立との重なりを確かめる範囲（今日から何日先まで）。除外を登録した直後に Server Action が
 * 返す重なり（`settings/actions.ts` の `PLAN_CONFLICT_HORIZON_DAYS`）と同じ範囲にする
 * （DB が受ける献立の日付の上限 = 今日 + 400 日）。
 */
const PLAN_CONFLICT_HORIZON_DAYS = 400

/** 離乳の段階の一般案内の出典（出典表に在るものだけ。無い ID は出さない）。 */
function weaningSources(): GuidanceSourceView[] {
  const ids = [...new Set(WEANING_STAGE_GUIDES.flatMap((guide) => guide.sourceIds))]
  const sources: GuidanceSourceView[] = []
  for (const id of ids) {
    const source = getGuidanceSource(id)
    if (!source) continue
    sources.push({
      id: source.id,
      title: source.title,
      publisher: source.publisher,
      url: source.url,
      pages: source.pages,
      confirmedOn: source.confirmedOn,
    })
  }
  return sources
}

/**
 * ごはんの設定（/chores/meals/settings）。人数・汁物・調理時間・常備品・子どもの食事の段階、
 * 使わない食材（アレルギー・苦手）、好み、覚えた好み（食後の評価）。
 *
 * - 設定の一覧は、読めない「使わない食材」の行が在っても開ける（読めた分の一覧と削除を出し、
 *   読めない件数を示す）。それ以外が読めなければ `KeepLastGood` へ理由を渡す（初回の表示なら
 *   ごはんの error boundary、表示済みの画面の取り直しなら直前の内容を保って「更新できません
 *   でした」を出す。**ここから throw しないこと** — 取り直しの失敗で、編集中の設定が消える）。
 * - 献立との重なりは別に読む。読めなくても設定の画面は出し、重なりは「確かめられなかった」と示す
 *   （「重なりは無い」と言い換えない）。読めない除外が在るときも、重なりは確かめられない。
 * - 見ている本人は `getAuthContext()` の `userId`（クライアントの入力を使わない）。
 * - 子どもの名前・生年月日は画面の表示にだけ使う（外部へ送らない）。
 */
export default async function MealSettingsPage() {
  const { context } = await getAuthContext()
  if (!context) return null
  const { supabase, userId, householdId } = context

  const today = mealToday()
  const [loaded, conflictLoad] = await Promise.all([
    loadMealContext(supabase, householdId, {
      include: SETTINGS_VIEW_PARTS,
      today,
      tolerateUnreadableExclusions: true,
    }),
    // 除外を全部読めたときだけ、献立との重なりを言える（こちらは、読めない除外が在れば失敗を返す）
    loadMealContext(supabase, householdId, {
      include: PLAN_CONFLICT_PARTS,
      today,
      planRange: { from: today, to: shiftYmd(today, PLAN_CONFLICT_HORIZON_DAYS) },
    }),
  ])
  const scope = `settings:${userId}:${householdId}`
  if (!loaded.ok) return <KeepLastGood scope={scope} failure={new MealContextError(loaded.failures).message} />
  const ctx = loaded.context
  const view = buildSettingsView(ctx, userId)
  const planConflicts: PlanConflictReport | null = conflictLoad.ok ? buildPlanConflictReport(conflictLoad.context) : null

  const stageHints: Record<string, string> = {}
  for (const child of ctx.children) {
    const hint = childStageHint(childAgeMonths(child.birthDate, ctx.today), WEANING_STAGE_GUIDES)
    if (hint !== null) stageHints[child.id] = hint
  }

  // 自分の食後評価を直すのに要る値（版と、保存されている料理名）。見ている本人の分だけを渡す
  // （家族の評価は直せない。DB も本人以外の更新を拒む）
  const feedbackEdits: Record<string, FeedbackEditSeed> = {}
  for (const row of ctx.feedback) {
    if (row.profileId === userId) feedbackEdits[row.id] = { version: row.version, dishTitle: row.dishTitle }
  }

  return (
    <KeepLastGood scope={scope}>
      <MealSettingsView
        // 持ち主（利用者・世帯）が替われば、画面の状態と保存の手順ごと作り直す
        key={`${userId}:${householdId}`}
        owner={{ userId, householdId }}
        view={view}
        planConflicts={planConflicts}
        stageHints={stageHints}
        feedbackEdits={feedbackEdits}
        // 自由入力の「使わない食材」を、登録の前に判定するための語彙（判定が読む項目だけ。
        // 食材辞書・レシピのカタログそのものは画面へ渡さない）
        exclusionLexicon={buildExclusionLexicon(ctx.lookup)}
        weaningGuide={
          <WeaningGuide
            stages={WEANING_STAGE_GUIDES.map((guide) => ({
              id: guide.id,
              label: guide.label,
              ageLabel: guide.ageLabel,
              texture: guide.texture,
            }))}
            notes={WEANING_GENERAL_NOTES}
            sources={weaningSources()}
          />
        }
      />
    </KeepLastGood>
  )
}
