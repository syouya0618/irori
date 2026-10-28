"use server"

import { revalidatePath } from "next/cache"
import { getAuthContext, type AuthContext } from "@/lib/supabase/auth-context"
import { logSupabaseError } from "@/lib/supabase/log-error"
import { isClientId } from "@/lib/utils/client-id"
import type { Database } from "@/lib/types/database"
import {
  BREAST_COUNT_MAX,
  deriveDurationMinFromSec,
  FEEDING_DURATION_SEC_MIN,
  FEEDING_DURATION_SEC_MAX,
} from "@/lib/domain/feeding"
import { validateLogTime } from "@/lib/domain/baby-log-time"
import type { UpsertBabyDiaryResult } from "@/lib/domain/baby-diary"
import {
  BOTTLE_DEFAULT_RANGE_ERROR,
  decodeBottleDefault,
  isBottleDefaultMl,
  type UpdateBottleDefaultResult,
} from "@/lib/domain/bottle-default"
import { BABY_LOG_COLUMNS } from "@/lib/domain/baby-log-columns"
import { parseLookupIds, selectBabyLogsByIds } from "@/lib/domain/baby-log-lookup"
import { todayJstString } from "@/lib/utils/date-jst"
import {
  isTimestamptzText,
  STALE_SCREEN_SAVE_ERROR,
} from "@/lib/domain/timestamptz-text"
import type { BabyDiaryData, BabyLogData } from "@/lib/types/baby"
import { failureKindOfDbError, type CreateFailureKind } from "@/lib/domain/save-attempt"
import type {
  FeedingType,
  DiaperType,
  PoopAmount,
  BreastStartSide,
} from "@/lib/types/database"

const MAX_MEMO_LENGTH = 1000

// うんちの量（poop_amount）。DB CHECK chk_poop_amount_value / chk_poop_amount_only_poop
// （supabase/migrations/20260909100001）のミラー: 値は small / large、付けられるのは
// うんちを含む行（poop / both）だけ。pee 行に量を残す部分 update は DB が fail-loud で
// 拒否するため、updateLog は種類変更と対でしか量を扱わない（counts と同じ規約）。
const POOP_AMOUNT_ERROR = "うんちの量は 少量 / 大量 のいずれかで指定してください"
const POOP_AMOUNT_TYPE_ERROR = "うんちの量はうんちを含む記録にのみ指定できます"
const POOP_AMOUNT_WITHOUT_TYPE_ERROR =
  "うんちの量はおむつの種類と同時に指定してください"

function isPoopAmount(value: unknown): value is PoopAmount {
  return value === "small" || value === "large"
}

/**
 * 量を持てるおむつ種別か。DB CHECK（chk_poop_amount_only_poop）と同じ集合を
 * 名指しする。diaper_type に新しい値が増えた時は DB 側と同時にここも直すこと
 * （allowlist にしてあるのは「量が意味を持つ種別」を DB と一致させるためで、
 * 未知値が混ざっても量なし扱いで退化するだけ = 画面は倒れない）。
 */
function allowsPoopAmount(type: DiaperType): boolean {
  return type === "poop" || type === "both"
}

// 母乳サイクルの開始側（breast_start_side）。DB CHECK chk_breast_start_side_value /
// chk_breast_start_side_only_breast のミラー: 値は left / right、breast 行のみ。
// null は「不明」（旧行・旧形式タイマー復元）ゆえ受理する。
const BREAST_START_SIDE_ERROR = "開始側は 左 / 右 のいずれかで指定してください"
const BREAST_START_SIDE_TYPE_ERROR = "この授乳タイプには開始側を指定できません"
const BREAST_START_SIDE_WITHOUT_TYPE_ERROR =
  "開始側は授乳の種類と同時に指定してください"

function isBreastStartSide(value: unknown): value is BreastStartSide {
  return value === "left" || value === "right"
}

function validateMemoLength(memo?: string | null): string | null {
  if (memo && memo.length > MAX_MEMO_LENGTH) {
    return `メモは${MAX_MEMO_LENGTH}文字以内で入力してください`
  }
  return null
}

// 記録時刻（loggedAt）を伴う作成系 Action 共通の検証。
// 未指定（従来どおり DB の now() 既定）は素通し、指定時のみ未来/不正 ISO を拒否する。
function validateCreateLoggedAt(loggedAt?: string | null): string | null {
  if (loggedAt === undefined || loggedAt === null) return null
  return validateLogTime(loggedAt)
}

// 冪等 id（P2-08）。クライアントが「操作の意図」ごとに 1 回だけ作り、応答を失った再試行でも
// 同じ id を送る。形は UUID に限る（主キーに入れるため。形が違えば DB に届く前に拒む）。
const CLIENT_ID_ERROR =
  "記録の識別子が不正です。画面を再読み込みしてからもう一度お試しください。"

function validateClientId(clientId: string | undefined): string | null {
  if (clientId === undefined) return null
  return isClientId(clientId) ? null : CLIENT_ID_ERROR
}

type BabyLogInsert = Database["public"]["Tables"]["baby_logs"]["Insert"]
type BabyLogInsertBody = Omit<BabyLogInsert, "id" | "household_id" | "logged_by">
type BabyLogUpdate = Database["public"]["Tables"]["baby_logs"]["Update"]

// 編集しようとした記録が見えぬ（他端末で削除済み・別世帯）。別世帯の行も同じ文言にする。
const LOG_DELETED_ERROR = "この記録は他の端末で削除されていました。"
/**
 * 作成系 Action の結果。`replayed` は「同じ冪等 id の記録が既に在り、内容も同じだった」
 * 再試行の吸収（二重には記録していない）。呼び出し側は成功として扱ってよいが、
 * 「取り消す」を前回の本物の行へ向けぬよう、必要なら表示を分ける。
 *
 * 新しく書けた時は行の版（`updatedAt`）も返す。楽観 append の行はこの版を持つ —
 * 持たねば Realtime の echo / 再取得が届くまで、作成直後の編集が版を送れぬ（P2-07）。
 *
 * 記録時刻（`loggedAt`）も DB が書いた値のまま返す。loggedAt を送らぬクイック記録は DB の
 * now() で書かれ、応答が届いた時の端末時計とは数秒（時計がずれておればそれ以上）食い違う。
 * 楽観行をその端末時計で組むと、分を跨いだ時に画面の HH:mm が DB と違い、編集シートが
 * 違う時刻で seed され、保存の後に表示が DB の時刻へ飛ぶ（2026-10-25 のミルクの報告）。
 *
 * 成功（新規・replayed とも）は DB の確定行（`log`）も返す。replayed で版・時刻を返さぬと、
 * 応答を失った保存を再送で確かめた画面が、手元の値で架空の成功行を組むことになる（2026-10-27
 * 大型更新 A2: 保存済みはサーバの確定値で示す）。
 *
 * 失敗は `failure` で分類する（`@/lib/domain/save-attempt` の CreateFailureKind）:
 * rejected = 行は書かれておらぬと断定できる / unknown = 書かれたかもしれぬ / conflict = 同じ id に
 * 別の内容が保存済み（`conflict.current` に自世帯の確定行）。
 */
type InsertFailure = {
  error: string
  id: null
  // このサーバでは常に付ける。無い応答（古い形）は受け手が unknown として扱う（phaseAfterFailure）
  failure?: CreateFailureKind
  conflict?: { current: BabyLogData }
  updatedAt?: undefined
  loggedAt?: undefined
  replayed?: undefined
  log?: undefined
}
// 成功の版・時刻・確定行は、このサーバでは常に返す。型を optional に留めるのは、行を返さぬ
// 古い形の応答（デプロイを跨いだ画面・試験の stub）でも呼び出し側が壊れぬよう、受け手に
// 「無ければ送った値とサーバの時刻で組む」退避を書かせるため（feeding-timer の finishRecorded）
type InsertOutcome =
  | InsertFailure
  | {
      error: null
      id: string
      updatedAt?: string
      loggedAt?: string
      log?: BabyLogData
      replayed?: true
      failure?: undefined
      conflict?: undefined
    }

