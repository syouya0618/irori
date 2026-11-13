/**
 * 必須除外（アレルギー・苦手）の判定。
 *
 * 規則:
 * - 世帯に登録された除外の**和集合**で判定する（誰の除外かで絞らない。人数にも依らない）。
 * - 「苦手」として登録したものも「アレルギー」と同じく必須除外（点数では緩めない）。
 * - アレルゲンは食材辞書の構造化情報で判定し、`derivedFrom` をたどる（調味料・加工品・派生食材）。
 * - 任意材料（optional）に含まれる場合も除外する。
 * - 判定は 3 状態（`DishVerdict`）: `ok` = 問題なし / `blocked` = 当たる / `label_check` = 未確認。
 *   **原材料が分からないものを「含まない」と判定しない**:
 *   - 除外が 1 件でもある世帯では（苦手だけでも）、原材料が不明な料理（材料未登録の手動料理・辞書で解決できない
 *     材料・カタログに無いレシピ）は「未確認」（2026-11-11。以前はアレルギーの世帯だけ）。
 *   - アレルギーの除外が 1 つでもある世帯では、さらに、商品により原材料が変わる材料（`allergenInfo="varies"`）・
 *     `allergenStatus="unconfirmed"` のレシピも「未確認」（成分表示の確認が要る）。
 *   「未確認」は自動確定の候補にせず、確定（`confirmDinnerPlan`）も止める。
 * - 自由入力は辞書へ解決を試みる（`resolveExclusionLabel`）:
 *   1. アレルゲン名・食材名（別名）の完全一致
 *   2. 総称・類義の語の辞書（「乳製品」「甲殻類」「魚」「ひき肉」…。`exclusion-terms.ts`）
 *   3. アレルギーのときだけ、入力が品目名を含むか（「卵料理」⊃「卵」。広く倒す）
 *   4. 名前の一致（食材名・料理名が入力を**含む**）。判定に限界がある旨を `limited` で返す
 *   どれにも当たらない入力は `undetermined`（判定できない）。**何も外せていないのに「不使用」と
 *   見なさない**: アレルギーなら全ての料理を自動確定の候補から外し（`holdsAutoConfirm`）、
 *   苦手なら献立は止めずに「除外されていない」ことを結果で返す。
 * - 手動料理は、材料の登録の有無にかかわらず料理名も照らす（材料は任意で、全部とは限らない）。
 * - 「含む」での照合（3 と、手動料理の料理名）は、品目名を含むが、その品目ではない語の中の名前を数えない
 *   （「焼きそば」⊃「そば」・「豆乳」⊃「乳」・「鶏もも」⊃「もも」・「さけるチーズ」⊃「さけ」。`exclusion-terms.ts` の
 *   `hides` / `DEFAULT_NAME_MASKS`）。料理名の語が指す食材（焼きそば → 焼きそば麺）は、その食材を含むとみなして当てる。
 *
 * ここで言えるのは「登録した品目を材料に含む料理を外す」までで、
 * 商品ごとの原材料や混入までは保証しない。
 */

import { DEFAULT_NAME_MASKS, type ExclusionTermDef } from "./exclusion-terms"
import {
  allergenProfileOf,
  type CatalogInput,
  type CatalogView,
  ingredientNameOf,
  isSameOrDerivedFrom,
  toCatalogView,
} from "./lookup"
import { foldName, resolveIngredientId } from "./normalize"
import type {
  AllergenId,
  DishRole,
  ExclusionReason,
  FoodExclusion,
  IngredientDef,
  PlanEntry,
  PlanEntryStatus,
  RecipeDef,
  RecipeIngredient,
} from "./types"

export type BlockVia = "allergen" | "ingredient" | "derived" | "name"

export interface BlockHit {
  exclusionId: string
  reason: ExclusionReason
  /** 該当した材料。料理名だけで一致したときは null。 */
  ingredientId: string | null
  via: BlockVia
}

export type UnverifiableReason =
  /** 商品により原材料が異なる材料を含む。 */
  | "varies_ingredient"
  /** レシピのアレルゲン情報が未確認。 */
  | "allergen_unconfirmed"
  /** 辞書に無い材料（成分を確かめられない）。 */
  | "unknown_ingredient"
  /** 材料が登録されていない手動料理。 */
  | "no_ingredients"
  /** カタログに無いレシピ ID。 */
  | "unknown_recipe"

export interface Unverifiable {
  reason: UnverifiableReason
  ingredientId: string | null
}

export type DishVerdict = "ok" | "label_check" | "blocked"

export interface DishEvaluation {
  /** 自動で確定してよいか（`verdict === "ok"`）。 */
  allowed: boolean
  verdict: DishVerdict
  blockedBy: BlockHit[]
  /** アレルギーの除外があり、成分を確かめられない部分がある（原材料の確認が必要）。 */
  needsLabelCheck: boolean
  unverifiable: Unverifiable[]
}

