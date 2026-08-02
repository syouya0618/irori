/**
 * Realtime 購読の可観測化ヘルパ (#92 診断)。
 *
 * `channel.subscribe()` を callback 無しで呼ぶと realtime-js は
 * CHANNEL_ERROR / TIMED_OUT / CLOSED を全て握り潰す (RealtimeChannel は
 * いずれも `callback?.(...)`)。これは CLAUDE.md「エラー握り潰し禁止」に
 * 抵触し、#92 (本番で postgres_changes 配信が届かない) の切り分けを
 * 不能にしていた。全 postgres_changes 購読に本ヘルパを配線して可観測化する。
 *
 * 判定の指針:
 * - `SUBSCRIBED` … ジョイン成功。
 * - `CLOSED`     … セッション途中の socket 死。「無操作で更新されず・
 *   リロードで直る」症状の最有力候補 (join 後 WS が静かに切れる) を確定させる。
 * - `CHANNEL_ERROR` / `TIMED_OUT` … 購読層の失敗。
 * さらに [logRealtimeEvent] のイベント entry ログが出るのに UI が古ければ
 * state/refetch 経路、一度も出なければ受信/dispatch 層、と切り分けられる。
 *
 * ⚠️ このファイルは境界指令（`"use client"`）を持たぬ中立モジュールのまま保つこと。
 * 指令を付けるとクライアント境界になり、Server Component から値 import された
 * 瞬間に client reference へ差し替わって実行時に壊れる（`next build` も `tsc` も
 * 通るため潜伏する既知の罠）。現に import 元はすべて `"use client"` ゆえ、
 * 中立のままでクライアントバンドルへ入る。
 */

import { reportRealtimeAnomaly } from "./realtime-anomaly-action"

/**
 * サーバへ報告する異常 status。正常な `SUBSCRIBED` を含めてはならぬ
 * （常時ログが流れて異常が埋もれる）。Server Action 側にも同じ集合の
 * 検証があり、こちらはネットワーク往復を発生させぬための一次フィルタじゃ。
 */
const REPORTABLE_STATUSES = new Set(["CLOSED", "CHANNEL_ERROR", "TIMED_OUT"])

/**
 * 「1 セッション 1 回」のゲート。モジュールスコープのため、タブを開いている間
 * （= 1 セッション）は最初の異常 1 件だけがサーバへ届く。
 * 再接続のフラップで同じ異常が数十回飛ぶのを防ぐ。
 */
let anomalyReported = false

/** 購読ステータスの構造化ログ。`subscribe((status, err) => ...)` から呼ぶ。 */
export function logRealtimeStatus(
  channel: string,
  status: string,
  err?: Error,
): void {
  const payload = {
    channel,
    status,
    at: new Date().toISOString(),
    error: err?.message,
  }
  if (status === "SUBSCRIBED") {
    console.info(`[realtime] ${channel} subscribed`, payload)
  } else if (status === "CLOSED") {
    console.warn(`[realtime] ${channel} closed`, payload)
  } else {
    console.error(`[realtime] ${channel} subscription error`, payload)
  }

  reportAnomalyOnce(channel, status, err)
}

/**
 * 異常をサーバへ 1 回だけ投げる。**本来の機能（購読とログ）を絶対に壊さぬ**こと
 * が最優先ゆえ、次の三重で守る:
 *   1. 送信前にゲートを立てる — 同期 throw しても再送ループにならぬ
 *   2. `try/catch` — action 参照の解決失敗など同期例外を握る
 *   3. `.catch()` — 圏外・500 等の非同期 reject を握る（`void fn()` の裸置きは
 *      unhandled rejection になるため禁止。先行 PR で潰した形じゃ）
 * どの経路でも呼び出し元へは例外を漏らさない。
 */
function reportAnomalyOnce(channel: string, status: string, err?: Error): void {
  if (anomalyReported) return
  if (!REPORTABLE_STATUSES.has(status)) return

  // 送信を試みる前に立てる（失敗しても再試行しない ＝ 1 セッション 1 回を厳守）。
  anomalyReported = true

  try {
    reportRealtimeAnomaly(channel, status, err?.message).catch(
      (reportErr: unknown) => {
        // 報告の失敗自体は本来の機能に無関係。握り潰さずローカルにだけ残す。
        console.warn(`[realtime] ${channel} anomaly report failed`, {
          channel,
          status,
          message:
            reportErr instanceof Error ? reportErr.message : String(reportErr),
        })
      },
    )
  } catch (reportErr) {
    console.warn(`[realtime] ${channel} anomaly report threw`, {
      channel,
      status,
      message:
        reportErr instanceof Error ? reportErr.message : String(reportErr),
    })
  }
}

/**
 * postgres_changes ハンドラ発火の entry ログ。row 本体 (PII) は出さず
 * table / eventType のみ記録する。ハンドラが発火しているか (＝フレームが
 * 到達しているか) を本番で確認するための信号。
 */
export function logRealtimeEvent(
  channel: string,
  payload: { table?: string; eventType?: string },
): void {
  console.info(`[realtime] ${channel} event`, {
    channel,
    table: payload.table,
    eventType: payload.eventType,
  })
}
