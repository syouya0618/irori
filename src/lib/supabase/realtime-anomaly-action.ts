"use server"

import { createClient } from "@/lib/supabase/server"
import { getVerifiedUserId } from "@/lib/supabase/verified-user"

/**
 * Realtime 購読の**異常のみ**をサーバへ届ける Server Action（#92 の診断経路）。
 *
 * ## なぜ要るか
 * Realtime のログを出す 5 ファイルはすべて `"use client"` ゆえ、`console.*` は
 * 利用者のブラウザにしか出ぬ。#92（間欠的に配信が届かない）が半年特定できて
 * おらぬのは、**症状が起きた端末のコンソールを誰も見ていない**という構造的理由じゃ。
 * 異常時だけサーバへ 1 回投げれば、Vercel のランタイムログに痕跡が残り、
 * 「いつ・どの channel が・どの status で落ちたか」を後から追える。
 *
 * ## 意図的に狭くしてある点
 * - **異常 3 種のみ**（`CLOSED` / `CHANNEL_ERROR` / `TIMED_OUT`）。正常な
 *   `SUBSCRIBED` を送るとログが常時流れ、異常が埋もれて「気づく」が壊れる。
 * - **1 セッション 1 回**（呼び出し側 `realtime-log.ts` のゲート）。再接続の
 *   フラップで同じ異常が数十回飛ぶのを防ぐ。
 * - **未認証は黙って捨てる**。Server Action は action id を知る者なら誰でも
 *   POST できるため、認証を課さねば匿名のログ注入口になる（fail-open の既定値）。
 *   ここは記録の口であって認可の判断には使わぬゆえ、落とすのは静かでよい。
 * - アラートは張らぬ。2 名規模では「気づく」より「後から追える」で足りる。
 *
 * 監視 SaaS（Sentry / Datadog / analytics）は導入しない方針じゃ。
 */

/** 受け付ける異常 status。ここに無い値は記録せず捨てる。 */
const ANOMALY_STATUSES = new Set(["CLOSED", "CHANNEL_ERROR", "TIMED_OUT"])

/** ログ 1 行が肥大化して他の行を押し流さぬための上限。 */
const MAX_FIELD_LENGTH = 200

function clamp(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined
  return value.length > MAX_FIELD_LENGTH
    ? `${value.slice(0, MAX_FIELD_LENGTH)}…`
    : value
}

export async function reportRealtimeAnomaly(
  channel: string,
  status: string,
  errorMessage?: string,
): Promise<void> {
  // 異常 3 種以外は記録しない（正常系でログを埋めない）。
  if (!ANOMALY_STATUSES.has(status)) return

  const supabase = await createClient()
  const userId = await getVerifiedUserId(supabase, "realtime-anomaly")
  // 未認証は静かに捨てる。throw せぬのは、呼び出し側の `.catch()` を
  // 「例外の常態」にしないため（catch は本当の異常のためのバックストップ）。
  if (!userId) return

  console.error("[realtime-anomaly] 購読が異常終了しました", {
    channel: clamp(channel),
    status,
    error: clamp(errorMessage),
    userId,
    at: new Date().toISOString(),
  })
}