interface AllergenRule {
  exclusionId: string
  reason: ExclusionReason
  allergenId: AllergenId
}
interface IngredientRule {
  exclusionId: string
  reason: ExclusionReason
  ingredientId: string
}
interface NameRule {
  exclusionId: string
  reason: ExclusionReason
  folded: string
}
/** 材料の無い料理を、料理名で判定するための語。 */
interface TitleNeedle {
  exclusionId: string
  reason: ExclusionReason
  folded: string
  ingredientId: string | null
}

/** どの食材・料理にも当たらず、判定できない除外。 */
export interface UndeterminedExclusion {
  exclusionId: string
  /** 入力された語（一覧に無い ID で登録された除外は、その ID）。 */
  label: string
  reason: ExclusionReason
}

export interface ExclusionSet {
  readonly view: CatalogView
  /** 除外が 1 件も無い。 */
  readonly isEmpty: boolean
  /** アレルギーの除外が 1 件でもある。 */
  readonly hasAllergy: boolean
  readonly allergenRules: readonly AllergenRule[]
  readonly ingredientRules: readonly IngredientRule[]
  readonly nameRules: readonly NameRule[]
  readonly titleNeedles: readonly TitleNeedle[]
  /** 辞書へ解決できず、名前の一致でしか判定できない除外（画面で限界を示す）。 */
  readonly limited: readonly { exclusionId: string; label: string }[]
  /**
   * 辞書にも名前の一致にも当たらず、**何も外せていない**除外（判定できない）。
   * 苦手（`reason: "dislike"`）は献立を止めない。画面で「除外されていない」と示すために返す。
   */
  readonly undetermined: readonly UndeterminedExclusion[]
  /**
   * 判定できない**アレルギー**の除外がある。該当する料理を見分けられないため、
   * どの料理も自動では確定しない（全て「原材料の確認が必要」になる）。
   */
  readonly holdsAutoConfirm: boolean
}

/** 「落花生（ピーナッツ）」を「落花生（ピーナッツ）」「落花生」「ピーナッツ」として引けるようにする。 */
function nameVariants(name: string): string[] {
  const parts = name.normalize("NFKC").split(/[()]/u)
  return [...new Set([name, ...parts].map(foldName).filter((folded) => folded !== ""))]
}

function ingredientNeedles(ingredientId: string, view: CatalogView): string[] {
  const def = view.index.byId.get(ingredientId)
  const names = def ? [def.name, ...def.aliases] : [ingredientId]
  return names.map(foldName).filter((folded) => folded !== "")
}

// ── 文の中の品目名（「含む」での照合） ─────────────────────────────

/** 文に探す品目名（アレルゲン名の表記・食材の表示名と別名。fold 済み）。 */
interface ScanName {
  folded: string
  kind: "allergen" | "ingredient"
  id: string
}

interface NameMask {
  folded: string
  /** この語の中に現れても数えない名前（fold 済み）。 */
  hides: readonly string[]
  /** 指す先を持つ料理名の語（`exclusionTerms` の `hides` つきの項目）。隠すだけの語は null。 */
  term: ExclusionTermDef | null
}

interface NameScanner {
  names: readonly ScanName[]
  masks: readonly NameMask[]
}

const SCANNERS = new WeakMap<CatalogView, NameScanner>()

function scannerOf(view: CatalogView): NameScanner {
  const cached = SCANNERS.get(view)
  if (cached) return cached
  const names: ScanName[] = []
  for (const allergen of view.allergens) {
    for (const folded of nameVariants(allergen.name)) names.push({ folded, kind: "allergen", id: allergen.id })
  }
  for (const def of view.index.byId.values()) {
    for (const folded of new Set(ingredientNeedles(def.id, view))) names.push({ folded, kind: "ingredient", id: def.id })
  }
  const masks: NameMask[] = []
  const addMask = (words: readonly string[], hides: readonly string[], term: ExclusionTermDef | null) => {
    const folded = hides.map(foldName).filter((hide) => hide !== "")
    if (folded.length === 0) return
    for (const word of words) {
      const key = foldName(word)
      if (key !== "") masks.push({ folded: key, hides: folded, term })
    }
  }
  for (const term of view.exclusionTerms) if (term.hides !== undefined) addMask(term.terms, term.hides, term)
  for (const mask of DEFAULT_NAME_MASKS) addMask(mask.words, mask.hides, null)
  const scanner: NameScanner = { names, masks }
  SCANNERS.set(view, scanner)
  return scanner
}

function indexesOf(text: string, word: string): number[] {
  const out: number[] = []
  for (let at = text.indexOf(word); at !== -1; at = text.indexOf(word, at + 1)) out.push(at)
  return out
}

