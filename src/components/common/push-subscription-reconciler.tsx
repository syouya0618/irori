"use client"

import { useEffect } from "react"
import {
  PUSH_RECONCILE_MARKER_KEY,
  PUSH_RESUBSCRIBE_PATH,
  isResubscribeAccepted,
  reconcilePushSubscription,
  type ResubscribeRequestBody,
} from "@/lib/pwa/push-reconcile"

/**
 * 起動時に、ブラウザの購読をサーバへ登録し直す（render なし・B-4）。
 *
 * 配信ジョブが 410 で消した行を作り直す唯一の自動経路じゃ。設計と代償
 * （`failure_count` が畳まれる件）は `@/lib/pwa/push-reconcile` の冒頭に書いた。
 *
 * ## 走る頻度
 * `(main)/layout.tsx` に置く。layout はクライアント遷移では**再マウントされぬ**
 * ゆえ、effect は**ハードロードごとに 1 回**じゃ（`CacheUserGuard` と同じ位置・
 * 同じ性質）。加えて sessionStorage の印で、同じ endpoint なら 2 度目は即座に退く。
 *
 * `revalidatePath("/settings")`（B-1 の Server Action が呼ぶ）でも走らぬ。
 * Next 16 公式 docs 原文（`node_modules/next/dist/docs/01-app/01-getting-started/
 * 07-mutating-data.md:508`）:
 *   "The server update applies to the current React tree, re-rendering, mounting,
 *    or unmounting components, as needed. Client state is preserved for
 *    re-rendered components, and **effects re-run if their dependencies changed**."
 * この effect の依存は `[]` ゆえ再実行されぬ。主が「この端末で通知を受け取る」を
 * 押した直後に、こちらの upsert が割り込んで `failure_count` を畳むことは無い。
 *
 * ## ⚠️ effect 内で同期的に setState をせぬ
 * この component は state を一切持たぬ（返すのは null）。React Compiler の
 * 「effect 内の同期 setState」規則に触れる余地を構造から消してある。
 *
 * ## `userId` を受け取る理由
 * 印を**利用者で区切る**ためじゃ（`CacheUserGuard` と同じ配線）。共用端末で
 * 持ち主が代わった時に必ず 1 回走らせる。詳細は `push-reconcile.ts` の
 * `PUSH_RECONCILE_MARKER_KEY` を見よ。
 */
export function PushSubscriptionReconciler({ userId }: { userId: string }) {
  useEffect(() => {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return

    let cancelled = false

    const run = async () => {
      const outcome = await reconcilePushSubscription({
        getSubscriptionJson: async () => {
          // ⚠️ `navigator.serviceWorker.ready` を使わぬ。SW が 1 つも登録されて
          // おらぬ環境（`next dev` は `ServiceWorkerManager` が unregister する）
          // では **永久に解決せぬ** promise になる。`getRegistration()` は
          // 未登録なら undefined で解決する。
          const registration = await navigator.serviceWorker.getRegistration()
          if (!registration) return null
          const subscription = await registration.pushManager.getSubscription()
          return subscription ? subscription.toJSON() : null
        },
        register: async (body: ResubscribeRequestBody) => {
          const res = await fetch(PUSH_RESUBSCRIBE_PATH, {
            method: "POST",
            // ⚠️ 承認ゲートの 307 を追わせぬ（追うと HTML の 200 を成功と誤読する）。
            redirect: "manual",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          })
          return isResubscribeAccepted(res)
        },
        readMarker: () => {
          try {
            return sessionStorage.getItem(PUSH_RECONCILE_MARKER_KEY)
          } catch (err) {
            // プライベートモード等で読めずとも続行する（印が無い＝毎回走るだけ）。
            console.warn("[push-reconciler] sessionStorage の読み取りに失敗:", err)
            return null
          }
        },
        writeMarker: (marker) => {
          try {
            sessionStorage.setItem(PUSH_RECONCILE_MARKER_KEY, marker)
          } catch (err) {
            console.warn("[push-reconciler] sessionStorage の書き込みに失敗:", err)
          }
        },
        userId,
        userAgent: navigator.userAgent,
      })

      if (cancelled) return
      // 握り潰さぬ。受理されなかった時だけ残す（正常系でログを汚さぬ）。
      // ⚠️ endpoint は出さぬ（送信能力そのものゆえ）。
      if (outcome === "rejected" || outcome === "incomplete") {
        console.warn("[push-reconciler] 購読の突き合わせが成立せず:", outcome)
      }
    }

    void run().catch((err) => {
      // 圏外・SW 未対応・権限周りで落ちても、画面は何も壊れてはならぬ。
      console.warn("[push-reconciler] 突き合わせに失敗:", err)
    })

    return () => {
      cancelled = true
    }
    // 依存は userId のみ。layout はクライアント遷移で再マウントされぬゆえ、実質は
    // ハードロードごとに 1 回じゃ（同一ページ内で利用者が変わることは無い）。
  }, [userId])

  return null
}
