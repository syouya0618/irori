/**
 * 1 回の保存操作（作成）の状態と、送信スナップショットの共有型（2026-10-27 大型更新 テーマ A）。
 *
 * **これは送信キュー（outbox）ではない。** 利用者が押した一つの保存要求の結果を照合し、利用者の
 * 操作で同じ内容を送り直すための記録じゃ。圏外で新規記録を積んで自動で送る仕組み・Background Sync・
 * 復帰時の無人アップロードは作らぬ（既存の outbox 見送りを守る）。
 *
 * 状態（PRODUCT_SPEC A2 の 6 区分）:
 * - 未送信の入力/下書き … スナップショットが**無い**状態（画面の入力 state・下書き保存が持つ）
 * - sending … 送信中
 * - 成功が確定 … スナップショットを**消す**。成功の表示はサーバの確定行で組む
 * - unknown … 応答不明。サーバに届いて保存されたかもしれぬ。同じ内容でしか送り直さぬ
 * - rejected … サーバが保存の**前**に明確に拒否した（検証・認証）。入力を直して送り直せる
 * - conflict … 同じ id で別の内容が既に保存済み等。利用者の確認が要る
 *
 * 契約:
 * - 最初の有効な保存操作で送信値（id・所有者・時刻・種類・量・左右秒・回数・開始側…）を捕捉し、
 *   結果が不明な間は**変えぬ**。時刻や経過秒を再送のたびに作り直すと、同じ id に別の内容を送って
 *   サーバの内容照合に拒まれ、保存できているのに成功を確定できぬ（監査 F01）
 * - 応答不明のまま新しい id で登録し直さぬ（本当の二重記録になる）
 * - 「Promise が reject した＝サーバに未到達」と決めつけぬ（応答だけが失われた形と区別できぬ）
 */

export type SaveAttemptPhase = "sending" | "unknown" | "rejected" | "conflict"

/** 送信スナップショットの持ち主。別の利用者・世帯の端末保存は表示も送信もせぬ。 */
export interface SaveOwner {
  childId?: string
  userId: string
  householdId: string
}

export const SAVE_ATTEMPT_SCHEMA_VERSION = 1

export interface SaveAttempt<P> {
  schemaVersion: typeof SAVE_ATTEMPT_SCHEMA_VERSION
  /** 冪等 id（主キー）。最初の保存操作から成功の確定まで同じ値 */
  clientId: string
  owner: SaveOwner
  /** 最初の有効な保存操作の時刻（ISO）。再送しても変えぬ */
  firstAttemptAt: string
  /** サーバへ送る値そのもの。再送はこれを**そのまま**送る */
  payload: P
  phase: SaveAttemptPhase
  /** 最後に利用者へ見せた失敗の文言（秘密・本文は入れぬ） */
  lastError?: string
}

/**
 * 作成系 Server Action の失敗の分類。サーバは自分が分かる範囲で返す:
 * - rejected: DB に届く前の検証・認証・未承認で拒否した、または DB が制約違反で拒否した
 *   （行は書かれておらぬと断定できる）
 * - unknown: DB への要求が送られた後の失敗（接続断・タイムアウト等）。書かれたかもしれぬ
 * - conflict: 同じ冪等 id に別の内容の行が既に在る
 * 分類を持たぬ応答（古いサーバ）は unknown として扱う（安全側 = 同じ内容でしか送り直さぬ）。
 */
export type CreateFailureKind = "rejected" | "unknown" | "conflict"

/**
 * DB の失敗が「行は書かれておらぬ」と断定できるか（サーバ側の分類）。Postgres の SQLSTATE を持つ
 * 失敗（23xxx 制約違反・22xxx データ不正・42xxx 権限/構文）と PostgREST が DB へ渡す前に拒んだ
 * 失敗（PGRSTxxx: JWT 失効・要求不正）は、行が書かれておらぬ形。code を持たぬ失敗（fetch の
 * 失敗・タイムアウト。postgrest-js は code: "" で返す）は、要求が DB に届いて書かれた後に
 * 応答だけが失われた形と区別できぬゆえ unknown とする。
 */
export function failureKindOfDbError(error: { code?: string | null }): CreateFailureKind {
  const code = error.code ?? ""
  return /^(22|23|42)[0-9A-Z]{3}$/.test(code) || /^PGRST\d{3}$/.test(code)
    ? "rejected"
    : "unknown"
}

export function isCreateFailureKind(value: unknown): value is CreateFailureKind {
  return value === "rejected" || value === "unknown" || value === "conflict"
}

/**
 * Server Action の結果（または例外）から次の状態を決める純関数。
 * 例外（fetch の reject・Server Action の通信断）は常に unknown — 要求が届かなかったのか、
 * 保存の後で応答だけが失われたのかをクライアントは区別できぬ。
 */
export function phaseAfterFailure(
  outcome:
    | { thrown: true }
    | { thrown: false; failure?: unknown },
): Exclude<SaveAttemptPhase, "sending"> {
  if (outcome.thrown) return "unknown"
  return isCreateFailureKind(outcome.failure) ? outcome.failure : "unknown"
}

/** 応答不明の間に利用者へ出す文言（画面の共通語。「保存済み」とも「失敗」とも断定せぬ）。 */
export const SAVE_UNKNOWN_MESSAGE =
  "保存できたか確認できていません。同じ内容でもう一度送ると、二重にならずに確かめられます。"

/** 送り直しの釦の共通語（入力を変えずに同じ内容を送る）。 */
export const SAVE_RESEND_LABEL = "同じ内容でもう一度送る"

/** 同じ id に別の内容が保存済みだった時の共通語。 */
export const SAVE_CONFLICT_MESSAGE =
  "この操作は少し前に別の内容で記録済みでした。タイムラインの記録を確かめ、必要なら記録を直してください。"
