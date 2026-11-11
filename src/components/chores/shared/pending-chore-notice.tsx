"use client"

import { useId, useState } from "react"
import { AlertCircle, CircleHelp, RotateCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  CHORE_UNKNOWN_RETRIES_BEFORE_WITHDRAW,
  type ChorePendingItem,
  type UseChoreSaveResult,
} from "./use-chore-save"

type NoticeSource<P extends object> = Pick<
  UseChoreSaveResult<P>,
  | "pending"
  | "unreadable"
  | "storageOk"
  | "saving"
  | "retry"
  | "discard"
  | "discardUnreadable"
  | "message"
  | "messageTone"
>

/**
 * 保存の結果の文言と、結果不明の控えの一覧（`useChoreSave` の戻り値をそのまま渡す）。
 *
 * - 送信中の控えは並べぬ（押した操作の側が送信中を示す。1 タップごとにカードが明滅せぬよう）
 * - 並ぶのは「保存できたか確認できていない」控えだけ。「同じ操作で確認」は同じ操作 ID・同じ内容を
 *   送り直すゆえ二重にならぬ。**自動では送らぬ**
 * - 破棄は、再送が拒否された控えと、読めぬ控えにだけ出す（2 段の確認。破棄すると、その操作が
 *   保存されたかをこの端末から確かめられなくなる）
 * - 結果不明のままの控えには、通信できる状態での確認が
 *   `CHORE_UNKNOWN_RETRIES_BEFORE_WITHDRAW` 回続けて結果不明に終わった後にだけ「確認をやめる」を
 *   出す（2 段の確認）。出口が無いと、その端末でその機能の保存が全て止まったままになる。
 *   **取り下げは端末の控えを消すだけで、操作は取り消さぬ** — 保存済みのまま同じ操作をやり直すと
 *   新しい ID で二重になりうるゆえ、先に画面の内容で確かめるよう必ず伝える（取り下げの後は
 *   `useChoreSave` が Server の内容を取り直す）
 * - 色だけで示さぬ（アイコン + 文）。`showMessage={false}` で文言を呼び出し側の好きな位置へ出せる
 */
