import { toast } from "sonner"

/**
 * 圏外・不安定な電波下で Server Action が reject した時の共通ハンドリング。
 *
 * ## なぜ必要か
 * `startTransition(async () => { await someAction() })` の中で発生した未処理の
 * reject は、最寄りの error boundary へ bubble する
 * (node_modules/next/dist/docs/01-app/01-getting-started/10-error-handling.md:375
 *  "unhandled errors inside `startTransition` from `useTransition`, will bubble up
 *   to the nearest error boundary")。
 * 圏外タップのたびに画面ごとエラー化し、記録も無言で失われる袋小路になるため、
 * 各ハンドラは reject を try/catch で握ってこのトーストへ倒す。
 *
 * なお `.catch()` の無い floating promise（`void action()` や プレーン async
 * onClick）は **error boundary へは飛ばず、無言の unhandled rejection になる** —
 * 機序は別物だが、ユーザーから見た「無言で失敗する」は同じゆえ同じ文言で扱う。
 *
 * ## 境界指令（"use client"）を付けない理由
 * `sonner` 自体が `"use client"` を持つクライアントモジュールだが、このファイルには
 * 敢えて指令を置かない。`"use client"` を付けると本モジュールがクライアント境界に
 * なり、`OFFLINE_ERROR_MESSAGE` を Server Component から値 import した瞬間に
 * client reference へ差し替わって実行時に壊れる（`next build` も `tsc` も通るため
 * 潜伏する。~/.claude/rules/nextjs-supabase.md の既知の罠）。
 * 指令を持たない中立モジュールなら、import 元（すべて `"use client"` コンポーネント）
 * の境界を継承してクライアントバンドルへ入る。現に Server 側からの import は無い。
 */
export const OFFLINE_ERROR_MESSAGE =
  "通信できませんでした。電波の良い場所でもう一度お試しください"

/**
 * reject を握り潰さずに構造化ログへ残し、圏外トーストを出す。
 *
 * `redirect()` / `notFound()` を投げる Server Action を呼ぶ箇所では、catch の
 * **先頭**で `unstable_rethrow(err)` を呼んでから本関数を呼ぶこと（フレームワークの
 * 内部エラーを握り潰すと遷移が死ぬ）。本関数は rethrow を内包しない — 呼び出し側で
 * ローディング state の巻き戻し等を行う順序を壊さないため。
 *
 * @param context どのファイル・どの Action かがログから一意に分かる文字列。
 *   `"[baby-quick-actions] recordFeeding"` の形で渡す。
 */
export function toastOfflineError(context: string, err: unknown) {
  logOfflineError(context, err)
  toast.error(OFFLINE_ERROR_MESSAGE)
}

/**
 * トーストを出さずにログだけ残す版。
 *
 * ユーザーが叩いていない **バックグラウンド処理**（マウント時の自動チェック、
 * 在庫変更に追随する再計算など）専用。圏外でページを開くたびにトーストが出ると
 * 本来の操作の失敗通知が埋もれるため、通知は「ユーザーが起点の操作」に限る。
 * 握り潰しではない — 出力するログは `toastOfflineError` と同一。
 */
export function logOfflineError(context: string, err: unknown) {
  // 握り潰さずエラー詳細を構造化ログに残す（CLAUDE.md: catch 内でログ必須）。
  console.error(`${context} が例外を投げました`, {
    message: err instanceof Error ? err.message : String(err),
  })
}
