"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import {
  discardDraft,
  draftStorageKey,
  draftWriteFailureMessage,
  readDraft,
  writeDraft,
  type DraftOwner,
  type DraftReadResult,
  type DraftRecord,
  type DraftTarget,
  type DraftWriteResult,
} from "@/lib/domain/draft-storage"

/** 入力が止まってから端末へ書くまでの待ち（打鍵ごとに書かぬ） */
export const DRAFT_SAVE_DEBOUNCE_MS = 400

export interface UseDraftOptions<T> {
  /** null の間（持ち主が分からぬ）は読みも書きもせぬ */
  owner: DraftOwner | null
  target: DraftTarget
  /** 編集を始めた時点のサーバの版（行が無ければ null）。表記の文字列のまま */
  baseVersion: string | null
  isContent: (value: unknown) => value is T
  /** false の間は書かぬ（保存中・送信中など） */
  enabled?: boolean
}

export interface UseDraftResult<T> {
  /** マウント時に見つかった下書き（復元するかは呼び出し側が決める） */
  restored: DraftRecord<T> | null
  /** マウント時の読みの結果（discarded は期限切れ・破損・旧版・不一致を捨てた） */
  readResult: DraftReadResult<T>["status"]
  /** 見つかった下書きの版が、今のサーバの版と違う（家族か別端末が先に保存した） */
  restoredIsStale: boolean
  /** 入力が変わるたびに呼ぶ（間引いて書く） */
  update: (content: T) => void
  /** 今すぐ書く（閉じる直前など）。結果を返す */
  flush: () => DraftWriteResult | null
  /** 最後に書いた結果。null はまだ書いておらぬ */
  lastWrite: DraftWriteResult | null
  /** 書けなんだ時の文言（「下書き保存済み」とは言わぬ） */
  failureMessage: string | null
  /** 明示の破棄・保存成功で、この対象の下書きだけを消す */
  clear: () => void
  /** 別のタブがこの下書きを消した（保存・破棄した）/ 書き換えた */
  externalChange: "cleared" | "updated" | null
}

/**
 * 端末下書き（`@/lib/domain/draft-storage`）を React のフォームに繋ぐ。
 *
 * - 本文の state はフォームが持つ（このフックは書き写すだけ）。日本語 IME の変換中に値を
 *   書き戻さぬ — 端末へ写すだけで、入力欄の値には触れぬ
 * - 書くのは入力が止まってから（DRAFT_SAVE_DEBOUNCE_MS）と、画面が隠れる時（pagehide /
 *   visibilitychange）と、アンマウントの時
 * - 書けなんだら failureMessage を出す。呼び出し側は「下書き保存済み」と表示してはならぬ
 */
export function useDraft<T>(opts: UseDraftOptions<T>): UseDraftResult<T> {
  const { owner, target, baseVersion, isContent, enabled = true } = opts
  const key = owner ? draftStorageKey(owner, target) : null

  const [initial] = useState<DraftReadResult<T>>(() =>
    owner ? readDraft(owner, target, isContent) : { status: "none" },
  )
  const restored = initial.status === "found" ? initial.draft : null
  const [lastWrite, setLastWrite] = useState<DraftWriteResult | null>(null)
  const [externalChange, setExternalChange] = useState<"cleared" | "updated" | null>(null)

  const pendingRef = useRef<{ content: T } | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latest = useRef({ owner, target, baseVersion, enabled })
  useEffect(() => {
    latest.current = { owner, target, baseVersion, enabled }
  })

  const writeNow = useCallback((): DraftWriteResult | null => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    const pending = pendingRef.current
    const { owner: o, target: t, baseVersion: v, enabled: e } = latest.current
    if (!pending || !o || !e) return null
    pendingRef.current = null
    const result = writeDraft(o, t, v, pending.content)
    setLastWrite(result)
    return result
  }, [])

  const update = useCallback(
    (content: T) => {
      pendingRef.current = { content }
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(writeNow, DRAFT_SAVE_DEBOUNCE_MS)
    },
    [writeNow],
  )

  const clear = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    pendingRef.current = null
    const { owner: o, target: t } = latest.current
    if (o) discardDraft(o, t)
    setLastWrite(null)
  }, [])

  // 画面が隠れる・閉じられる時に書き切る（アプリの切替・タブを閉じる・再読込）
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") writeNow()
    }
    window.addEventListener("pagehide", writeNow)
    document.addEventListener("visibilitychange", onHide)
    return () => {
      window.removeEventListener("pagehide", writeNow)
      document.removeEventListener("visibilitychange", onHide)
      // アンマウント（シートを閉じた）でも書き切る
      writeNow()
    }
  }, [writeNow])

  // 別タブの保存・破棄（storage イベントは他のタブの変更だけを知らせる）
  useEffect(() => {
    if (!key) return
    const onStorage = (e: StorageEvent) => {
      if (e.key !== key) return
      setExternalChange(e.newValue === null ? "cleared" : "updated")
    }
    window.addEventListener("storage", onStorage)
    return () => window.removeEventListener("storage", onStorage)
  }, [key])

  return {
    restored,
    readResult: initial.status,
    restoredIsStale: restored !== null && restored.baseVersion !== baseVersion,
    update,
    flush: writeNow,
    lastWrite,
    failureMessage: lastWrite && !lastWrite.ok ? draftWriteFailureMessage(lastWrite.reason) : null,
    clear,
    externalChange,
  }
}
