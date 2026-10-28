"use client"

import Link from "next/link"
import { BookOpen, ChevronRight, History, PenLine, RotateCw, TriangleAlert } from "lucide-react"
import { Button } from "@/components/ui/button"
import { HomeFoldToggle, HomeFoldedRow } from "./baby-collapsible-section"
import type { BabyDiaryData } from "@/lib/types/baby"

interface BabyDailyDiaryProps {
  /** 選択日の日記（無ければ null）。1日1本。 */
  diary: BabyDiaryData | null
  isToday: boolean
  /**
   * 選択日の日記を取得中。本文も「日記を書く」も出さぬ（前の日の本文を新しい日の
   * 下書きにせぬため。レビュー P2-4）
   */
  loading?: boolean
  /**
   * 選択日の日記を読み込めなかった（2026-10-27）。「日記を書く」（＝日記が無い）とは言わず、
   * 失敗と再読み込みを出す。書く・編集の導線も出さぬ（前の日の本文を残さぬ W-1 と同じ門）
   */
  failed?: boolean
  onRetry?: () => void
  /** この日の下書きがこの端末に残っておる（畳まず、その旨を出す） */
  hasDraft?: boolean
  /** 日記の編集シートを開く（既存本文の編集 / 新規作成の両方） */
  onEdit: () => void
  /** 畳んでおるか（ホームの任意の折り畳み。省略時は畳めぬ） */
  folded?: boolean
  onFoldChange?: (folded: boolean) => void
}

/**
 * その日の育児日記（ぴよログ流の1日1本）。日末（タイムラインの下）に全文を
 * 常時表示する。切り詰め（line-clamp）はしない。タップで編集シートを開く。
 * 日付キーの機能ゆえ過去日の日記も書ける（isToday はタイトル表示にのみ使う）。
 */
export function BabyDailyDiary({
  diary,
  isToday,
  loading = false,
  failed = false,
  onRetry,
  hasDraft = false,
  onEdit,
  folded = false,
  onFoldChange,
}: BabyDailyDiaryProps) {
  const title = isToday ? "今日の育児日記" : "育児日記"
  // 復元できる下書き・読み込みの失敗は畳まぬ（畳んで隠さぬ）
  if (folded && onFoldChange && !hasDraft && !failed) {
    return (
      <HomeFoldedRow
        title={title}
        summary={loading ? "読み込み中" : diary ? diary.content.split("\n")[0] : "まだ書いていません"}
        icon={<BookOpen size={20} />}
        onExpand={() => onFoldChange(false)}
      />
    )
  }
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between px-1">
        <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
          {title}
        </h2>
        <div className="flex items-center">
          {/* 空の日でも過去日記の閲覧入口を常在させる（/baby/diary 一覧へ） */}
          <Link
            href="/baby/diary"
            className="flex min-h-11 items-center gap-0.5 px-1 text-xs text-muted-foreground transition-colors duration-200 hover:text-foreground"
          >
            <BookOpen size={13} className="shrink-0" />
            すべて
            <ChevronRight size={13} className="shrink-0" />
          </Link>
          {onFoldChange && !hasDraft && !failed && (
            <HomeFoldToggle title="育児日記" onFold={() => onFoldChange(true)} />
          )}
        </div>
      </div>

      <div className="glass rounded-2xl shadow-lg shadow-black/[0.04]">
        {loading ? (
          <div
            role="status"
            aria-label="日記を読み込み中"
            className="flex min-h-11 items-center p-4"
          >
            <div className="h-3 w-2/3 animate-pulse rounded bg-muted-foreground/15" />
          </div>
        ) : failed ? (
          // role は status（記録の取得失敗はタイムラインが alert で知らせる。重ねて割り込ませぬ）
          <div role="status" className="flex flex-col items-start gap-2 p-4">
            <p className="flex items-start gap-2 text-sm text-muted-foreground">
              <TriangleAlert size={16} className="mt-0.5 shrink-0 text-destructive" aria-hidden="true" />
              この日の日記を読み込めませんでした（日記がないとは限りません）
            </p>
            {onRetry && (
              <Button
                type="button"
                variant="outline"
                onClick={onRetry}
                aria-label="日記をもう一度読み込む"
                className="min-h-11"
              >
                <RotateCw size={16} />
                もう一度読み込む
              </Button>
            )}
          </div>
        ) : diary ? (
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
        {hasDraft && !loading && !failed && (
          <p className="flex items-center gap-1.5 border-t border-border/40 px-4 py-2 text-xs text-muted-foreground">
            <History size={13} className="shrink-0" aria-hidden="true" />
            この端末に保存していない下書きがあります（開くと戻せます）
          </p>
        )}
      </div>
    </div>
  )
}
