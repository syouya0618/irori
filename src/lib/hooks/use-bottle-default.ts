"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { createClient } from "@/lib/supabase/client"
import { logSupabaseError } from "@/lib/supabase/log-error"
import { selectBottleDefault } from "@/lib/supabase/bottle-default-query"
import { useVisibilityRefetch } from "@/lib/hooks/use-visibility-refetch"
import {
  decodeBottleDefault,
  formatBottleAmount,
  type BottleDefaultState,
} from "@/lib/domain/bottle-default"

/**
 * 取り直し 1 回の時間切れ。電波が繋がっても通らぬ状態（lie-fi）で、読めていない時のミルクの
 * タップ（クイック記録の共有 transition の中で待つ）が全釦を止め続けぬよう上限を置く。
 */
export const BOTTLE_DEFAULT_REFETCH_TIMEOUT_MS = 8_000

/**
 * 中止できぬ待ち（auth の getSession 等）を signal の中止で打ち切る。PostgREST の問い合わせは
 * Promise ではなく thenable ゆえ PromiseLike で受ける
 */
function untilAborted<T>(promise: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    const onAbort = () => reject(signal.reason)
    signal.addEventListener("abort", onAbort, { once: true })
    Promise.resolve(promise).then(
      (value) => {
        signal.removeEventListener("abort", onAbort)
        resolve(value)
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort)
        reject(err)
      },
    )
  })
}

export interface BottleDefaultController {
  /** 画面が今知っておる「いつものミルク量」 */
  state: BottleDefaultState
  /**
   * DB から取り直す。反映した状態を返す。session が無い・失敗した・時間切れの時は null
   * （表示は変えぬ）。より新しい取り直しに追い越された時はその結果を、保存の反映（apply）に
   * 追い越された時は反映した状態を返す（追い越されただけで「読めなかった」とは言わぬ）。
   */
  refetch: () => Promise<BottleDefaultState | null>
  /**
   * 保存の成功・衝突で分かったサーバの真値を反映する。それより前に始まった取り直しの
   * 結果は捨てる（保存の後に古い量へ戻さぬ）。
   */
  apply: (next: BottleDefaultState) => void
}

/**
 * 育児画面の「いつものミルク量」（households.bottle_default_ml）を持つ。
 *
 * 初期値はサーバの初回描画（baby/page.tsx）が読んだ値で**一度だけ** seed し、その後は
 * マウント・画面復帰（visible / focus）で取り直す。夫婦の別端末で変えた量はここで届く
 * （households は Realtime の publication に載せておらぬ）。マウント時にも取るのは、戻る/
 * 進むで Next が古い RSC payload を使い回すため（baby-dashboard.tsx の resyncLogs と同じ理由）。
 *
 * 防御:
 * - session が無ければ取りも反映もせぬ。session 切れの anon 問い合わせは RLS でエラー無しの
 *   0 行になり、それを読むと決めてある量が「取得失敗」に化ける（baby-dashboard.tsx の
 *   hasUsableSession と同じ失敗類型。あちらは画面の局所関数ゆえここで同じ確かめ方をする）
 * - 世代 + AbortController: 新しい取り直し・保存の反映（apply）が古い取り直しを捨てる。
 *   保存の前に始まった取り直しが保存の後に古い 120 を返し、表示が戻って次のタップが 120 で
 *   記録される — を塞ぐ
 * - 取り直しの失敗は今の表示を保つ（構造化ログだけ）。決めてある量を失敗で消さぬ
 * - 時間切れ（BOTTLE_DEFAULT_REFETCH_TIMEOUT_MS）で打ち切る。中止できぬ getSession も含めて待ちを切る
 */
