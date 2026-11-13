import Link from "next/link"
import { Baby, ChevronRight, CircleAlert, CircleHelp, ScanSearch, Scissors } from "lucide-react"

import { TEXT_LINK } from "@/components/chores/meals/plan/link-styles"
import { AddToPlanButton } from "@/components/chores/meals/shared/add-to-plan-button"
import { ExclusionHoldNotice } from "@/components/chores/meals/shared/exclusion-hold-notice"
import { MealNotice } from "@/components/chores/meals/shared/meal-notices"
import { VerdictMark } from "@/components/chores/meals/shared/meal-marks"
import { MEAL_CHILD_STAGES_HREF } from "@/components/chores/meals/shared/meal-routes"
import { CHILD_SERVING_UNSUPPORTED_TEXT, SEPARATE_BEFORE_SEASONING_NOTE } from "@/lib/meals/catalog/child-guidance"
import { dishRoleLabel, formatMinutes, formatServings } from "@/lib/meals/server/format"
import { DINNER_SERVINGS_DEFAULT } from "@/lib/meals/server/rows"
import type { RecipeChildView, RecipeDetailView, RecipeIngredientView } from "@/lib/meals/server/views"
import { cn } from "@/lib/utils"

import { GuidanceSources } from "../basics/guidance-sources"
import {
  MARK_ALERT_TONE,
  MARK_BADGE_CLASS,
  MARK_NEUTRAL_TONE,
  MARK_WARN_TONE,
} from "../basics/field-classes"

const CARD = "glass flex flex-col gap-3 rounded-2xl p-4 shadow-lg shadow-black/[0.04]"
const SECTION_HEADING = "text-sm font-semibold text-muted-foreground"
const ALERT_BOX =
  "flex flex-col gap-2 rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-3 text-sm text-foreground"

function IngredientRow({ ingredient }: { ingredient: RecipeIngredientView }) {
  return (
    <li data-testid="recipe-ingredient" className="flex flex-col gap-1 py-2">
      <div className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 text-base break-words [overflow-wrap:anywhere]">
          {ingredient.name}
          {ingredient.optional && <span className="text-sm text-muted-foreground">（なくても作れます）</span>}
        </span>
        <span className="shrink-0 text-base font-medium">{ingredient.quantityText}</span>
      </div>
      {ingredient.note !== null && <p className="text-sm break-words text-muted-foreground">{ingredient.note}</p>}
      {(ingredient.excluded || ingredient.labelCheck !== null || ingredient.allergens.length > 0) && (
        <ul className="flex flex-wrap items-center gap-1.5">
          {ingredient.excluded && (
            <li className={cn(MARK_BADGE_CLASS, MARK_ALERT_TONE)}>
              <CircleAlert size={14} className="shrink-0" aria-hidden="true" />
              使わない食材
            </li>
          )}
          {ingredient.labelCheck !== null && (
            <li className={cn(MARK_BADGE_CLASS, MARK_WARN_TONE)}>
              <ScanSearch size={14} className="shrink-0" aria-hidden="true" />
              原材料の確認が必要
            </li>
          )}
          {ingredient.allergens.length > 0 && (
            <li className="text-sm break-words text-muted-foreground">
              含む: {ingredient.allergens.map((allergen) => allergen.name).join("・")}
            </li>
          )}
        </ul>
      )}
    </li>
  )
}