const REPLAY_MISMATCH_ERROR =
  "この操作は少し前に別の内容で記録済みです。画面を更新して記録を確かめてください。"


/**
 * DB の行が、今回送った内容と一致するか。二つの再試行で共有する:
 * - 作成の冪等 id（P2-08 の契約: 世帯**と内容**が一致した時だけ成功）
 * - 編集の版ガード（P2-07: 版が合わず 0 行でも、行が送った内容そのものなら、応答だけが
 *   失われた自分の保存の再試行ゆえ成功）
 * 比べるのは今回送った列だけ（logged_at を送らぬクイック記録は DB の now() 既定と、
 * 編集で送らなかった列は家族の変更と比べぬ）。数値は等値、文字列は同値、null と
 * undefined は同じ「無し」。logged_at は表記が揺れる（"Z" と "+00:00"）ため epoch で比べる。
 */
function sameRecordedContent(
  existing: Record<string, unknown>,
  body: Record<string, unknown>,
): boolean {
  for (const [key, sent] of Object.entries(body)) {
    // 送っていない列（DB 既定に委ねた logged_at 等）は比べぬ
    if (sent === undefined) continue
    const stored = existing[key]
    if (key === "logged_at") {
      if (new Date(String(sent)).getTime() !== new Date(String(stored)).getTime()) {
        return false
      }
      continue
    }
    const a = sent ?? null
    const b = stored ?? null
    if (a === b) continue
    if (typeof a === "number" && typeof b === "number" && a === b) continue
    return false
  }
  return true
}

/**
 * baby_logs へ 1 行書く共通経路（record* の 5 本が共有する）。
 *
 * `clientId` があれば主キーとして INSERT する。主キー重複（23505）は「前回の保存は DB で
 * 成立したが応答だけが失われ、利用者が再試行した」形ゆえ、同じ世帯にその id の行が在り
 * **内容も同じ**なら、既に記録済みとして同じ id を成功（`replayed`）で返す（二重記録を
 * 作らぬ。P2-08）。内容が違う（直して押し直した）なら、画面と DB が無言で食い違わぬよう
 * fail-loud にする。別世帯の id や削除済みなら重複とは扱わず、通常の失敗にする
 * （id は推測されうるため、世帯で絞る）。
 */
async function insertBabyLog(
  supabase: AuthContext["supabase"],
  householdId: string,
  userId: string,
  body: BabyLogInsertBody,
  clientId: string | undefined,
  label: string,
): Promise<InsertOutcome> {
  const failed = (failure: CreateFailureKind): InsertFailure => ({
    error: `${label}に失敗しました。`,
    id: null,
    failure,
  })
  const { data, error } = await supabase
    .from("baby_logs")
    .insert({
      ...(clientId !== undefined && { id: clientId }),
      household_id: householdId,
      logged_by: userId,
      ...body,
    })
    .select(BABY_LOG_COLUMNS)
    .single()

  if (error) {
    if (error.code === "23505" && clientId !== undefined) {
      const { data: existing, error: lookupError } = await supabase
        .from("baby_logs")
        .select(BABY_LOG_COLUMNS)
        .eq("id", clientId)
        .eq("household_id", householdId)
        .maybeSingle()
      if (lookupError) {
        logSupabaseError("baby", `${label}: 重複 id の読み直しに失敗`, lookupError, {
          userId,
          householdId,
          clientId,
        })
        // 自世帯に同じ id の行が在るかもしれぬ（確かめられなんだ）
        return failed("unknown")
      }
      if (existing) {
        const stored = existing as BabyLogData
        if (!sameRecordedContent(existing as Record<string, unknown>, body)) {
          // 前回の保存は成立しており、今回は別の内容。黙ってどちらかを採らぬ
          console.warn(`[baby] ${label}: 同じ冪等 id に別の内容の再試行`, {
            householdId,
            clientId,
          })
          return {
            error: REPLAY_MISMATCH_ERROR,
            id: null,
            failure: "conflict",
            conflict: { current: stored },
          }
        }
        // 応答を失った前回の保存が成立していた。再試行を吸収して同じ id と確定行を返す
        console.info(`[baby] ${label}: 再試行を既存の記録として受理`, {
          householdId,
          clientId,
        })
        revalidatePath("/baby")
        return {
          error: null,
          id: stored.id,
          updatedAt: stored.updated_at as string,
          loggedAt: stored.logged_at,
          log: stored,
          replayed: true,
        }
      }
      // 自世帯に行が無い主キー重複（別世帯の id の流用・推測）。この id では書けぬ
      logSupabaseError("baby", `${label}に失敗`, error, { userId, householdId })
      return failed("rejected")
    }
    logSupabaseError("baby", `${label}に失敗`, error, { userId, householdId })
    return failed(failureKindOfDbError(error))
  }
  if (!data) {
    console.error(`[baby] ${label}: 行が返らず`, { userId, householdId })
    return failed("unknown")
  }

  const saved = data as BabyLogData
  revalidatePath("/baby")
  return {
    error: null,
    id: saved.id,
    updatedAt: saved.updated_at as string,
    loggedAt: saved.logged_at,
    log: saved,
  }
}

// 母乳サイクル行（feeding_type: 'breast'）の左右吸わせ回数を検証する。
// DB CHECK chk_breast_counts_required（supabase/migrations/20260726100002）のミラー:
// 両方必須・整数・各 0..20・合計 >= 1。recordFeeding / updateLog で共有する。
const BREAST_COUNTS_ERROR =
  "左右の回数は0〜20回・合計1回以上で指定してください"

// 母乳サイクル行の左右別授乳時間を検証する。DB CHECK（chk_breast_side_sec_pair /
// chk_breast_side_sec_total — supabase/migrations/20260727100001）のミラー:
// 両方指定・整数・各 0..10800・合計 >= 1。duration_sec はサーバが左右の和から
// 導出する（クライアントの合計送信を信用しない・二重真値源の禁止）。
const BREAST_SIDES_ERROR =
  "左右の授乳時間は両方・各0〜180分・合計1秒以上で指定してください"
const BREAST_SIDES_WITH_TOTAL_ERROR =
  "左右の時間があるときは合計時間は指定できません（合計は自動計算されます）"
const BREAST_SIDES_TYPE_ERROR = "この授乳タイプには左右の時間を指定できません"
const BREAST_SIDES_TOTAL_ONLY_ERROR =
  "左右の時間を持つ記録は、左右それぞれの時間で編集してください"

function validateBreastSideSeconds(
  leftSec: number | null | undefined,
  rightSec: number | null | undefined,
): string | null {
  if (
    leftSec == null ||
    rightSec == null ||
    !Number.isInteger(leftSec) ||
    !Number.isInteger(rightSec) ||
    leftSec < 0 ||
    leftSec > FEEDING_DURATION_SEC_MAX ||
    rightSec < 0 ||
    rightSec > FEEDING_DURATION_SEC_MAX ||
    leftSec + rightSec < 1
  ) {
    return BREAST_SIDES_ERROR
  }
  return null
}

function validateBreastCounts(
  leftCount: number | null | undefined,
  rightCount: number | null | undefined,
): string | null {
  if (
    leftCount == null ||
    rightCount == null ||
    !Number.isInteger(leftCount) ||
    !Number.isInteger(rightCount) ||
    leftCount < 0 ||
    leftCount > BREAST_COUNT_MAX ||
    rightCount < 0 ||
    rightCount > BREAST_COUNT_MAX ||
    leftCount + rightCount < 1
  ) {
    return BREAST_COUNTS_ERROR
  }
  return null
}