interface TextScan {
  /** 文に現れた品目名（品目名を含むが、その品目ではない語の中にしか現れないものは除く）。 */
  names: ScanName[]
  /** 文に現れた、指す先を持つ料理名の語（「焼きそば」→ 焼きそば麺）。 */
  terms: ExclusionTermDef[]
}

/**
 * fold 済みの文から、品目名を探す（部分一致）。品目名を含むが、その品目ではない語（「焼きそば」⊃「そば」）の
 * **中に現れた**名前は数えない。同じ名前が語の外にも現れていれば数える（「焼きそばとざるそば」の「そば」）。
 */
function scanText(folded: string, view: CatalogView): TextScan {
  const { names, masks } = scannerOf(view)
  const hidden = new Set<string>()
  const terms: ExclusionTermDef[] = []
  for (const mask of masks) {
    const starts = indexesOf(folded, mask.folded)
    if (starts.length === 0) continue
    if (mask.term !== null && !terms.includes(mask.term)) terms.push(mask.term)
    for (const start of starts) {
      const end = start + mask.folded.length
      for (const hide of mask.hides) {
        for (const at of indexesOf(folded, hide)) {
          if (at >= start && at + hide.length <= end) hidden.add(`${at}:${hide}`)
        }
      }
    }
  }
  const shown = names.filter((name) => indexesOf(folded, name.folded).some((at) => !hidden.has(`${at}:${name.folded}`)))
  return { names: shown, terms }
}

/** 語の辞書の 1 項目が指す先（このカタログに無い ID は使わない）。 */
function termTargets(term: ExclusionTermDef, view: CatalogView): { allergenIds: AllergenId[]; ingredientIds: string[] } {
  const allergenIds = (term.allergenIds ?? []).filter((allergenId) => isKnownAllergen(allergenId, view))
  const except = new Set(term.exceptIngredientIds ?? [])
  const sections = new Set<string>(term.sections ?? [])
  const fromSections = [...view.index.byId.values()]
    .filter((def) => sections.has(def.section) && !except.has(def.id))
    .map((def) => def.id)
  const ingredientIds = [...(term.ingredientIds ?? []), ...fromSections].filter((id) => view.index.byId.has(id))
  return { allergenIds, ingredientIds }
}

// ── 自由入力の解決 ─────────────────────────────────────────────────

/**
 * `resolved`: アレルゲン・食材へ解決した。
 * `name_only`: 辞書へは解決できないが、食材名・料理名に入力を含むものがある（その分だけ外す）。
 * `undetermined`: どこにも当たらない（判定できない。何も外せていない）。
 */
export type ExclusionResolutionStatus = "resolved" | "name_only" | "undetermined"

/**
 * `exact` = アレルゲン名・食材名の完全一致 / `term` = 総称・類義の語の辞書 /
 * `contains` = 入力が品目名を含む（推定。アレルギーは名前の一致より先に、苦手は名前の一致が無いときだけ）。
 */
export type ExclusionResolutionVia = "exact" | "term" | "contains"

/**
 * その除外が献立へどう効くか。
 * `excludes` = 該当する料理を外す / `holds_auto_confirm` = 判定できないアレルギー。全ての料理を自動では確定しない /
 * `no_effect` = 判定できない苦手。**何も除外されない**。
 */
export type ExclusionLabelEffect = "excludes" | "holds_auto_confirm" | "no_effect"

export interface ExclusionResolution {
  status: ExclusionResolutionStatus
  effect: ExclusionLabelEffect
  /** 解決した先のアレルゲン（一覧の記載順ではなく、解決した順）。 */
  allergenIds: AllergenId[]
  /** 解決した先の食材（派生品は含めない。判定のときにたどる）。 */
  ingredientIds: string[]
  via: ExclusionResolutionVia[]
  /** 名前に入力を含む食材（`name_only` の根拠）。 */
  nameMatchedIngredientIds: string[]
  /** 料理名に入力を含むレシピ（`name_only` の根拠）。 */
  nameMatchedRecipeIds: string[]
}

/** 入力が品目名を「含む」で解決するときの、食材名の最短の長さ（1 文字の「酢」「塩」で広がりすぎないように）。 */
const MIN_CONTAINED_INGREDIENT_NAME = 2

function pushId(target: string[], id: string): void {
  if (!target.includes(id)) target.push(id)
}

/** そのアレルゲン ID を、このカタログが知っているか（一覧にあるか、どれかの食材が持つ）。 */
function isKnownAllergen(allergenId: AllergenId, view: CatalogView): boolean {
  if (view.allergens.some((allergen) => allergen.id === allergenId)) return true
  for (const def of view.index.byId.values()) if (def.allergens.includes(allergenId)) return true
  return false
}

