import { Info } from "lucide-react"

import { ALLERGEN_JUDGEMENT_DISCLAIMER, ALLERGEN_LIST_DISCLAIMER } from "@/lib/meals/catalog/allergens"
import {
  CHILD_GUIDANCE_DISCLAIMER,
  CHILD_SERVING_SCOPE_NOTE,
  CHILD_SERVING_UNSUPPORTED_TEXT,
} from "@/lib/meals/catalog/child-guidance"
import { DINNER_SERVINGS_DEFAULT } from "@/lib/meals/server/rows"
import { cn } from "@/lib/utils"

/**
 * ごはんの画面に添える注意書きの定型（文言の置き場所はここ 1 か所）。
 *
 * 境界指令を持たない（Server Component からも Client Component からも描ける）。
 * アレルギーと子ども向け案内の文言は、出典と一緒に管理しているカタログの定数をそのまま使う
 * （ここで言い換えない）。それ以外は Irori が何をしていて、何を保証していないかを書く。
 * 「保証する」「安全」「監修済み」と読める文は置かない。
 */
export const MEAL_NOTICES = {
  /** 除外の判定の限界。アレルギーの除外がある世帯の、提案・献立・レシピの画面に添える。 */
  allergyJudgement: ALLERGEN_JUDGEMENT_DISCLAIMER,
  /** アレルゲンの選択肢の性質。使わない食材の設定画面に添える。 */
  allergenList: ALLERGEN_LIST_DISCLAIMER,
  /** 自由入力の除外の判定のしかた。自由入力の除外があるときに添える。 */
  customExclusion:
    "自由に入力した「使わない食材」は、食材や料理の名前に含まれるかどうかで判定します。別の呼び名や、加工品の原材料までは見分けられません。",
  /** 子ども向け案内の位置づけ。取り分け案内・離乳の一般案内を出す画面に必ず添える。 */
  childGuidance: CHILD_GUIDANCE_DISCLAIMER,
  /** 取り分け案内の対象範囲。 */
  childServingScope: CHILD_SERVING_SCOPE_NOTE,
  /** 取り分けに対応していない料理・対象外の年齢・未設定のときの表示。 */
  childServingUnsupported: CHILD_SERVING_UNSUPPORTED_TEXT,
  /** 献立の性質。自動で作った献立を出す画面に添える。 */
  nutrition:
    "献立は、在庫・好み・調理時間・最近の重なりをもとに機械的に組み合わせたものです。栄養のバランスを保証するものではありません。",
  /** 「自動」と「AI 補助」の違い。 */
  planOrigin:
    "「自動」は Irori の決まった手順で組んだ献立です。「AI 補助」は、希望の読み取りと候補の並べ替えに生成 AI を使った結果で、材料・分量・使わない食材の判定には AI を使っていません。",
  /** 希望の入力欄に添える。 */
  aiWish:
    "希望は料理の条件だけを書いてください。名前・病名・お子さんの情報は書かないでください（AI 補助を使うとき、入力した文は外部の AI サービスへ送られます）。",
  /** 在庫の充足の読み方。 */
  stockEstimate:
    "在庫は登録された内容からの見込みです。数量が分からないもの、確認から日が経ったものは「分量要確認」として示します。",
  /** 買い物リストの量の読み方。 */
  groceryEstimate:
    "買う量はレシピの分量から計算した目安です。個数と重さは換算していません。「在庫量を確認」と出ている食材は、家にある量を見てから買ってください。",
  /** 標準の人数で計算しているとき（設定が未登録の世帯）。 */
  defaultServings: `人数が未設定のため、標準の${DINNER_SERVINGS_DEFAULT}人分で計算しています。人数は設定で変えられます。`,
} as const

export type MealNoticeKind = keyof typeof MEAL_NOTICES

/** 注意書き 1 件。色ではなくアイコンと文で示す。 */
export function MealNotice({ kind, className }: { kind: MealNoticeKind; className?: string }) {
  return (
    <p
      role="note"
      className={cn(
        "flex items-start gap-2 rounded-xl bg-muted/60 px-3 py-2 text-xs leading-relaxed text-muted-foreground",
        className,
      )}
    >
      <Info size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
      <span>{MEAL_NOTICES[kind]}</span>
    </p>
  )
}
