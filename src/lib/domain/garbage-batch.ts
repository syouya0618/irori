import {
  GARBAGE_KIND_PRESETS,
  garbageRequestLabel,
  isGarbageRequest,
  type EventPurposeScope,
  type GarbageCandidate,
  type GarbageRequest,
} from "./garbage"
import type { RpcStatus } from "./rpc-outcome"

/**
 * 既存の予定の候補を、まとめて「ごみの日」に分類する手順（純関数）。
 *
 * ## 契約
 * - **利用者が選んで確かめた候補だけ**を送る。題から推した名称は初期選択にとどめ、確認の画面で選び直せる
 * - 送る内容は確認の時点で固定する（名称・範囲・通知・見ておった版）。通知は常に「変えない」（`keep`）—
 *   まとめての操作で通知を付けたり消したりせぬ
 * - **1 件ずつ順に**、既存の保存の手順（`useChoreSave` → `submitGarbageRequest` → RPC）で送る。各件は
 *   それぞれの操作 ID を持ち、結果不明なら端末の控えに残る（「同じ操作で確認」で同じ内容を送り直せる）
 * - まとめて 1 つの取引にはならぬ。途中で止まれば、保存できた件はそのまま残り、送っておらぬ件は送らぬ
 *   （取り消しも上書きもせぬ）。結果不明が出たらそこで止める（確認の前に次を送らぬ）
 * - 結果は件ごとに分けて数える。全件を確かめられた時だけ「すべて保存しました」と言う
 */

/** 一度に選べる件数の上限（候補の上限と同じ）。 */
export const GARBAGE_BATCH_MAX = 20

export type GarbageBatchStatus =
  /** まだ送っておらぬ（順番待ち） */
  | "waiting"
  /** 送信中 */
  | "sending"
  /** 保存し、読み直しでも確かめた */
  | "saved"
  /** 既に同じ内容で保存されておった（応答を失った再送など。書いておらぬ） */
  | "unchanged"
  /** 保存の応答はあったが、読み直しで確かめられなんだ */
  | "unverified"
  /** 別の端末の変更が先。何も書いておらぬ */
  | "conflict"
  /** 保存できなんだ（理由つき）。何も書いておらぬ */
  | "rejected"
  /** 結果不明（端末の控えあり。同じ操作で確認できる） */
  | "unknown"
  /** 前の操作の確認待ち・取りやめで、送っておらぬ */
  | "stopped"
  /** 続きを送る時点で候補でなくなっておった（ほかで分類された・予定が変わった）ゆえ、送っておらぬ */
  | "skipped"

export interface GarbageBatchItem {
  eventId: string
  title: string
  startDate: string
  isSeries: boolean
  source: string
  scope: EventPurposeScope
  kind: string
  /** 送る内容（確認の時点で固定。再送もこのまま） */
  request: Extract<GarbageRequest, { op: "save" }>
  /** 控え・結果に出す操作の説明 */
  label: string
  status: GarbageBatchStatus
  /** 保存できなんだ理由（rejected） */
  error?: string
}

export interface GarbageBatch {
  items: GarbageBatchItem[]
  /** running = 順に送っておる / stopped = 途中で止めた / done = 全件の結果が出た */
  phase: "running" | "stopped" | "done"
}

/** 確認の画面での 1 件の選択（候補と、選んだ名称）。 */
export interface GarbageBatchChoice {
  candidate: GarbageCandidate
  /** プリセットの名称。未選択は null */
  kind: string | null
}

const PRESET_LABELS = new Set(GARBAGE_KIND_PRESETS.map((preset) => preset.label))

/** まとめての分類で選べる名称か（プリセットだけ。自由入力は 1 件ずつの分類で入れる）。 */
export function isBatchKind(kind: string | null): kind is string {
  return kind !== null && PRESET_LABELS.has(kind)
}

/** 確認の画面の初期選択（題から推した名称がプリセットなら、それ。無ければ未選択）。 */
export function initialBatchChoice(candidate: GarbageCandidate): GarbageBatchChoice {
  return { candidate, kind: isBatchKind(candidate.suggestedKind) ? candidate.suggestedKind : null }
}

/** 繰り返しの候補はシリーズ全体、単発はその予定だけを分類する。 */
export function batchScopeOf(candidate: GarbageCandidate): EventPurposeScope {
  return candidate.event.isSeries ? "series" : "event"
}