function effectOf(status: ExclusionResolutionStatus, reason: ExclusionReason): ExclusionLabelEffect {
  if (status !== "undetermined") return "excludes"
  return reason === "allergy" ? "holds_auto_confirm" : "no_effect"
}

function resolveLabel(label: string, reason: ExclusionReason, view: CatalogView): ExclusionResolution {
  const folded = foldName(label)
  const allergenIds: AllergenId[] = []
  const ingredientIds: string[] = []
  const via: ExclusionResolutionVia[] = []
  const nameMatchedIngredientIds: string[] = []
  const nameMatchedRecipeIds: string[] = []
  const finish = (): ExclusionResolution => {
    const status: ExclusionResolutionStatus =
      allergenIds.length > 0 || ingredientIds.length > 0
        ? "resolved"
        : nameMatchedIngredientIds.length > 0 || nameMatchedRecipeIds.length > 0
          ? "name_only"
          : "undetermined"
    return {
      status,
      effect: effectOf(status, reason),
      allergenIds,
      ingredientIds,
      via,
      nameMatchedIngredientIds,
      nameMatchedRecipeIds,
    }
  }
  if (folded === "") return finish()

  // 1. アレルゲン名・食材名（別名）の完全一致
  for (const allergen of view.allergens) {
    if (nameVariants(allergen.name).includes(folded)) pushId(allergenIds, allergen.id)
  }
  const exactIngredient = resolveIngredientId(label, view.index)
  if (exactIngredient !== null) pushId(ingredientIds, exactIngredient)
  if (allergenIds.length > 0 || ingredientIds.length > 0) via.push("exact")

  // 2. 総称・類義の語。このカタログに無い ID は使わない（外せないものを「解決した」と言わない）
  let byTerm = false
  for (const term of view.exclusionTerms) {
    if (!term.terms.some((word) => foldName(word) === folded)) continue
    const targets = termTargets(term, view)
    for (const allergenId of targets.allergenIds) {
      pushId(allergenIds, allergenId)
      byTerm = true
    }
    for (const ingredientId of targets.ingredientIds) {
      pushId(ingredientIds, ingredientId)
      byTerm = true
    }
  }
  if (byTerm) via.push("term")

  // 入力が品目名を含むか（「卵料理」「乳飲料」「ピーナッツバター」）。誤って広がることはあるが、何も外さないより安全。
  // 品目名を含むが、その品目ではない語の中の名前は数えない（「焼きそばパン」⊃「そば」・「豆乳プリン」⊃「乳」）。
  // 語が指す先を持てば、その先を足す（「焼きそばパン」→ 焼きそば麺）。
  //
  // 分類の語は、含む品目 1 つへ縮めない（「なす科」→ なす だけを外すと、トマト・じゃがいもが外れないのに
  // 「適用済み」に見える）。「〜科」は含む品目では解決しない（判定できない語として、選び直してもらう）。
  // 「〜類」は、類全体を指す品目（アレルゲン名「えび」・総称の食材「きのこ」）にだけ解決する。
  const taxonFamily = folded.includes("科")
  const classWord = folded.includes("類")
  const resolveByContainment = (): void => {
    if (taxonFamily) return
    const scan = scanText(folded, view)
    for (const name of scan.names) {
      if (name.kind === "allergen") pushId(allergenIds, name.id)
    }
    for (const name of scan.names) {
      if (name.kind !== "ingredient" || name.folded.length < MIN_CONTAINED_INGREDIENT_NAME) continue
      if (classWord && view.index.byId.get(name.id)?.generic !== true) continue
      pushId(ingredientIds, name.id)
    }
    if (!classWord) {
      for (const term of scan.terms) {
        const targets = termTargets(term, view)
        for (const allergenId of targets.allergenIds) pushId(allergenIds, allergenId)
        for (const ingredientId of targets.ingredientIds) pushId(ingredientIds, ingredientId)
      }
    }
    if (allergenIds.length > 0 || ingredientIds.length > 0) via.push("contains")
  }
  const unresolved = (): boolean => allergenIds.length === 0 && ingredientIds.length === 0

  // 3. アレルギーで、まだ解決できていないとき: 名前の一致より先に、含まれる品目へ広げる。
  if (reason === "allergy" && unresolved()) resolveByContainment()

  // 4. 名前の一致（食材名・料理名が入力を含む）
  for (const def of view.index.byId.values()) {
    if (ingredientNeedles(def.id, view).some((name) => name.includes(folded))) nameMatchedIngredientIds.push(def.id)
  }
  for (const recipe of view.recipes) {
    if (foldName(recipe.title).includes(folded)) nameMatchedRecipeIds.push(recipe.id)
  }

  // 5. 苦手は、名前の一致が 1 つも無いときに限って、含まれる品目へ広げる（「卵料理」→ 卵）。
  //    料理名に当たる入力（「卵焼き」）は 4 の一致だけで外し、「卵が苦手」へは広げない。
  //    ここで広げないと、登録した「苦手」が何も除外しないまま残る（苦手も必須除外という契約に反する）。
  if (
    reason === "dislike" &&
    unresolved() &&
    nameMatchedIngredientIds.length === 0 &&
    nameMatchedRecipeIds.length === 0
  ) {
    resolveByContainment()
  }
  return finish()
}

