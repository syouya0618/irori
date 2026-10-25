"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import {
  CalendarSync,
  Check,
  CircleAlert,
  CircleCheck,
  Link2,
  Loader2,
  RefreshCw,
  RotateCw,
  TriangleAlert,
} from "lucide-react"
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
import { interpretSyncResponse, type SyncOutcome } from "./google-sync-outcome"

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
 *
 * ## 「同期」の言い分け
 * `/api/google/sync` は同期が**終わるまで待って**から `{ ok, summary }` を返す。
 * ゆえに「同期を開始しました」とは言わぬ（以前の文言は事実と違った）。summary を読み、
 * 完了・一部失敗・再接続が必要・別の同期が実行中を分けて伝える（google-sync-outcome.ts）。
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
  /**
   * カレンダー一覧を**読めなかった**（＝一覧が空とは限らぬ）。空と混ぜると
   * 「もう一度接続してください」と要らぬ再接続へ誘う。
   */
  calendarsUnknown?: boolean
}

/** OAuth の開始・再接続はどちらも同じ経路（`prompt=consent` ゆえ再同意になる）。 */
const CONNECT_PATH = "/api/google/oauth/start"

/**
 * `?google=<notice>` → 利用者向けの文言。**未知コードは表示せぬ**（退化）。
 * `retry` は「もう一度接続」で直る見込みがあるか（設定不備は利用者には直せぬ）。
 */
const NOTICE_MESSAGES: Record<
  string,
  { tone: "ok" | "warn"; text: string; retry: boolean }
> = {
  connected: { tone: "ok", text: "Google カレンダーを接続しました。", retry: false },
  connected_no_calendars: {
    tone: "warn",
    text: "接続しましたが、カレンダー一覧を取得できませんでした。もう一度接続してください。",
    retry: true,
  },
  missing_scope: {
    tone: "warn",
    text: "カレンダーの閲覧が許可されませんでした。同意画面で「カレンダーの表示」にチェックを入れて、もう一度接続してください。",
    retry: true,
  },
  no_refresh_token: {
    tone: "warn",
    text: "接続情報を取得できませんでした。もう一度接続してください。",
    retry: true,
  },
  csrf: {
    tone: "warn",
    text: "接続に失敗しました。お手数ですが、もう一度接続してください。",
    retry: true,
  },
  denied: {
    tone: "warn",
    text: "接続が許可されませんでした。カレンダーを同期するには接続を許可してください。",
    retry: true,
  },
  invalid_grant: {
    tone: "warn",
    text: "接続の有効期限が切れていました。もう一度接続してください。",
    retry: true,
  },
  network: {
    tone: "warn",
    text: "Google に接続できませんでした。通信状況を確認して、もう一度お試しください。",
    retry: true,
  },
  not_configured: {
    tone: "warn",
    text: "Google 連携が設定されていません。管理者にお問い合わせください。",
    retry: false,
  },
  save_failed: {
    tone: "warn",
    text: "接続情報の保存に失敗しました。もう一度接続してください。",
    retry: true,
  },
  error: {
    tone: "warn",
    text: "接続に失敗しました。もう一度お試しください。",
    retry: true,
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

/**
 * 接続の状態の札。**denylist**: active 以外は全て「再接続が必要」側へ倒す。
 * active でも直近の失敗（last_error_kind）があれば「同期エラー」。
 */
type ConnectionBadge = "connected" | "reauth" | "error" | "syncing"

function connectionBadgeOf(c: GoogleConnectionView): ConnectionBadge {
  if (c.connectionStatus !== "active") return "reauth"
  if (c.lastErrorKind !== null) return "error"
  if (c.syncStatus === "syncing") return "syncing"
  return "connected"
}

const BADGE_LABEL: Record<ConnectionBadge, string> = {
  connected: "接続済み",
  reauth: "再接続が必要",
  error: "同期エラー",
  syncing: "同期中",
}

/**
 * route に届かなんだ応答の振り分け（export-card.tsx と同じ規則）。
 * - `"unauthenticated"`: route 自身の 401（route は 401 を**未認証の時だけ**返す。UX-03）
 * - `"redirected"`: proxy の 307（opaqueredirect / status 0 / 3xx）。proxy は未認証なら
 *   /login、未承認**または profiles の一過性の取得失敗**なら /pending-approval へ送るゆえ、
 *   原因を断定せず再読み込みを促す（N1。再読み込みで proxy が正しく振り分ける）
 */
type GateOutcome = "unauthenticated" | "redirected" | null

function gateOutcome(response: Response): GateOutcome {
  if (response.status === 401) return "unauthenticated"
  if (
    response.type === "opaqueredirect" ||
    response.status === 0 ||
    (response.status >= 300 && response.status < 400)
  ) {
    return "redirected"
  }
  return null
}

const GATE_MESSAGES: Record<Exclude<GateOutcome, null>, string> = {
  unauthenticated: "セッションが切れました。ログインし直してください",
  redirected: "ログイン状態を確認できませんでした。画面を再読み込みしてください",
}

/**
 * サーバが文言を返さなんだ失敗の既定文言（route の 403 / 5xx は素のテキストを返す）。
 * - 403: route が未承認・世帯なしと判定した（ログインし直しても直らぬ）
 * - 5xx: サーバ側の障害（一過性の取得失敗は 503）。待てば直る側じゃ
 */
function syncFailureMessage(status: number): string {
  if (status === 403) {
    return "このアカウントでは同期できません（承認されていないか、世帯に参加していません）"
  }
  if (status >= 500) {
    return "同期に失敗しました。時間をおいてもう一度お試しください"
  }
  return "同期に失敗しました"
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
          ? // hover は薄めず暗く（bg-primary/80 は白文字 3.5:1。--primary-hover は 6.3:1。ui/button と同じ）
            "bg-primary text-primary-foreground hover:bg-primary-hover"
          : "border border-border bg-background hover:bg-muted",
      )}
    >
      <Link2 size={16} aria-hidden="true" />
      {label}
    </a>
  )
}

