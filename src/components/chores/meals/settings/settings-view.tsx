"use client"

import { useId, useMemo, useRef, useState, type ReactNode } from "react"
import Link from "next/link"
import { AlertCircle, CircleCheck } from "lucide-react"

import { OUTLINE_LINK } from "@/components/chores/meals/plan/link-styles"
import type { FeedbackChoiceValue } from "@/components/chores/meals/shared/feedback-choices"
import { MealNotice } from "@/components/chores/meals/shared/meal-notices"
import {
  MEALS_PLAN_HREF,
  MEAL_SETTINGS_CHILD_STAGES_ID,
  MEAL_SETTINGS_FEEDBACK_ID,
} from "@/components/chores/meals/shared/meal-routes"
import { Button } from "@/components/ui/button"
import { PendingChoreNotice } from "@/components/chores/shared/pending-chore-notice"
import { RefreshOnVisible } from "@/components/chores/shared/refresh-on-visible"
import {
  CHORE_SAVE_MESSAGES,
  useChoreSave,
  type ChoreSaveOutcome,
} from "@/components/chores/shared/use-chore-save"
import type { ChoreOwner } from "@/lib/domain/chore-pending"
import { GUARDIAN_MEAL_STAGES, type GuardianMealStage } from "@/lib/meals/child-serving"
import { formatServings } from "@/lib/meals/server/format"
import {
  isDinnerRequest,
  isDinnerServingsRequest,
  type DinnerRequest,
  type DinnerSaveSuccess,
  type DinnerServingsRequest,
} from "@/lib/meals/server/plan-requests"
import {
  SETTINGS_INPUT_MESSAGES,
  saveFoodExclusionIssue,
  type PlanConflictReport,
  type SaveFoodExclusionRequest,
} from "@/lib/meals/server/settings-requests"
import { buildExclusionSet } from "@/lib/meals/exclusions"
import type { SettingsView } from "@/lib/meals/server/views"
import type { ExclusionReason } from "@/lib/meals/types"
import { newClientId } from "@/lib/utils/client-id"

import {
  isMealBasicsRequest,
  labelOfMealBasicsRequest,
  type MealBasicsRequest,
} from "../basics/meal-basics-request"
import {
  OTHER_SCREEN_SAVE_TEXTS,
  isMealRequest,
  runMealRequest,
  type MealRequest,
  type MealSaveSuccess,
} from "../plan/meal-request"
import { labelOfDinnerRequest } from "../plan/plan-labels"
import {
  EXCLUSION_HOLDS_EFFECT,
  EXCLUSION_NO_EFFECT,
  EXCLUSION_REGISTERED_TEXTS,
  EXCLUSION_UNDETERMINED_LEAD,
  allergyCategoryCandidates,
  describeExclusionPreview,
  lexiconCatalog,
  previewExclusionLabel,
  type AllergyCategoryCandidate,
  type ExclusionLexicon,
  type ExclusionPreviewText,
} from "./exclusion-lexicon"
import { ExclusionForm, ExclusionList, PlanConflictPanel } from "./settings-exclusions"
import {
  DinnerBasicsCard,
  DinnerChildStagesCard,
  DinnerStaplesCard,
  type DinnerSettingsPatch,
  type SettingsVersionGuard,
} from "./settings-household-cards"
import { FeedbackList, PreferenceForm, PreferenceList, type FeedbackEditSeed } from "./settings-preferences"

/** 表示中の定期再取得の間隔（家族の変更を取り込む）。 */
const POLL_MS = 60_000

interface Notice {
  text: string
  tone: "status" | "alert"
}

/** 保存の結果の文を出す区画（最後に操作した区画に出す。長い画面で、結果が視界の外に出ないように）。 */
type SettingsCard = "basics" | "staples" | "children"
type Area = "top" | SettingsCard | "exclusions" | "preferences" | "feedback"
/** 未保存の入力を持ちうる区画（設定の 3 枚のカード・除外の登録フォーム・評価の編集）。 */
type DraftArea = SettingsCard | "exclusion_form" | "feedback_editor"

