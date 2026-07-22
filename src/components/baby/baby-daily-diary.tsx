"use client"

import Link from "next/link"
import { BookOpen, ChevronRight, PenLine } from "lucide-react"
import type { BabyDiaryData } from "@/lib/types/baby"

interface BabyDailyDiaryProps {
  /** 選択日の日記（無ければ null）。1日1本。 */
  diary: BabyDiaryData | null
  isToday: boolean
  /** 日記の編集シートを開く（既存本文の編集 / 新規作成の両方） */
  onEdit: () => void
}

/**
 * その日の育児日記（ぴよログ流の1日1本）。日末（タイムラインの下）に全文を
 * 常時表示する。切り詰め（line-clamp）はしない。タップで編集シートを開く。
 * 日付キーの機能ゆえ過去日の日記も書ける（isToday はタイトル表示にのみ使う）。
 */
export function BabyDailyDiary({ diary, isToday, onEdit }: BabyDailyDiaryProps) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between px-1">
        <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
          {isToday ? "今日の育児日記" : "育児日記"}
        </h2>
        {/* 空の日でも過去日記の閲覧入口を常在させる（/baby/diary 一覧へ） */}
        <Link
          href="/baby/diary"
          className="flex min-h-11 items-center gap-0.5 px-1 text-xs text-muted-foreground transition-colors duration-200 hover:text-foreground"
        >
          <BookOpen size={13} className="shrink-0" />
          すべて
          <ChevronRight size={13} className="shrink-0" />
        </Link>
      </div>

      <div className="glass rounded-2xl shadow-lg shadow-black/[0.04]">
        {diary ? (
          <button
            type="button"
            onClick={onEdit}
            aria-label="日記を編集"
            className="block min-h-11 w-full p-4 text-left transition-colors duration-200 hover:bg-accent/30"
          >
            <p className="text-sm leading-relaxed break-words whitespace-pre-wrap">
              {diary.content}
            </p>
          </button>
        ) : (
          <button
            type="button"
            onClick={onEdit}
            className="flex min-h-11 w-full items-center justify-center gap-2 p-4 text-sm text-muted-foreground transition-colors duration-200 hover:text-foreground"
          >
            <PenLine size={16} className="shrink-0" />
            日記を書く
          </button>
        )}
      </div>
    </div>
  )
}
