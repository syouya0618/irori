/**
 * 子どもの食事に関する案内データ（出典つき）。
 *
 * 境界指令を持たない中立モジュール。コード同梱の正本であり、生成 AI に書かせない。
 *
 * ここに置くのは 3 種類だけ:
 *  (a) 乳児の離乳段階の「一般案内」— 個別レシピの対応とは別物。これがあるからといって
 *      どのレシピも乳児向けにはならない。
 *  (b) 一次資料で確認した年齢制約（食材辞書の `ageRule` と対になる）。
 *  (c) 幼児（2 歳以降）へ取り分けるときの一般的な注意。
 *
 * 文言はすべて、下の出典表にある公的資料を確認したうえでの Irori 独自の短い言い換え。
 * 一次資料で確認できていない事柄（例: 特定の菓子やパンについての注意）は書かない。
 * 「これで安全」「そのまま食べられる」といった断定はしない。
 */
import type { ChildServingStage } from "@/lib/meals/types"

// ── 出典表 ─────────────────────────────────────────────────────────

export interface GuidanceSource {
  id: string
  /** 文書名。 */
  title: string
  /** 発行者。 */
  publisher: string
  url: string
  /** 根拠にした箇所（ページ・項目）。 */
  pages: string
  /** 一次資料を確認した日（YYYY-MM-DD）。 */
  confirmedOn: string
  /**
   * 確認の方法。`direct` は公式 PDF の本文を読んだ。`summary` は公式ページを取得して
   * 要点を抜き出した（逐語の引用はしていない）。
   */
  verification: "direct" | "summary"
  /** この資料で確認できた範囲（どの案内の根拠になるか）。 */
  supports: string
}

export const GUIDANCE_SOURCES: readonly GuidanceSource[] = [
  {
    id: "mhlw_honey_leaflet",
    title: "ハチミツを与えるのは1歳を過ぎてから。（リーフレット）",
    publisher: "厚生労働省",
    url: "https://www.mhlw.go.jp/file/06-Seisakujouhou-11130500-Shokuhinanzenbu/0000161404.pdf",
    pages: "リーフレット全体（1枚）",
    confirmedOn: "2026-11-11",
    verification: "direct",
    supports:
      "1歳未満にはちみつ・はちみつ入りの食品を与えないこと。通常の加熱や調理では防げないこと。1歳以上は対象外であること。",
  },
  {
    id: "cfa_weaning_guide_2019",
    title: "授乳・離乳の支援ガイド（2019年改定版）",
    publisher:
      "「授乳・離乳の支援ガイド」改定に関する研究会（こども家庭庁ウェブサイト掲載）",
    url: "https://www.cfa.go.jp/assets/contents/node/basic_page/field_ref_resources/6790a829-15c7-49d3-9156-9e40e8d9c20c/b0946e59/20230401_policies_boshihoken_junyuu_01.pdf",
    pages: "p.30〜34（離乳の開始・進行・完了、離乳の進め方の目安）",
    confirmedOn: "2026-11-11",
    verification: "direct",
    supports:
      "離乳の段階名・月齢の目安・調理形態。離乳期に、家族の食事から調味前のものを取り分けたり薄味のものを取り入れたりすること。はちみつは1歳を過ぎるまで与えないこと。",
  },
  {
    id: "caa_choking_2021",
    title:
      "食品による子どもの窒息・誤嚥事故に注意！（News Release 令和3年1月20日）",
    publisher: "消費者庁",
    url: "https://www.caa.go.jp/policies/policy/consumer_safety/caution/caution_047/assets/caution_047_210120_0001.pdf",
    pages: "p.1、p.8",
    confirmedOn: "2026-11-11",
    verification: "direct",
    supports:
      "硬い豆やナッツ類を5歳以下に食べさせないこと。球状の食品は4等分する・調理して軟らかくすること。食べるときの姿勢と集中。",
  },
  {
    id: "cfa_accident_handbook",
    title: "こどもの事故防止ハンドブック（窒息・誤飲事故）",
    publisher: "こども家庭庁",
    url: "https://www.cfa.go.jp/policies/child-safety-actions/handbook/content-1",
    pages: "「食事中に食べ物で窒息（0歳から6歳くらい）」の項",
    confirmedOn: "2026-11-11",
    verification: "summary",
    supports:
      "離乳期を過ぎ3歳頃までは、かむ力・飲み込む力に応じて適度な大きさに切ること。0〜5歳では乾いたナッツ・豆類、もち・白玉団子、いか・こんにゃくなどを避けること。球状の食品は4等分すること。",
  },
  {
    id: "mhlw_dri_2025_sodium",
    title:
      "「日本人の食事摂取基準（2025年版）」策定検討会報告書 ミネラル（多量ミネラル）",
    publisher: "厚生労働省",
    url: "https://www.mhlw.go.jp/content/10904750/001316468.pdf",
    pages: "p.281（ナトリウムの食事摂取基準）",
    confirmedOn: "2026-11-11",
    verification: "direct",
    supports:
      "食塩相当量の目標量が、1〜2歳・3〜5歳では大人より少ないこと（薄味にする根拠）。",
  },
]

