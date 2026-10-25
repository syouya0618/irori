/**
 * `/api/google/sync` の応答（`{ ok: true, summary }`）を利用者向けの 1 文へ写す純関数。
 *
 * route は同期が**終わってから**返す。`ok: true` は「route が落ちなかった」だけで、
 * 内訳には購読ごとの失敗や再接続の要否が入りうる。ゆえに `ok` だけで「完了」と言わぬ。
 *
 * - 応答の形は信用せぬ（unknown として読む）。読めねば「完了」へ退化させる —— route が
 *   ok を返した事実までは確かゆえ、それ以上を捏造せぬ
 * - 購読の status は **denylist**: "synced" 以外は全て「同期できていない」側へ倒す
 *   （enum drift 防御。新しい status が増えても無音で成功扱いにせぬ）
 * - 同期は世帯単位で走るゆえ、内訳はこの接続のものだけを見る。**無ければ全体へ逃げず失敗**
 *   と言う（再接続待ちの接続は syncHousehold が内訳から外すため、配偶者の成功を借りぬ）
 */

export type SyncOutcomeTone = "ok" | "warn" | "error"

export interface SyncOutcome {
  tone: SyncOutcomeTone
  text: string
}

interface SubscriptionOutcomeLike {
  status: string
  upserted: number
  deleted: number
}

interface ConnectionOutcomeLike {
  connectionId: string | null
  needsReauth: boolean
  subscriptions: SubscriptionOutcomeLike[]
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0
}

function readConnections(body: unknown): ConnectionOutcomeLike[] | null {
  if (!isRecord(body) || !isRecord(body.summary)) return null
  const raw = body.summary.connections
  if (!Array.isArray(raw)) return null
  const out: ConnectionOutcomeLike[] = []
  for (const c of raw) {
    if (!isRecord(c)) continue
    const subs = Array.isArray(c.subscriptions) ? c.subscriptions : []
    out.push({
      connectionId: typeof c.connectionId === "string" ? c.connectionId : null,
      needsReauth: c.needsReauth === true,
      subscriptions: subs.filter(isRecord).map((s) => ({
        status: typeof s.status === "string" ? s.status : "",
        upserted: num(s.upserted),
        deleted: num(s.deleted),
      })),
    })
  }
  return out
}

/**
 * @param selectedCount この接続で「同期する」に選ばれておるカレンダーの数（カードが知っておる）。
 *   内訳が空の時に「選ばれていない」と「失敗した」を分けるのに使う。null = 一覧を読めず分からぬ
 *   （その時は空の内訳を失敗側へ倒す。「選ばれていない」とは断定せぬ）。
 */
export function interpretSyncResponse(
  body: unknown,
  connectionId: string,
  selectedCount: number | null,
): SyncOutcome {
  const all = readConnections(body)
  // 形が読めぬ（接続の id すら無い）応答は、route が ok を返した事実以上を言わぬ
  if (all === null || all.every((c) => c.connectionId === null)) {
    return { tone: "ok", text: "同期が完了しました" }
  }
  // ⚠️ **他の接続の結果へ逃げぬ。** syncHousehold は再接続待ちの接続を内訳から外す
  // （`.neq("connection_status","needs_reauth")`）。自分の内訳が無い時に世帯全体を見ると、
  // 配偶者の成功を自分の「完了」と言い、再接続のバナーと矛盾する。
  const own = all.filter((c) => c.connectionId === connectionId)
  if (own.length === 0) {
    return {
      tone: "error",
      text: "この接続は同期されませんでした。再接続が必要か、同期に失敗しています",
    }
  }

  if (own.some((c) => c.needsReauth)) {
    return {
      tone: "error",
      text: "Google の許可が切れていたため同期できませんでした。再接続してください",
    }
  }
  const subs = own.flatMap((c) => c.subscriptions)
  if (subs.length === 0) {
    // 一過性の失敗（トークン・一覧の取得）でも内訳は空のまま返る。選んでおるのに空なら失敗じゃ
    return selectedCount === null || selectedCount > 0
      ? {
          tone: "error",
          text: "同期に失敗しました。時間をおいてもう一度お試しください",
        }
      : {
          tone: "warn",
          text: "同期するカレンダーが選ばれていないため、取り込む予定はありませんでした",
        }
  }

  const failed = subs.filter((s) => s.status === "failed").length
  const leased = subs.filter((s) => s.status === "skipped_leased").length
  const resync = subs.filter((s) => s.status === "resync_required").length
  // 既知の 4 値の外（新しい status）も「同期できていない」側へ数える（denylist）
  const notSynced = subs.filter((s) => s.status !== "synced").length
  const unknown = notSynced - failed - leased - resync

  if (failed > 0 || unknown > 0) {
    const n = failed + unknown
    return {
      tone: "warn",
      text: `${subs.length}件中${n}件のカレンダーを同期できませんでした。時間をおいてもう一度お試しください`,
    }
  }
  if (leased > 0) {
    return {
      tone: "warn",
      text: "別の同期が実行中でした。少し待ってから最終同期時刻を確認してください",
    }
  }
  if (resync > 0) {
    return {
      tone: "warn",
      text: "Google 側の変更に合わせて同期をやり直しています。次の同期で最新になります",
    }
  }
  const upserted = subs.reduce((a, s) => a + s.upserted, 0)
  const deleted = subs.reduce((a, s) => a + s.deleted, 0)
  return {
    tone: "ok",
    text:
      upserted + deleted === 0
        ? "同期が完了しました（変更はありませんでした）"
        : `同期が完了しました（追加・更新 ${upserted}件、削除 ${deleted}件）`,
  }
}
