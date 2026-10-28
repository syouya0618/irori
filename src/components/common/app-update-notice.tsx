"use client"

import { useId, useState } from "react"
import { RefreshCw, TriangleAlert } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  describeLocalWork,
  hasLocalWork,
  summarizeLocalWork,
} from "@/lib/domain/local-work"
import type { SaveOwner } from "@/lib/domain/save-attempt"
import { useAppVersion } from "@/lib/pwa/use-app-version"

/** 端末の未確定作業を確かめられぬ時（保存領域が読めぬ・持ち主が分からぬ）の一文 */
export const LOCAL_WORK_UNKNOWN_MESSAGE =
  "この端末に書きかけや計測中のものが残っているか確認できませんでした"

/** 更新の前に読む注意（読み直しの意味と、OS 側の表示の別保証） */
export const UPDATE_RELOAD_NOTE =
  "読み直すと新しい版の画面になります。ホーム画面のアイコンや名前は、端末が独自の間隔で更新します。"

function defaultReload() {
  window.location.reload()
}

type Confirm = { kind: "work"; text: string } | { kind: "unknown" } | null

/**
 * 「読み直して更新する」の操作。押した時だけ読み直す（自動ではせぬ）。
 *
 * 端末に書きかけ・計測・保存を確認中のものがある時（contract §5 の summarizeLocalWork）は、
 * まずその旨を出し、利用者に選ばせる。読み直しても端末保存から戻る作りじゃが、送信中の操作の
 * 応答を取りこぼしうるゆえ「確認が済んでから」を勧める。確かめられぬ時（保存領域を読めぬ・
 * 持ち主が分からぬ）も「何も無い」とは言わず、同じく確認を挟む。
 */
export function UpdateAction({
  owner,
  onReload = defaultReload,
}: {
  owner: SaveOwner | null
  onReload?: () => void
}) {
  const [confirm, setConfirm] = useState<Confirm>(null)
  const descId = useId()

  const handleUpdate = () => {
    if (owner === null) {
      setConfirm({ kind: "unknown" })
      return
    }
    const summary = summarizeLocalWork(owner)
    if (hasLocalWork(summary)) {
      const text = describeLocalWork(summary) ?? LOCAL_WORK_UNKNOWN_MESSAGE
      setConfirm({ kind: "work", text: summary.storageReadable ? text : `${text}。${LOCAL_WORK_UNKNOWN_MESSAGE}` })
      return
    }
    if (!summary.storageReadable) {
      setConfirm({ kind: "unknown" })
      return
    }
    onReload()
  }

  if (confirm !== null) {
    return (
      <div
        role="group"
        aria-label="更新の前の確認"
        aria-describedby={descId}
        className="flex flex-col gap-2 rounded-xl bg-muted/60 p-3"
      >
        <div id={descId} className="flex flex-col gap-1 text-sm">
          <p className="flex items-start gap-2 font-medium text-foreground">
            <TriangleAlert size={16} className="mt-0.5 shrink-0 text-primary" aria-hidden="true" />
            {confirm.kind === "work" ? confirm.text : LOCAL_WORK_UNKNOWN_MESSAGE}
          </p>
          <p className="text-muted-foreground">
            保存を確認中のものがあれば、確認が終わってから更新すると安心です。端末に保存できた書きかけと計測は、読み直した後も戻ります。
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => setConfirm(null)}
            autoFocus
            className="min-h-11 flex-1 cursor-pointer"
          >
            あとで
          </Button>
          <Button type="button" onClick={onReload} className="min-h-11 flex-1 cursor-pointer">
            それでも更新する
          </Button>
        </div>
      </div>
    )
  }

  return (
    <Button
      type="button"
      onClick={handleUpdate}
      className="min-h-11 w-full cursor-pointer"
    >
      <RefreshCw size={16} aria-hidden="true" />
      読み直して更新する
    </Button>
  )
}

/**
 * 新しい版がある時だけ出す控えめな案内（画面の先頭に置く）。版が同じ・確かめられぬ時は出さぬ。
 * 古い画面のまま新しいサーバへ送って失敗した時（staleClient）も出す。
 *
 * 置き場所: `(main)/layout.tsx` に `owner` を渡して置く想定（統合の主担当が配線）。
 * 設定画面の版の欄（VersionCard）にも同じ操作がある。
 */
export function AppUpdateNotice({
  owner,
  onReload,
}: {
  owner: SaveOwner | null
  onReload?: () => void
}) {
  const { result, staleClient } = useAppVersion()
  const [dismissed, setDismissed] = useState(false)
  const available = staleClient || result?.state === "different"
  if (!available || dismissed) return null
  return (
    <section
      aria-label="新しい版のお知らせ"
      className="glass-subtle mx-4 mt-3 flex flex-col gap-2 rounded-2xl p-3 shadow-lg shadow-black/[0.04]"
    >
      <p className="text-sm font-medium text-foreground">
        {staleClient
          ? "アプリが新しくなっています。読み直すと最新の画面になります"
          : "新しい版が公開されています"}
      </p>
      <p className="text-xs text-muted-foreground">{UPDATE_RELOAD_NOTE}</p>
      <UpdateAction owner={owner} onReload={onReload} />
      <button
        type="button"
        onClick={() => setDismissed(true)}
        className="min-h-11 rounded-lg text-sm text-muted-foreground transition-colors duration-200 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
      >
        今は閉じる
      </button>
    </section>
  )
}
