"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  deviceTimeToServerTimeMs,
  estimateServerTimeMs,
  fetchServerTimeSample,
  significantDeviceSkewMs,
  type ServerTimeSample,
} from "@/lib/domain/server-clock"

/** 開いておる間にサンプルを取り直す間隔（MAX_SAMPLE_AGE_MS = 30 分より短く。長い計測の停止でも使える） */
export const SERVER_CLOCK_REFRESH_MS = 10 * 60_000

export interface ServerClock {
  /** 押した瞬間のサーバ時刻（ISO）。推定できねば null */
  serverNowIso: () => string | null
  /**
   * 端末の時計で測った過去の時刻（走っておるタイマーの開始）を、サーバの時計へ写した時刻（ISO）。
   * 写せねば null — 呼び出し側は端末の時刻のまま送る（`deviceTimeToServerTimeMs`）
   */
  toServerIso: (deviceDate: Date) => string | null
  /**
   * 最後に取れたサンプルが示す端末の時計のずれ（端末 − サーバ。ms）。往復の誤差を除いても 1 分以上
   * ずれておる時だけ値、それ以外（ずれが小さい・サンプルが無い）は null。描画に使ってよい（サンプルが
   * 届いた時に state へ置く。描画の中で時計を読まぬ）。時刻を直す根拠にはせず、注記にだけ使う
   */
  deviceSkewMs: number | null
}

/**
 * サーバの時計で時刻を決める関数（2026-10-28 N3。方式と限界は `@/lib/domain/server-clock`）。
 *
 * `active` の間（授乳のシートが開いておる間）、開いた時・画面へ戻った時・SERVER_CLOCK_REFRESH_MS ごとに
 * サーバの時刻のサンプルを取り直す。サンプルはこの画面の寿命の間だけ持つ（端末に保存せぬ — 経過の
 * 時計は再読込で 0 に戻る）。返す関数は event handler からだけ呼ぶこと（描画中に時計を読まぬ）。
 * 推定できぬ時は null。押下を新しいサンプルの取得で待たせぬ。
 */
export function useServerClock(active: boolean): ServerClock {
  const sampleRef = useRef<ServerTimeSample | null>(null)
  const [deviceSkewMs, setDeviceSkewMs] = useState<number | null>(null)

  useEffect(() => {
    if (!active) return
    const controller = new AbortController()
    const refresh = () => {
      void fetchServerTimeSample({ signal: controller.signal }).then((sample) => {
        // 取れなんだ時は前のサンプルを捨てぬ（使えるかは押した時に判じる）
        if (sample && !controller.signal.aborted) {
          sampleRef.current = sample
          setDeviceSkewMs(significantDeviceSkewMs(sample))
        }
      })
    }
    refresh()
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh()
    }
    document.addEventListener("visibilitychange", onVisible)
    // 開いたまま長く計測しても（wake lock で画面は点いたまま）、停めた時に古すぎぬサンプルを持つ
    const interval = setInterval(refresh, SERVER_CLOCK_REFRESH_MS)
    return () => {
      controller.abort()
      clearInterval(interval)
      document.removeEventListener("visibilitychange", onVisible)
      // 閉じた後に開き直した時、前のサンプルのずれを新しいサンプルが届くまで出し続けぬ（v9rc1 INFO UX-08）
      setDeviceSkewMs(null)
    }
  }, [active])

  const serverNowIso = useCallback(() => {
    const sample = sampleRef.current
    if (!sample) return null
    const ms = estimateServerTimeMs(sample)
    return ms === null ? null : new Date(ms).toISOString()
  }, [])
  const toServerIso = useCallback((deviceDate: Date) => {
    const sample = sampleRef.current
    if (!sample) return null
    const ms = deviceTimeToServerTimeMs(deviceDate.getTime(), sample)
    return ms === null ? null : new Date(ms).toISOString()
  }, [])
  return useMemo(
    () => ({ serverNowIso, toServerIso, deviceSkewMs }),
    [serverNowIso, toServerIso, deviceSkewMs],
  )
}