/**
 * 確認した選択から、送る内容を固定する。名称が未選択・プリセット外の件、同じ予定の重複、上限を
 * 超える選択が 1 つでも在れば null（一部だけ送らぬ。確認の画面で直させる）。
 */
export function buildGarbageBatch(choices: readonly GarbageBatchChoice[]): GarbageBatch | null {
  if (choices.length === 0 || choices.length > GARBAGE_BATCH_MAX) return null
  const seen = new Set<string>()
  const items: GarbageBatchItem[] = []
  for (const { candidate, kind } of choices) {
    if (!isBatchKind(kind)) return null
    const { event } = candidate
    if (seen.has(event.id)) return null
    seen.add(event.id)
    const scope = batchScopeOf(candidate)
    const request: Extract<GarbageRequest, { op: "save" }> = {
      op: "save",
      eventId: event.id,
      scope,
      action: "garbage",
      garbageKind: kind,
      reminder: "keep",
      // 候補は分類の行を持たぬ予定ゆえ、見ておった版はどちらも null（行が在れば RPC が conflict で止める）
      seen: { series: candidate.current.seen.series, event: candidate.current.seen.event },
    }
    if (!isGarbageRequest(request)) return null
    items.push({
      eventId: event.id,
      title: event.title,
      startDate: event.start_date,
      isSeries: event.isSeries,
      source: event.source,
      scope,
      kind,
      request,
      label: garbageRequestLabel(request, event.title),
      status: "waiting",
    })
  }
  return { items, phase: "running" }
}

/** 次に送る件（送信中の件が在る間・走っておらぬ間は null）。 */
export function nextGarbageBatchItem(batch: GarbageBatch): GarbageBatchItem | null {
  if (batch.phase !== "running") return null
  if (batch.items.some((item) => item.status === "sending")) return null
  return batch.items.find((item) => item.status === "waiting") ?? null
}

function withItem(batch: GarbageBatch, eventId: string, update: (item: GarbageBatchItem) => GarbageBatchItem): GarbageBatch {
  let changed = false
  const items = batch.items.map((item) => {
    if (item.eventId !== eventId) return item
    const next = update(item)
    if (next !== item) changed = true
    return next
  })
  return changed ? { ...batch, items } : batch
}

export function markGarbageBatchSending(batch: GarbageBatch, eventId: string): GarbageBatch {
  return withItem(batch, eventId, (item) => (item.status === "waiting" ? { ...item, status: "sending" } : item))
}

/** 送らずに止める（順番待ちの件を「送っておらぬ」にする）。結果の出た件には触れぬ。 */
export function stopGarbageBatch(batch: GarbageBatch): GarbageBatch {
  if (batch.phase !== "running") return batch
  return {
    phase: "stopped",
    items: batch.items.map((item) => (item.status === "waiting" ? { ...item, status: "stopped" } : item)),
  }
}

/** 順番待ちが無くなったら終える。 */
export function finishGarbageBatch(batch: GarbageBatch): GarbageBatch {
  if (batch.phase !== "running") return batch
  if (batch.items.some((item) => item.status === "waiting" || item.status === "sending")) return batch
  return { ...batch, phase: batch.items.some((item) => item.status === "stopped") ? "stopped" : "done" }
}

/**
 * 止めた後に、送っておらぬ件を順番待ちへ戻して続ける（結果の出た件は送り直さぬ）。
 * `stillCandidate` は今の画面の候補に残っておるか — 止めておる間にシート（1 件ずつの分類）や家族が分類した
 * 予定は、固めた古い内容で送り直さぬ（送れば RPC が衝突で止めるが、「別の端末の変更」と誤って言うことになる）。
 */
export function resumeGarbageBatch(
  batch: GarbageBatch,
  stillCandidate: (eventId: string) => boolean = () => true,
): GarbageBatch {
  if (batch.phase !== "stopped" || !batch.items.some((item) => item.status === "stopped")) return batch
  const items = batch.items.map((item): GarbageBatchItem =>
    item.status !== "stopped" ? item : stillCandidate(item.eventId) ? { ...item, status: "waiting" } : { ...item, status: "skipped" },
  )
  return finishGarbageBatch({ phase: "running", items })
}

/** 1 件の応答（`useChoreSave` の結果を、この手順に要る分だけにしたもの）。 */
export type GarbageBatchOutcome =
  | { kind: "settled"; status: RpcStatus; readbackFailed: boolean }
  | { kind: "rejected"; error: string }
  | { kind: "unknown" }

