/**
 * 子どもの月齢から、離乳の段階の「目安」の文を作る（設定画面で、保護者が段階を選ぶときに添える）。
 *
 * 境界指令を持たない中立モジュール（純関数。案内のデータは引数で受け、カタログを import しない）。
 *
 * - **段階を決めない。** 返すのは「月齢の目安ではこの段階に当たる」という文だけで、選択肢の初期値にも
 *   使わない（資料自身が月齢を「あくまでも目安」としている。発達や食べている物は月齢から分からない）。
 * - 案内のデータ（`WEANING_STAGE_GUIDES`）に月齢の範囲が在る段階だけを言う。範囲の外（19 か月以降など）は
 *   何も言わない（根拠の無い目安を作らない）。
 */

export interface StageGuideRange {
  label: string
  ageLabel: string
  approxFromMonths: number
  approxToMonths: number
}

export function childStageHint(ageMonths: number | null, guides: readonly StageGuideRange[]): string | null {
  if (ageMonths === null || !Number.isFinite(ageMonths) || ageMonths < 0) return null
  const months = Math.floor(ageMonths)
  const matched = guides.find((guide) => months >= guide.approxFromMonths && months <= guide.approxToMonths)
  if (matched) {
    return `月齢の目安では「${matched.label}（${matched.ageLabel}）」に当たります。実際の食べ方に合わせて選んでください。`
  }
  const first = guides.reduce<StageGuideRange | null>(
    (earliest, guide) => (earliest === null || guide.approxFromMonths < earliest.approxFromMonths ? guide : earliest),
    null,
  )
  if (first !== null && months < first.approxFromMonths) {
    return `離乳の開始は「${first.ageLabel}」が目安とされています。始める時期は、お子さんの様子に合わせて決めてください。`
  }
  return null
}
