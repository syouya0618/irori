"use client"

import { Info, Loader2 } from "lucide-react"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { UpdateAction, UPDATE_RELOAD_NOTE } from "@/components/common/app-update-notice"
import { useAppVersion } from "@/lib/pwa/use-app-version"
import { clientBuildId, DEV_BUILD_ID } from "@/lib/release/build-info"
import { RELEASE_HIGHLIGHTS, RELEASE_NAME } from "@/lib/release/release-notes"
import type { SaveOwner } from "@/lib/domain/save-attempt"
import type { VersionCheckResult } from "@/lib/pwa/app-version"

function buildLabel(id: string): string {
  return id === DEV_BUILD_ID ? "開発用の版（識別子なし）" : id
}

/** サーバの版の欄の文言。取得できなかったことを「最新です」と言い換えぬ */
function serverStatusText(result: VersionCheckResult | null): string {
  if (result === null) return "確認しています…"
  if (result.state === "same") return "この端末の版と同じです"
  if (result.state === "different") return "新しい版が公開されています"
  switch (result.reason) {
    case "dev-build":
      return "開発用の版のため、比べられません"
    case "gate":
      return "ログイン状態を確認できなかったため、確かめられませんでした"
    case "timeout":
      return "時間内に応答がなく、確かめられませんでした"
    default:
      return "確かめられませんでした（通信の状態をご確認ください）"
  }
}

/**
 * 設定 > ヘルプとアカウントの「このアプリの版」（2026-10-27 大型更新 E1）。
 *
 * リリース名・この端末が読んでおる build（ビルド時に埋め込んだ短い SHA）・いま公開中の build
 * （/api/version）・利用者向けの変更点を出す。branch 名・環境名・利用者の情報は出さぬ。
 * 新しい版がある時は UpdateAction（押した時だけ読み直す。書きかけ等があれば先に確認）を出す。
 */
export function VersionCard({ owner }: { owner: SaveOwner | null }) {
  const { result, checking, staleClient, recheck } = useAppVersion()
  const client = clientBuildId()
  const available = staleClient || result?.state === "different"

  return (
    <Card className="glass">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Info size={18} aria-hidden="true" />
          このアプリの版
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-sm font-medium">{RELEASE_NAME}</p>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          <dt className="text-muted-foreground">この端末の版</dt>
          <dd className="font-mono tabular-nums" data-testid="client-build-id">
            {buildLabel(client)}
          </dd>
          <dt className="text-muted-foreground">公開中の版</dt>
          <dd aria-live="polite" data-testid="server-build-status">
            {result?.serverBuildId && result.state !== "unknown" ? (
              <span className="font-mono tabular-nums">{result.serverBuildId} </span>
            ) : null}
            <span className={result?.serverBuildId && result.state !== "unknown" ? "text-muted-foreground" : undefined}>
              {staleClient ? "新しい版が公開されています" : serverStatusText(result)}
            </span>
          </dd>
        </dl>

        {available ? (
          <div className="flex flex-col gap-2">
            <p className="text-xs text-muted-foreground">{UPDATE_RELOAD_NOTE}</p>
            <UpdateAction owner={owner} />
          </div>
        ) : (
          <Button
            type="button"
            variant="outline"
            onClick={recheck}
            disabled={checking}
            className="min-h-11 w-full cursor-pointer"
          >
            {checking && <Loader2 size={16} className="animate-spin" aria-hidden="true" />}
            新しい版を確かめる
          </Button>
        )}

        <div className="flex flex-col gap-1">
          <h3 className="text-sm font-medium">この更新のおもな変更</h3>
          <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-muted-foreground">
            {RELEASE_HIGHLIGHTS.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      </CardContent>
    </Card>
  )
}