const SOURCE_BY_ID: ReadonlyMap<string, GuidanceSource> = new Map(
  GUIDANCE_SOURCES.map((s) => [s.id, s]),
)

/** 出典 ID から出典を引く。未知の ID は undefined（呼び出し側で表示を省く）。 */
export function getGuidanceSource(id: string): GuidanceSource | undefined {
  return SOURCE_BY_ID.get(id)
}

// ── 共通の注意書き ─────────────────────────────────────────────────

/**
 * 案内全体の位置づけ。取り分け案内・離乳の一般案内を出す画面に必ず添える。
 * （監修の有無を偽らないための文言。禁止語検査はこの定数だけを対象外にしている。）
 */
export const CHILD_GUIDANCE_DISCLAIMER =
  "この案内は、公的機関の公開資料をもとに Irori が独自にまとめた一般的な注意です。専門家の監修は受けていません。お子さんの発達や体調に合わせて調整し、心配なときは医師などに相談してください。"

/** 取り分け案内の対象範囲。 */
export const CHILD_SERVING_SCOPE_NOTE =
  "取り分けの案内は、離乳食を終えた2歳以降の幼児向けです。離乳食の作り方や、新しい食材を始める時期の判断には対応していません。"

/** `childServing` を持たないレシピ、または対象外の年齢・未設定のときの表示。 */
export const CHILD_SERVING_UNSUPPORTED_TEXT =
  "この料理の取り分け案内は未対応です"

/**
 * 「味付け前に取り分ける」という手順の位置づけ。
 * 幼児について調味前の取り分けを明記した一次資料は確認できていないため、
 * 「薄味にするための手順」として示し、離乳期の文脈であることを隠さない。
 */
export const SEPARATE_BEFORE_SEASONING_NOTE =
  "味付けの前に取り分けるのは、大人より薄味にしやすくするための手順です。「授乳・離乳の支援ガイド」は離乳期の食事について、家族の食事から調味前のものを取り分ける方法を挙げています。"

export const CHILD_SERVING_STAGE_LABELS: Readonly<
  Record<ChildServingStage, string>
> = {
  toddler_2y_plus: "2歳以降の幼児",
}

// ── (a) 離乳段階の一般案内 ─────────────────────────────────────────

export interface WeaningStageGuide {
  id: "early" | "middle" | "late" | "completion"
  /** 段階名（支援ガイドの呼称）。 */
  label: string
  /** 月齢の目安の表記。「頃」を落とさない。 */
  ageLabel: string
  /**
   * 月齢の目安（両端を含む）。表示の初期値を提案するためだけに使う。
   * 段階を月齢から自動確定してはならない（資料自身が「あくまでも目安」としている）。
   */
  approxFromMonths: number
  approxToMonths: number
  /** 調理形態の目安（短い独自の言い換え）。 */
  texture: string
  sourceIds: readonly string[]
}

export const WEANING_STAGE_GUIDES: readonly WeaningStageGuide[] = [
  {
    id: "early",
    label: "離乳初期",
    ageLabel: "生後5〜6か月頃",
    approxFromMonths: 5,
    approxToMonths: 6,
    texture: "なめらかにすりつぶした状態から始める",
    sourceIds: ["cfa_weaning_guide_2019"],
  },
  {
    id: "middle",
    label: "離乳中期",
    ageLabel: "生後7〜8か月頃",
    approxFromMonths: 7,
    approxToMonths: 8,
    texture: "舌でつぶせるくらいの固さ",
    sourceIds: ["cfa_weaning_guide_2019"],
  },
  {
    id: "late",
    label: "離乳後期",
    ageLabel: "生後9〜11か月頃",
    approxFromMonths: 9,
    approxToMonths: 11,
    texture: "歯ぐきでつぶせるくらいの固さ",
    sourceIds: ["cfa_weaning_guide_2019"],
  },
  {
    id: "completion",
    label: "離乳完了期",
    ageLabel: "生後12〜18か月頃",
    approxFromMonths: 12,
    approxToMonths: 18,
    texture: "歯ぐきでかめるくらいの固さ",
    sourceIds: ["cfa_weaning_guide_2019"],
  },
]

/** 一般案内に添える注記。個別レシピの対応とは別であることを明示する。 */
export const WEANING_GENERAL_NOTES: readonly string[] = [
  "月齢はあくまで目安です。お子さんの食欲や成長・発達の様子に合わせて進めてください。",
  "これは離乳の段階についての一般的な案内で、Irori の個別のレシピが離乳食に対応していることを示すものではありません。",
  "食物アレルギーが心配なときや、新しい食材を始める時期は、自己判断せず医師に相談してください。",
]