function ChildServingCard({ child, steps }: { child: RecipeChildView; steps: readonly string[] }) {
  const { serving } = child
  return (
    <li data-testid="recipe-child" className={CARD}>
      <div className="flex flex-col gap-0.5">
        <p className="text-base font-medium break-words [overflow-wrap:anywhere]">{child.name}</p>
        <p className="text-sm text-muted-foreground">
          {child.ageLabel ?? "生年月日は未登録"}・食事の段階: {child.stageLabel ?? "未設定"}
        </p>
      </div>

      {child.ageWarnings.map((warning) => (
        <div key={warning.ingredientName} role="alert" className={ALERT_BOX}>
          <p className="flex items-start gap-2 font-semibold">
            <CircleAlert size={16} className="mt-0.5 shrink-0 text-destructive" aria-hidden="true" />
            <span className="min-w-0 break-words">
              {warning.ageUnknown
                ? `${warning.title}（この料理は${warning.ingredientName}を使います。生年月日が未登録のため、年齢を確認してください）`
                : `${warning.title}（この料理は${warning.ingredientName}を使います。${child.name}には与えないでください）`}
            </span>
          </p>
          {warning.body !== "" && <p className="break-words">{warning.body}</p>}
          <GuidanceSources sources={warning.sources} />
        </div>
      ))}

      {serving.supported ? (
        <div className="flex flex-col gap-3">
          <p className={cn(MARK_BADGE_CLASS, MARK_NEUTRAL_TONE, "w-fit")}>
            <Scissors size={14} className="shrink-0" aria-hidden="true" />
            取り分けの案内（{serving.label}）
          </p>
          {/* 案内は、保護者が食事の段階を設定した子にだけ出る（月齢だけからは出さない。C-61 / C-64） */}
          <p className="text-sm text-muted-foreground">保護者が設定した食事の段階にもとづいて表示しています。</p>
          <div className="flex flex-col gap-1">
            <p className="text-sm font-semibold">味付けの前に取り分ける</p>
            <p className="text-sm break-words">
              手順 {serving.separateBeforeStep + 1}
              {steps[serving.separateBeforeStep] !== undefined && `「${steps[serving.separateBeforeStep]}」`}
              の前に取り分けます。
            </p>
            <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
              {serving.instructions.map((text) => (
                <li key={text} className="break-words">
                  {text}
                </li>
              ))}
            </ul>
          </div>
          {serving.cautions.length > 0 && (
            <div className="flex flex-col gap-1">
              <p className="text-sm font-semibold">形・やわらかさ・加熱の注意</p>
              <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
                {serving.cautions.map((text) => (
                  <li key={text} className="break-words">
                    {text}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <GuidanceSources sources={serving.sources} />
        </div>
      ) : (
        <div className="flex flex-col items-start gap-1">
          <p className="flex items-start gap-2 text-sm">
            <CircleHelp size={16} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="min-w-0 break-words">{serving.text}</span>
          </p>
          {/* 未設定のときだけ、設定できる場所へ送る（料理が未対応・対象外のときは、設定しても出ない） */}
          {serving.reason === "未設定" && child.stageLabel === null && (
            <>
              <p className="text-sm break-words text-muted-foreground">
                食事の段階は保護者が選びます（月齢だけでは決めていません）。「幼児食」に設定したお子さんにだけ、対応している料理の取り分け案内を表示します。
              </p>
              <Link
                href={MEAL_CHILD_STAGES_HREF}
                prefetch={false}
                aria-label={`${child.name}の食事の段階を設定する`}
                className={TEXT_LINK}
              >
                食事の段階を設定する
                <ChevronRight size={16} aria-hidden="true" />
              </Link>
            </>
          )}
          {serving.reason === "未設定" && child.ageLabel === null && (
            <Link
              href="/children"
              prefetch={false}
              aria-label={`${child.name}の生年月日を登録する`}
              className={TEXT_LINK}
            >
              生年月日を登録する
              <ChevronRight size={16} aria-hidden="true" />
            </Link>
          )}
        </div>
      )}
    </li>
  )
}

/**
 * レシピ詳細（/chores/meals/recipes/[id]）の表示。`buildRecipeDetailView` の結果をそのまま描く。
 *
 * - 材料の量は、世帯の人数に合わせて元のレシピから一度だけ計算した値（ここで計算し直さない）。
 * - アレルゲンは食材辞書から導いたもの。一覧に無いことを「含まない」とは書かない。
 * - 取り分けは、対応している料理 × 対象の子どもにだけ案内を出す。未対応・未設定・対象外は理由を
 *   出し、食べられるとは書かない。案内は出典つきのデータで、監修を受けていない旨を必ず添える。
 * - 境界指令を持たない（Server Component から描く）。
 */
export function RecipeDetail({ view }: { view: RecipeDetailView }) {
  const { exclusion } = view
  const anyServingShown = view.children.some((child) => child.serving.supported)
  return (
    <article className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <p className="text-sm text-muted-foreground">
          {dishRoleLabel(view.role)}・{formatMinutes(view.minutes)}
          {view.includesStaple && "・主食を含む料理"}
        </p>
        <h2 className="text-lg font-semibold break-words [overflow-wrap:anywhere]">{view.title}</h2>
        {view.tags.length > 0 && (
          <ul aria-label="この料理のタグ" className="flex flex-wrap gap-1.5">
            {view.tags.map((tag) => (
              <li key={tag.id} className={cn(MARK_BADGE_CLASS, MARK_NEUTRAL_TONE)}>
                {tag.label}
              </li>
            ))}
          </ul>
        )}
        {exclusion.verdict !== "ok" && <VerdictMark verdict={exclusion.verdict} className="w-fit" />}
        {/*
          この料理を献立へ入れる（page が `AddToPlanProvider` で包んだときだけ出る）。使わない食材に当たる・
          原材料を確かめられない料理には出さない（自動の献立と提案の候補から外している料理を、ここから
          入れさせない。サーバーも採用の直前に検証し直す）
        */}
        {exclusion.verdict === "ok" && <AddToPlanButton recipeId={view.recipeId} title={view.title} role={view.role} />}
      </header>

      <ExclusionHoldNotice notice={exclusion.notice} />

      {exclusion.verdict === "blocked" && (
        <div role="alert" className={ALERT_BOX}>
          <p className="flex items-start gap-2 font-semibold">
            <CircleAlert size={16} className="mt-0.5 shrink-0 text-destructive" aria-hidden="true" />
            <span>この料理は、世帯の「使わない食材」を含みます。献立と提案の候補から外しています。</span>
          </p>
          <ul className="flex flex-col gap-1">
            {exclusion.hits.map((hit) => (
              <li key={hit.exclusionId} className="break-words">
                {hit.reasonLabel}（{hit.subjectLabel}）: {hit.targetLabel}
                {hit.ingredientNames.length > 0 && `　該当する材料: ${hit.ingredientNames.join("・")}`}
              </li>
            ))}
          </ul>
        </div>
      )}
      {exclusion.verdict === "label_check" && (
        <div role="alert" className={ALERT_BOX}>
          <p className="flex items-start gap-2 font-semibold">
            <ScanSearch size={16} className="mt-0.5 shrink-0 text-destructive" aria-hidden="true" />
            <span>
              {exclusion.unverifiable.length === 0 && exclusion.notice.holdsAutoConfirm === true
                ? // 料理の材料には確認の要るものが無い。判定できないアレルギーの登録のためだけに外している
                  "判定できないアレルギーの登録があるため、この料理が該当するかを見分けられません。自動の献立と提案の候補から外しています（料理そのものの材料の問題ではありません）。"
                : "アレルギーの設定があり、この料理は原材料を確かめられません。自動の献立と提案の候補から外しています。"}
            </span>
          </p>
          <ul className="flex flex-col gap-1">
            {exclusion.unverifiable.map((item, index) => (
              <li key={`${item.code}-${index}`} className="break-words">
                {item.text}
              </li>
            ))}
          </ul>
        </div>
      )}

      <section aria-labelledby="recipe-ingredients-heading" className="flex flex-col gap-3">
        <h3 id="recipe-ingredients-heading" className={SECTION_HEADING}>
          材料（{formatServings(view.servings)}）
        </h3>
        {view.usingDefaultServings ? (
          <p data-testid="recipe-default-servings" className="text-sm">
            人数が未設定のため、標準の{DINNER_SERVINGS_DEFAULT}人分で表示しています。人数は、ごはんの設定で変えられます。
          </p>
        ) : (
          view.servings !== view.baseServings && (
            <p className="text-sm text-muted-foreground">
              元のレシピ（{formatServings(view.baseServings)}）の分量を、{formatServings(view.servings)}に合わせて計算しています。
            </p>
          )
        )}
        <ul
          aria-labelledby="recipe-ingredients-heading"
          className="glass flex flex-col divide-y divide-border/60 rounded-2xl px-4 py-1 shadow-lg shadow-black/[0.04]"
        >
          {view.ingredients.map((ingredient, index) => (
            <IngredientRow key={`${ingredient.ingredientId}-${index}`} ingredient={ingredient} />
          ))}
        </ul>
      </section>

      <section aria-labelledby="recipe-steps-heading" className="flex flex-col gap-3">
        <h3 id="recipe-steps-heading" className={SECTION_HEADING}>
          作り方
        </h3>
        <div className={CARD}>
          <ol aria-labelledby="recipe-steps-heading" className="flex list-decimal flex-col gap-2 pl-6">
            {view.steps.map((step, index) => (
              <li key={index} data-testid="recipe-step" className="text-base break-words">
                {step}
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section aria-labelledby="recipe-allergens-heading" className="flex flex-col gap-3">
        <h3 id="recipe-allergens-heading" className={SECTION_HEADING}>
          含まれるアレルゲン（食材辞書から {view.allergens.length} 品目）
        </h3>
        <div className={CARD}>
          {view.allergens.length > 0 ? (
            <ul aria-labelledby="recipe-allergens-heading" className="flex flex-col gap-2">
              {view.allergens.map((allergen) => (
                <li key={allergen.id} data-testid="recipe-allergen" className="flex flex-col text-sm">
                  <span className="text-base font-medium break-words">
                    {allergen.name}
                    {allergen.tierLabel !== null && (
                      <span className="text-sm font-normal text-muted-foreground">（{allergen.tierLabel}）</span>
                    )}
                  </span>
                  <span className="break-words text-muted-foreground">材料: {allergen.ingredientNames.join("・")}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm">
              食材辞書に登録されたアレルゲンは見つかりませんでした。アレルゲンを含まないことを示すものではありません。
            </p>
          )}
          {view.needsLabelCheck && (
            <p className="flex items-start gap-2 text-sm">
              <ScanSearch size={16} className="mt-0.5 shrink-0 text-amber-700 dark:text-amber-300" aria-hidden="true" />
              <span className="min-w-0 break-words">
                {view.labelCheckIngredientNames.length > 0
                  ? `原材料の確認が必要な材料: ${view.labelCheckIngredientNames.join("・")}（商品によって原材料が異なります）`
                  : "この料理のアレルゲン情報は確認できていません。"}
              </span>
            </p>
          )}
          <MealNotice kind="allergyJudgement" />
          {exclusion.notice.limited.length > 0 && <MealNotice kind="customExclusion" />}
        </div>
      </section>

      {view.ageRules.length > 0 && (
        <section aria-labelledby="recipe-age-heading" className="flex flex-col gap-3">
          <h3 id="recipe-age-heading" className={SECTION_HEADING}>
            年齢についての注意
          </h3>
          {view.ageRules.map((rule) => (
            <div key={rule.ingredientName} data-testid="recipe-age-rule" className={ALERT_BOX}>
              <p className="flex items-start gap-2 font-semibold">
                <CircleAlert size={16} className="mt-0.5 shrink-0 text-destructive" aria-hidden="true" />
                <span className="min-w-0 break-words">
                  {rule.title}（この料理は{rule.ingredientName}を使います）
                </span>
              </p>
              {rule.body !== "" && <p className="break-words">{rule.body}</p>}
              <GuidanceSources sources={rule.sources} />
            </div>
          ))}
        </section>
      )}

      <section aria-labelledby="recipe-serving-heading" className="flex flex-col gap-3">
        <h3 id="recipe-serving-heading" className={SECTION_HEADING}>
          子どもへの取り分け
        </h3>
        {view.children.length === 0 ? (
          <div className={CARD}>
            <p className="flex items-start gap-2 text-sm">
              <Baby size={16} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span>
                {view.childServing.available
                  ? `この料理には、${view.childServing.stageLabel ?? "幼児"}向けの取り分け案内があります。お子さんが登録されていないため、表示していません。`
                  : CHILD_SERVING_UNSUPPORTED_TEXT}
              </span>
            </p>
          </div>
        ) : (
          <ul aria-labelledby="recipe-serving-heading" className="flex flex-col gap-3">
            {view.children.map((child) => (
              <ChildServingCard key={child.childId} child={child} steps={view.steps} />
            ))}
          </ul>
        )}
        {anyServingShown && (
          <p className="rounded-xl bg-muted/60 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
            {SEPARATE_BEFORE_SEASONING_NOTE}
          </p>
        )}
        <MealNotice kind="childServingScope" />
        <MealNotice kind="childGuidance" />
      </section>

      <p className="text-xs break-words text-muted-foreground">
        {view.sourceNote}（レシピの版 {view.version}）
      </p>
    </article>
  )
}