export function GoogleCalendarCard({
  connections,
  notice,
  connectionsUnknown = false,
}: {
  connections: GoogleConnectionView[]
  /** `?google=` の値。未知コードは何も出さぬ。 */
  notice: string | null
  /** 接続を**読めなかった**（＝未接続とは限らぬ）。接続ボタンを出さず再読み込みを促す。 */
  connectionsUnknown?: boolean
}) {
  const router = useRouter()
  const noticeMessage = notice === null ? undefined : NOTICE_MESSAGES[notice]

  return (
    <Card className="glass">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CalendarSync size={18} aria-hidden="true" />
          Google カレンダー
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {noticeMessage ? (
          <div
            role="status"
            className={cn(
              "flex flex-col gap-2 rounded-xl px-3 py-2 text-sm",
              noticeMessage.tone === "ok"
                ? "bg-muted/60 text-muted-foreground"
                : "bg-primary/10 text-primary",
            )}
          >
            <p className="flex items-start gap-2">
              {noticeMessage.tone === "ok" ? (
                <CircleCheck size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
              ) : (
                <TriangleAlert size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
              )}
              {noticeMessage.text}
            </p>
            {/* 失敗の通知には、その場で直す一手を添える（画面の下まで探させぬ） */}
            {noticeMessage.tone === "warn" &&
              noticeMessage.retry &&
              connections.length > 0 && (
                <div className="self-start">
                  <CalendarConnectLink label="もう一度接続する" variant="default" />
                </div>
              )}
          </div>
        ) : null}

        {connectionsUnknown ? (
          // ⚠️ 読めなかった接続を「未接続」と描かぬ。未接続と偽れば接続ボタンを押させ、
          // 既に在る接続の上に同意をやり直させることになる。
          <div
            role="alert"
            className="flex flex-col items-start gap-2 rounded-xl bg-muted/60 px-3 py-3 text-sm text-muted-foreground"
          >
            <p className="flex items-start gap-2">
              <TriangleAlert size={16} className="mt-0.5 shrink-0 text-destructive" aria-hidden="true" />
              接続の状態を取得できませんでした。未接続とは限りません。
            </p>
            <Button
              type="button"
              variant="outline"
              onClick={() => router.refresh()}
              className="cursor-pointer"
            >
              <RotateCw size={16} />
              再読み込み
            </Button>
          </div>
        ) : connections.length === 0 ? (
          <div className="flex flex-col gap-3">
            <p className="flex items-center gap-2 text-sm">
              <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                未接続
              </span>
              接続すると、Google の予定が予定画面に並びます。
            </p>
            {/* 読み取りのみであることは接続前に知らせる（接続後は札と一覧が状態を語る） */}
            <p className="text-xs text-muted-foreground">
              読み取りのみで、Google 側の予定を書き換えることはありません。
            </p>
            <CalendarConnectLink label="Google カレンダーを接続" />
          </div>
        ) : (
          connections.map((connection) => (
            <GoogleConnectionRow
              key={connection.id}
              connection={connection}
              onSynced={() => router.refresh()}
            />
          ))
        )}
      </CardContent>
    </Card>
  )
}