interface RecordFeedingInput {
  feedingType: FeedingType
  amountMl?: number | null
  /**
   * 授乳時間（秒精度）。duration_min は round(sec/60) でサーバ側導出し併記する
   * （両列を1経路で書き drift を防ぐ）。母乳/ミルク等の時間なし記録では省略する。
   */
  durationSec?: number | null
  /**
   * 母乳サイクル（feedingType: 'breast'）の左吸わせ回数。0..20、右と合計 >= 1。
   * DB CHECK chk_breast_counts_required（supabase/migrations/20260726100002）を
   * サーバ側でミラー検証する。feedingType が 'breast' 以外の時は指定不可
   * （chk_breast_counts_only_breast のミラー）。
   */
  breastLeftCount?: number | null
  /** 母乳サイクル（feedingType: 'breast'）の右吸わせ回数。制約は breastLeftCount と同じ。 */
  breastRightCount?: number | null
  /**
   * 母乳サイクルの左の授乳秒数。指定時は右と両方必須（各 0..10800・合計 >= 1）で、
   * **durationSec は指定不可 — duration_sec/min はサーバが左右の和から導出する**
   * （chk_breast_side_sec_total の等式と二重真値源を防ぐ1経路書込）。
   * 未指定（両方なし）は sides を持たない従来形（合計のみ）で記録される。
   */
  breastLeftSec?: number | null
  /** 母乳サイクルの右の授乳秒数（制約は breastLeftSec と同じ）。 */
  breastRightSec?: number | null
  /**
   * 母乳サイクルの開始側（left / right）。feedingType が 'breast' の時のみ指定可
   * （chk_breast_start_side_only_breast のミラー）。null / 未指定は「不明」で合法
   * （旧形式 localStorage から復元したタイマーは開始側を知らない）。
   */
  breastStartSide?: BreastStartSide | null
  /** 記録時刻（ISO 8601）。未指定時は DB の now() 既定に依存する。 */
  loggedAt?: string
  memo?: string
  /**
   * 冪等 id（UUID。P2-08）。操作の意図ごとに 1 回だけ作り、再試行でも同じ値を送る。
   * 省略時はサーバ（DB 既定）が id を振る = 再試行の吸収は効かぬ。
   */
  clientId?: string
}

interface RecordDiaperInput {
  diaperType: DiaperType
  /**
   * うんちの量（small / large）。diaperType が poop / both の時のみ指定可
   * （chk_poop_amount_only_poop のミラー）。null / 未指定は「量の記録なし」。
   */
  poopAmount?: PoopAmount | null
  /** 記録時刻（ISO 8601）。未指定時は DB の now() 既定に依存する。 */
  loggedAt?: string
  memo?: string
  /** 冪等 id（UUID。P2-08）。RecordFeedingInput と同じ契約。 */
  clientId?: string
}

interface RecordTemperatureInput {
  temperature: number
  /** 記録時刻（ISO 8601）。未指定時は DB の now() 既定に依存する。 */
  loggedAt?: string
  memo?: string
  /** 冪等 id（UUID。P2-08）。RecordFeedingInput と同じ契約。 */
  clientId?: string
}

interface RecordGrowthInput {
  weightG?: number | null
  heightCm?: number | null
  /** 記録時刻（ISO 8601）。未指定時は DB の now() 既定に依存する。 */
  loggedAt?: string
  memo?: string
  /** 冪等 id（UUID。P2-08）。RecordFeedingInput と同じ契約。 */
  clientId?: string
}

interface RecordMemoInput {
  memo: string
  /** 記録時刻（ISO 8601）。未指定時は DB の now() 既定に依存する。 */
  loggedAt?: string
  /** 冪等 id（UUID。P2-08）。RecordFeedingInput と同じ契約。 */
  clientId?: string
}

export async function recordFeeding(input: RecordFeedingInput) {
  const memoError = validateMemoLength(input.memo)
  if (memoError) return { error: memoError, id: null, failure: "rejected" as const }
  const timeError = validateCreateLoggedAt(input.loggedAt)
  if (timeError) return { error: timeError, id: null, failure: "rejected" as const }
  const clientIdError = validateClientId(input.clientId)
  if (clientIdError) return { error: clientIdError, id: null, failure: "rejected" as const }

  // breast_left_count / breast_right_count の検証（DB CHECK
  // chk_breast_counts_only_breast / chk_breast_counts_required のミラー）。
  if (input.feedingType === "breast") {
    const countsError = validateBreastCounts(
      input.breastLeftCount,
      input.breastRightCount,
    )
    if (countsError) return { error: countsError, id: null, failure: "rejected" as const }
  } else if (input.breastLeftCount != null || input.breastRightCount != null) {
    // chk_breast_counts_only_breast のミラー: breast 以外は counts を持てない
    return { error: "この授乳タイプには左右の回数を指定できません", id: null, failure: "rejected" as const }
  }

  // 左右別の授乳時間（sides）。指定時は合計をサーバ導出する（二重真値源の禁止）。
  const hasSides =
    input.breastLeftSec != null || input.breastRightSec != null
  if (hasSides) {
    if (input.feedingType !== "breast") {
      return { error: BREAST_SIDES_TYPE_ERROR, id: null, failure: "rejected" as const }
    }
    if (input.durationSec != null) {
      return { error: BREAST_SIDES_WITH_TOTAL_ERROR, id: null, failure: "rejected" as const }
    }
    const sidesError = validateBreastSideSeconds(
      input.breastLeftSec,
      input.breastRightSec,
    )
    if (sidesError) return { error: sidesError, id: null, failure: "rejected" as const }
  }

  // 開始側（chk_breast_start_side_value / chk_breast_start_side_only_breast のミラー）。
  // null は「不明」として素通し（旧形式タイマー復元・編集シートの「不明」）。
  if (input.breastStartSide != null) {
    if (!isBreastStartSide(input.breastStartSide)) {
      return { error: BREAST_START_SIDE_ERROR, id: null, failure: "rejected" as const }
    }
    if (input.feedingType !== "breast") {
      return { error: BREAST_START_SIDE_TYPE_ERROR, id: null, failure: "rejected" as const }
    }
  }

  const result = await getAuthContext()
  if (result.error !== null) return { error: result.error, id: null, failure: "rejected" as const }
  const { supabase, userId, householdId } = result.context

  // sides あり → duration_sec は左右の和（chk_breast_side_sec_total の等式）。
  // sides なし → 従来どおりクライアントの durationSec（母乳以外・旧形サイクル）。
  const durationSec = hasSides
    ? input.breastLeftSec! + input.breastRightSec!
    : input.durationSec ?? null
  return insertBabyLog(
    supabase,
    householdId,
    userId,
    {
      log_type: "feeding",
      feeding_type: input.feedingType,
      amount_ml: input.amountMl ?? null,
      // 秒を source of truth に、分は後方互換のため round で併記（1経路で両列を書く）
      duration_sec: durationSec,
      duration_min: deriveDurationMinFromSec(durationSec),
      // breast 以外は上で拒否済みゆえ常に null（chk_breast_counts_only_breast のミラー）
      breast_left_count:
        input.feedingType === "breast" ? input.breastLeftCount ?? null : null,
      breast_right_count:
        input.feedingType === "breast" ? input.breastRightCount ?? null : null,
      breast_left_sec: hasSides ? input.breastLeftSec ?? null : null,
      breast_right_sec: hasSides ? input.breastRightSec ?? null : null,
      // breast 以外は上で拒否済みゆえ常に null（chk_breast_start_side_only_breast のミラー）
      breast_start_side:
        input.feedingType === "breast" ? input.breastStartSide ?? null : null,
      // 未指定時は logged_at を送らず DB の now() 既定に委ねる（従来挙動）
      ...(input.loggedAt != null && { logged_at: input.loggedAt }),
      memo: input.memo || null,
    },
    input.clientId,
    "授乳の記録",
  )
}

