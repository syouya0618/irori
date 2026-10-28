"use client"

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react"
import {
  checkServerVersion,
  getStaleClientDetected,
  getStaleClientDetectedOnServer,
  subscribeStaleClient,
  VERSION_RECHECK_INTERVAL_MS,
  type VersionCheckResult,
} from "@/lib/pwa/app-version"
import { clientBuildId } from "@/lib/release/build-info"

export interface AppVersionStatus {
  /** null = まだ確かめておらぬ（確認中） */
  result: VersionCheckResult | null
  checking: boolean
  /** 古い画面から新しいサーバへ action を送って失敗した（版の食い違いの確かな証拠） */
  staleClient: boolean
  /** 今すぐ確かめ直す（利用者の操作） */
  recheck: () => void
}

/**
 * 端末とサーバの版を、開いた時と画面復帰時（前回から 10 分以上たった時だけ）に軽く確かめる。
 * 取得は期限 8 秒・取消しつき（`checkServerVersion`）。アンマウントで取り消す。
 * 自動で再読込はせぬ — 案内の表示だけ（読み直すのは利用者が押した時だけ）。
 */
export function useAppVersion(): AppVersionStatus {
  const [result, setResult] = useState<VersionCheckResult | null>(null)
  // 開いた時は確かめに行くゆえ true で始める（effect の中で同期に setState せぬ）
  const [checking, setChecking] = useState(true)
  const lastCheckedAtRef = useRef<number>(0)
  const controllerRef = useRef<AbortController | null>(null)
  const staleClient = useSyncExternalStore(
    subscribeStaleClient,
    getStaleClientDetected,
    getStaleClientDetectedOnServer,
  )

  /** 外部（/api/version）の読み出しを始める。setState は応答の callback の中だけ */
  const start = useCallback(() => {
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    lastCheckedAtRef.current = Date.now()
    void checkServerVersion({ signal: controller.signal, client: clientBuildId() }).then((next) => {
      if (controller.signal.aborted) return
      setResult(next)
      setChecking(false)
    })
  }, [])

  /** 利用者の操作・画面復帰から確かめ直す（イベントの callback ゆえ確認中を出してよい） */
  const run = useCallback(() => {
    setChecking(true)
    start()
  }, [start])

  useEffect(() => {
    start()
    const onVisible = () => {
      if (document.visibilityState !== "visible") return
      if (Date.now() - lastCheckedAtRef.current < VERSION_RECHECK_INTERVAL_MS) return
      run()
    }
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      document.removeEventListener("visibilitychange", onVisible)
      controllerRef.current?.abort()
    }
  }, [start, run])

  return { result, checking, staleClient, recheck: run }
}
