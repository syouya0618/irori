"use client"

import { useState, useEffect, useRef } from "react"
import { BookOpen, Loader2, PenLine } from "lucide-react"
import { toast } from "sonner"
import { createClient } from "@/lib/supabase/client"
import { logSupabaseError } from "@/lib/supabase/log-error"
import { todayJstString } from "@/lib/utils/date-jst"
import {
  DIARY_PAGE_SIZE,
  formatDiaryDateHeadingFromYmd,
} from "@/lib/domain/baby-diary"
import { BabyDiaryEditSheet } from "./baby-diary-edit-sheet"
import type { BabyDiaryData } from "@/lib/types/baby"

// 日記一覧で取得するカラム（BabyDiaryData と対応・diary/page.tsx と一致させる）。
const BABY_DIARY_COLUMNS = "id, diary_date, content, updated_at"

interface BabyDiaryViewProps {
  initialDiaries: BabyDiaryData[]
  householdId: string
}

/**
 * 育児日記（1日1本）の一覧ビュー。日付降順に全文表示し、タップでその日の
 * 日記を編集できる。「今日の日記を書く」は当日分の作成/編集への近道。
 *
 * ページネーション掟（CLAUDE.md）:
 * - diary_date は UNIQUE(household_id, diary_date) ゆえ世帯内で一意 —
 *   order("diary_date", desc) だけで全順序が決定化される（tiebreak 不要）。
 * - オフセットは「受領済み件数（diaries.length）」を用いる。サーバの max_rows で
 *   切り詰められても次ページが受領済みの直後から続き、行を無音で飛ばさない。
 * - 終端は「返却0件」でのみ判定する。短いページを終端扱いしない。
 */
export function BabyDiaryView({
  initialDiaries,
  householdId,
}: BabyDiaryViewProps) {
  const [diaries, setDiaries] = useState<BabyDiaryData[]>(initialDiaries)
  // 「もっと見る」押下ごとに増やして追ページ取得の useEffect を発火させるトークン。
  const [loadToken, setLoadToken] = useState(0)
  const [loading, setLoading] = useState(false)
  const [reachedEnd, setReachedEnd] = useState(false)
  // 編集シート（key 再マウントで state を初期化式から再構築する formKey 流儀）。
  const [editOpen, setEditOpen] = useState(false)
  const [editDate, setEditDate] = useState("")
  const [editContent, setEditContent] = useState("")
  const [editKey, setEditKey] = useState(0)

  // 次に取得すべきオフセット = これまでに受領した件数。diaries 更新に追従させる。
  const offsetRef = useRef(initialDiaries.length)
  useEffect(() => {
    offsetRef.current = diaries.length
  }, [diaries])

  // 追ページ取得。loadToken の変化（= ボタン押下）でのみ発火する。
  useEffect(() => {
    if (loadToken === 0) return

    const supabase = createClient()
    const abortController = new AbortController()
    const offset = offsetRef.current

    supabase
      .from("baby_diaries")
      .select(BABY_DIARY_COLUMNS)
      .eq("household_id", householdId)
      .order("diary_date", { ascending: false })
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
        setDiaries((prev) => {
          const seen = new Set(prev.map((d) => d.id))
          const additions = data.filter((d) => !seen.has(d.id))
          return additions.length > 0 ? [...prev, ...additions] : prev
        })
      })

    return () => {
      abortController.abort()
    }
  }, [loadToken, householdId])

  const openEdit = (date: string, content: string) => {
    setEditDate(date)
    setEditContent(content)
    setEditKey((k) => k + 1)
    setEditOpen(true)
  }

  // 保存/削除の反映: 1日1本ゆえ diary_date で置換・除去し、日付降順を保つ。
  const handleSaved = (diary: BabyDiaryData | null) => {
    setDiaries((prev) => {
      if (!diary) return prev.filter((d) => d.diary_date !== editDate)
      const without = prev.filter((d) => d.diary_date !== diary.diary_date)
      return [...without, diary].sort((a, b) =>
        b.diary_date.localeCompare(a.diary_date),
      )
    })
  }

  const today = todayJstString()
  const todayDiary = diaries.find((d) => d.diary_date === today) ?? null

  const writeButton = (
    <button
      type="button"
      onClick={() => openEdit(today, todayDiary?.content ?? "")}
      className="glass flex min-h-11 items-center justify-center gap-2 rounded-2xl px-4 text-sm font-medium text-primary shadow-lg shadow-black/[0.04] transition-colors duration-200 hover:text-primary/80"
    >
      <PenLine size={16} />
      今日の日記を書く
    </button>
  )

  const editSheet = (
    <BabyDiaryEditSheet
      key={editKey}
      open={editOpen}
      onOpenChange={setEditOpen}
      diaryDate={editDate || today}
      initialContent={editContent}
      onSaved={handleSaved}
    />
  )

  if (diaries.length === 0) {
    return (
      <div className="flex flex-col gap-4">
        {writeButton}
        <div className="flex flex-col items-center justify-center gap-3 py-16">
          <BookOpen size={48} className="text-muted-foreground/30" />
          <p className="text-sm text-muted-foreground">まだ日記がありません</p>
        </div>
        {editSheet}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      {writeButton}

      {diaries.map((diary) => (
        <section key={diary.id} className="flex flex-col gap-1">
          <h2 className="px-1 text-sm font-semibold text-muted-foreground">
            {formatDiaryDateHeadingFromYmd(diary.diary_date)}
          </h2>
          <button
            type="button"
            onClick={() => openEdit(diary.diary_date, diary.content)}
            aria-label={`${diary.diary_date} の日記を編集`}
            className="glass block min-h-11 w-full rounded-2xl p-4 text-left shadow-lg shadow-black/[0.04] transition-colors duration-200 hover:bg-accent/30"
          >
            <p className="text-sm leading-relaxed break-words whitespace-pre-wrap">
              {diary.content}
            </p>
          </button>
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

      {editSheet}
    </div>
  )
}