export async function recordDiaper(input: RecordDiaperInput) {
  const memoError = validateMemoLength(input.memo)
  if (memoError) return { error: memoError, id: null, failure: "rejected" as const }
  const timeError = validateCreateLoggedAt(input.loggedAt)
  if (timeError) return { error: timeError, id: null, failure: "rejected" as const }
  const clientIdError = validateClientId(input.clientId)
  if (clientIdError) return { error: clientIdError, id: null, failure: "rejected" as const }

  // うんちの量（chk_poop_amount_value / chk_poop_amount_only_poop のミラー）。
  // null / 未指定は「量の記録なし」として素通し（クイック記録の「指定なし」）。
  if (input.poopAmount != null) {
    if (!isPoopAmount(input.poopAmount)) {
      return { error: POOP_AMOUNT_ERROR, id: null, failure: "rejected" as const }
    }
    if (!allowsPoopAmount(input.diaperType)) {
      return { error: POOP_AMOUNT_TYPE_ERROR, id: null, failure: "rejected" as const }
    }
  }

  const result = await getAuthContext()
  if (result.error !== null) return { error: result.error, id: null, failure: "rejected" as const }
  const { supabase, userId, householdId } = result.context

  return insertBabyLog(
    supabase,
    householdId,
    userId,
    {
      log_type: "diaper",
      diaper_type: input.diaperType,
      // pee は上で拒否済みゆえ常に null（chk_poop_amount_only_poop のミラー）
      poop_amount: allowsPoopAmount(input.diaperType)
        ? input.poopAmount ?? null
        : null,
      ...(input.loggedAt != null && { logged_at: input.loggedAt }),
      memo: input.memo || null,
    },
    input.clientId,
    "おむつの記録",
  )
}

export async function recordTemperature(input: RecordTemperatureInput) {
  const memoError = validateMemoLength(input.memo)
  if (memoError) return { error: memoError, id: null, failure: "rejected" as const }
  const timeError = validateCreateLoggedAt(input.loggedAt)
  if (timeError) return { error: timeError, id: null, failure: "rejected" as const }
  const clientIdError = validateClientId(input.clientId)
  if (clientIdError) return { error: clientIdError, id: null, failure: "rejected" as const }

  const result = await getAuthContext()
  if (result.error !== null) return { error: result.error, id: null, failure: "rejected" as const }
  const { supabase, userId, householdId } = result.context

  // B-03: 楽観 append 用に作成ログの id を返す。
  return insertBabyLog(
    supabase,
    householdId,
    userId,
    {
      log_type: "temperature",
      temperature: input.temperature,
      ...(input.loggedAt != null && { logged_at: input.loggedAt }),
      memo: input.memo || null,
    },
    input.clientId,
    "体温の記録",
  )
}

export async function recordGrowth(input: RecordGrowthInput) {
  const memoError = validateMemoLength(input.memo)
  if (memoError) return { error: memoError, id: null, failure: "rejected" as const }
  const timeError = validateCreateLoggedAt(input.loggedAt)
  if (timeError) return { error: timeError, id: null, failure: "rejected" as const }
  const clientIdError = validateClientId(input.clientId)
  if (clientIdError) return { error: clientIdError, id: null, failure: "rejected" as const }

  const result = await getAuthContext()
  if (result.error !== null) return { error: result.error, id: null, failure: "rejected" as const }
  const { supabase, userId, householdId } = result.context

  // B-03: 楽観 append 用に作成ログの id を返す。
  return insertBabyLog(
    supabase,
    householdId,
    userId,
    {
      log_type: "growth",
      weight_g: input.weightG ?? null,
      height_cm: input.heightCm ?? null,
      ...(input.loggedAt != null && { logged_at: input.loggedAt }),
      memo: input.memo || null,
    },
    input.clientId,
    "成長記録",
  )
}

export async function recordMemo(input: RecordMemoInput) {
  if (!input.memo) return { error: "メモを入力してください", id: null, failure: "rejected" as const }
  const memoError = validateMemoLength(input.memo)
  if (memoError) return { error: memoError, id: null, failure: "rejected" as const }
  const timeError = validateCreateLoggedAt(input.loggedAt)
  if (timeError) return { error: timeError, id: null, failure: "rejected" as const }
  const clientIdError = validateClientId(input.clientId)
  if (clientIdError) return { error: clientIdError, id: null, failure: "rejected" as const }

  const result = await getAuthContext()
  if (result.error !== null) return { error: result.error, id: null, failure: "rejected" as const }
  const { supabase, userId, householdId } = result.context

  // B-03: 楽観 append 用に作成ログの id を返す。
  return insertBabyLog(
    supabase,
    householdId,
    userId,
    {
      log_type: "memo",
      ...(input.loggedAt != null && { logged_at: input.loggedAt }),
      memo: input.memo,
    },
    input.clientId,
    "メモの記録",
  )
}

const LOOKUP_ERROR = "記録を確かめられませんでした。通信状況を確認してもう一度お試しください。"

/**
 * 応答不明の保存（`@/lib/domain/save-attempt` の unknown）が DB に在るかを確かめる**読みだけ**の
 * Action。利用者の「記録されたか確かめる」と、再読込・復帰の照合に使う。送り直しはせぬ。
 *
 * 世帯は引数で受けず getAuthContext の世帯で絞る（RLS と二重。別世帯の id は見つからぬのと
 * 同じ応答 = 存在を漏らさぬ）。見つからぬことは「保存されなかった」の断定ではない — 応答の
 * 失われた要求がまだ処理中でありうるゆえ、呼び出し側は同じ内容の送り直し（冪等）を勧める。
 *
 * ⚠️ Server Action は直列に送られる。応答の返らぬ記録の後ろでは待たされるゆえ、送信が終わらぬ
 * 間の照合は GET /api/baby-logs/lookup（期限・取消しつき）を使うこと（`@/lib/domain/baby-log-lookup`）。
 */
export async function findBabyLogsByIds(
  ids: string[],
): Promise<{ error: string; logs: null } | { error: null; logs: BabyLogData[] }> {
  const parsed = parseLookupIds(ids)
  if (!parsed) return { error: CLIENT_ID_ERROR, logs: null }
  const result = await getAuthContext()
  if (result.error !== null) return { error: result.error, logs: null }
  const { supabase, householdId } = result.context

  const { logs, error } = await selectBabyLogsByIds(supabase, householdId, parsed)
  if (error) {
    logSupabaseError("baby", "保存の照合（id の読み）に失敗", error, {
      householdId,
      count: parsed.length,
    })
    return { error: LOOKUP_ERROR, logs: null }
  }
  return { error: null, logs }
}

