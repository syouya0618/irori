"use client"

import { useState, useEffect, useRef, useMemo } from "react"
import { BookOpen, Loader2, PenLine } from "lucide-react"
import { toast } from "sonner"
import { createClient } from "@/lib/supabase/client"
import { logSupabaseError } from "@/lib/supabase/log-error"
import { formatTimeJst } from "@/lib/utils/date-jst"
import { groupMemoLogsByDate, DIARY_PAGE_SIZE } from "@/lib/domain/baby-diary"
import { BabyLogFormSheet } from "./baby-log-form-sheet"
import type { BabyLogData } from "@/lib/types/baby"

// 日記一覧で取得するカラム（BabyLogData と対応・page.tsx と一致させる）。
const BABY_LOG_COLUMNS =
  "id, log_type, logged_at, logged_by, feeding_type, amount_ml, diaper_type, ended_at, temperature, weight_g, height_cm, duration_min, duration_sec, memo, created_at"

interface BabyDiaryViewProps {
  initialLogs: BabyLogData[]
  householdId: string
  /** 記録者（logged_by）。日記の新規作成シート（BabyLogFormSheet）に渡す。 */
  userId: string
}

/**
 * メモログを日記として JST 日付降順にグルーピングし全文表示する一覧ビュー。
 *
 * ページネーション掟（CLAUDE.md）:
 * - order は logged_at 降順 + id を最終ソートキー（一意）で全順序を決定化する。
 * - オフセットは「受領済み件数（logs.length）」を用いる。サーバの max_rows で
 *   1ページが要求件数未満に切り詰められても、次ページが受領済みの直後から続くため
 *   行を無音で飛ばさない（page*PAGE_SIZE 固定オフセットは飛ばす危険がある）。
 * - 終端は「返却0件」でのみ判定する。短いページ（0 < n < PAGE_SIZE）を終端扱いしない。
 */
export function BabyDiaryView({
  initialLogs,
  householdId,
  userId,
}: BabyDiaryViewProps) {
  const [logs, setLogs] = useState<BabyLogData[]>(initialLogs)
  // 「もっと見る」押下ごとに増やして追ページ取得の useEffect を発火させるトークン。
  const [loadToken, setLoadToken] = useState(0)
  const [loading, setLoading] = useState(false)
  const [reachedEnd, setReachedEnd] = useState(false)
  // 「日記を書く」シート（memo 作成モードの BabyLogFormSheet）の開閉。
  // formKey は開くたびに増やして再マウントし、シートの全 state（本文・時刻）を
  // 初期化式から再構築する（dashboard の formKey 流儀を踏襲）。
  const [composeOpen, setComposeOpen] = useState(false)
  const [composeKey, setComposeKey] = useState(0)

  // 次に取得すべきオフセット = これまでに受領した件数。logs 更新に追従させる。
  const offsetRef = useRef(initialLogs.length)
  useEffect(() => {
    offsetRef.current = logs.length
  }, [logs])

  // 追ページ取得。loadToken の変化（= ボタン押下）でのみ発火し、初期マウント
  // （loadToken === 0）では initialLogs で足りるため何もしない。
  useEffect(() => {
    if (loadToken === 0) return

    const supabase = createClient()
    const abortController = new AbortController()
    const offset = offsetRef.current

    supabase
      .from("baby_logs")
      .select(BABY_LOG_COLUMNS)
      .eq("household_id", householdId)
      .eq("log_type", "memo")
      .order("logged_at", { ascending: false })
      .order("id")
      .range(offset, offset + DIARY_PAGE_SIZE - 1)
      .abortSignal(abortController.signal)
      .then(({ data, error }) => {
        // 遷移離脱（abort）は成功/失敗いずれの分岐にも入れない。
        if (abortController.signal.aborted) return
        setLoading(false)
        if (error) {
          logSupabaseError("baby", "diary load-more fetch failed", error, {
            householdId,
            offset,
          })
          toast.error("読み込みに失敗しました")
          return
        }
        // 終端判定は「返却0件」でのみ。短いページは終端扱いしない。
        if (!data || data.length === 0) {
          setReachedEnd(true)
          return
        }
        // id ベースの dedupe マージ（受領済み行を末尾に追記して降順を維持）。
        setLogs((prev) => {
          const seen = new Set(prev.map((l) => l.id))
          const additions = data.filter((l) => !seen.has(l.id))
          return additions.length > 0 ? [...prev, ...additions] : prev
        })
      })

    return () => {
      abortController.abort()
    }
  }, [loadToken, householdId])

  const groups = useMemo(() => groupMemoLogsByDate(logs), [logs])

  // 作成成功時の楽観 prepend（新規日記は「今」の記録ゆえ降順リストの先頭が正位置。
  // Realtime echo との二重追加は id dedupe で防ぐ）。
  const handleLogRecorded = (log: BabyLogData) => {
    setLogs((prev) =>
      prev.some((l) => l.id === log.id) ? prev : [log, ...prev],
    )
  }

  const composeButton = (
    <button
      type="button"
      onClick={() => {
        setComposeKey((k) => k + 1)
        setComposeOpen(true)
      }}
      className="glass flex min-h-11 items-center justify-center gap-2 rounded-2xl px-4 text-sm font-medium text-primary shadow-lg shadow-black/[0.04] transition-colors duration-200 hover:text-primary/80"
    >
      <PenLine size={16} />
      日記を書く
    </button>
  )

  const composeSheet = (
    <BabyLogFormSheet
      key={composeKey}
      open={composeOpen}
      onOpenChange={setComposeOpen}
      log={null}
      createLogType="memo"
      userId={userId}
      onLogRecorded={handleLogRecorded}
    />
  )

  if (logs.length === 0) {
    return (
      <div className="flex flex-col gap-4">
        {composeButton}
        <div className="flex flex-col items-center justify-center gap-3 py-16">
          <BookOpen size={48} className="text-muted-foreground/30" />
          <p className="text-sm text-muted-foreground">まだ日記がありません</p>
        </div>
        {composeSheet}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      {composeButton}
      {groups.map((group) => (
        <section key={group.date} className="flex flex-col gap-1">
          <h2 className="px-1 text-sm font-semibold text-muted-foreground">
            {group.label}
          </h2>
          <div className="glass divide-y divide-border/30 rounded-2xl shadow-lg shadow-black/[0.04]">
            {group.logs.map((log) => (
              <div key={log.id} className="flex gap-3 p-3">
                <span className="shrink-0 pt-0.5 font-mono text-xs text-muted-foreground">
                  {formatTimeJst(log.logged_at)}
                </span>
                <p className="min-w-0 flex-1 text-sm break-words whitespace-pre-wrap">
                  {log.memo}
                </p>
              </div>
            ))}
          </div>
        </section>
      ))}

      {!reachedEnd && (
        <button
          type="button"
          onClick={() => {
            // loading は effect 本体での同期 setState を避けるためクリック時に立てる
            // （effect 内の setState は react-hooks/set-state-in-effect に抵触）。
            setLoading(true)
            setLoadToken((t) => t + 1)
          }}
          disabled={loading}
          className="glass flex min-h-11 items-center justify-center gap-2 rounded-2xl px-4 text-sm font-medium text-muted-foreground shadow-lg shadow-black/[0.04] transition-colors duration-200 hover:text-foreground disabled:opacity-50"
        >
          {loading ? (
            <>
              <Loader2 size={16} className="animate-spin" />
              読み込み中...
            </>
          ) : (
            "もっと見る"
          )}
        </button>
      )}

      {composeSheet}
    </div>
  )
}
