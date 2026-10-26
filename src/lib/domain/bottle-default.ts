/**
 * いつものミルク量（`households.bottle_default_ml`）の契約。
 *
 * クイック記録の「ミルク」を 1 タップで押した時に `amount_ml` へ入れる量。世帯で 1 つ持ち、
 * 夫婦どちらの端末からでも変えられる。変えた量は**次の記録から**効き、過去の記録は書き換えぬ。
 * 月齢からの自動推定や、未設定時の勝手な既定量は持たぬ（未設定なら量の入力を求める）。
 *
 * 範囲は DB CHECK `chk_bottle_default_ml`（supabase/migrations/20261025100001）・
 * サーバの `updateBottleDefault`・量を変更するシートの三者で同じ 1〜999 の整数。
 *
 * ⚠️ 境界指令を持たぬ中立モジュールに置く。Server Component（baby/page.tsx）・Server Action・
 * Client Component の三者が**値として** import するため（CLAUDE.md の "use client" 値 import の罠）。
 */

export const BOTTLE_DEFAULT_MIN_ML = 1
export const BOTTLE_DEFAULT_MAX_ML = 999
/** 量を変更するシートの増減幅（ml）。ミルクの量は 10ml 刻みで増やすことが多い */
export const BOTTLE_DEFAULT_STEP_ML = 10

export const BOTTLE_DEFAULT_RANGE_ERROR = `ミルクの量は${BOTTLE_DEFAULT_MIN_ML}〜${BOTTLE_DEFAULT_MAX_ML}mlの整数で入力してください`

/** 設定として保存できる量か（1〜999 の整数）。DB CHECK chk_bottle_default_ml のミラー */
export function isBottleDefaultMl(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= BOTTLE_DEFAULT_MIN_ML &&
    value <= BOTTLE_DEFAULT_MAX_ML
  )
}

/**
 * 画面が持つ「いつものミルク量」の状態。
 * - `set`: 量が決まっておる。ミルクは 1 タップでこの量を記録する
 * - `unset`: 世帯でまだ決めておらぬ（列が NULL）。ミルクは量の入力を求める
 * - `error`: 読めなかった。未設定とは**区別する** — 未設定と取り違えると、決めてある量を
 *   知らぬまま設定し直させ、家族が決めた量を上書きさせる
 */
export type BottleDefaultState =
  | { status: "set"; amountMl: number }
  | { status: "unset" }
  | { status: "error" }

/**
 * `households` から `bottle_default_ml` を読んだ結果を状態へ写す。サーバの初回描画
 * （baby/page.tsx）と画面の取り直し（useBottleDefault）が共有する**唯一の判定規則**:
 *
 * - error がある → `error`
 * - 行が無い（data が null）→ `error`。自世帯の行は必ず在るゆえ、無いのは RLS で見えぬ
 *   （session 切れの anon 問い合わせはエラー無しの 0 行で返る）= 判定不能
 * - 列が null → `unset`
 * - 1〜999 の整数 → `set`
 * - それ以外（列が欠けた応答・範囲外）→ `error`（読めた値を信じきれぬ時は量を出さぬ）
 */
export function decodeBottleDefault(result: {
  data: { bottle_default_ml?: unknown } | null
  error: unknown
}): BottleDefaultState {
  if (result.error) return { status: "error" }
  if (!result.data) return { status: "error" }
  const value = result.data.bottle_default_ml
  if (value === null) return { status: "unset" }
  if (isBottleDefaultMl(value)) return { status: "set", amountMl: value }
  return { status: "error" }
}

/**
 * `updateBottleDefault`（Server Action）の結果。型は "use server" ファイルの外に置く。
 * - `ok: true`: 保存できた（応答を失った保存の再試行で、既に同じ量になっていた時も含む）
 * - `conflict`: 画面が見ていた量（expectedMl）の後に、家族または自分の別端末が量を変えていた。
 *   上書きはしておらぬ。`currentMl` は DB の今の量（null は未設定）
 */
export type UpdateBottleDefaultResult =
  | { ok: true; amountMl: number }
  | { ok: false; error: string; conflict?: undefined }
  | { ok: false; error: string; conflict: { currentMl: number | null } }

/** 量の表記（「120ml」）。タイムラインの要約（baby-log-summary.ts の `${amount_ml}ml`）と揃える */
export function formatBottleAmount(amountMl: number): string {
  return `${amountMl}ml`
}
