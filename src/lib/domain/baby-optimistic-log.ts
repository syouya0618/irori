import { deriveDurationMinFromSec } from "./feeding"
import type { BabyLogData } from "@/lib/types/baby"
import type { BabyLogType, FeedingType, DiaperType } from "@/lib/types/database"

/**
 * B-03: 記録系 Server Action の成功時に、返却された id を使ってクライアント側で
 * 楽観 append 用の `BabyLogData` を組み立てる純関数。
 *
 * revalidatePath の RSC 更新は `useState(initialLogs)` シードに破棄され、記録の即時
 * 反映は実質 Realtime 単一経路だった。#92（本番 Realtime 不達）下でも timeline/回数を
 * 即時更新し、feeding/diaper の再タップ二重記録を止血するため、Server Action が返す
 * DB の実 id でこの行を作り setLogs へ前置きする（既存 Realtime echo は id 重複スキップで吸収）。
 *
 * ⚠️ この楽観 append が正しいのは、記録導線（quick actions / それが開く form-sheet /
 * feeding-timer）が全て isToday ゲート（baby-dashboard.tsx の `isToday && <BabyQuickActions>`）
 * 下にあり、`loggedAt` の既定が client now = 当日ゆえ選択日窓と一致するからこそ。
 * F-03（過去日クイック記録の解禁）採択時は、日付不一致行が timeline に混入するため
 * 本設計の再検討が必須（計画書 §3 B-03 の安全前提）。
 *
 * 注: `household_id` は `BabyLogData` に含まれない（RLS でサーバ側が担保）。
 * `logged_at` / `created_at` は DB now() と数秒ズレうるが、Realtime echo または
 * リロード時のサーバ値で上書きされ収束する。
 */
export interface BuildOptimisticLogParams {
  id: string
  logType: BabyLogType
  loggedBy: string
  /** 既定は呼び出し時刻（当日）。編集シート等で明示したい場合のみ渡す。 */
  loggedAt?: string
  feedingType?: FeedingType | null
  amountMl?: number | null
  diaperType?: DiaperType | null
  endedAt?: string | null
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
    diaper_type: params.diaperType ?? null,
    ended_at: params.endedAt ?? null,
    temperature: params.temperature ?? null,
    weight_g: params.weightG ?? null,
    height_cm: params.heightCm ?? null,
    duration_sec: params.durationSec ?? null,
    // サーバの recordFeeding と同じ導出を共有し、楽観 append と DB 実体を一致させる
    duration_min: deriveDurationMinFromSec(params.durationSec),
    memo: params.memo ?? null,
    created_at: now,
  }
}