function GoogleConnectionRow({
  connection,
  onSynced,
}: {
  connection: GoogleConnectionView
  /** 同期の往復が終わった（最終同期時刻・状態を取り直す）。 */
  onSynced: () => void
}) {
  const [isSyncing, setIsSyncing] = useState(false)
  // 直近の「今すぐ同期」の結果。toast は消えるゆえ、カードにも残す。
  const [lastOutcome, setLastOutcome] = useState<SyncOutcome | null>(null)

  // ## denylist（allowlist にするな）
  // 「active 以外は全て要注意」で判定する。DB に新しい異常値が増えても
  // 再連携導線が無音で消えぬ向きじゃ。
  const needsAttention = connection.connectionStatus !== "active"
  const isNeedsReauth = connection.connectionStatus === "needs_reauth"
  const badge = connectionBadgeOf(connection)
  const syncStatusLabel =
    SYNC_STATUS_LABELS[connection.syncStatus] ?? "不明"
  const errorMessage =
    connection.lastErrorKind === null
      ? null
      : (ERROR_KIND_LABELS[connection.lastErrorKind] ?? null)
  // 選択はトグルの楽観更新と同じ値を見る（props は revalidate まで古い）。
  // 失敗で巻き戻ればここも戻るゆえ、見出しの件数と同期結果の解釈がずれぬ。
  const [selection, setSelection] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(connection.calendars.map((c) => [c.id, c.isSelected])),
  )
  const selectedCount = connection.calendars.filter(
    (c) => selection[c.id] ?? c.isSelected,
  ).length
  // 一覧を読めなかった時は件数が分からぬ（0 と混ぜると失敗を「選ばれていない」と言う）
  const knownSelectedCount = connection.calendarsUnknown ? null : selectedCount

  const report = (outcome: SyncOutcome) => {
    setLastOutcome(outcome)
    if (outcome.tone === "ok") toast.success(outcome.text)
    else if (outcome.tone === "warn") toast.warning(outcome.text)
    else toast.error(outcome.text)
  }

  const handleSyncNow = async () => {
    setIsSyncing(true)
    setLastOutcome(null)
    // 外部 API を経由するため必ずタイムアウトを持たせる（無応答で永久ローディングにせぬ）。
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 30_000)
    try {
      const response = await fetch("/api/google/sync", {
        method: "POST",
        // ⚠️ 承認ゲートの 307 を追わせぬ（追うと login 画面の 200 を成功と誤読する）。
        redirect: "manual",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connectionId: connection.id }),
        signal: controller.signal,
      })
      const gate = gateOutcome(response)
      if (gate !== null) {
        console.error("[google-calendar-card] 認証・承認の門で同期に届かず", {
          gate,
          status: response.status,
          type: response.type,
        })
        report({ tone: "error", text: GATE_MESSAGES[gate] })
        return
      }
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          error?: unknown
        } | null
        const message =
          typeof payload?.error === "string"
            ? payload.error
            : syncFailureMessage(response.status)
        console.error("[google-calendar-card] 同期の要求が失敗", {
          status: response.status,
        })
        report({ tone: "error", text: message })
        return
      }
      // 成功と言ってよいのは route が `{ ok: true }` を返した時だけじゃ（嘘の成功を出さぬ）。
      const body = (await response.json().catch((err: unknown) => {
        console.error("[google-calendar-card] 同期の応答を JSON として読めず", {
          status: response.status,
          message: err instanceof Error ? err.message : String(err),
        })
        return null
      })) as { ok?: unknown } | null
      if (body?.ok !== true) {
        if (body !== null) {
          console.error("[google-calendar-card] 同期の応答が ok ではない", {
            status: response.status,
          })
        }
        report({ tone: "error", text: "同期に失敗しました" })
        return
      }
      // 同期は route の中で終わっておる。内訳で完了・一部失敗・再接続を言い分ける
      report(interpretSyncResponse(body, connection.id, knownSelectedCount))
      // 最終同期時刻と接続の状態はサーバの行が真値じゃ。取り直して描き直す
      onSynced()
    } catch (err) {
      const aborted = err instanceof Error && err.name === "AbortError"
      console.error("[google-calendar-card] 同期リクエストに失敗", {
        aborted,
        message: err instanceof Error ? err.message : String(err),
      })
      report({
        tone: "error",
        text: aborted ? "同期がタイムアウトしました" : "同期に失敗しました",
      })
    } finally {
      clearTimeout(timeout)
      setIsSyncing(false)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="text-sm font-medium break-all">{connection.googleEmail}</p>
          <p className="text-xs text-muted-foreground">
            最終同期: {formatSyncedAt(connection.lastSyncedAt)}（{syncStatusLabel}）
          </p>
        </div>
        <span
          className={cn(
            "flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
            badge === "connected"
              ? "bg-muted text-muted-foreground"
              : "bg-primary/10 text-primary",
          )}
        >
          {badge === "connected" ? (
            <CircleCheck size={12} aria-hidden="true" />
          ) : badge === "syncing" ? (
            <Loader2 size={12} className="animate-spin" aria-hidden="true" />
          ) : (
            <CircleAlert size={12} aria-hidden="true" />
          )}
          {BADGE_LABEL[badge]}
        </span>
      </div>

      {needsAttention ? (
        // warm orange のバナー（計画書 §D-5）。primary の値は globals.css の --primary が正本。
        <div className="flex flex-col gap-2 rounded-xl bg-primary/10 px-3 py-3 ring-1 ring-primary/20">
          <p className="flex items-start gap-2 text-sm font-medium text-primary">
            <TriangleAlert size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
            {isNeedsReauth
              ? "再連携が必要です"
              : // 未知の状態でも黙らず、状態名をそのまま見せて再接続を促す。
                `接続の状態を確認してください（${connection.connectionStatus}）`}
          </p>
          <p className="text-xs text-primary/80">
            Google の許可が切れているため、予定を取得できません。もう一度接続してください。
            同じ Google アカウントで許可し直せば、選んだカレンダーはそのまま使えます。
          </p>
          <div className="self-start">
            <CalendarConnectLink label="再接続" variant="default" />
          </div>
        </div>
      ) : errorMessage !== null ? (
        <p className="flex items-start gap-2 rounded-xl bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
          <CircleAlert size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
          {errorMessage}
        </p>
      ) : null}

      {connection.calendarsUnknown ? (
        <p className="flex items-start gap-2 text-xs text-muted-foreground">
          <TriangleAlert size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
          カレンダーの一覧を読み込めませんでした。画面を再読み込みしてください（接続し直す必要はありません）。
        </p>
      ) : connection.calendars.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          カレンダー一覧を取得できていません。もう一度接続してください。
        </p>
      ) : (
        <fieldset className="flex flex-col gap-2">
          <legend className="text-xs font-medium text-muted-foreground">
            同期するカレンダー（{connection.calendars.length}件中{selectedCount}件）
          </legend>
          <div className="flex flex-col gap-1.5">
            {connection.calendars.map((calendar) => (
              <CalendarToggle
                key={calendar.id}
                calendar={calendar}
                isSelected={selection[calendar.id] ?? calendar.isSelected}
                setIsSelected={(next) =>
                  setSelection((prev) => ({ ...prev, [calendar.id]: next }))
                }
              />
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            選択の変更は次の同期から予定画面に反映されます。
          </p>
        </fieldset>
      )}

      {/* 再接続待ちの接続は同期の対象外（syncHousehold が外す）。押しても何も起きぬ
          ボタンは出さず、上の「再接続」だけを道にする */}
      {!isNeedsReauth && (
      <div className="flex flex-col gap-2">
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
          {isSyncing ? "同期中…" : "今すぐ同期"}
        </Button>
        {/* 結果は文言で残す（toast は数秒で消える）。tone は色だけでなくアイコンでも示す */}
        {lastOutcome && (
          <p
            aria-live="polite"
            className={cn(
              "flex items-start gap-2 text-xs",
              lastOutcome.tone === "ok" ? "text-muted-foreground" : "text-primary",
              lastOutcome.tone === "error" && "text-destructive",
            )}
          >
            {lastOutcome.tone === "ok" ? (
              <CircleCheck size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
            ) : (
              <CircleAlert size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
            )}
            {lastOutcome.text}
          </p>
        )}
      </div>
      )}
    </div>
  )
}

function CalendarToggle({
  calendar,
  isSelected,
  setIsSelected,
}: {
  calendar: GoogleCalendarSubscriptionView
  /** 選択の状態は行（GoogleConnectionRow）が持つ。件数の見出しと同期結果の解釈が同じ値を見る。 */
  isSelected: boolean
  setIsSelected: (next: boolean) => void
}) {
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
      aria-busy={isPending || undefined}
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
      {/* 状態は印の有無と文字でも示す（色だけに頼らぬ） */}
      <span className="flex shrink-0 items-center gap-1 text-xs">
        {isPending ? (
          <Loader2 size={14} className="animate-spin" aria-hidden="true" />
        ) : isSelected ? (
          <Check size={16} aria-hidden="true" />
        ) : null}
        <span aria-hidden="true">{isSelected ? "同期する" : "同期しない"}</span>
      </span>
    </button>
  )
}
