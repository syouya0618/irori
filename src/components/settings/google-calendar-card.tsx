"use client"

import { useState, useTransition } from "react"
import { toast } from "sonner"
import { CalendarSync, Check, Link2, Loader2, RefreshCw, TriangleAlert } from "lucide-react"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { formatTimeJst, toJstDateString } from "@/lib/utils/date-jst"
import { updateGoogleCalendarSelection } from "@/app/(main)/settings/actions"
// startTransition 内の未処理 reject は error boundary へ bubble する（offline-error.ts）
import { toastOfflineError } from "@/lib/utils/offline-error"

/**
 * Google カレンダー接続カード（計画書 §7 D-4）。
 *
 * ## enum drift 防御（CLAUDE.md の掟）
 * `connection_status` / `sync_status` / `last_error_kind` は **DB 側で増えうる**。
 * migration が増えてクライアントの型が追随しておらぬ間に未知値で throw すると、
 * その行を含む描画が画面ごと倒れる。ゆえに:
 *   - 型は `string` で受け、ラベルは辞書引き + `??` で**既定表示へ退化**させる
 *   - 「異常か否か」の判定は**除外したい値を名指しする denylist**で書く
 *     （`status !== "active"` = active 以外は全て要注意）。allowlist
 *     （`status === "needs_reauth"`）だと DB に新しい異常値が増えた瞬間、
 *     その接続が**無音で健全扱い**になり再連携導線が消える。
 */

export interface GoogleCalendarSubscriptionView {
  id: string
  googleCalendarId: string
  /** Google の表示名。NULL / 空なら `googleCalendarId` へフォールバックする。 */
  summary: string | null
  isSelected: boolean
}

export interface GoogleConnectionView {
  id: string
  googleEmail: string
  /** DB ENUM だが未知値で倒れぬよう素の string で受ける（上記 enum drift 防御）。 */
  connectionStatus: string
  syncStatus: string
  lastErrorKind: string | null
  lastSyncedAt: string | null
  calendars: GoogleCalendarSubscriptionView[]
}

/** OAuth の開始・再接続はどちらも同じ経路（`prompt=consent` ゆえ再同意になる）。 */
const CONNECT_PATH = "/api/google/oauth/start"

/** `?google=<notice>` → 利用者向けの文言。**未知コードは表示せぬ**（退化）。 */
const NOTICE_MESSAGES: Record<string, { tone: "ok" | "warn"; text: string }> = {
  connected: { tone: "ok", text: "Google カレンダーを接続しました。" },
  connected_no_calendars: {
    tone: "warn",
    text: "接続しましたが、カレンダー一覧を取得できませんでした。もう一度接続してください。",
  },
  missing_scope: {
    tone: "warn",
    text: "カレンダーの閲覧が許可されませんでした。同意画面で「カレンダーの表示」にチェックを入れて、もう一度接続してください。",
  },
  no_refresh_token: {
    tone: "warn",
    text: "接続情報を取得できませんでした。もう一度接続してください。",
  },
  csrf: {
    tone: "warn",
    text: "接続に失敗しました。お手数ですが、もう一度接続してください。",
  },
  denied: {
    tone: "warn",
    text: "接続が許可されませんでした。カレンダーを同期するには接続を許可してください。",
  },
  invalid_grant: {
    tone: "warn",
    text: "接続の有効期限が切れていました。もう一度接続してください。",
  },
  network: {
    tone: "warn",
    text: "Google に接続できませんでした。通信状況を確認して、もう一度お試しください。",
  },
  not_configured: {
    tone: "warn",
    text: "Google 連携が設定されていません。管理者にお問い合わせください。",
  },
  save_failed: {
    tone: "warn",
    text: "接続情報の保存に失敗しました。もう一度接続してください。",
  },
  error: {
    tone: "warn",
    text: "接続に失敗しました。もう一度お試しください。",
  },
}

/** `sync_status` のラベル。未知値は「不明」へ退化させる。 */
const SYNC_STATUS_LABELS: Record<string, string> = {
  idle: "待機中",
  syncing: "同期中",
  error: "エラー",
}

/** `last_error_kind` のラベル。未知値は文言を出さぬ（嘘を書かぬ）。 */
const ERROR_KIND_LABELS: Record<string, string> = {
  invalid_grant: "再連携が必要です",
  gone: "同期をやり直しています",
  quota: "同期が混み合っています。しばらくして再度お試しください",
  network: "通信に失敗しました。次回の同期で自動的に再試行します",
  unknown: "同期に失敗しました",
}