export function useBottleDefault(
  householdId: string,
  initial: BottleDefaultState,
): BottleDefaultController {
  const [state, setState] = useState<BottleDefaultState>(initial)
  // 取り直しの結果を「今の表示」と比べるため（変わった時だけ知らせる）。描画には使わぬ
  const stateRef = useRef<BottleDefaultState>(initial)
  const generationRef = useRef(0)
  const controllerRef = useRef<AbortController | null>(null)
  // いま飛んでおる取り直し。追い越された呼び出しが、新しい方の結果を待てるように持つ
  const inFlightRef = useRef<{
    generation: number
    promise: Promise<BottleDefaultState | null>
  } | null>(null)

  const commit = useCallback((next: BottleDefaultState) => {
    stateRef.current = next
    setState(next)
  }, [])

  const apply = useCallback(
    (next: BottleDefaultState) => {
      generationRef.current += 1
      controllerRef.current?.abort()
      controllerRef.current = null
      commit(next)
    },
    [commit],
  )

  const refetch = useCallback((): Promise<BottleDefaultState | null> => {
    controllerRef.current?.abort()
    const generation = ++generationRef.current
    const controller = new AbortController()
    controllerRef.current = controller
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, BOTTLE_DEFAULT_REFETCH_TIMEOUT_MS)
    const context = { householdId }
    const superseded = () =>
      controller.signal.aborted || generationRef.current !== generation
    // 追い越された時の答え: 新しい取り直しの結果、無ければ（apply・unmount）今の状態
    const followLatest = (): Promise<BottleDefaultState | null> => {
      const latest = inFlightRef.current
      if (latest && latest.generation > generation) return latest.promise
      return Promise.resolve(stateRef.current)
    }
    const onAborted = (): Promise<BottleDefaultState | null> | null => {
      if (timedOut) {
        console.warn("[baby] bottle default refetch timed out", context)
        return null
      }
      return followLatest()
    }
    const run = async (): Promise<BottleDefaultState | null> => {
      try {
        const supabase = createClient()
        const { data: sessionData, error: sessionError } = await untilAborted(
          supabase.auth.getSession(),
          controller.signal,
        )
        if (superseded()) return onAborted()
        if (sessionError) {
          logSupabaseError(
            "baby",
            "bottle default refetch skipped: session unavailable",
            sessionError,
            context,
          )
          return null
        }
        if (!sessionData.session) {
          console.warn("[baby] bottle default refetch skipped: no session", context)
          return null
        }
        const result = await untilAborted(
          selectBottleDefault(supabase, householdId, controller.signal),
          controller.signal,
        )
        if (superseded()) return onAborted()
        if (result.error) {
          logSupabaseError("baby", "bottle default refetch failed", result.error, context)
          return null
        }
        const next = decodeBottleDefault(result)
        if (next.status === "error") {
          console.error("[baby] bottle default refetch returned no usable row", context)
          return null
        }
        const prev = stateRef.current
        // 別の端末で量が変わっていた。1 タップで記録される量が黙って変わらぬよう知らせる
        // （読めていなかった状態からの回復は「変わった」ではないゆえ黙る）
        if (
          next.status === "set" &&
          prev.status !== "error" &&
          !(prev.status === "set" && prev.amountMl === next.amountMl)
        ) {
          toast.info(
            `いつものミルク量が別の端末で${formatBottleAmount(next.amountMl)}に変更されました`,
          )
        }
        commit(next)
        return next
      } catch (err) {
        if (controller.signal.aborted) return onAborted()
        console.error("[baby] bottle default refetch threw", {
          ...context,
          message: err instanceof Error ? err.message : String(err),
        })
        return null
      } finally {
        clearTimeout(timer)
        if (controllerRef.current === controller) controllerRef.current = null
        if (inFlightRef.current?.generation === generation) inFlightRef.current = null
      }
    }
    const promise = run()
    inFlightRef.current = { generation, promise }
    return promise
  }, [householdId, commit])

  // マウント時に 1 回取り直し、unmount で in-flight を止める（離脱後の setState を走らせぬ）
  useEffect(() => {
    void refetch()
    return () => {
      controllerRef.current?.abort()
    }
  }, [refetch])

  useVisibilityRefetch(
    useCallback(() => {
      void refetch()
    }, [refetch]),
  )

  return { state, refetch, apply }
}