export async function updateLog(
  logId: string,
  updates: {
    loggedAt?: string
    feedingType?: FeedingType
    amountMl?: number | null
    /**
     * 授乳時間（秒精度）。duration_min は record 系と同じく round(sec/60) で
     * サーバ側導出し両列を1経路で書く（旧 durationMin 単独更新は sec との
     * drift を生むため廃止）。null は「時間なしの授乳」= 両列 null。
     */
    durationSec?: number | null
    /**
     * 母乳サイクルの左右別授乳時間（秒）。指定時は両方必須（各 0..10800・合計 >= 1）
     * かつ feedingType='breast' 必須で、**durationSec は同時指定不可** —
     * duration_sec/min はサーバが左右の和から導出する（chk_breast_side_sec_total の
     * 等式・二重真値源の禁止）。sides を持つ既存行への durationSec 単独編集は
     * fail-loud で拒否される（無音で sides を捨てない）。feedingType を 'breast'
     * 以外へ変更すると counts と同様に常に null で上書きされる。
     */
    breastLeftSec?: number | null
    breastRightSec?: number | null
    /**
     * 母乳サイクル（feedingType: 'breast'）の左右吸わせ回数。feedingType が
     * 'breast' の時のみ必須（recordFeeding と同じ検証）。feedingType を
     * 'breast' 以外へ変更する時は無視され、常に null で上書きされる
     * （chk_breast_counts_only_breast のミラー。amount_ml の null 化と同じ規約）。
     *
     * ⚠️ counts は feedingType と**対でしか反映されない**: feedingType 未指定で
     * counts だけ送っても検証も書き込みもされない（編集シートは feeding 編集時に
     * 必ず feedingType を送る前提。「回数だけ直す」導線を足すならこの契約を先に直せ）。
     */
    breastLeftCount?: number | null
    breastRightCount?: number | null
    /**
     * 母乳サイクルの開始側。**feedingType と対でしか受け付けない**（単独送信は
     * fail-loud で拒否）。feedingType='breast' なら指定値（null = 不明へ戻す）を
     * 書き、'breast' 以外へ変更する時は counts / sides と同じく常に null で上書き
     * する（chk_breast_start_side_only_breast のミラー）。feedingType='breast' で
     * 未指定なら既存値に触れない（送り忘れで開始側を消さない）。
     */
    breastStartSide?: BreastStartSide | null
    diaperType?: DiaperType
    /**
     * うんちの量。**diaperType と対でしか受け付けない**（単独送信は fail-loud で
     * 拒否）。diaperType が poop / both なら指定値（null = 量なしへ戻す）を書き、
     * pee へ変更する時は常に null で上書きする（chk_poop_amount_only_poop のミラー
     * — 量を残したまま pee にすると DB CHECK 違反で更新が落ちる）。poop / both で
     * 未指定なら既存値に触れない。
     */
    poopAmount?: PoopAmount | null
    temperature?: number | null
    weightG?: number | null
    heightCm?: number | null
    memo?: string | null
  },
  /**
   * 編集を始めた時点の行の版（`updated_at` の表記のまま。`new Date()` を通すとマイクロ秒が
   * 落ちて常に衝突する）。サーバはこの版を条件にした 1 本の UPDATE で書き、版が進んで
   * おれば 0 行 = 衝突として返す（P2-07: 家族が先に保存した記録を古い画面から無言で
   * 上書きせぬ。日記 P1-06・予定と同じ楽観的排他。版は trg_baby_logs_updated_at が
   * UPDATE ごとに進める）。
   */
  expectedUpdatedAt: string,
  // 成功時は更新後の行（サーバ真値）を返す。呼び出し側はこれで画面を即時に書き換える —
  // Realtime UPDATE の到達だけに頼ると、不達の間「更新しました」と出るのに旧値のまま
  // 残る（作成・削除が B-03 で楽観反映へ移った後も、編集だけが取り残されておった）。
  // log が optional なのは、行を返さぬ旧形の応答でも呼び出し側が壊れぬようにするため。
  // 衝突時は `conflict.current` に最新の行（他端末で削除済み・別世帯なら null）を返す。
): Promise<
  | { error: string; log?: undefined; conflict?: { current: BabyLogData | null } }
  | { error: null; log?: BabyLogData; conflict?: undefined }
