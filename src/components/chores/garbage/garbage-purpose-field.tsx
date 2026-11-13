"use client"

import { useEffect, useId, useState } from "react"
import Link from "next/link"
import { CircleHelp, RotateCw, Trash } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  UNCLASSIFIED_PURPOSE,
  type GarbageRequest,
  type ResolvedEventPurpose,
} from "@/lib/domain/garbage"
import { PendingChoreNotice } from "@/components/chores/shared/pending-chore-notice"
import type { ChoreEditSessions, UseChoreSaveResult } from "@/components/chores/shared/use-chore-save"
import { GarbageKindLabel } from "./garbage-kind-icon"
import { GarbagePurposeForm, type GarbageFormTarget } from "./garbage-purpose-form"

interface GarbagePurposeFieldProps {
  target: GarbageFormTarget
  /** 今の用途。未指定は「何も分類しておらぬ」。`unknown` は読めておらぬ */
  purpose: ResolvedEventPurpose | undefined
  save: UseChoreSaveResult<GarbageRequest>
  /**
   * 保存が確定した回数（親が数える）。増えたらフォームを畳む — 保存の結果は親の一覧の取り直しで
   * `purpose` に映る。親は「この欄のフォームから送った操作の応答」だけを数えること（R35）。
   */
  settledCount: number
  /** 分類を読み直す（読めておらぬ時に出す） */
  onReload?: () => void
  /**
   * 分類フォームの編集セッション（R35）。渡すと、フォームを開くたびに新しい番号を振って送信に添え、
   * 閉じる・欄が消える時に終える。親の hook は応答の時に「送ったフォームが今も開いておるか」を比べ、
   * 送った後に閉じた・別の予定（同じ予定の開き直しも）で開いたフォームを畳まぬ。
   */
  sessions?: Pick<ChoreEditSessions, "begin" | "end">
}

/**
 * 予定のシート（編集・Google の詳細）に置く「ごみの日」の欄。
 *
 * 予定の本体とは**別の保存**じゃ（通知の欄と同じ）: 予定の内容は変えず、用途だけを別表へ書く。
 * ゆえに Google の予定（本体は閲覧のみ）でも分類できる。出どころと用途は別の軸。
 *
 * - 今の分類を文字で言う（色・アイコンだけにせぬ）
 * - 分類を読めておらぬ時は、読めぬまま書き換えさせぬ（読み直しを促す）
 * - タイトルからの自動の分類はせぬ（押して選ぶまで何も保存せぬ）
 */
export function GarbagePurposeField({
  target,
  purpose,
  save,
  settledCount,
  onReload,
  sessions,
}: GarbagePurposeFieldProps) {
  const headingId = useId()
  const [open, setOpen] = useState(false)
  // 最後に開いたフォームの編集セッション（畳んだ後も、その保存の結果の文言をこの欄に出すため持つ）
  const [session, setSession] = useState<number | null>(null)
  // 保存が確定したらフォームを畳む（render 中の条件付き setState。effect で同期せぬ）
  const [seenSettled, setSeenSettled] = useState(settledCount)
  if (seenSettled !== settledCount) {
    setSeenSettled(settledCount)
    setOpen(false)
  }

  // 欄が消える（予定のシートを閉じた・別の予定へ移った）・新しいフォームを開いた時に、前のセッションを終える。
  // 親は今のセッションと一致する時だけ終えるゆえ、新しいセッションを開いた後の終了は効かぬ
  useEffect(() => {
    if (session === null || !sessions) return
    return () => sessions.end(session)
  }, [session, sessions])

  function openForm() {
    if (sessions) setSession(sessions.begin())
    setOpen(true)
  }

  function closeForm() {
    if (sessions && session !== null) sessions.end(session)
    setOpen(false)
  }

  // この欄に出す文言: このフォームの操作のもの・どの操作にも属さぬもの・（フォームを畳んでおる間は）
  // この欄の確認の一覧から押した操作のもの。別の予定・閉じたフォームから送った操作の結果は出さぬ
  const showMessage =
    !sessions ||
    save.messageSession === null ||
    (session !== null && save.messageSession === session) ||
    (!open && save.messageSession === undefined)

  const current = purpose ?? UNCLASSIFIED_PURPOSE
  const classified = current.kind === "garbage" || (current.kind === "normal" && current.exception)

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2" data-testid="garbage-purpose-field">
      <h3 id={headingId} className="flex items-center gap-1.5 text-sm font-medium">
        <Trash size={14} aria-hidden="true" />
        ごみの日
      </h3>

      {current.kind === "unknown" ? (
        <div className="flex flex-col items-start gap-2 rounded-xl bg-muted/60 px-3 py-2 text-sm">
          <p className="flex items-start gap-2">
            <CircleHelp size={16} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span>
              ごみの日の分類を読み込めていません（ごみの日ではない、とは限りません）。読み込めるまで変更できません。
            </span>
          </p>
          {onReload && (
            <Button type="button" variant="outline" onClick={onReload} className="cursor-pointer">
              <RotateCw size={16} aria-hidden="true" />
              分類を読み直す
            </Button>
          )}
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-1 text-sm">
            {current.kind === "garbage" ? (
              <>
                <GarbageKindLabel label={current.label} className="text-sm font-medium" />
                <p className="text-xs text-muted-foreground">
                  {current.scope === "series"
                    ? "繰り返しのすべての回に付けた分類です。"
                    : current.seriesLabel !== null
                      ? `この回だけの分類です（ほかの回は「${current.seriesLabel}」）。`
                      : "この予定に付けた分類です。"}
                  {current.reminderOptOut ? " この回の通知は止めています。" : ""}
                </p>
              </>
            ) : current.exception ? (
              <p className="text-sm">
                この回だけ通常の予定に戻しています
                {current.seriesLabel !== null ? `（ほかの回は「${current.seriesLabel}」）` : ""}。
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">ごみの日ではありません。</p>
            )}
          </div>

          {open ? (
            <div className="rounded-xl border border-border/60 p-3">
              <GarbagePurposeForm
                key={session ?? "form"}
                target={target}
                current={current}
                disabled={save.blocked}
                onSubmit={(request, label) => {
                  // 送ったフォームの編集セッションを添える（応答の時、このフォームが今も開いておるかを比べる）
                  if (sessions && session !== null) save.send(request, label, session)
                  else save.send(request, label)
                }}
                onCancel={closeForm}
              />
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={openForm}
                className="cursor-pointer"
              >
                {classified ? "分類を変更・解除" : "ごみの日にする"}
              </Button>
              {classified && (
                <Link
                  href="/chores/garbage"
                  className="flex min-h-11 items-center rounded-lg px-2 text-sm font-medium text-primary transition-colors duration-200 hover:bg-primary/10 focus-visible:outline-2 focus-visible:outline-ring"
                >
                  ごみの一覧を開く
                </Link>
              )}
            </div>
          )}
        </>
      )}

      <PendingChoreNotice save={save} showMessage={showMessage} />
    </section>
  )
}