/**
 * 応答を件へ映す。結果不明なら、その件を「確認待ち」にして残りを送らぬ（止める）。
 * 同じ件の後からの確認（「同じ操作で確認」の応答）も、ここで結果を書き換える。
 */
export function settleGarbageBatchItem(batch: GarbageBatch, eventId: string, outcome: GarbageBatchOutcome): GarbageBatch {
  const status: GarbageBatchStatus =
    outcome.kind === "unknown"
      ? "unknown"
      : outcome.kind === "rejected"
        ? "rejected"
        : outcome.status === "conflict"
          ? "conflict"
          : outcome.readbackFailed
            ? "unverified"
            : outcome.status === "replayed"
              ? "unchanged"
              : "saved"
  const next = withItem(batch, eventId, (item) =>
    item.status === "sending" || item.status === "unknown"
      ? { ...item, status, error: outcome.kind === "rejected" ? outcome.error : undefined }
      : item,
  )
  if (next === batch) return batch
  return outcome.kind === "unknown" ? stopGarbageBatch(next) : finishGarbageBatch(next)
}

export interface GarbageBatchSummary {
  total: number
  /** 保存を確かめた（既に同じ内容だった件を含む） */
  saved: number
  /** 保存の応答はあったが読み直しで確かめられなんだ */
  unverified: number
  /** 保存しておらぬと分かっておる（衝突・拒否） */
  notSaved: number
  /** 結果不明 */
  unknown: number
  /** 送っておらぬ（順番待ち・止めた） */
  notSent: number
  /** 候補でなくなったゆえ送っておらぬ */
  skipped: number
  sending: number
}

export function summarizeGarbageBatch(batch: GarbageBatch): GarbageBatchSummary {
  const count = (...statuses: GarbageBatchStatus[]) => batch.items.filter((item) => statuses.includes(item.status)).length
  return {
    total: batch.items.length,
    saved: count("saved", "unchanged"),
    unverified: count("unverified"),
    notSaved: count("conflict", "rejected"),
    unknown: count("unknown"),
    notSent: count("waiting", "stopped"),
    skipped: count("skipped"),
    sending: count("sending"),
  }
}

/**
 * 結果の要約の文。**全件を確かめられた時だけ**「すべて」と言う。部分的な成功は件数で分けて言う。
 */
export function garbageBatchSummaryText(batch: GarbageBatch): string {
  const s = summarizeGarbageBatch(batch)
  if (batch.phase === "running") {
    return `${s.total}件を1件ずつ分類しています（応答を受け取ったのは${s.saved + s.unverified + s.notSaved + s.unknown}件）。`
  }
  if (s.saved === s.total) return `${s.total}件すべてを、ごみの日として保存しました。`
  const parts = [`${s.total}件のうち、保存を確かめたのは${s.saved}件です。`]
  if (s.unverified > 0) parts.push(`${s.unverified}件は保存の応答がありましたが、読み直しで確かめられていません（画面を再読込して確かめてください）。`)
  if (s.notSaved > 0) parts.push(`${s.notSaved}件は保存していません。`)
  if (s.unknown > 0) {
    parts.push(
      `${s.unknown}件は保存できたか確認できていません（「同じ操作で確認」で確かめてください。確認をやめた時は、一覧で保存されたかを確かめてください）。`,
    )
  }
  if (s.notSent > 0) parts.push(`${s.notSent}件は送っていません。`)
  if (s.skipped > 0) parts.push(`${s.skipped}件は候補でなくなったため送っていません。`)
  return parts.join("")
}

/** 件ごとの状態の文。 */
export function garbageBatchStatusText(item: GarbageBatchItem): string {
  switch (item.status) {
    case "waiting":
      return "順番待ち"
    case "sending":
      return "保存しています"
    case "saved":
      return "保存しました"
    case "unchanged":
      return "保存済みでした（変更なし）"
    case "unverified":
      return "応答はありましたが、読み直しで確かめられていません"
    case "conflict":
      return "別の端末の変更が先にありました。保存していません"
    case "rejected":
      return `保存できませんでした${item.error ? `（${item.error}）` : ""}`
    case "unknown":
      return "保存できたか確認できていません"
    case "stopped":
      return "送っていません"
    case "skipped":
      return "候補でなくなったため送っていません（ほかで分類された・予定が変わったなど）"
  }
}