/**
 * 自由入力の除外が、このカタログで何に解決するかを返す（設定画面の確認用。判定と同じ規則）。
 * `effect` が `holds_auto_confirm` / `no_effect` の入力は、一覧から選び直すよう促すこと。
 */
export function resolveExclusionLabel(
  label: string,
  reason: ExclusionReason,
  catalog: CatalogInput,
): ExclusionResolution {
  return resolveLabel(label, reason, toCatalogView(catalog))
}

// ── 規則の組み立て ─────────────────────────────────────────────────

interface RuleDraft {
  allergenRules: AllergenRule[]
  ingredientRules: IngredientRule[]
  nameRules: NameRule[]
  limited: { exclusionId: string; label: string }[]
  undetermined: UndeterminedExclusion[]
}

function addAllergenRule(draft: RuleDraft, exclusion: FoodExclusion, allergenId: AllergenId): void {
  const exists = draft.allergenRules.some(
    (rule) => rule.exclusionId === exclusion.id && rule.allergenId === allergenId,
  )
  if (!exists) draft.allergenRules.push({ exclusionId: exclusion.id, reason: exclusion.reason, allergenId })
}

function addUndetermined(draft: RuleDraft, exclusion: FoodExclusion, label: string): void {
  draft.undetermined.push({ exclusionId: exclusion.id, label, reason: exclusion.reason })
}

/**
 * アレルギーとして食材を登録したとき、同じアレルゲンを含む他の食材へ広げる対象。
 * 素の食材（由来が無く、成分が定まっている）は全てのアレルゲンへ広げる（卵 → マヨネーズ）。
 * 加工品（由来がある・商品で原材料が変わる）は広げず、その食材と派生品だけに留める
 * （どの成分が原因かを推測しない）。辞書の `allergySpread` が明示されていれば、それに従う。
 * 広げない品目は、設定画面で「品目として登録する候補」として示す（`exclusion-lexicon.ts`。黙って広げない）。
 */
export function allergySpreadOf(def: IngredientDef): readonly AllergenId[] {
  if (def.allergySpread !== undefined) return def.allergySpread
  const isPlainRoot = (def.derivedFrom ?? []).length === 0 && def.allergenInfo === "known"
  return isPlainRoot ? def.allergens : []
}

/** 食材の規則を足す。辞書に無い ID なら false（何にも当たらない）。 */
function addIngredientRule(
  draft: RuleDraft,
  exclusion: FoodExclusion,
  ingredientId: string,
  view: CatalogView,
): boolean {
  const exists = draft.ingredientRules.some(
    (rule) => rule.exclusionId === exclusion.id && rule.ingredientId === ingredientId,
  )
  if (!exists) {
    draft.ingredientRules.push({ exclusionId: exclusion.id, reason: exclusion.reason, ingredientId })
  }
  const def = view.index.byId.get(ingredientId)
  if (!def) return false
  if (exclusion.reason === "allergy") {
    for (const allergenId of allergySpreadOf(def)) addAllergenRule(draft, exclusion, allergenId)
  }
  return true
}

function addCustomRule(draft: RuleDraft, exclusion: FoodExclusion, label: string, view: CatalogView): void {
  const resolution = resolveLabel(label, exclusion.reason, view)
  for (const allergenId of resolution.allergenIds) addAllergenRule(draft, exclusion, allergenId)
  for (const ingredientId of resolution.ingredientIds) addIngredientRule(draft, exclusion, ingredientId, view)
  const folded = foldName(label)
  const exact = resolution.via.includes("exact")
  // 完全一致で解決した語は、名前の一致へ広げない（そばアレルギーで「ソース焼きそば」を外さない）。
  // 総称・推定で解決した語と未解決の語は、名前に含むものも外す（除外は広く倒す）
  if (!exact && folded !== "") {
    draft.nameRules.push({ exclusionId: exclusion.id, reason: exclusion.reason, folded })
  }
  if (!exact && !resolution.via.includes("term")) draft.limited.push({ exclusionId: exclusion.id, label })
  if (resolution.status === "undetermined") addUndetermined(draft, exclusion, label)
}

