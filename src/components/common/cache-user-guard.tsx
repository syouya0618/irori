"use client"

import { purgeOtherSleepRequests } from "@/lib/domain/sleep-pending"
import { useEffect } from "react"
import {
  purgeHouseholdCaches,
  setCacheOwner,
  LAST_USER_ID_STORAGE_KEY,
} from "@/lib/pwa/sw-messages"
import {
  belongsToOwner,
  clearPersistedTimer,
  readPersistedTimer,
  purgeChildTimers,
} from "@/lib/domain/feeding-timer-storage"
import { purgeDraftsNotOwnedBy } from "@/lib/domain/draft-storage"
import { purgePendingSavesNotOwnedBy } from "@/lib/domain/pending-saves-storage"
import { purgeCalendarPendingCreatesNotOwnedBy } from "@/lib/domain/calendar-pending-creates"
import { HANDOFF_EVENTS_KEY_PREFIX, HANDOFF_KEY_PREFIX } from "@/lib/domain/handoff"
import { HOME_FOLD_KEY_PREFIX } from "@/components/baby/baby-collapsible-section"

/**
 * 持ち主（`<prefix><userId>:<householdId>`）付きの表示の好み・印のうち、今の持ち主以外のものを消す。
 * 記録の本文は持たぬが、前の利用者の「いつ見たか」「何を畳んだか」を共用端末に残さぬ。
 */
function purgeOwnerScopedKeys(prefixes: string[], owner: { userId: string; householdId: string }) {
  try {
    const stale: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key) continue
      const prefix = prefixes.find((p) => key.startsWith(p))
      if (prefix && key !== `${prefix}${owner.userId}:${owner.householdId}`) stale.push(key)
    }
    for (const key of stale) localStorage.removeItem(key)
  } catch (err) {
    console.warn("[cache-user-guard] 持ち主付きの表示設定を整理できず", {
      message: err instanceof Error ? err.message : String(err),
    })
  }
}

/**
 * 別ユーザーでのログインを検知して世帯データ入り SW キャッシュを破棄する (render なし)。
 *
 * 同一端末でユーザー B がログインした際、ユーザー A の世帯の HTML / RSC キャッシュが
 * オフライン閲覧で漏れるのを防ぐ。(main) レイアウト配下でのみマウントされるため、
 * userId は常に認証済みユーザーの ID。
 *
 * あわせて世帯キャッシュの持ち主を今の利用者にする（setCacheOwner）。SW は持ち主のタグが
 * 一致する項目しか配らぬゆえ、破棄の後に届いた前の利用者の応答も、破棄に失敗して残った
 * 前の利用者の項目も、今の利用者には配られぬ。
 *
 * 端末の未確定の作業（下書き・応答不明の保存・授乳の計測。2026-10-27 大型更新）は持ち主
 * （利用者・世帯）付きで、今の持ち主と違うものはここで消す — 前の利用者・前の世帯の本文や送信内容を
 * 今の利用者へ見せず、送らぬ。今の持ち主のものは残す（同じ人のログアウト→再ログインで戻れる）。
 * 各保存は読む時にも持ち主で絞る（二重の防御）。
 */
export function CacheUserGuard({ userId, householdId }: { userId: string; householdId: string }) {
  useEffect(() => {
    const owner = { userId, householdId }
    purgeDraftsNotOwnedBy(owner)
    purgePendingSavesNotOwnedBy(owner)
    purgeCalendarPendingCreatesNotOwnedBy(owner)
    purgeOwnerScopedKeys([HOME_FOLD_KEY_PREFIX, HANDOFF_KEY_PREFIX, HANDOFF_EVENTS_KEY_PREFIX], owner)
    purgeOtherSleepRequests(owner)
    purgeChildTimers(owner)
    const timer = readPersistedTimer()
    if (timer && !belongsToOwner(timer, owner)) clearPersistedTimer()
  }, [userId, householdId])

  useEffect(() => {
    let cancelled = false

    const run = async () => {
      let previousUserId: string | null = null
      try {
        previousUserId = localStorage.getItem(LAST_USER_ID_STORAGE_KEY)
      } catch (err) {
        // localStorage 不可 (プライベートモード等) でも続行する
        console.warn("[cache-user-guard] localStorage 読み取りに失敗:", err)
      }

      let purged = true
      if (previousUserId && previousUserId !== userId) {
        // 前の利用者の授乳タイマーが端末に残っておれば消す（P3-08。タイマー側の持ち主
        // 判定と二重の防御 — 旧形式の保存は持ち主を持たぬため、ここでしか消えぬ）
        clearPersistedTimer()
        purgeChildTimers()
        // purgeHouseholdCaches は reject しない (破棄を確かめられたかを boolean で返す)。
        // 持ち主の記録を先に消してから破棄する
        purged = await purgeHouseholdCaches()
      }

      // ログアウト等で (main) を離れた後に、持ち主を書き戻さぬ
      if (cancelled) return
      // 持ち主は破棄の成否に**従属させず**今の利用者へ書く。破棄に失敗した時こそ要る —
      // 書かねば持ち主の記録が前の利用者のまま残りうり、残った前の利用者の項目がタグ照合を
      // 素通りして今の利用者に配られる。書けば前の利用者の項目はタグが合わず配られぬ。
      if (!(await setCacheOwner(userId))) {
        console.warn(
          "[cache-user-guard] 世帯キャッシュの持ち主を書けず（この端末ではオフライン用に保存されぬ）",
        )
      }
      if (!purged) {
        // 確かめられぬまま鍵を今の ID へ書き換えれば、次のマウントでは「同じ利用者」に
        // 見えて二度と破棄を試みぬ。前の ID を残し、次のマウントで再び試みる (P2-24)。
        console.warn(
          "[cache-user-guard] 前の利用者のキャッシュ破棄を確認できず。前の ID を残して次回に再試行する",
        )
        return
      }

      if (cancelled) return
      try {
        localStorage.setItem(LAST_USER_ID_STORAGE_KEY, userId)
      } catch (err) {
        console.warn("[cache-user-guard] localStorage 書き込みに失敗:", err)
      }
    }

    void run()
    return () => {
      cancelled = true
    }
  }, [userId])

  return null
}