export function PendingChoreNotice<P extends object>({
  save,
  showMessage = true,
}: {
  save: NoticeSource<P>
  showMessage?: boolean
}) {
  const headingId = useId()
  const [confirming, setConfirming] = useState<string | null>(null)
  const waiting = save.pending.filter((entry) => entry.phase === "unknown")
  const message = showMessage ? save.message : ""

  if (!message && waiting.length === 0 && save.unreadable === 0) return null

  return (
    <div className="flex flex-col gap-3">
      {message &&
        (save.messageTone === "alert" ? (
          <p role="alert" className="flex items-start gap-2 text-sm text-foreground">
            <AlertCircle size={16} className="mt-0.5 shrink-0 text-destructive" aria-hidden="true" />
            <span>{message}</span>
          </p>
        ) : (
          <p role="status" className="text-sm text-muted-foreground">
            {message}
          </p>
        ))}

      {!save.storageOk && waiting.length > 0 && (
        <p role="alert" className="text-sm text-foreground">
          この端末に控えを残せていません。保存結果を確認するまで、この画面を閉じないでください。
        </p>
      )}

      {save.unreadable > 0 && (
        <section className="glass flex flex-col gap-2 rounded-2xl p-4 shadow-lg shadow-black/[0.04]">
          <p className="flex items-start gap-2 text-sm">
            <AlertCircle size={16} className="mt-0.5 shrink-0 text-destructive" aria-hidden="true" />
            <span>
              この端末に、読み取れない保存の控えが {save.unreadable} 件あります。新しい保存を止めています。
            </span>
          </p>
          {confirming === "unreadable" ? (
            <>
              <p className="text-sm text-muted-foreground">
                破棄すると、その操作が保存されたかをこの端末から確かめられなくなります。画面の内容で確認してから破棄してください。
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="destructive"
                  disabled={save.saving}
                  onClick={() => {
                    setConfirming(null)
                    save.discardUnreadable()
                  }}
                >
                  破棄する
                </Button>
                <Button type="button" variant="outline" onClick={() => setConfirming(null)}>
                  やめる
                </Button>
              </div>
            </>
          ) : (
            <Button
              type="button"
              variant="outline"
              className="self-start"
              disabled={save.saving}
              onClick={() => setConfirming("unreadable")}
            >
              読み取れない控えを破棄
            </Button>
          )}
        </section>
      )}

      {waiting.length > 0 && (
        <section
          aria-labelledby={headingId}
          className="glass flex flex-col gap-3 rounded-2xl p-4 shadow-lg shadow-black/[0.04]"
        >
          <h2 id={headingId} className="flex items-center gap-2 text-sm font-semibold">
            <CircleHelp size={16} className="shrink-0 text-muted-foreground" aria-hidden="true" />
            保存できたか確認できていない操作
          </h2>
          <p className="text-sm text-muted-foreground">
            「同じ操作で確認」は同じ内容を送り直します。保存済みなら二重にはなりません。
          </p>
          <ul className="flex flex-col gap-3">
            {waiting.map((entry) => (
              <PendingRow
                key={entry.id}
                entry={entry}
                saving={save.saving}
                confirming={confirming === entry.id}
                onConfirming={(on) => setConfirming(on ? entry.id : null)}
                onRetry={() => save.retry(entry)}
                onDiscard={() => {
                  setConfirming(null)
                  save.discard(entry)
                }}
              />
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

function PendingRow<P extends object>({
  entry,
  saving,
  confirming,
  onConfirming,
  onRetry,
  onDiscard,
}: {
  entry: ChorePendingItem<P>
  saving: boolean
  confirming: boolean
  onConfirming: (on: boolean) => void
  onRetry: () => void
  onDiscard: () => void
}) {
  const labelId = useId()
  // 再送が拒否された控えは「破棄」、結果不明が続く控えは「確認をやめる」（どちらも 2 段）
  const stuckUnknown = !entry.retryError && (entry.unknownRetries ?? 0) >= CHORE_UNKNOWN_RETRIES_BEFORE_WITHDRAW
  return (
    <li className="flex flex-col gap-2 border-t border-border/60 pt-3 first:border-t-0 first:pt-0">
      <p id={labelId} className="text-sm font-medium break-words">
        {entry.label}
      </p>
      {entry.retryError && (
        <p className="text-sm text-muted-foreground">
          確認し直しましたが、受け付けられませんでした（{entry.retryError}）。先の操作が保存されている場合があります。
        </p>
      )}
      {stuckUnknown && (
        <p className="text-sm text-muted-foreground">
          確認を繰り返しましたが、保存できたかをまだ確認できていません。通信できる場所で、もう一度「同じ操作で確認」を試すのが安全です。
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="button" disabled={saving} aria-describedby={labelId} onClick={onRetry}>
          <RotateCw size={16} aria-hidden="true" />
          同じ操作で確認
        </Button>
        {entry.retryError && !confirming && (
          <Button
            type="button"
            variant="outline"
            disabled={saving}
            aria-describedby={labelId}
            onClick={() => onConfirming(true)}
          >
            控えを破棄
          </Button>
        )}
        {stuckUnknown && !confirming && (
          <Button
            type="button"
            variant="outline"
            disabled={saving}
            aria-describedby={labelId}
            onClick={() => onConfirming(true)}
          >
            確認をやめる
          </Button>
        )}
      </div>
      {confirming && (
        <>
          {entry.retryError ? (
            <p className="text-sm text-muted-foreground">
              破棄すると、この操作が保存されたかをこの端末から確かめられなくなります。画面の内容で確認してから破棄してください。
            </p>
          ) : (
            <p role="alert" className="flex items-start gap-2 text-sm text-foreground">
              <AlertCircle size={16} className="mt-0.5 shrink-0 text-destructive" aria-hidden="true" />
              <span>
                確認をやめると、この端末の控えだけを消します。操作そのものは取り消されません（保存されていた場合は、そのまま残ります）。消した後は、この操作が保存されたかをこの端末から確かめられません。同じ操作をやり直す前に、必ず画面の内容で保存済みかを確かめてください。保存済みのままやり直すと、二重に記録されることがあります。
              </span>
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="destructive"
              disabled={saving}
              aria-describedby={labelId}
              onClick={onDiscard}
            >
              {entry.retryError ? "破棄する" : "控えを消して確認をやめる"}
            </Button>
            <Button type="button" variant="outline" onClick={() => onConfirming(false)}>
              やめる
            </Button>
          </div>
        </>
      )}
    </li>
  )
}