export interface MealSettingsViewProps {
  owner: ChoreOwner
  view: SettingsView
  /**
   * 今日以降の献立と「使わない食材」の重なり（Server Component が読んだもの）。
   * null = 確かめられなかった（「重なりは無い」と言わない）。
   */
  planConflicts: PlanConflictReport | null
  /** child_id → 月齢からの目安の文（添えるだけ。段階は決めない）。 */
  stageHints: Record<string, string>
  /** 離乳の段階の一般案内（Server Component が描いたもの）。 */
  weaningGuide?: ReactNode
  /**
   * 自分の食後評価を直すのに要る値（評価の ID → 版と、保存されている料理名）。**見ている本人の分だけ**。
   * 渡されなければ、評価の編集は出さない（削除だけ）。
   */
  feedbackEdits?: Record<string, FeedbackEditSeed>
  /**
   * 自由入力の「使わない食材」が何に解決するかを、登録の前に確かめるための語彙
   * （`buildExclusionLexicon`。カタログそのものは画面へ渡さない）。
   */
  exclusionLexicon?: ExclusionLexicon
}

/** 設定の版を、自分の保存の連なりの鍵にするときの表記（未登録の世帯の「版なし」を含む）。 */
const NO_SETTINGS_VERSION = "(none)"
const versionKey = (version: string | null) => version ?? NO_SETTINGS_VERSION