> {
  const memoError = validateMemoLength(updates.memo)
  if (memoError) return { error: memoError }

  // うんちの量は種類と対（無音 no-op を作らず fail-loud）。
  if (updates.poopAmount !== undefined) {
    if (updates.diaperType === undefined) {
      return { error: POOP_AMOUNT_WITHOUT_TYPE_ERROR }
    }
    if (updates.poopAmount !== null) {
      if (!isPoopAmount(updates.poopAmount)) return { error: POOP_AMOUNT_ERROR }
      if (!allowsPoopAmount(updates.diaperType)) {
        return { error: POOP_AMOUNT_TYPE_ERROR }
      }
    }
  }

  // 開始側は授乳の種類と対（同上）。
  if (updates.breastStartSide !== undefined) {
    if (updates.feedingType === undefined) {
      return { error: BREAST_START_SIDE_WITHOUT_TYPE_ERROR }
    }
    if (updates.breastStartSide !== null) {
      if (!isBreastStartSide(updates.breastStartSide)) {
        return { error: BREAST_START_SIDE_ERROR }
      }
      if (updates.feedingType !== "breast") {
        return { error: BREAST_START_SIDE_TYPE_ERROR }
      }
    }
  }

  // 授乳時間の範囲検証（DB CHECK chk_duration_sec と同じ 1..10800 秒 + 整数のみ）。
  // null は「時間なしへ戻す」で妥当。クライアント parse（parseFeedingDurationInput）
  // との二重防御としてサーバでも弾く。
  if (updates.durationSec !== undefined && updates.durationSec !== null) {
    const sec = updates.durationSec
    if (
      !Number.isInteger(sec) ||
      sec < FEEDING_DURATION_SEC_MIN ||
      sec > FEEDING_DURATION_SEC_MAX
    ) {
      return { error: "授乳時間は1秒〜180分の範囲で指定してください" }
    }
  }

  // breast_left_count / breast_right_count の検証（DB CHECK chk_breast_counts_required
  // のミラー）。feedingType='breast' への変更時のみ必須。'breast' 以外への変更時は
  // payload 側で強制 null 化するためここでは検証しない（クライアントの送り忘れ/
  // 消し忘れをエラーにせず、常に null で DB CHECK 違反を防ぐ）。
  if (updates.feedingType === "breast") {
    const countsError = validateBreastCounts(
      updates.breastLeftCount,
      updates.breastRightCount,
    )
    if (countsError) return { error: countsError }
  }

  // 左右別の授乳時間（sides）。counts と違い、誤経路を無音 no-op にせず fail-loud にする。
  const sidesPresent =
    updates.breastLeftSec !== undefined || updates.breastRightSec !== undefined
  if (sidesPresent) {
    if (updates.feedingType !== "breast") {
      return { error: BREAST_SIDES_TYPE_ERROR }
    }
    if (updates.durationSec !== undefined) {
      return { error: BREAST_SIDES_WITH_TOTAL_ERROR }
    }
    const sidesError = validateBreastSideSeconds(
      updates.breastLeftSec,
      updates.breastRightSec,
    )
    if (sidesError) return { error: sidesError }
  }

  // 未来時刻の拒否（+5 分の時計ずれ許容）。auth 前に純関数で弾く（memoError と同順）。
  // クライアント検証と同一の validateLogTime を共有し判定を一致させる。
  if (updates.loggedAt !== undefined) {
    const timeError = validateLogTime(updates.loggedAt)
    if (timeError) return { error: timeError }
  }

  // 版を送らぬ呼び出し（デプロイを跨いだ古い PWA バンドル等）を無条件の上書きへ倒さない。
  // undefined も null も不正な表記もここで止める（ログの編集に「行が無い」版は無い）。
  if (!isTimestamptzText(expectedUpdatedAt)) {
    return { error: STALE_SCREEN_SAVE_ERROR }
  }

  const result = await getAuthContext()
  if (result.error !== null) return { error: result.error }
  const { supabase, householdId } = result.context

  // 既存行を読む必要があるのは durationSec 単独編集（sides なし）のときのみ —
  // 既存行が sides を持つなら fail-loud で拒否する（合計だけ書き換えると
  // chk_breast_side_sec_total の等式違反で生の Postgres エラーになるか、
  // 無音で sides を捨てるかの二択になるため、手前で明示的に拒む）。
  // 読んだ後に行が変わっても、下の UPDATE は版で絞るため 0 行（衝突）になる —
  // この先読みは判定材料を得るだけで、書き込みの可否は版の条件が一度に決める。
  const needsExistingRow = updates.durationSec !== undefined && !sidesPresent
  if (needsExistingRow) {
    const { data: existing, error: fetchError } = await supabase
      .from("baby_logs")
      .select("breast_left_sec")
      .eq("id", logId)
      .eq("household_id", householdId)
      .maybeSingle()
    if (fetchError) {
      logSupabaseError("baby", "ログ更新前の取得に失敗", fetchError, {
        logId,
        householdId,
      })
      return { error: "ログの更新に失敗しました。" }
    }
    if (!existing) {
      return { error: LOG_DELETED_ERROR, conflict: { current: null } }
    }
    if (existing.breast_left_sec != null) {
      return { error: BREAST_SIDES_TOTAL_ONLY_ERROR }
    }
  }

  // 書く列は一度だけ組み、UPDATE と「0 行の時に行が送った内容そのものか」の比較で
  // 同じものを使う（別々に組むと、比較だけが古い規約のまま残りうる）。
  const payload: BabyLogUpdate = {
    ...(updates.loggedAt !== undefined && { logged_at: updates.loggedAt }),
    ...(updates.feedingType !== undefined && {
      feeding_type: updates.feedingType,
      // chk_breast_counts_only_breast のミラー: 'breast' 以外へ変更する時は
      // 必ず counts を null 化する（クライアントの送り忘れ/消し忘れで DB CHECK
      // 違反にしない）。'breast' への変更時は上の検証済み値をそのまま書く。
      breast_left_count:
        updates.feedingType === "breast" ? updates.breastLeftCount : null,
      breast_right_count:
        updates.feedingType === "breast" ? updates.breastRightCount : null,
    }),
    // sides / 開始側の null 化は種別変更時のみ（'breast' のまま未指定の編集 —
    // 旧形サイクル行の合計編集など — では列に触れない）
    ...(updates.feedingType !== undefined &&
      updates.feedingType !== "breast" && {
        breast_left_sec: null,
        breast_right_sec: null,
        breast_start_side: null,
      }),
    // 開始側は feedingType='breast' と対で指定された時だけ書く（null = 不明へ戻す）
    ...(updates.breastStartSide !== undefined &&
      updates.feedingType === "breast" && {
        breast_start_side: updates.breastStartSide,
      }),
    // sides 指定時は合計をサーバ導出（validateBreastSideSeconds 通過済み・
    // durationSec の同時指定は上で拒否済み → duration_sec の書込はこの1経路のみ）
    ...(sidesPresent && {
      breast_left_sec: updates.breastLeftSec,
      breast_right_sec: updates.breastRightSec,
      duration_sec: updates.breastLeftSec! + updates.breastRightSec!,
      duration_min: deriveDurationMinFromSec(
        updates.breastLeftSec! + updates.breastRightSec!,
      ),
    }),
    ...(updates.amountMl !== undefined && { amount_ml: updates.amountMl }),
    ...(updates.durationSec !== undefined && {
      duration_sec: updates.durationSec,
      duration_min: deriveDurationMinFromSec(updates.durationSec),
    }),
    ...(updates.diaperType !== undefined && {
      diaper_type: updates.diaperType,
    }),
    // pee へ変更する時は量を必ず null 化する（chk_poop_amount_only_poop のミラー。
    // クライアントの送り忘れ/消し忘れで DB CHECK 違反にしない）
    ...(updates.diaperType !== undefined &&
      !allowsPoopAmount(updates.diaperType) && { poop_amount: null }),
    // poop / both では指定された時だけ書く（null = 量なしへ戻す）
    ...(updates.poopAmount !== undefined &&
      updates.diaperType !== undefined &&
      allowsPoopAmount(updates.diaperType) && {
        poop_amount: updates.poopAmount,
      }),
    ...(updates.temperature !== undefined && {
      temperature: updates.temperature,
    }),
    ...(updates.weightG !== undefined && { weight_g: updates.weightG }),
    ...(updates.heightCm !== undefined && { height_cm: updates.heightCm }),
    ...(updates.memo !== undefined && { memo: updates.memo }),
  }

  // id・世帯・版の三点で絞った 1 本の UPDATE（先に版を読んでから無条件に書く形にせぬ —
  // 読みと書きの間に家族の保存が挟まると、その変更を無言で上書きする）。行ロックの後で
  // 条件を評価し直すため、同時の保存でも版の合う側の 1 本だけが書ける。
  // .update() は 0 行でも error: null を返す（版違い・別世帯・不在 id）。結果は配列で
  // 受け、0 行を「成功」と偽らない（0 行の非 GET に maybeSingle / single を使うと
  // postgrest-js の版で扱いが揺れる — 日記と同じ受け方）。
  // 列は BABY_LOG_COLUMNS 一式 — 返した行で画面を書き換えるため（duration_min の導出や
  // 種別変更に伴う null 化もサーバの結果をそのまま使い、クライアントで再現せぬ）。
  const { data, error } = await supabase
    .from("baby_logs")
    .update(payload)
    .eq("id", logId)
    .eq("household_id", householdId)
    .eq("updated_at", expectedUpdatedAt)
    .select(BABY_LOG_COLUMNS)

  if (error) {
    logSupabaseError("baby", "ログの更新に失敗", error, { logId, householdId })
    return { error: "ログの更新に失敗しました。" }
  }
  const saved = data?.[0]
  if (saved) {
    revalidatePath("/baby")
    return { error: null, log: saved as BabyLogData }
  }

  // 0 行: 版が進んでおる（家族・自分の別端末が先に保存）か、行が無い（削除済み・別世帯）。
  // 読み直して確かめる。読み直しまで失敗したら衝突とも削除とも断定せぬ。
  const { data: current, error: readError } = await supabase
    .from("baby_logs")
    .select(BABY_LOG_COLUMNS)
    .eq("id", logId)
    .eq("household_id", householdId)
    .maybeSingle()
  if (readError) {
    logSupabaseError("baby", "log conflict re-read failed", readError, {
      logId,
      householdId,
    })
    return {
      error: "記録を更新できたか確かめられませんでした。画面を更新して記録を確かめてください。",
    }
  }
  // 別世帯の行も RLS と世帯の絞り込みで見えぬゆえ、削除済みと同じ応答になる（他の世帯の
  // 記録の存在を漏らさぬ）。
  if (!current) {
    return { error: LOG_DELETED_ERROR, conflict: { current: null } }
  }
  // 応答だけが失われた保存の再試行は、版が進んでおるゆえ 0 行になるが、行は今送った内容
  // そのものじゃ。それは衝突ではなく既に成立した保存ゆえ、成功として返す（冪等。日記と
  // 同じ扱い）。送っていない列は比べぬ — その後の家族の変更（時刻など）は残したまま返す。
  if (sameRecordedContent(current as Record<string, unknown>, payload)) {
    revalidatePath("/baby")
    return { error: null, log: current as BabyLogData }
  }
  // 書いた人は断定しない（応答が失われた自分の保存・同じ利用者の別端末も同じ形になる）。
  return {
    error: "この記録は別の端末で先に更新されていました（家族またはご自身）。",
    conflict: { current: current as BabyLogData },
  }
}

const LOG_DELETE_ERROR = "ログの削除に失敗しました。"

export async function deleteLog(
  logId: string,
  /**
   * 削除を選んだ画面が見ていた行の版（`updated_at` の表記のまま）。編集シートは開いた時点の
   * 版、記録直後の「取り消す」は作成に成功した時にサーバが返した版を送る。サーバはこの版を
   * 条件にした 1 本の DELETE で消し、版が進んでおれば 0 行 = 衝突として返す（家族が先に
   * 直した記録を、古い画面から編集ごと消させぬ。updateLog と同じ楽観的排他）。
   */
  expectedUpdatedAt: string,
  // 0 行は読み直して分ける: 行が無い（削除済み・別世帯）→ alreadyDeleted（呼び出し側は
  // 画面の幽霊行を外す）、版が進んでおる → conflict.current に最新の行（外さず見せる）、
  // 読み直しまで失敗 → どちらも付けぬ（行を外させぬ）。
): Promise<
  | { error: null; alreadyDeleted?: undefined; conflict?: undefined }
  | { error: string; alreadyDeleted: true; conflict?: undefined }
  | { error: string; alreadyDeleted?: undefined; conflict: { current: BabyLogData } }
  | { error: string; alreadyDeleted?: undefined; conflict?: undefined }