function buildTitleNeedles(draft: RuleDraft, view: CatalogView): TitleNeedle[] {
  const needles: TitleNeedle[] = []
  const ids = [...view.index.byId.keys()]
  for (const rule of draft.allergenRules) {
    const allergen = view.allergens.find((a) => a.id === rule.allergenId)
    for (const folded of allergen ? nameVariants(allergen.name) : []) {
      needles.push({ exclusionId: rule.exclusionId, reason: rule.reason, folded, ingredientId: null })
    }
    for (const id of ids) {
      if (!allergenProfileOf(id, view.index).allergens.has(rule.allergenId)) continue
      for (const folded of ingredientNeedles(id, view)) {
        needles.push({ exclusionId: rule.exclusionId, reason: rule.reason, folded, ingredientId: id })
      }
    }
  }
  for (const rule of draft.ingredientRules) {
    for (const id of new Set([rule.ingredientId, ...ids])) {
      if (isSameOrDerivedFrom(id, rule.ingredientId, view.index, lineageOptionsOf(rule.reason)) === null) continue
      for (const folded of ingredientNeedles(id, view)) {
        needles.push({ exclusionId: rule.exclusionId, reason: rule.reason, folded, ingredientId: id })
      }
    }
  }
  return needles
}

/** アレルギーの除外は、精製品の由来（片栗粉 → じゃがいも）へも及ぼす。苦手には及ぼさない。 */
function lineageOptionsOf(reason: ExclusionReason): { includeRefined: boolean } {
  return { includeRefined: reason === "allergy" }
}

/** 世帯の除外の和集合を作る。誰の除外か（subject）では絞らない。 */
export function buildExclusionSet(
  exclusions: readonly FoodExclusion[],
  catalog: CatalogInput,
): ExclusionSet {
  const view = toCatalogView(catalog)
  const draft: RuleDraft = { allergenRules: [], ingredientRules: [], nameRules: [], limited: [], undetermined: [] }
  for (const exclusion of exclusions) {
    const target = exclusion.target
    if (target.kind === "allergen") {
      addAllergenRule(draft, exclusion, target.allergenId)
      // 一覧にもどの食材にも無い ID（先に増えた品目など）は、何にも当たらない = 判定できない
      if (!isKnownAllergen(target.allergenId, view)) addUndetermined(draft, exclusion, target.allergenId)
    } else if (target.kind === "ingredient") {
      if (!addIngredientRule(draft, exclusion, target.ingredientId, view)) {
        draft.limited.push({ exclusionId: exclusion.id, label: target.ingredientId })
        addUndetermined(draft, exclusion, target.ingredientId)
      }
    } else {
      addCustomRule(draft, exclusion, target.label, view)
    }
  }
  return {
    view,
    isEmpty: exclusions.length === 0,
    hasAllergy: exclusions.some((exclusion) => exclusion.reason === "allergy"),
    ...draft,
    titleNeedles: buildTitleNeedles(draft, view),
    holdsAutoConfirm: draft.undetermined.some((item) => item.reason === "allergy"),
  }
}

/** 献立の確定と買い物の自動の更新を止めている、判定できないアレルギーの登録の名前（重ねない。登録の順）。 */
export function undeterminedAllergyLabels(set: Pick<ExclusionSet, "undetermined">): string[] {
  return [...new Set(set.undetermined.filter((item) => item.reason === "allergy").map((item) => item.label))]
}

/** 判定の対象にする料理の最小形（カタログのレシピ・手動料理の両方をここへ寄せる）。 */
export interface DishView {
  title: string
  /** null = 材料が登録されていない。 */
  ingredients: readonly RecipeIngredient[] | null
  /** レシピのアレルゲン確認状態。手動料理は `from_ingredients`（材料があるぶんだけ判定する）。 */
  allergenStatus: RecipeDef["allergenStatus"]
  /**
   * 手動料理（利用者が名前を打った料理）。材料は任意で全部とは限らないため、材料の登録の有無に
   * かかわらず料理名も除外の品目名に照らす。カタログのレシピには立てない
   * （材料が正本。料理名で当てると、そばアレルギーで「ソース焼きそば」まで外れる）。
   */
  manual?: boolean
}

function pushUnique(hits: BlockHit[], hit: BlockHit): void {
  const exists = hits.some(
    (h) =>
      h.exclusionId === hit.exclusionId && h.ingredientId === hit.ingredientId && h.via === hit.via,
  )
  if (!exists) hits.push(hit)
}

/**
 * 食材 1 つが、アレルゲンの規則・食材の規則（派生をたどる）に当たるか。`via` を渡すと、その経路として記録する
 * （料理名の語が指す食材 = 「name」）。
 */
