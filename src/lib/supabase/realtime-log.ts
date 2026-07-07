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
 */

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
