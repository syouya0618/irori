"use client"

import { useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import {
  automaticRefreshHold,
  isDeviceOffline,
  isServerReachabilityFresh,
  noteServerReachable,
  probeServer,
  watchUnsavedInput,
} from "./refresh-gate"

/** 更新を見送った・できなかった理由（画面に文で出す）。 */
export type ChoresRefreshNotice = "offline" | "unreachable" | "held"

export const CHORES_REFRESH_MESSAGES: Readonly<Record<ChoresRefreshNotice, string>> = {
  offline: "オフラインのため更新していません。表示しているのは前回読み込んだ内容です。",
  unreachable: "サーバーに接続できず、更新できませんでした。表示しているのは前回読み込んだ内容です。",
  held: "入力や保存の途中のため、自動の更新を止めています。",
}

export interface ChoresRefresh {
  /**
   * Server の内容を取り直す。`auto` = 復帰時・定期（入力や保存の途中は見送る）、
   * `manual` = 利用者が押した更新・保存の確定後（見送らぬ）。
   */
  refresh: (mode: "auto" | "manual", options?: { paused?: boolean }) => void
  /** 直近の更新を見送った・できなかった理由。更新を呼べたら null へ戻る */
  notice: ChoresRefreshNotice | null
}

/**
 * 家事の画面の `router.refresh()` の唯一の入口（門の順序と理由は `refresh-gate.ts` 冒頭）。
 * 圏外・サーバーへ届かぬ時は呼ばず、直前の表示を保って理由を返す。**`router.refresh()` を直に
 * 呼ばぬこと** — 取得に失敗するとハードナビゲーションへ倒れ、画面と未保存の入力が消える。
 */
export function useChoresRefresh(): ChoresRefresh {
  const router = useRouter()
  const [notice, setNotice] = useState<ChoresRefreshNotice | null>(null)
  const probeRef = useRef<AbortController | null>(null)

  useEffect(() => {
    // この画面が描けた = Server の応答が届いた直後
    noteServerReachable()
    const stopWatching = watchUnsavedInput()
    return () => {
      stopWatching()
      probeRef.current?.abort()
      probeRef.current = null
    }
  }, [])

  function refresh(mode: "auto" | "manual", options?: { paused?: boolean }) {
    if (isDeviceOffline()) {
      setNotice("offline")
      return
    }
    const held = () => mode === "auto" && (options?.paused === true || automaticRefreshHold() !== null)
    if (held()) {
      setNotice("held")
      return
    }
    if (isServerReachabilityFresh()) {
      setNotice(null)
      router.refresh()
      return
    }
    // 確かめは 1 本に絞る（定期・復帰・押下が重なっても並べぬ）
    if (probeRef.current) return
    const controller = new AbortController()
    probeRef.current = controller
    void probeServer(controller.signal).then((reachable) => {
      if (probeRef.current !== controller) return
      probeRef.current = null
      if (controller.signal.aborted) return
      if (!reachable) {
        setNotice(isDeviceOffline() ? "offline" : "unreachable")
        return
      }
      noteServerReachable()
      // 確かめておる間に入力・保存が始まっておれば、自動の更新は見送る
      if (held()) {
        setNotice("held")
        return
      }
      setNotice(null)
      router.refresh()
    })
  }

  return { refresh, notice }
}
