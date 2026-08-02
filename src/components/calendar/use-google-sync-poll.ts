"use client"

import { useEffect, useRef } from "react"
import { hasSyncAdvanced } from "@/lib/domain/google-sync-signal"

/**
 * V7: Google 同期の完了を **Realtime を使わずに**拾う短命ポーリング。
 *
 * ## なぜ Realtime ではないか（計画書 V7）
 * 1. `google_calendar_subscriptions` は `sync_token` / `sync_lease_until` という
 *    秘密を持つため publication へ載せられぬ（列フィルタに安全性を賭けられぬ）。
 * 2. **削除のみの同期サイクルは `calendar_events` に INSERT/UPDATE を生まぬ**。
 *    ゆえに `calendar_events` の Realtime では Google 側の削除を検知できぬ。
 * 3. #92（Realtime の間欠不達）が未解決ゆえ、クリティカルパスに置かぬ。
 *
 * ## 短命であること
 * `syncScheduled === true`（= サーバが `after()` で同期を予約した）ときだけ、
 * 数回だけ叩いて終わる。前進を捕まえられなくても既存の
 * `useVisibilityRefetch`（タブ復帰で refetch）が後から拾うため、ここは
 * **best-effort で十分**じゃ。回数を無制限にすると開きっぱなしのタブが
 * Server Action を叩き続ける。
 */

/** ポーリング間隔（ms）。同期は数百 ms〜数秒で終わる想定。 */
export const GOOGLE_SYNC_POLL_INTERVAL_MS = 2000
/** 最大試行回数（計画書「1〜3 回」）。 */
export const GOOGLE_SYNC_POLL_ATTEMPTS = 3

export interface UseGoogleSyncPollArgs {
  /** サーバが背景同期を予約したか（`maybeScheduleSync().syncScheduled`）。 */
  enabled: boolean
  /** 予約時点の `last_synced_at`。これより新しくなったら前進と見なす。 */
  baseline: string | null
  /** Server Action。`fetchGoogleSyncSignal` を渡す。 */
  fetchSignal: () => Promise<{ lastSyncedAt: string | null }>
  /** 前進を検知したとき（events を refetch する）。 */
  onAdvanced: () => void
}

export function useGoogleSyncPoll({
  enabled,
  baseline,
  fetchSignal,
  onAdvanced,
}: UseGoogleSyncPollArgs): void {
  // コールバック類は毎レンダー作り直されるため ref に逃がす。
  // 依存に入れるとポーリングが毎レンダー再起動して回数制限が意味を失う。
  const fetchSignalRef = useRef(fetchSignal)
  const onAdvancedRef = useRef(onAdvanced)
  useEffect(() => {
    fetchSignalRef.current = fetchSignal
    onAdvancedRef.current = onAdvanced
  })

  useEffect(() => {
    if (!enabled) return

    // Server Action は `AbortController` を受けぬ（`fetch` ではない）。
    // ゆえに中断は「結果を捨てる」フラグで表す。アンマウント後に
    // onAdvanced を呼ばぬことがこのフラグの役目じゃ。
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const attempt = async (remaining: number): Promise<void> => {
      try {
        const { lastSyncedAt } = await fetchSignalRef.current()
        if (cancelled) return
        if (hasSyncAdvanced(baseline, lastSyncedAt)) {
          onAdvancedRef.current()
          return
        }
      } catch (err) {
        // 握り潰さぬ。ポーリングの失敗は画面を倒さぬが、原因不明の
        // 「同期したのに出ない」を作らぬためログには残す。
        if (cancelled) return
        console.error("[calendar] 同期シグナルの取得に失敗", {
          message: err instanceof Error ? err.message : String(err),
        })
      }
      if (remaining <= 1) return
      timer = setTimeout(() => {
        void attempt(remaining - 1)
      }, GOOGLE_SYNC_POLL_INTERVAL_MS)
    }

    timer = setTimeout(() => {
      void attempt(GOOGLE_SYNC_POLL_ATTEMPTS)
    }, GOOGLE_SYNC_POLL_INTERVAL_MS)

    return () => {
      cancelled = true
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [enabled, baseline])
}
