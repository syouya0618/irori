"use client"

import { useState, type ReactNode } from "react"
import { AlertCircle, RotateCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { CHORES_REFRESH_MESSAGES, useChoresRefresh } from "./use-chores-refresh"

/**
 * 画面全体の読み取りに失敗した時の受け皿。**初回の失敗**と**表示済みの画面の取り直しの失敗**を
 * 分ける。
 *
 * ```tsx
 * // page.tsx（Server Component）。読めた時も読めなんだ時も、同じ位置に同じ部品を返す
 * if (!loaded.ok) return <KeepLastGood scope={scope} failure="食材を読み込めませんでした" />
 * return <KeepLastGood scope={scope}><PantryView … /></KeepLastGood>
 * ```
 *
 * - 取り直し（復帰時・定期の再取得・保存後）が失敗した時は、**直前に読めた内容をそのまま描き続け**、
 *   上に「更新できませんでした」を出す。同じ要素を返すゆえ、中の Client Component は unmount されず、
 *   入力中の state（開いたシート・下書き・結果不明の控え）が残る
 * - 直前に読めた内容が無い時（初回の表示・`scope` が替わった時）は throw して、いちばん近い
 *   `error.tsx` へ渡す（「無い」と偽らぬ）
 *
 * **page から throw してはならぬ理由**: error boundary は取り直しの失敗でも子を fallback に
 * 置き換える。React は error boundary の復帰で既存の子を再利用せぬゆえ、boundary の側で直前の
 * 子を描き直しても state は戻らぬ。ゆえに「失敗」を例外ではなく prop で受ける。
 *
 * `scope` は「同じ内容の続き」と言える範囲（利用者・世帯・表示中の週など）。替われば直前の
 * 内容を使わぬ（別の世帯・別の週の内容を、今の画面として出さぬ）。
 */
export function KeepLastGood({
  scope,
  failure,
  children,
}: {
  scope: string
  /** 読めなんだ時だけ渡す、利用者向けの理由（例: 「献立を読み込めませんでした」） */
  failure?: string
  children?: ReactNode
}) {
  const failed = failure !== undefined
  const [last, setLast] = useState<{ scope: string; node: ReactNode } | null>(
    failed ? null : { scope, node: children },
  )
  // 読めた内容を覚える（描画中の state 調整。Server の payload が替わった時だけ走る）
  if (!failed && (last === null || last.scope !== scope || last.node !== children)) {
    setLast({ scope, node: children })
  }
  const { refresh, notice } = useChoresRefresh()

  if (failed && (last === null || last.scope !== scope)) {
    // 出せる内容が無い = 初回の失敗。画面全体の失敗として error.tsx へ
    throw new Error(failure)
  }

  // 2 つの枠（知らせ・内容）の位置を固定する。知らせの有無で内容の位置がずれると作り直される
  return (
    <>
      {failed ? (
        <div
          role="status"
          data-testid="stale-content-notice"
          className="flex flex-col items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-3 text-sm"
        >
          <p className="flex items-start gap-2">
            <AlertCircle size={16} className="mt-0.5 shrink-0 text-destructive" aria-hidden="true" />
            <span>
              最新の内容に更新できませんでした（{failure}）。表示しているのは前回読み込めた内容で、古い場合があります。入力中の内容はそのまま残っています。
            </span>
          </p>
          <Button type="button" variant="outline" className="cursor-pointer" onClick={() => refresh("manual")}>
            <RotateCw size={16} aria-hidden="true" />
            もう一度読み込む
          </Button>
          {notice && notice !== "held" && <p>{CHORES_REFRESH_MESSAGES[notice]}</p>}
        </div>
      ) : null}
      {failed ? last?.node : children}
    </>
  )
}