function Section({
  id,
  title,
  description,
  children,
}: {
  /** 別の画面からこの区画へ送るときの行き先（`#id`）。 */
  id?: string
  title: string
  description?: string
  children: ReactNode
}) {
  const headingId = useId()
  return (
    <section id={id} aria-labelledby={headingId} className="flex scroll-mt-4 flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 id={headingId} className="text-sm font-semibold text-muted-foreground">
          {title}
        </h2>
        {description !== undefined && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {children}
    </section>
  )
}

/**
 * ごはんの設定（/chores/meals/settings）。人数・汁物・調理時間、常備品、使わない食材
 * （アレルギー・苦手）、好み、覚えた好み（食後の評価）、子どもの食事の段階。
 *
 * - 保存は `useChoreSave`（操作 ID と内容を送信の前に固定・結果不明は同じ操作で確認・自動再送なし）。
 * - 設定（人数ほか）は 1 行に入っている。カードごとに「そのカードの項目だけ」を変え、残りは
 *   サーバーの今の値のまま送る（別のカードの入力途中の値を巻き込まない）。
 * - **カードは、触った時点の設定の版を固定する。** 触った後に版が進み、それがこの画面の自分の保存
 *   （別のカードの保存）で進んだものでなければ、保存を止めて「他の端末で変更されました」と出す
 *   （古い入力に新しい版を付けて送ると、版の照合が素通りして家族の変更を黙って巻き戻す）。
 *   サーバーの版の照合（conflict）は、その後ろの最後の砦として残る。
 * - 使わない食材を変えたら、今日以降の献立との重なりを一覧で示す（献立は書き換えない）。
 *   自由入力が食材の一覧と照合できないときは、登録の前後と一覧で、そのとおりに言う。
 * - 覚えた好み（食後の評価）は、自分の分をここで直せる（献立の画面に出なくなった古い評価も）。
 */
export function MealSettingsView({
  owner,
  view,
  planConflicts,
  stageHints,
  weaningGuide,
  feedbackEdits,
  exclusionLexicon,
}: MealSettingsViewProps) {
  const [notice, setNotice] = useState<Notice | null>(null)
  const [area, setArea] = useState<Area>("top")
  // この画面の自分の保存で進んだ設定の版（保存の前の版 → 保存の後の版）。カードが「触った後の版の
  // 進みは自分の保存だけか」を確かめるのに使う
  const [ownChain, setOwnChain] = useState<Record<string, string>>({})
  // 釦だけで変わる未保存の入力（人数の増減・常備品のチップ・評価の編集など）を持つ区画。
  // 文字の入力と違い、自動の取り直しの見送りに自動では数えられない
  const [drafts, setDrafts] = useState<Partial<Record<DraftArea, boolean>>>({})
  const [feedbackListKey, setFeedbackListKey] = useState(0)
  // 人数を変えた保存の後の「これからの献立もそろえますか」。`mismatch` が null = 件数を確かめられなかった
  const [servingsPrompt, setServingsPrompt] = useState<{ servings: number; mismatch: number | null } | null>(null)
  const servingsChangedRef = useRef(false)
  const setDraft = (at: DraftArea) => (hasDraft: boolean) => setDrafts((prev) => ({ ...prev, [at]: hasDraft }))
  // 自由入力の除外の判定に使う索引（語彙が替わったときだけ作り直す）
  const lexiconView = useMemo(
    () => (exclusionLexicon === undefined ? null : lexiconCatalog(exclusionLexicon)),
    [exclusionLexicon],
  )
  // 登録済みの自由入力の除外が、今の食材の一覧で何に解決するか（判定できないものに印を付ける）
  const customNotes: Record<string, ExclusionPreviewText> = {}
  for (const exclusion of view.exclusions) {
    // サーバーが判定した「どう効いているか」を優先する（一覧に無い ID で登録された除外も含む）
    if (exclusion.effect === "holds_auto_confirm") {
      customNotes[exclusion.id] = { kind: "holds", lead: EXCLUSION_UNDETERMINED_LEAD, effect: EXCLUSION_HOLDS_EFFECT }
    } else if (exclusion.effect === "no_effect") {
      customNotes[exclusion.id] = { kind: "no_effect", lead: EXCLUSION_UNDETERMINED_LEAD, effect: EXCLUSION_NO_EFFECT }
    } else if (exclusion.target.kind === "custom" && lexiconView !== null && exclusionLexicon !== undefined) {
      // 自由入力が何として扱われているか（同じ規則をこの画面で引く）
      customNotes[exclusion.id] = describeExclusionPreview(
        previewExclusionLabel(exclusion.target.label, exclusion.reason, lexiconView),
        exclusionLexicon,
      )
    }
  }
  const undeterminedCount = Object.values(customNotes).filter(
    (note) => note.kind === "holds" || note.kind === "no_effect",
  ).length
  // 対象品目（大豆・鶏肉）の候補。アレルギーの登録で既に品目全体が外れておる品目は「登録済み」と言う（候補にしない）。
  // 数えるのは判定と同じ規則（`buildExclusionSet` のアレルゲンの規則）: 品目での登録に加え、素の食材（大豆）の登録が
  // 広げた品目も含む。苦手の登録は数えない
  const registeredAllergyAllergens = useMemo(() => {
    if (lexiconView === null) {
      return view.exclusions.flatMap((exclusion) =>
        exclusion.reason === "allergy" && exclusion.target.kind === "allergen" ? [exclusion.target.allergenId] : [],
      )
    }
    const rules = buildExclusionSet(view.exclusions, lexiconView).allergenRules
    return [...new Set(rules.filter((rule) => rule.reason === "allergy").map((rule) => rule.allergenId))]
  }, [view.exclusions, lexiconView])
  function categoryCandidatesFor(
    target: { kind: "ingredient"; ingredientId: string } | { kind: "custom"; label: string },
    reason: ExclusionReason,
  ): AllergyCategoryCandidate[] {
    if (lexiconView === null || exclusionLexicon === undefined || reason !== "allergy") return []
    if (target.kind === "ingredient") {
      return allergyCategoryCandidates(
        { reason, ingredientIds: [target.ingredientId] },
        exclusionLexicon,
        registeredAllergyAllergens,
      )
    }
    // 自由入力は、判定と同じ解決で食材へ当たったときだけ（名前の一致・判定できない語には出さない）
    const resolution = previewExclusionLabel(target.label, reason, lexiconView)
    if (resolution.status !== "resolved") return []
    return allergyCategoryCandidates(
      { reason, ingredientIds: resolution.ingredientIds, directAllergenIds: resolution.allergenIds },
      exclusionLexicon,
      registeredAllergyAllergens,
    )
  }
  // 登録済みのアレルギー（食材・自由入力）が含むが、外していない対象品目（黙って広げず、選べるようにする）
  const categoryNotes: Record<string, AllergyCategoryCandidate[]> = {}
  for (const exclusion of view.exclusions) {
    if (exclusion.reason !== "allergy") continue
    const target = exclusion.target
    const candidates =
      target.kind === "ingredient"
        ? categoryCandidatesFor({ kind: "ingredient", ingredientId: target.ingredientId }, exclusion.reason)
        : target.kind === "custom"
          ? categoryCandidatesFor({ kind: "custom", label: target.label }, exclusion.reason)
          : []
    const open = candidates.filter((candidate) => !candidate.registered)
    if (open.length > 0) categoryNotes[exclusion.id] = open
  }
  // 設定のカード・登録フォームは、保存が確定したら作り直して、サーバーの最新から始める。
  // 作り直すのは保存したカードだけ（ほかのカードの入力途中の値は残す）。家族が先に変えていた時は
  // 3 枚とも作り直す（古い値をもとにした入力で、家族の変更を巻き戻さない）
  const [cardKeys, setCardKeys] = useState<Record<SettingsCard, number>>({ basics: 0, staples: 0, children: 0 })
  const lastSettingsCardRef = useRef<SettingsCard>("basics")
  const [exclusionFormKey, setExclusionFormKey] = useState(0)
  const [preferenceFormKey, setPreferenceFormKey] = useState(0)
  // この画面で登録した除外（重なりの一覧で「今回の登録に該当」と示す）
  const [highlightIds, setHighlightIds] = useState<string[]>([])
  // 保存の応答に入っていた重なり。サーバーの内容を取り直すまでの間だけ使う
  const [actionConflicts, setActionConflicts] = useState<{
    report: PlanConflictReport | null
    basis: PlanConflictReport | null
  } | null>(null)

  function onOutcome(outcome: ChoreSaveOutcome<MealRequest, MealSaveSuccess>) {
    if (outcome.kind === "rejected") {
      // 保存されていないと確定。入力は残す（直して送り直せる）
      setNotice({ text: outcome.error, tone: "alert" })
      return
    }
    if (outcome.kind === "unknown") {
      setNotice(null)
      return
    }
    const { result } = outcome
    const request = outcome.payload
    if (!("op" in result)) {
      if (isDinnerRequest(request) && request.op === "feedback") {
        // 「覚えた好み」の編集（食後評価の保存。献立の Action が応える）
        const dinner = result as DinnerSaveSuccess
        // 保存できた・別の端末が先に変えていた、のどちらでも編集を閉じて最新を見せる
        setFeedbackListKey((key) => key + 1)
        setDrafts((prev) => ({ ...prev, feedback_editor: false }))
        setNotice(
          dinner.status === "conflict"
            ? {
                text: dinner.notices[0] ?? "この評価は別の端末で更新されていました。上書きはしていません。最新の内容を確認してください。",
                tone: "alert",
              }
            : { text: "評価を更新しました。次の提案から、更新した内容を使います。", tone: "status" },
        )
        return
      }
      if (isDinnerServingsRequest(request) && request.op === "servings_upcoming") {
        // 設定の人数を変えた後に、利用者が選んだ「これからの献立もそろえる」（献立の Action が応える）
        const dinner = result as DinnerSaveSuccess
        setServingsPrompt(null)
        setNotice(
          dinner.status === "conflict"
            ? {
                text:
                  dinner.notices[0] ??
                  "別の端末が先に献立を変えていたため、人数をそろえられませんでした。献立の画面で確認してください。",
                tone: "alert",
              }
            : {
                text:
                  dinner.notices.join(" ") ||
                  `これからの献立の人数を、${request.servings}人分にそろえました。`,
                tone: "status",
              },
        )
        return
      }
      // 献立・買い物の画面で送った操作を、この画面から確かめ直したとき
      setNotice(
        result.status === "conflict"
          ? { text: OTHER_SCREEN_SAVE_TEXTS.conflict, tone: "alert" }
          : { text: OTHER_SCREEN_SAVE_TEXTS.saved, tone: "status" },
      )
      return
    }
    switch (result.op) {
      case "settings_save": {
        const saved = lastSettingsCardRef.current
        setCardKeys((keys) =>
          result.status === "conflict"
            ? { basics: keys.basics + 1, staples: keys.staples + 1, children: keys.children + 1 }
            : { ...keys, [saved]: keys[saved] + 1 },
        )
        setDrafts((prev) =>
          result.status === "conflict"
            ? { ...prev, basics: false, staples: false, children: false }
            : { ...prev, [saved]: false },
        )
        // 自分の保存で進んだ版を覚える（別のカードの入力途中の値を、家族の変更と取り違えない）。
        // `replayed`（確かめ直し）は数えない — 返る設定が、自分の保存の後に家族が変えた版でありうる
        if (
          result.status === "saved" &&
          result.settings !== null &&
          isMealBasicsRequest(request) &&
          request.op === "settings_save"
        ) {
          const from = versionKey(request.version)
          const to = versionKey(result.settings.version)
          if (from !== to) setOwnChain((prev) => ({ ...prev, [from]: to }))
        }
        // 人数を変えた保存の後: 既に在る献立は書き換えていない。変更前の人数のままの料理が在れば
        // （または確かめられなければ）、そろえるかを利用者に選んでもらう
        if (
          result.status !== "conflict" &&
          servingsChangedRef.current &&
          isMealBasicsRequest(request) &&
          request.op === "settings_save"
        ) {
          servingsChangedRef.current = false
          const mismatch = result.planServingsMismatch
          if (mismatch === null || (typeof mismatch === "number" && mismatch > 0)) {
            setServingsPrompt({ servings: request.servings, mismatch })
          } else {
            setServingsPrompt(null)
          }
        }
        setNotice(
          result.status === "conflict"
            ? {
                text: "別の端末が先に設定を変えていました。上書きはしていません。最新の内容を確認して、必要ならもう一度変更してください。",
                tone: "alert",
              }
            : { text: "設定を保存しました。", tone: "status" },
        )
        return
      }
      case "exclusion_save": {
        setExclusionFormKey((key) => key + 1)
        setDrafts((prev) => ({ ...prev, exclusion_form: false }))
        setHighlightIds((prev) => (prev.includes(result.exclusion.id) ? prev : [...prev, result.exclusion.id]))
        setActionConflicts({ report: result.planConflicts, basis: planConflicts })
        // 「献立と提案から外します」と言うのは、食材の一覧と照合できたときだけ。
        // サーバーが返した解決の結果を使い、無ければ同じ規則をこの画面で引く
        const { target, reason } = result.exclusion
        const effect =
          result.resolution?.effect ??
          (target.kind === "custom" && lexiconView !== null
            ? previewExclusionLabel(target.label, reason, lexiconView).effect
            : target.kind === "custom"
              ? null
              : "excludes")
        const registered = result.status === "conflict" ? "同じ内容の「使わない食材」が、既に登録されています。" : "使わない食材に登録しました。"
        if (effect === "holds_auto_confirm") {
          setNotice({ text: `${registered}${EXCLUSION_REGISTERED_TEXTS.holds}`, tone: "alert" })
        } else if (effect === "no_effect") {
          setNotice({ text: `${registered}${EXCLUSION_REGISTERED_TEXTS.no_effect}`, tone: "alert" })
        } else if (effect === null) {
          setNotice({
            text: `${registered}食材の一覧と照合できたかは、上の一覧で確認してください。`,
            tone: "status",
          })
        } else {
          setNotice({
            text: result.status === "conflict" ? registered : `${registered}献立と提案から外します。`,
            tone: "status",
          })
        }
        return
      }
      case "exclusion_delete": {
        setActionConflicts({ report: result.planConflicts, basis: planConflicts })
        setNotice({ text: "使わない食材から削除しました。", tone: "status" })
        return
      }
      case "preference_save": {
        setPreferenceFormKey((key) => key + 1)
        if (result.deleted) {
          setNotice({ text: "この好みは、別の端末で削除されていました。保存していません。", tone: "alert" })
        } else if (result.status === "conflict") {
          setNotice({
            text: "同じ対象の好みが既に登録されているか、別の端末が先に変更していました。上書きはしていません。最新の内容を確認してください。",
            tone: "alert",
          })
        } else {
          setNotice({ text: "好みを保存しました。次の提案から使います。", tone: "status" })
        }
        return
      }
      case "preference_delete":
        setNotice({ text: "好みを削除しました。次の提案から使いません。", tone: "status" })
        return
      case "feedback_delete":
        setNotice({ text: "評価を削除しました。次の提案と理由の表示から使いません。", tone: "status" })
        return
      default:
        // 食材の画面で送った操作を、この画面から確かめ直したとき
        setNotice(
          result.status === "conflict"
            ? { text: CHORE_SAVE_MESSAGES.conflict, tone: "alert" }
            : { text: "保存しました。内容は食材の画面で確認できます。", tone: "status" },
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

  /** 操作を送る。受け付けたら true。結果の文は `at` の区画に出す。 */
  function send(at: Area, request: MealBasicsRequest, name?: string): boolean {
    setNotice(null)
    setArea(at)
    return save.send(request, labelOfMealBasicsRequest(request, name)) !== null
  }

  /** `from` の版から `to` の版までが、この画面の自分の保存だけで進んだものか（同じ版なら true）。 */
  function isOwnLineage(from: string | null, to: string | null): boolean {
    const goal = versionKey(to)
    let at = versionKey(from)
    // 連なりは保存 1 回につき 1 つ伸びるだけ。輪にならないが、念のため歩数を限る
    for (let hops = 0; hops <= 100; hops += 1) {
      if (at === goal) return true
      if (!Object.prototype.hasOwnProperty.call(ownChain, at)) return false
      at = ownChain[at]
    }
    return false
  }
  // 画面が持っている設定の版に、自分の保存で進んだ先が在る = 保存の結果がまだ届いていない。
  // この間に別のカードを送ると、古い値（今の画面の値）で、保存したばかりの自分の変更を巻き戻す
  const catchingUp = Object.prototype.hasOwnProperty.call(ownChain, versionKey(view.settings.version))
  const guard: SettingsVersionGuard = { version: view.settings.version, isOwnLineage, catchingUp }

  function saveSettings(at: SettingsCard, patch: DinnerSettingsPatch, baseVersion: string | null): boolean {
    const { settings } = view
    // カードが入力を始めた版から今の版までが、自分の保存だけで進んだときにだけ送る（釦は無効にして
    // あるが、Enter での送信もここで止める）
    if (catchingUp || !isOwnLineage(baseVersion, settings.version)) return false
    lastSettingsCardRef.current = at
    // 人数を変える保存か（保存の後に、既に在る献立へ反映するかを尋ねる）
    servingsChangedRef.current = patch.servings !== undefined && patch.servings !== settings.servings
    // 今の世帯にいる子・アプリが知っている段階・食材の一覧に在る常備品だけを送る
    // （DB と Action は、世帯にいない子・未知の段階・一覧に無い食材を含む保存を丸ごと拒む）
    const childStages: Record<string, GuardianMealStage> = {}
    for (const child of view.children) {
      const stage = child.stage
      if (stage !== null && (GUARDIAN_MEAL_STAGES as readonly string[]).includes(stage)) {
        childStages[child.childId] = stage as GuardianMealStage
      }
    }
    const knownStapleIds = new Set(view.staples.filter((staple) => staple.known).map((staple) => staple.id))
    return send(at, {
      op: "settings_save",
      version: settings.version,
      servings: settings.servings,
      includeSoup: settings.includeSoup,
      maxCookMinutes: settings.maxCookMinutes,
      stapleIngredientIds: settings.stapleIngredientIds.filter((id) => knownStapleIds.has(id)),
      childStages,
      ...patch,
    })
  }

  /**
   * 自分の食後評価を直す（C-75）。献立の画面の評価と同じ操作（`feedback`）で、評価の ID と
   * **編集を開いた時点の版**を送る（別の端末が先に変えていれば上書きしない）。
   */
  function saveFeedbackEdit(
    row: SettingsView["feedback"][number],
    seed: FeedbackEditSeed,
    version: string,
    value: FeedbackChoiceValue,
  ): boolean {
    const request: DinnerRequest = {
      op: "feedback",
      id: row.id,
      version,
      recipeId: row.recipeId,
      // 保存されている料理名をそのまま送る（評価の対象を、編集で書き換えない）
      dishTitle: seed.dishTitle.trim() !== "" ? seed.dishTitle : row.dishTitle,
      eatenOn: row.eatenOn,
      taste: value.taste,
      effort: value.effort,
      again: value.again,
      excludeFromLearning: value.excludeFromLearning,
    }
    setNotice(null)
    setArea("feedback")
    return save.send(request, labelOfDinnerRequest(request, () => "")) !== null
  }

  const sending = save.pending.find((entry) => entry.phase === "sending")?.payload
  const busyExclusionId = sending?.op === "exclusion_delete" ? sending.id : null
  const busyPreferenceId = sending?.op === "preference_save" || sending?.op === "preference_delete" ? sending.id : null
  const busyFeedbackId = sending?.op === "feedback_delete" || sending?.op === "feedback" ? sending.id : null
  /** 送信中の印は、最後に操作した区画の釦にだけ出す。 */
  const savingAt = (at: Area) => save.saving && area === at

  // 保存の応答の重なりは、サーバーの内容が取り直されるまで（= props が替わるまで）だけ使う
  const conflictReport =
    actionConflicts !== null && actionConflicts.basis === planConflicts ? actionConflicts.report : planConflicts

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
  const messageAt = (at: Area) => (area === at ? message : null)

  const childOptions = view.children.map((child) => ({ id: child.childId, name: child.name }))

  return (
    <div className="flex flex-col gap-6">
      {messageAt("top")}
      <PendingChoreNotice
        // 控えの一覧からの確かめ直し・破棄の結果は、一覧のすぐ上に出す
        save={{
          ...save,
          retry: (entry) => {
            setNotice(null)
            setArea("top")
            save.retry(entry)
          },
          discard: (entry) => {
            setNotice(null)
            setArea("top")
            save.discard(entry)
          },
          discardUnreadable: () => {
            setNotice(null)
            setArea("top")
            save.discardUnreadable()
          },
        }}
        showMessage={false}
      />

      <Section title="献立の基本">
        <DinnerBasicsCard
          key={`basics-${cardKeys.basics}`}
          settings={view.settings}
          settingsMissing={view.settingsMissing}
          disabled={save.blocked}
          saving={savingAt("basics")}
          guard={guard}
          onSave={(patch, baseVersion) => saveSettings("basics", patch, baseVersion)}
          onDraftChange={setDraft("basics")}
        />
        {messageAt("basics")}
        {servingsPrompt !== null && (
          // 設定の保存は献立を書き換えない。既に在る献立へ反映するかは、利用者が選ぶ（R45）
          <div
            role="group"
            aria-label="これからの献立の人数"
            data-testid="settings-servings-prompt"
            className="glass flex flex-col items-start gap-2 rounded-2xl p-4 shadow-lg shadow-black/[0.04]"
          >
            {servingsPrompt.mismatch === null ? (
              <>
                <p className="text-sm">
                  人数の設定は保存しました。これからの献立に、変更前の人数のままの料理が在るかは確かめられませんでした（在っても、自動では変えていません）。献立の画面で確認してください。
                </p>
                <Link href={MEALS_PLAN_HREF} prefetch={false} className={OUTLINE_LINK}>
                  献立の画面で確認する
                </Link>
              </>
            ) : (
              <>
                <p className="text-sm">
                  これからの献立のうち {servingsPrompt.mismatch} 品は、変更前の人数のままです（設定を変えても、既に在る献立は自動では変えていません）。買い物の量は、料理ごとの人数で計算しています。
                </p>
                <Button
                  type="button"
                  disabled={save.blocked}
                  onClick={() => {
                    setNotice(null)
                    setArea("basics")
                    const request: DinnerServingsRequest = { op: "servings_upcoming", servings: servingsPrompt.servings }
                    save.send(request, labelOfDinnerRequest(request, () => ""))
                  }}
                >
                  これからの献立も{formatServings(servingsPrompt.servings)}にする
                </Button>
                <p className="text-xs text-muted-foreground">
                  今日以降の提案・確定の料理が対象です（固定した料理も含みます）。作った料理・過ぎた日は変わりません。
                </p>
              </>
            )}
            <Button type="button" variant="outline" onClick={() => setServingsPrompt(null)}>
              {servingsPrompt.mismatch === null ? "閉じる" : "そのままにする"}
            </Button>
          </div>
        )}
      </Section>

      <Section title="常備品">
        <DinnerStaplesCard
          key={`staples-${cardKeys.staples}`}
          staples={view.staples}
          disabled={save.blocked}
          saving={savingAt("staples")}
          guard={guard}
          onSave={(patch, baseVersion) => saveSettings("staples", patch, baseVersion)}
          onDraftChange={setDraft("staples")}
        />
        {messageAt("staples")}
      </Section>

      <Section
        title="使わない食材"
        description="アレルギーのある食材・苦手な食材を登録します。一覧から選んだもの・食材の一覧と照合できたものは、どちらの理由でも、家族全員の献立と提案から必ず外します。自由に入力した名前が照合できないときは、その旨を表示します。"
      >
        {undeterminedCount > 0 && (
          // 開いた時から在る表示ゆえ alert にしない（開くたびに読み上げが割り込まないように）
          <p data-testid="settings-undetermined-summary" className="flex items-start gap-2 text-sm text-foreground">
            <AlertCircle size={16} className="mt-0.5 shrink-0 text-destructive" aria-hidden="true" />
            <span className="min-w-0 break-words">
              自動では判定できない登録が {undeterminedCount} 件あります。その登録では料理を外せていません。下の一覧で確かめ、一覧から選ぶか食材名で登録し直してください。
            </span>
          </p>
        )}
        <ExclusionList
          exclusions={view.exclusions}
          customNotes={customNotes}
          categoryNotes={categoryNotes}
          unreadable={view.unreadableExclusions}
          disabled={save.blocked}
          busyId={busyExclusionId}
          onDelete={(exclusion) =>
            send("exclusions", { op: "exclusion_delete", id: exclusion.id }, exclusion.targetLabel)
          }
          onRegisterCategory={(exclusion, candidate) => {
            // 元の登録は書き換えず、同じ「誰の分」で品目の登録を足す
            const request: SaveFoodExclusionRequest = {
              id: newClientId(),
              reason: "allergy",
              target: { kind: "allergen", allergenId: candidate.allergenId },
              subject: exclusion.subject,
            }
            const issue = saveFoodExclusionIssue(request)
            if (issue !== null) {
              setArea("exclusions")
              setNotice({ text: SETTINGS_INPUT_MESSAGES[issue], tone: "alert" })
              return
            }
            send("exclusions", { op: "exclusion_save", ...request }, candidate.allergenName)
          }}
        />
        {messageAt("exclusions")}
        <PlanConflictPanel report={conflictReport} highlightIds={highlightIds} />
        <ExclusionForm
          key={`exclusion-${exclusionFormKey}`}
          allergens={view.allergens}
          ingredientOptions={view.ingredientOptions}
          members={view.members}
          childOptions={childOptions}
          disabled={save.blocked}
          saving={savingAt("exclusions") && sending?.op === "exclusion_save"}
          previewCustom={
            lexiconView !== null && exclusionLexicon !== undefined
              ? (label, reason) =>
                  describeExclusionPreview(previewExclusionLabel(label, reason, lexiconView), exclusionLexicon)
              : undefined
          }
          categoryCandidatesFor={
            lexiconView !== null && exclusionLexicon !== undefined ? categoryCandidatesFor : undefined
          }
          onSubmit={(request, targetLabel) => send("exclusions", { op: "exclusion_save", ...request }, targetLabel)}
          onDraftChange={setDraft("exclusion_form")}
        />
        <MealNotice kind="allergyJudgement" />
      </Section>

      <Section
        title="好み"
        description="好き・苦手は、提案の順位にだけ使います。家族共通の好みと、個人の好みを分けて登録できます。"
      >
        <PreferenceList
          preferences={view.preferences}
          unreadable={view.unreadable.preferences ?? 0}
          disabled={save.blocked}
          busyId={busyPreferenceId}
          onFlip={(preference) =>
            send(
              "preferences",
              {
                op: "preference_save",
                id: preference.id,
                version: preference.version,
                scope: preference.scope,
                target: preference.target,
                sentiment: preference.sentiment === "like" ? "dislike" : "like",
              },
              preference.targetLabel,
            )
          }
          onDelete={(preference) =>
            send("preferences", { op: "preference_delete", id: preference.id }, preference.targetLabel)
          }
        />
        {messageAt("preferences")}
        <PreferenceForm
          key={`preference-${preferenceFormKey}`}
          options={view.preferenceOptions}
          disabled={save.blocked}
          saving={savingAt("preferences") && sending?.op === "preference_save" && sending.version === null}
          onSubmit={(request, targetLabel) => send("preferences", { op: "preference_save", ...request }, targetLabel)}
        />
      </Section>

      <Section id={MEAL_SETTINGS_FEEDBACK_ID} title="覚えた好み">
        <FeedbackList
          // 評価の保存が確定したら作り直す（開いていた編集を閉じ、最新の内容から始める）
          key={`feedback-${feedbackListKey}`}
          feedback={view.feedback}
          since={view.feedbackSince}
          unreadable={view.unreadable.feedback ?? 0}
          disabled={save.blocked}
          busyId={busyFeedbackId}
          editSeeds={feedbackEdits}
          onDelete={(row) => send("feedback", { op: "feedback_delete", id: row.id }, row.dishTitle)}
          onSave={saveFeedbackEdit}
          onDraftChange={setDraft("feedback_editor")}
        />
        {messageAt("feedback")}
      </Section>

      <Section id={MEAL_SETTINGS_CHILD_STAGES_ID} title="子どもの食事">
        <DinnerChildStagesCard
          key={`children-${cardKeys.children}`}
          childViews={view.children}
          stageOptions={view.stageOptions}
          stageHints={stageHints}
          guide={weaningGuide}
          disabled={save.blocked}
          saving={savingAt("children")}
          guard={guard}
          onSave={(patch, baseVersion) => saveSettings("children", patch, baseVersion)}
          onDraftChange={setDraft("children")}
        />
        {messageAt("children")}
      </Section>

      {/* 釦だけで変わる未保存の入力が在る間は、自動の取り直しを見送る（自動では検出されない） */}
      <RefreshOnVisible pollMs={POLL_MS} paused={Object.values(drafts).some((hasDraft) => hasDraft === true)} />
    </div>
  )
}
