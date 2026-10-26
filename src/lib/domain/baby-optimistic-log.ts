import { deriveDurationMinFromSec } from "./feeding"
import type { BabyLogData } from "@/lib/types/baby"
import type {
  BabyLogType,
  FeedingType,
  DiaperType,
  PoopAmount,
  BreastStartSide,
} from "@/lib/types/database"

/**
 * B-03: 記録系 Server Action の成功時に、返却された id を使ってクライアント側で
 * 楽観 append 用の `BabyLogData` を組み立てる純関数。
 *
 * revalidatePath の RSC 更新は `useState(initialLogs)` シードに破棄され、記録の即時
 * 反映は実質 Realtime 単一経路だった。#92（本番 Realtime 不達）下でも timeline/回数を
 * 即時更新し、feeding/diaper の再タップ二重記録を止血するため、Server Action が返す
 * DB の実 id でこの行を作り setLogs へ前置きする（既存 Realtime echo は id 重複スキップで吸収）。
 *
 * ⚠️ `loggedAt` は DB に書かれた値と**同じ値**を渡すこと。記録シート・タイマーは送った
 * loggedAt を、loggedAt を送らぬクイック記録はサーバが返す記録時刻（DB の now()）を渡す。
 * 端末時計で補うと、分を跨いだ時に画面と DB の HH:mm が食い違い、編集シートが違う時刻で
 * seed され、保存の後に表示が DB の時刻へ飛ぶ（2026-10-25 のミルクの報告）。Realtime の
 * INSERT echo と appendLog は同じ id の行を捨てるゆえ、食い違いは再取得まで直らぬ。
 * どの日の窓へ入れるかは親（appendLog）が行の日付で決める。
 *
 * 注: `household_id` は `BabyLogData` に含まれない（RLS でサーバ側が担保）。
 * `created_at` は呼び出し時刻で埋める（表示にも編集にも使わぬ）。
 */
export interface BuildOptimisticLogParams {
  id: string
  /**
   * 作成で書けた行の版（Server Action が返す `updatedAt` = DB の `updated_at`）。**省略不可** —
   * 楽観行が版を持たねば、Realtime の echo（同じ id の行は捨てる）や再取得が届くまで、
   * 作成直後の編集が版を送れず保存できぬ（P2-07 の版ガード）。応答に版が無い時だけ
   * null を渡す（行は出す — 出さねば記録が見えず再タップの二重記録を招く。その行の
   * 編集はサーバが「画面が古い」で止め、無条件の上書きにはならぬ）。
   */
  updatedAt: string | null
  logType: BabyLogType
  loggedBy: string
  /**
   * DB に書かれた記録時刻（上の ⚠️）。省略時は呼び出し時刻で補うが、それは古いサーバの応答に
   * 記録時刻が無い時の退避に限る。
   */
  loggedAt?: string
  feedingType?: FeedingType | null
  amountMl?: number | null
  /**
   * 母乳サイクルで左を吸わせた回数（feedingType='breast' の時のみ渡す）。
   * 片側 0 は falsy だが `??` で拾うため 0 が null に化けない
   * （null に化けると DB の chk_breast_counts_required に弾かれ乖離する）。
   */
  breastLeftCount?: number | null
  /** 母乳サイクルで右を吸わせた回数（同上） */
  breastRightCount?: number | null
  /**
   * 母乳サイクルの左右別秒数（両方渡すか両方省略 — DB CHECK chk_breast_side_sec_pair
   * のミラー）。0 は有効値ゆえ `??` で拾い null に化けさせない。
   */
  breastLeftSec?: number | null
  breastRightSec?: number | null
  /** 母乳サイクルの開始側（feedingType='breast' の時のみ渡す。不明なら省略 = null） */
  breastStartSide?: BreastStartSide | null
  diaperType?: DiaperType | null
  /** うんちの量（diaperType が poop / both の時のみ渡す。量なしなら省略 = null） */
  poopAmount?: PoopAmount | null
  temperature?: number | null
  weightG?: number | null
  heightCm?: number | null
  /** 授乳時間（秒精度）。duration_min は round(sec/60) で導出し併記する */
  durationSec?: number | null
  memo?: string | null
}

export function buildOptimisticLog(
  params: BuildOptimisticLogParams,
): BabyLogData {
  const now = new Date().toISOString()
  return {
    id: params.id,
    log_type: params.logType,
    logged_at: params.loggedAt ?? now,
    logged_by: params.loggedBy,
    feeding_type: params.feedingType ?? null,
    amount_ml: params.amountMl ?? null,
    breast_left_count: params.breastLeftCount ?? null,
    breast_right_count: params.breastRightCount ?? null,
    breast_left_sec: params.breastLeftSec ?? null,
    breast_right_sec: params.breastRightSec ?? null,
    breast_start_side: params.breastStartSide ?? null,
    diaper_type: params.diaperType ?? null,
    poop_amount: params.poopAmount ?? null,
    temperature: params.temperature ?? null,
    weight_g: params.weightG ?? null,
    height_cm: params.heightCm ?? null,
    duration_sec: params.durationSec ?? null,
    // サーバの recordFeeding と同じ導出を共有し、楽観 append と DB 実体を一致させる
    duration_min: deriveDurationMinFromSec(params.durationSec),
    memo: params.memo ?? null,
    created_at: now,
    updated_at: params.updatedAt,
  }
}