// ── (b) 年齢制約 ───────────────────────────────────────────────────

export interface AgeRestrictionRule {
  id: string
  /** 対象の食材（食材辞書の ID）。辞書側の `ageRule` と一致させる。 */
  ingredientIds: readonly string[]
  /** この月齢未満には与えない（12 = 満1歳の誕生日より前）。 */
  minAgeMonths: number
  title: string
  body: string
  sourceIds: readonly string[]
}

export const AGE_RESTRICTION_RULES: readonly AgeRestrictionRule[] = [
  {
    id: "honey_under_12m",
    ingredientIds: ["honey"],
    minAgeMonths: 12,
    title: "はちみつは1歳を過ぎてから",
    body: "1歳未満の赤ちゃんには、はちみつと、はちみつ入りの飲み物・お菓子・料理を与えないでください。乳児ボツリヌス症にかかることがあり、原因となる菌は通常の加熱や調理ではなくなりません。",
    sourceIds: ["mhlw_honey_leaflet", "cfa_weaning_guide_2019"],
  },
]

// ── (c) 幼児（2 歳以降）へ取り分けるときの一般的な注意 ─────────────

export interface ToddlerServingNote {
  id: string
  /** 何についての注意か（色に頼らず文字で区別するための見出し）。 */
  topic: "taste" | "shape" | "avoid" | "eating"
  text: string
  sourceIds: readonly string[]
}

export const TODDLER_SERVING_TOPIC_LABELS: Readonly<
  Record<ToddlerServingNote["topic"], string>
> = {
  taste: "味付け",
  shape: "形・やわらかさ",
  avoid: "避けたい食品",
  eating: "食べるとき",
}

export const TODDLER_SERVING_NOTES: readonly ToddlerServingNote[] = [
  {
    id: "light_seasoning",
    topic: "taste",
    text: "大人より薄味にします。1日の食塩の目標量は、1〜2歳で3.0g未満（女の子は2.5g未満）、3〜5歳で3.5g未満と、大人（男性7.5g未満・女性6.5g未満）より少なく設定されています。",
    sourceIds: ["mhlw_dri_2025_sodium"],
  },
  {
    id: "cut_to_ability",
    topic: "shape",
    text: "3歳頃までは、歯の生え方やかむ力・飲み込む力に合わせて、食べやすい大きさに切ります。",
    sourceIds: ["cfa_accident_handbook"],
  },
  {
    id: "round_foods",
    topic: "shape",
    text: "ミニトマトやぶどうなど球状の食品は丸ごと与えず、4等分にするか、加熱してやわらかくします。",
    sourceIds: ["caa_choking_2021", "cfa_accident_handbook"],
  },
  {
    id: "hard_beans_nuts",
    topic: "avoid",
    text: "豆やナッツ類など、硬くてかみ砕く必要のある食品は、5歳以下には与えません。細かく砕いても気管に入るおそれがあります。",
    sourceIds: ["caa_choking_2021", "cfa_accident_handbook"],
  },
  {
    id: "sticky_or_chewy",
    topic: "avoid",
    text: "もち・白玉団子のように粘りが強いものや、いか・こんにゃくのように弾力があってかみ切りにくいものは、5歳までは避けます。",
    sourceIds: ["cfa_accident_handbook"],
  },
  {
    id: "sit_and_focus",
    topic: "eating",
    text: "姿勢よく座り、食べることに集中できるようにします。口に食べ物を入れたまま遊んだり、話したり、寝転んだりしないよう見守ります。",
    sourceIds: ["caa_choking_2021", "cfa_accident_handbook"],
  },
]

/**
 * 取り分け案内（`childServing`）を付けない食材。
 * 0〜5 歳では避けるとされた食品（硬い豆・ナッツ類、もち、いか、こんにゃく）に当たるもの。
 * 一次資料の列挙より広め（安全側）に取り、枝豆・しらたきも含めている。
 * これを材料に含むレシピには取り分け案内を付けない（カタログ検査テストで固定）。
 */
export const CHILD_SERVING_BLOCKED_INGREDIENT_IDS: readonly string[] = [
  "soybean",
  "edamame",
  "peanuts",
  "almond",
  "walnut",
  "mochi",
  "squid",
  "konnyaku",
  "shirataki",
]

/**
 * 球状で、丸ごとでは与えないとされた食品に当たる食材。
 * 初期カタログでは、これを含むレシピにも取り分け案内を付けない。
 */
export const CHILD_SERVING_ROUND_INGREDIENT_IDS: readonly string[] = [
  "cherry_tomato",
]