function addRuleHits(ingredientId: string, set: ExclusionSet, hits: BlockHit[], via?: "name"): void {
  const { index } = set.view
  const profile = allergenProfileOf(ingredientId, index)
  for (const rule of set.allergenRules) {
    if (!profile.allergens.has(rule.allergenId)) continue
    pushUnique(hits, { exclusionId: rule.exclusionId, reason: rule.reason, ingredientId, via: via ?? "allergen" })
  }
  for (const rule of set.ingredientRules) {
    const relation = isSameOrDerivedFrom(ingredientId, rule.ingredientId, index, lineageOptionsOf(rule.reason))
    if (relation === null) continue
    pushUnique(hits, {
      exclusionId: rule.exclusionId,
      reason: rule.reason,
      ingredientId,
      via: via ?? (relation === "same" ? "ingredient" : "derived"),
    })
  }
}

function evaluateIngredient(
  ingredientId: string,
  set: ExclusionSet,
  hits: BlockHit[],
  unverifiable: Unverifiable[],
): void {
  const profile = allergenProfileOf(ingredientId, set.view.index)
  addRuleHits(ingredientId, set, hits)
  if (set.nameRules.length > 0) {
    const names = ingredientNeedles(ingredientId, set.view)
    for (const rule of set.nameRules) {
      if (!names.some((name) => name.includes(rule.folded))) continue
      pushUnique(hits, { exclusionId: rule.exclusionId, reason: rule.reason, ingredientId, via: "name" })
    }
  }
  const reason: UnverifiableReason | null = profile.unknown
    ? "unknown_ingredient"
    : profile.varies
      ? "varies_ingredient"
      : null
  if (reason && !unverifiable.some((u) => u.reason === reason && u.ingredientId === ingredientId)) {
    unverifiable.push({ reason, ingredientId })
  }
}

/** 原材料そのものが分からない理由（除外が 1 件でもあれば「未確認」にする）。 */
const UNKNOWN_MATERIAL_REASONS: ReadonlySet<UnverifiableReason> = new Set(["no_ingredients", "unknown_ingredient"])

const OK_EVALUATION: DishEvaluation = {
  allowed: true,
  verdict: "ok",
  blockedBy: [],
  needsLabelCheck: false,
  unverifiable: [],
}

/** 料理 1 つを除外の和集合で判定する。 */
export function evaluateDish(dish: DishView, set: ExclusionSet): DishEvaluation {
  if (set.isEmpty) return { ...OK_EVALUATION, blockedBy: [], unverifiable: [] }
  const hits: BlockHit[] = []
  const unverifiable: Unverifiable[] = []
  const ingredients = dish.ingredients ?? []
  for (const ingredient of ingredients) {
    evaluateIngredient(ingredient.ingredientId, set, hits, unverifiable)
  }
  const title = foldName(dish.title)
  for (const rule of set.nameRules) {
    if (!title.includes(rule.folded)) continue
    pushUnique(hits, { exclusionId: rule.exclusionId, reason: rule.reason, ingredientId: null, via: "name" })
  }
  if (ingredients.length === 0) unverifiable.push({ reason: "no_ingredients", ingredientId: null })
  // 材料の無い料理と手動料理は、登録した品目の名前を料理名に照らす。
  // 手動料理は材料があっても照らす（材料を足した途端に「エビフライ」が通る、を起こさない）。
  // 品目名を含むが、その品目ではない語の中の名前は数えない（「焼きそば」の「そば」・「豆乳鍋」の「乳」で当てない）。
  // 料理名の語が指す食材（焼きそば → 焼きそば麺）は、材料に書き漏れていても含むとみなして当てる
  if (ingredients.length === 0 || dish.manual === true) {
    const scan = scanText(title, set.view)
    const shown = new Set(scan.names.map((name) => name.folded))
    for (const needle of set.titleNeedles) {
      if (!shown.has(needle.folded)) continue
      pushUnique(hits, {
        exclusionId: needle.exclusionId,
        reason: needle.reason,
        ingredientId: needle.ingredientId,
        via: "name",
      })
    }
    for (const term of scan.terms) {
      for (const ingredientId of termTargets(term, set.view).ingredientIds) addRuleHits(ingredientId, set, hits, "name")
    }
  }
  if (dish.allergenStatus === "unconfirmed") {
    unverifiable.push({ reason: "allergen_unconfirmed", ingredientId: null })
  }
  // 「未確認」: 原材料が分からない（材料未登録・辞書で解決できない材料）料理は、除外が 1 件でもあれば（苦手だけでも）
  // 「含まない」と言えない。商品で原材料が変わる材料・未確認のレシピは、アレルギーの除外があるときだけ。
  // 判定できないアレルギーの除外があれば、該当する料理を見分けられない。どの料理も自動では確定しない
  const unknownMaterials = unverifiable.some((item) => UNKNOWN_MATERIAL_REASONS.has(item.reason))
  const needsLabelCheck = (set.hasAllergy && unverifiable.length > 0) || unknownMaterials || set.holdsAutoConfirm
  const verdict: DishVerdict = hits.length > 0 ? "blocked" : needsLabelCheck ? "label_check" : "ok"
  return { allowed: verdict === "ok", verdict, blockedBy: hits, needsLabelCheck, unverifiable }
}

