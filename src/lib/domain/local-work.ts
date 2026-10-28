import { readPersistedTimer, summarizePersistedTimer } from "@/lib/domain/feeding-timer-storage"
import { listPendingSaves } from "@/lib/domain/pending-saves-storage"
import { countOwnedDrafts } from "@/lib/domain/draft-storage"
import {
  listCalendarPendingCreates,
  listMemoryOnlyCalendarCreates,
} from "@/lib/domain/calendar-pending-creates"
import type { SaveOwner } from "@/lib/domain/save-attempt"

/**
 * この端末に残っておる「まだ家族と共有されておらぬ / 保存を確かめられておらぬ」作業の要約
 * （2026-10-27 大型更新 §1・E1）。本文は読まぬ — 件数と種類だけ。
 *
 * 使い道:
 * - PWA 更新の案内: これが空でない間は自動で再読込せぬ（利用者が選んだ時だけ。再読込しても
 *   端末保存から戻るが、送信中の操作の応答を取りこぼさぬよう利用者に選ばせる）
 * - ログアウトの確認: 端末に残るものを伝える（無言で捨てぬ）
 *
 * localStorage が使えぬ環境でも、このページだけにある予定の控えは数える。他の端末保存を
 * 判定できぬことを「何もない」と言い換えぬよう、`storageReadable` を併せて返す。
 */
export interface LocalWorkSummary {
  storageReadable: boolean
  /** 授乳の計測（走行中・停め忘れ・保存を確認中） */
  timer: { pendingSave: boolean; stale: boolean } | null
  /** 応答不明の作成（クイック記録・記録シート） */
  pendingSaves: number
  /** 予定の作成の控えのうち、保存されておりうるもの（送信中・確認中。v9） */
  calendarCreates: number
  /** 予定の作成の控えのうち、1 度きりの送信が拒まれ保存されておらぬもの（入力に戻って直せる。v9） */
  calendarCreatesRejected: number
  /** 上記の予定の控えのうち、端末へ書けずこのページだけにあるもの（再読込で消える） */
  calendarCreatesMemoryOnly: number
  /** 期限内の下書き（日記・予定・メモ） */
  drafts: number
}

function canReadStorage(): boolean {
  try {
    localStorage.getItem("irori:probe")
    return true
  } catch {
    return false
  }
}

export function summarizeLocalWork(owner: SaveOwner, nowMs: number = Date.now()): LocalWorkSummary {
  const storageReadable = canReadStorage()
  const timer = summarizePersistedTimer(readPersistedTimer(), owner, nowMs)
  const storedCreates = listCalendarPendingCreates(owner, nowMs)
  const storedIds = new Set(storedCreates.map((entry) => entry.clientId))
  const memoryCreates = listMemoryOnlyCalendarCreates(owner).filter((entry) => !storedIds.has(entry.clientId))
  const creates = [...storedCreates, ...memoryCreates]
  return {
    storageReadable,
    timer: timer ? { pendingSave: timer.pendingSave, stale: timer.stale } : null,
    pendingSaves: listPendingSaves(owner, nowMs).length,
    calendarCreates: creates.filter((e) => e.status !== "rejected").length,
    calendarCreatesRejected: creates.filter((e) => e.status === "rejected").length,
    calendarCreatesMemoryOnly: memoryCreates.length,
    drafts: countOwnedDrafts(owner, nowMs),
  }
}

/** 要約が空でないか（更新の自動再読込を止める条件）。 */
export function hasLocalWork(summary: LocalWorkSummary): boolean {
  return (
    summary.timer !== null ||
    summary.pendingSaves > 0 ||
    summary.calendarCreates > 0 ||
    summary.calendarCreatesRejected > 0 ||
    summary.drafts > 0
  )
}

/** 利用者向けの一文（ログアウト・更新の確認）。無ければ null。 */
export function describeLocalWork(summary: LocalWorkSummary): string | null {
  const parts: string[] = []
  if (summary.timer) {
    parts.push(summary.timer.pendingSave ? "保存を確認中の授乳" : "授乳の計測")
  }
  if (summary.pendingSaves > 0) parts.push(`保存を確認中の記録 ${summary.pendingSaves}件`)
  if (summary.calendarCreates > 0) parts.push(`保存を確認中の予定 ${summary.calendarCreates}件`)
  if (summary.calendarCreatesRejected > 0) parts.push(`保存できなかった予定 ${summary.calendarCreatesRejected}件`)
  if (summary.drafts > 0) parts.push(`下書き ${summary.drafts}件`)
  if (parts.length === 0) return null
  const memoryNote = summary.calendarCreatesMemoryOnly > 0
    ? "。端末に残せていない予定の控えは、読み直すと消えます"
    : ""
  return `この端末に、まだ家族と共有されていないものがあります（${parts.join("・")}）${memoryNote}`
}