/** ISO → 「M/D H:MM」。不正値でも throw せぬ（未同期と同じ扱いへ退化）。 */
function formatSyncedAt(iso: string | null): string {
  if (iso === null || iso.length === 0) return "未同期"
  try {
    const ymd = toJstDateString(iso)
    const [, month, day] = ymd.split("-")
    return `${Number(month)}/${Number(day)} ${formatTimeJst(iso)}`
  } catch {
    // 日付の体裁が崩れるだけの些事で設定画面を倒さぬ。
    return "未同期"
  }
}

function CalendarConnectLink({
  label,
  variant = "outline",
}: {
  label: string
  variant?: "default" | "outline"
}) {
  return (
    // `<Button>` を使わぬのは意図じゃ:
    //   1. base-ui の Button は `render` で `<a>` に差し替えても `role="button"` を
    //      強制するため、**遷移なのにボタンだと読み上げられる**（実測で確認）。
    //      これは Route Handler への GET 遷移ゆえ、素直にリンクであるべきじゃ。
    //   2. `buttonVariants` の基底クラスは shadcn 由来で `transition-all` を含む。
    //      自前の要素なら `transition-colors duration-200` だけで組める。
    // 素の <a> にするのは `<Link>` のプリフェッチが不要（かつ OAuth 開始を
    // 先読みで撃たれては困る）ためでもある。
    <a
      href={CONNECT_PATH}
      className={cn(
        // touch-target = min 44px（globals.css / DESIGN_SYSTEM.md）。
        "touch-target inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-lg px-3 text-sm font-medium transition-colors duration-200",
        variant === "default"
          ? "bg-primary text-primary-foreground hover:bg-primary/80"
          : "border border-border bg-background hover:bg-muted",
      )}
    >
      <Link2 size={16} />
      {label}
    </a>
  )
}

export function GoogleCalendarCard({
  connections,
  notice,
}: {
  connections: GoogleConnectionView[]
  /** `?google=` の値。未知コードは何も出さぬ。 */
  notice: string | null
}) {
  const noticeMessage = notice === null ? undefined : NOTICE_MESSAGES[notice]

  return (
    <Card className="glass">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CalendarSync size={18} />
          Google カレンダー
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {noticeMessage ? (
          <p
            role="status"
            className={cn(
              "rounded-xl px-3 py-2 text-xs",
              noticeMessage.tone === "ok"
                ? "bg-muted/60 text-muted-foreground"
                : "bg-primary/10 text-primary",
            )}
          >
            {noticeMessage.text}
          </p>
        ) : null}

        {connections.length === 0 ? (
          <>
            <p className="text-sm text-muted-foreground">
              Google カレンダーを接続すると、予定がカレンダーに表示されます。
              読み取りのみで、予定を書き換えることはありません。
            </p>
            <CalendarConnectLink label="Google カレンダーを接続" />
          </>
        ) : (
          connections.map((connection) => (
            <GoogleConnectionRow key={connection.id} connection={connection} />
          ))
        )}
      </CardContent>
    </Card>
  )
}