/** カタログのレシピ 1 件を判定する。 */
export function evaluateRecipe(recipe: RecipeDef, set: ExclusionSet): DishEvaluation {
  return evaluateDish(
    { title: recipe.title, ingredients: recipe.ingredients, allergenStatus: recipe.allergenStatus },
    set,
  )
}

export interface RecipePartition {
  /** 自動で確定してよい候補。 */
  allowed: RecipeDef[]
  /** 原材料の確認が必要（自動確定の候補にしない。別枠で見せる）。 */
  labelCheck: RecipeDef[]
  /** 必須除外に当たる。 */
  blocked: RecipeDef[]
}

/** レシピを判定結果で 3 つへ分ける（順序は入力のまま）。 */
export function partitionRecipes(recipes: readonly RecipeDef[], set: ExclusionSet): RecipePartition {
  const result: RecipePartition = { allowed: [], labelCheck: [], blocked: [] }
  for (const recipe of recipes) {
    const verdict = evaluateRecipe(recipe, set).verdict
    if (verdict === "ok") result.allowed.push(recipe)
    else if (verdict === "label_check") result.labelCheck.push(recipe)
    else result.blocked.push(recipe)
  }
  return result
}

export interface PlanConflict {
  entryId: string
  date: string
  role: DishRole
  title: string
  pinned: boolean
  status: PlanEntryStatus
  /** `blocked` = 必須除外に当たる。`label_check` = 成分を確かめられない。 */
  verdict: Exclude<DishVerdict, "ok">
  blockedBy: BlockHit[]
  unverifiable: Unverifiable[]
}

/** 献立の枠を判定用の形へ寄せる。カタログに無いレシピ ID は null（確かめられない）。 */
export function dishViewOfEntry(entry: PlanEntry, view: CatalogView): DishView | null {
  if (entry.recipeId !== null) {
    const recipe = view.recipeById.get(entry.recipeId)
    if (!recipe) return null
    return { title: recipe.title, ingredients: recipe.ingredients, allergenStatus: recipe.allergenStatus }
  }
  return {
    title: entry.customTitle ?? "",
    ingredients: entry.customIngredients,
    allergenStatus: "from_ingredients",
    manual: true,
  }
}

export function evaluateEntry(entry: PlanEntry, set: ExclusionSet): DishEvaluation {
  const dish = dishViewOfEntry(entry, set.view)
  if (dish) return evaluateDish(dish, set)
  if (set.isEmpty) return { ...OK_EVALUATION, blockedBy: [], unverifiable: [] }
  // カタログに無いレシピは材料を一切確かめられない。除外が 1 件でもあれば（苦手だけでも）通さない
  return {
    allowed: false,
    verdict: "label_check",
    blockedBy: [],
    needsLabelCheck: true,
    unverifiable: [{ reason: "unknown_recipe", ingredientId: null }],
  }
}

function entryTitle(entry: PlanEntry, view: CatalogView): string {
  if (entry.recipeId !== null) return view.recipeById.get(entry.recipeId)?.title ?? entry.recipeId
  return entry.customTitle ?? ""
}

/**
 * 除外の設定を変えた後に、既存の予定・固定枠との衝突を一覧にする。
 * **置換はしない**（固定でも新しい除外を無視せず、選び直せる状態にするのは呼び出し側）。
 * 対象は「提案」「確定」の枠。作り終えた枠・作らなかった枠は対象外。
 */
export function findPlanConflicts(entries: readonly PlanEntry[], set: ExclusionSet): PlanConflict[] {
  const conflicts: PlanConflict[] = []
  for (const entry of entries) {
    if (entry.status !== "proposed" && entry.status !== "confirmed") continue
    const evaluation = evaluateEntry(entry, set)
    if (evaluation.verdict === "ok") continue
    conflicts.push({
      entryId: entry.id,
      date: entry.date,
      role: entry.role,
      title: entryTitle(entry, set.view),
      pinned: entry.pinned,
      status: entry.status,
      verdict: evaluation.verdict,
      blockedBy: evaluation.blockedBy,
      unverifiable: evaluation.unverifiable,
    })
  }
  return conflicts.sort(
    (a, b) => a.date.localeCompare(b.date) || a.entryId.localeCompare(b.entryId),
  )
}

/** 画面の文言用: 該当した材料の表示名。 */
export function blockedIngredientNames(hits: readonly BlockHit[], set: ExclusionSet): string[] {
  const names = hits
    .map((hit) => (hit.ingredientId === null ? null : ingredientNameOf(hit.ingredientId, set.view.index)))
    .filter((name): name is string => name !== null)
  return [...new Set(names)]
}