> {
  // 版を送らぬ呼び出し（デプロイを跨いだ古い PWA バンドル等）を無条件の削除へ倒さない。
  // undefined も null も不正な表記もここで止める（記録の削除に「行が無い」版は無い）。
  if (!isTimestamptzText(expectedUpdatedAt)) {
    return { error: STALE_SCREEN_SAVE_ERROR }
  }

  const result = await getAuthContext()
  if (result.error !== null) return { error: result.error }
  const { supabase, householdId } = result.context

  // id・世帯・版の三点で絞った 1 本の DELETE（先に版を読んでから無条件に消す形にせぬ —
  // 読みと削除の間に家族の保存が挟まると、その変更ごと消す）。行ロックの後で条件を評価し
  // 直すため、同時の保存と削除でも版の合う側だけが通る。
  // .delete() は 0 行でも error: null を返す（版違い・別世帯・不在 id）。.select("id") で
  // 削除行を要求し、0 行を「成功」と偽らないようにする。
  const { data, error } = await supabase
    .from("baby_logs")
    .delete()
    .eq("id", logId)
    .eq("household_id", householdId)
    .eq("updated_at", expectedUpdatedAt)
    .select("id")

  if (error) {
    logSupabaseError("baby", "ログの削除に失敗", error, { logId, householdId })
    return { error: LOG_DELETE_ERROR }
  }
  if (data && data.length > 0) {
    revalidatePath("/baby")
    return { error: null }
  }

  // 0 行: 行が無い（削除済み・別世帯）か、版が進んでおる（家族・自分の別端末が先に保存）。
  // 読み直して確かめる。読み直しまで失敗したら、削除済みとも衝突とも断定せぬ。
  const { data: current, error: readError } = await supabase
    .from("baby_logs")
    .select(BABY_LOG_COLUMNS)
    .eq("id", logId)
    .eq("household_id", householdId)
    .maybeSingle()
  if (readError) {
    logSupabaseError("baby", "log delete re-read failed", readError, {
      logId,
      householdId,
    })
    return {
      error: "記録を削除できませんでした（最新の状態を確かめられませんでした）。画面を更新して記録を確かめてください。",
    }
  }
  if (!current) {
    // 成功とは偽らないが、呼び出し側が画面の幽霊行を外せるよう印を付ける
    // （他端末の削除はフィルタ付き Realtime で届かぬため、画面に残ったままの行を
    // 消そうとしてここへ来る。P1-04）。応答を失った自分の削除の再試行も同じ形じゃ。
    // 別世帯の行も RLS と世帯の絞り込みで見えぬゆえ同じ応答になる（存在を漏らさぬ）。
    return { error: "既に削除されています。", alreadyDeleted: true }
  }
  if (current.updated_at === expectedUpdatedAt) {
    // 版は合うのに消えなんだ: 他端末の更新ではなく削除そのものが拒まれた形。
    // 「先に更新されていた」とは偽らぬ（利用者は存在しない変更を探すことになる）。
    console.error("[baby] ログの削除が 0 行（版は一致）", { logId, householdId })
    return { error: LOG_DELETE_ERROR }
  }
  // 書いた人は断定しない（自分の別端末・記録直後の自分の編集も同じ形になる）。
  return {
    error:
      "この記録は別の端末で先に更新されていたため、削除しませんでした（家族またはご自身）。",
    conflict: { current: current as BabyLogData },
  }
}

// ---------------------------------------------------------------------------
// 育児日記（baby_diaries: 1世帯・1日1本のテキスト。ぴよログ流）
// ---------------------------------------------------------------------------

const MAX_DIARY_LENGTH = 5000
const DIARY_DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const BABY_DIARY_COLUMNS = "id, diary_date, content, updated_at"
const DIARY_SAVE_ERROR = "日記の保存に失敗しました。もう一度お試しください。"
const DIARY_DELETE_ERROR = "日記の削除に失敗しました。もう一度お試しください。"

/**
 * 期待版は null（＝行が無いことを期待）か、updated_at の表記の文字列だけを受ける。
 * 表記は形だけ確かめて文字列のまま `.eq()` へ渡す（`new Date()` を通すとマイクロ秒が
 * 落ち、以後の保存がすべて衝突する）。形の検査は予定の版・検索 cursor と共有する。
 */
function isDiaryVersion(value: unknown): value is string | null {
  return value === null || isTimestamptzText(value)
}

/**
 * その日の育児日記を保存する（1日1本）。`updated_at` を版とする楽観的排他（P1-06）。
 *
 * `expectedUpdatedAt` は編集を始めた時点で見ていた版（行が無ければ null）。
 * - null: INSERT … ON CONFLICT DO NOTHING。既に行が在れば衝突（取得失敗で空欄に
 *   見えていた日記を、空欄からの一言で置き換える経路を塞ぐ）。
 * - 版あり: `updated_at = 期待版` を条件に UPDATE。0 行なら衝突（配偶者が先に保存
 *   した本文を無言で上書きしない。トリガ trg_baby_diaries_updated_at が UPDATE ごとに
 *   版を進める）。
 * - content の trim 後が空 = その日の日記を消す。版ありなら同じ条件付きの DELETE、
 *   null なら行が無いことの確認だけ（DELETE を発行しない）。行が既に無ければ冪等に成功。
 * 衝突時は最新の行を読み直して `conflict.current` で返す。呼び出し側は下書きを捨てず、
 * 版を current へ進めてから保存し直す（＝意図した上書きになる）。
 *
 * 日付キー（diary_date）ゆえ過去日の日記も作成・編集できる（ぴよログ準拠）。
 * 未来日は拒否（date nav は未来へ進めない前提の二重防御）。
 */