function GoogleConnectionRow({
  connection,
}: {
  connection: GoogleConnectionView
}) {
  const [isSyncing, setIsSyncing] = useState(false)

  // ## denylist（allowlist にするな）
  // 「active 以外は全て要注意」で判定する。DB に新しい異常値が増えても
  // 再連携導線が無音で消えぬ向きじゃ。
  const needsAttention = connection.connectionStatus !== "active"
  const isNeedsReauth = connection.connectionStatus === "needs_reauth"
  const syncStatusLabel =
    SYNC_STATUS_LABELS[connection.syncStatus] ?? "不明"
  const errorMessage =
    connection.lastErrorKind === null
      ? null
      : (ERROR_KIND_LABELS[connection.lastErrorKind] ?? null)

  const handleSyncNow = async () => {
    setIsSyncing(true)
    // 外部 API を経由するため必ずタイムアウトを持たせる（無応答で永久ローディングにせぬ）。
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 30_000)
    try {
      const response = await fetch("/api/google/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connectionId: connection.id }),
        signal: controller.signal,
      })
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          error?: unknown
        } | null
        const message =
          typeof payload?.error === "string"
            ? payload.error
            : "同期に失敗しました"
        toast.error(message)
        return
      }
      toast.success("同期を開始しました")
    } catch (err) {
      const aborted = err instanceof Error && err.name === "AbortError"
      console.error("[google-calendar-card] 同期リクエストに失敗", {
        aborted,
        message: err instanceof Error ? err.message : String(err),
      })
      toast.error(
        aborted ? "同期がタイムアウトしました" : "同期に失敗しました",
      )
    } finally {
      clearTimeout(timeout)
      setIsSyncing(false)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <p className="text-sm font-medium break-all">{connection.googleEmail}</p>
        <p className="text-xs text-muted-foreground">
          最終同期: {formatSyncedAt(connection.lastSyncedAt)}（{syncStatusLabel}）
        </p>
      </div>

      {needsAttention ? (
        // warm orange のバナー（計画書 §D-5）。primary = oklch(0.65 0.19 50)。
        <div className="flex flex-col gap-2 rounded-xl bg-primary/10 px-3 py-3 ring-1 ring-primary/20">
          <p className="flex items-start gap-2 text-sm font-medium text-primary">
            <TriangleAlert size={16} className="mt-0.5 shrink-0" />
            {isNeedsReauth
              ? "再連携が必要です"
              : // 未知の状態でも黙らず、状態名をそのまま見せて再接続を促す。
                `接続の状態を確認してください（${connection.connectionStatus}）`}
          </p>
          <p className="text-xs text-primary/80">
            Google の許可が切れているため、予定を取得できません。もう一度接続してください。
          </p>
          <div className="self-start">
            <CalendarConnectLink label="再接続" variant="default" />
          </div>
        </div>
      ) : errorMessage !== null ? (
        <p className="rounded-xl bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
          {errorMessage}
        </p>
      ) : null}

      {connection.calendars.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          カレンダー一覧を取得できていません。もう一度接続してください。
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-muted-foreground">
            同期するカレンダーを選んでください。
          </p>
          <div className="flex flex-col gap-1.5">
            {connection.calendars.map((calendar) => (
              <CalendarToggle key={calendar.id} calendar={calendar} />
            ))}
          </div>
        </div>
      )}

      <Button
        type="button"
        variant="outline"
        size="lg"
        onClick={handleSyncNow}
        disabled={isSyncing}
        className="touch-target cursor-pointer self-start"
      >
        {isSyncing ? (
          <Loader2 size={16} className="animate-spin" />
        ) : (
          <RefreshCw size={16} />
        )}
        今すぐ同期
      </Button>
    </div>
  )
}

function CalendarToggle({
  calendar,
}: {
  calendar: GoogleCalendarSubscriptionView
}) {
  const [isSelected, setIsSelected] = useState(calendar.isSelected)
  const [isPending, startTransition] = useTransition()

  // summary は nullable（fail-soft）。空なら Google のカレンダー ID を出す。
  const label =
    calendar.summary !== null && calendar.summary.trim().length > 0
      ? calendar.summary
      : calendar.googleCalendarId

  const handleToggle = () => {
    const next = !isSelected
    setIsSelected(next)

    startTransition(async () => {
      try {
        const result = await updateGoogleCalendarSelection(calendar.id, next)
        if (result.error) {
          toast.error(result.error)
          setIsSelected(!next)
        }
      } catch (err) {
        // reject は「サーバーへ届いてすらいない」= result.error より確実に未反映ゆえ、
        // 業務エラー時と同じ巻き戻しを行う（選択が保存済みに見える嘘を残さない）。
        setIsSelected(!next)
        toastOfflineError(
          "[google-calendar-card] updateGoogleCalendarSelection",
          err,
        )
      }
    })
  }

  return (
    <button
      type="button"
      role="switch"
      aria-checked={isSelected}
      onClick={handleToggle}
      disabled={isPending}
      className={cn(
        // min-h-11 = 44px（DESIGN_SYSTEM.md のタッチターゲット最小）。
        // transition は **colors のみ**（transition-all は禁止）。
        "flex min-h-11 items-center justify-between gap-2 rounded-xl px-3 py-2 text-sm transition-colors duration-200",
        isSelected
          ? "bg-primary/10 text-primary ring-1 ring-primary/20"
          : "bg-muted/50 text-muted-foreground",
      )}
    >
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      {isSelected ? <Check size={16} className="shrink-0" /> : null}
    </button>
  )
}