export async function upsertBabyDiary(
  diaryDate: string,
  content: string,
  expectedUpdatedAt: string | null,
): Promise<UpsertBabyDiaryResult> {
  if (!DIARY_DATE_RE.test(diaryDate)) {
    return { error: "日付の形式が不正です", diary: null }
  }
  // YYYY-MM-DD は辞書順 = 暦順
  if (diaryDate > todayJstString()) {
    return { error: "未来の日記は書けません", diary: null }
  }
  const trimmed = content.trim()
  if (trimmed.length > MAX_DIARY_LENGTH) {
    return {
      error: `日記は${MAX_DIARY_LENGTH}文字以内で入力してください`,
      diary: null,
    }
  }
  // 版を送らぬ呼び出し（デプロイを跨いだ古い PWA バンドル等）を無条件の上書きへ
  // 倒さない。undefined も不正な表記もここで止める。
  if (!isDiaryVersion(expectedUpdatedAt)) {
    return {
      error: STALE_SCREEN_SAVE_ERROR,
      diary: null,
    }
  }

  const result = await getAuthContext()
  if (result.error !== null) return { error: result.error, diary: null }
  const { supabase, userId, householdId } = result.context

  // 衝突の確定: 最新の行を読み直して返す。読み直しまで失敗したら conflict を付けない
  // （current: null は「削除済み」の意味ゆえ、読めなかったことと混同させない）。
  const readConflict = async (): Promise<UpsertBabyDiaryResult> => {
    const { data: current, error: readError } = await supabase
      .from("baby_diaries")
      .select(BABY_DIARY_COLUMNS)
      .eq("household_id", householdId)
      .eq("diary_date", diaryDate)
      .maybeSingle()
    if (readError) {
      logSupabaseError("baby", "diary conflict re-read failed", readError, {
        householdId,
        diaryDate,
      })
      return {
        error: "この日の日記は他の端末で更新されています。最新の内容を読み込めませんでした。もう一度お試しください。",
        diary: null,
      }
    }
    // 書いた人は断定しない: 応答が失われた自分の保存や、同じ利用者の別端末の保存も
    // 同じ形で衝突する（読み直しは版を比べるだけで、書き手は見ていない）。
    return {
      error: current
        ? "この日の日記は別の端末で先に保存されていました（家族またはご自身）。"
        : "この日の日記は他の端末で削除されていました。",
      diary: null,
      conflict: { current: current ?? null },
    }
  }

  if (trimmed === "") {
    // 空保存 = その日の日記を削除（DB CHECK も空行を禁じており、空行は残さない）。
    if (expectedUpdatedAt === null) {
      // 「行が無い」と思って空保存した。在れば相手の本文ゆえ消さずに衝突とする。
      const conflict = await readConflict()
      if (conflict.conflict?.current === null) return { error: null, diary: null }
      return conflict
    }
    const { data: deleted, error } = await supabase
      .from("baby_diaries")
      .delete()
      .eq("household_id", householdId)
      .eq("diary_date", diaryDate)
      .eq("updated_at", expectedUpdatedAt)
      .select("id")

    if (error) {
      logSupabaseError("baby", "diary delete failed", error, {
        householdId,
        diaryDate,
      })
      return { error: DIARY_DELETE_ERROR, diary: null }
    }
    if (!deleted || deleted.length === 0) {
      // 版が合わぬ。既に無ければ消したい状態は満たされている（冪等）。
      const conflict = await readConflict()
      if (conflict.conflict?.current === null) return { error: null, diary: null }
      return conflict
    }
    revalidatePath("/baby")
    return { error: null, diary: null }
  }

  // 書き込みの結果は配列で受け 0 行を衝突として検知する（0 行の INSERT/UPDATE に
  // maybeSingle を使うと非 GET での扱いが postgrest-js の版で揺れる）。
  let written: BabyDiaryData[] | null
  if (expectedUpdatedAt === null) {
    const { data, error } = await supabase
      .from("baby_diaries")
      .upsert(
        {
          household_id: householdId,
          diary_date: diaryDate,
          content: trimmed,
          updated_by: userId,
        },
        { onConflict: "household_id,diary_date", ignoreDuplicates: true },
      )
      .select(BABY_DIARY_COLUMNS)
    if (error) {
      logSupabaseError("baby", "diary insert failed", error, {
        householdId,
        diaryDate,
      })
      return { error: DIARY_SAVE_ERROR, diary: null }
    }
    written = data
  } else {
    const { data, error } = await supabase
      .from("baby_diaries")
      .update({ content: trimmed, updated_by: userId })
      .eq("household_id", householdId)
      .eq("diary_date", diaryDate)
      .eq("updated_at", expectedUpdatedAt)
      .select(BABY_DIARY_COLUMNS)
    if (error) {
      logSupabaseError("baby", "diary update failed", error, {
        householdId,
        diaryDate,
      })
      return { error: DIARY_SAVE_ERROR, diary: null }
    }
    written = data
  }

  const saved = written?.[0]
  if (!saved) {
    const conflict = await readConflict()
    // 応答だけが失われた保存の再試行は、版が進んでおるゆえ 0 行になるが、読み直した
    // 本文は今送った本文と同じじゃ。それは衝突ではなく既に成立した保存ゆえ、成功として
    // 返す（冪等。空保存の側が「既に無い」を成功とするのと対称）。相手が偶然同じ本文を
    // 書いた場合も、守るべき本文は同じゆえ失うものは無い。
    const current = conflict.conflict?.current
    if (current && current.content === trimmed) {
      revalidatePath("/baby")
      return { error: null, diary: current }
    }
    return conflict
  }

  revalidatePath("/baby")
  return { error: null, diary: saved }
}

const BOTTLE_DEFAULT_SAVE_ERROR =
  "いつものミルク量を保存できませんでした。もう一度お試しください。"
const BOTTLE_DEFAULT_CONFLICT_ERROR =
  "いつものミルク量は、家族またはご自身の別の端末で先に変更されていました。"

/**
 * いつものミルク量（households.bottle_default_ml）を変える。世帯の誰でも変えられ（RLS の
 * households_update が自世帯の行だけに絞る）、次のクイック記録から効く。過去の記録には触れぬ。
 *
 * 楽観的排他は**値**で取る: 画面が見ていた量（`expectedMl`。未設定なら null）のままの時だけ
 * 書く。古い画面のまま保存して、家族が先に決めた量を黙って上書きせぬため（育児ログ・日記の
 * 版ガードと同じ考え）。量は 1 つの数ゆえ、途中で 120 → 160 → 120 と戻っていても「今 120」
 * なら画面と DB は一致しておる（版でなく値で足りる）。
 *
 * 0 行の時は読み直して分ける:
 * - 今の量が送った量と同じ → 応答だけ失った保存の再試行（または偶然の同値）ゆえ成功
 * - 違う量 → 衝突。今の量を返し、上書きはせぬ
 * - 行が読めぬ → 失敗（世帯の行は必ず在る。見えぬのは判定不能）
 *
 * 世帯は引数で受けず、getAuthContext の利用者の世帯だけを書く。
 */
export async function updateBottleDefault(input: {
  amountMl: number
  expectedMl: number | null
}): Promise<UpdateBottleDefaultResult> {
  // Server Action は直接 POST でも呼べる外部入力。型・範囲・null を DB に届く前に確かめる
  if (typeof input !== "object" || input === null) {
    return { ok: false, error: BOTTLE_DEFAULT_RANGE_ERROR }
  }
  const { amountMl, expectedMl } = input
  if (!isBottleDefaultMl(amountMl)) {
    return { ok: false, error: BOTTLE_DEFAULT_RANGE_ERROR }
  }
  // 見ていた量を送らぬ・形の合わぬ保存（古いバンドル等）は、無条件の上書きへ倒さず止める
  if (expectedMl !== null && !isBottleDefaultMl(expectedMl)) {
    return { ok: false, error: STALE_SCREEN_SAVE_ERROR }
  }

  const auth = await getAuthContext()
  if (auth.error !== null) return { ok: false, error: auth.error }
  const { supabase, userId, householdId } = auth.context
  const logContext = { userId, householdId }

  const update = supabase
    .from("households")
    .update({ bottle_default_ml: amountMl })
    .eq("id", householdId)
  // 未設定（NULL）との比較は `.is(null)`。`.eq(col, null)` は `= NULL` となり決して一致せぬ
  const guarded =
    expectedMl === null
      ? update.is("bottle_default_ml", null)
      : update.eq("bottle_default_ml", expectedMl)
  const { data, error } = await guarded.select("bottle_default_ml")

  if (error) {
    logSupabaseError("baby", "bottle default update failed", error, logContext)
    // 23514 = CHECK 違反（chk_bottle_default_ml）。上の検証と同じ範囲ゆえ通常は届かぬ
    if (error.code === "23514") return { ok: false, error: BOTTLE_DEFAULT_RANGE_ERROR }
    return { ok: false, error: BOTTLE_DEFAULT_SAVE_ERROR }
  }
  if (data && data.length > 0) {
    // 訪問済みの /baby の RSC payload を捨てさせる。捨てぬと「戻る」で古い量（initialBottleDefault）が
    // 取り直しの届くまで釦に出て、その間のタップが自分で変えたばかりの量と違う量で記録される
    revalidatePath("/baby")
    return { ok: true, amountMl }
  }

  const { data: row, error: readError } = await supabase
    .from("households")
    .select("bottle_default_ml")
    .eq("id", householdId)
    .maybeSingle()
  if (readError) {
    logSupabaseError("baby", "bottle default re-read failed", readError, logContext)
    return { ok: false, error: BOTTLE_DEFAULT_SAVE_ERROR }
  }
  const current = decodeBottleDefault({ data: row, error: null })
  if (current.status === "error") {
    console.error("[baby] bottle default re-read: 世帯の行が読めぬ", logContext)
    return { ok: false, error: BOTTLE_DEFAULT_SAVE_ERROR }
  }
  const currentMl = current.status === "set" ? current.amountMl : null
  if (currentMl === amountMl) {
    console.info("[baby] bottle default: 既に同じ量（再試行を成功として受理）", logContext)
    revalidatePath("/baby")
    return { ok: true, amountMl }
  }
  return {
    ok: false,
    error: BOTTLE_DEFAULT_CONFLICT_ERROR,
    conflict: { currentMl },
  }
}
