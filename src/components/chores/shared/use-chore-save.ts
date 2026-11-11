"use client"

import { useEffect, useLayoutEffect, useRef, useState, useTransition } from "react"
import {
  CHORE_PENDING_PREFIX,
  clipChorePendingLabel,
  discardUnreadableChorePending,
  listChorePending,
  putChorePending,
  removeChorePending,
  snapshotChorePending,
  type ChoreKind,
  type ChoreOwner,
  type ChorePending,
  type ChorePendingPhase,
} from "@/lib/domain/chore-pending"
import {
  isChoreSaveFailure,
  isChoreSaveSuccess,
  type ChoreSaveFailure,
  type ChoreSaveSuccess,
  type RpcStatus,
} from "@/lib/domain/rpc-outcome"
import { newClientId } from "@/lib/utils/client-id"
import { clearUnsavedInput, isDeviceOffline, noteServerReachable, setChoreSaveBusy } from "./refresh-gate"
import { useChoresRefresh } from "./use-chores-refresh"

/**
 * 家事機能の保存の共通手順（ごみ・掃除・ごはんが同じ契約で保存する）。
 *
 * ```tsx
 * const save = useChoreSave({ owner, kind: "cleaning", run: saveCleaningRoutine, isPayload })
 * save.send({ id: newClientId(), version: null, name }, "掃除の項目を追加")   // 行 id は payload の中で 1 回だけ作る
 * <PendingChoreNotice save={save} />
 * <Button disabled={save.blocked}>…</Button>
 * ```
 *
 * ## 契約（`save-attempt.ts` と 04 地図 §2.1 の正準パターンを汎用化したもの）
 * - **送信の前に**端末へ控えを残す。残せなくても送信は続け、警告を出す
 * - 再送は固定済みの payload を**そのまま**送る（操作 ID も同じ。新しい ID で作り直さぬ）
 * - `rejected` で控えを消すのは**初回だけ**。再送の `rejected` は「先の送信が成立しておらぬ」ことを
 *   意味せぬゆえ残す（利用者が保存済みの内容を確かめてから、明示操作で破棄できる）
 * - 例外（throw）は常に結果不明。「届かなかった」と決めつけぬ
 * - 控えが 1 件でも在る間・読めぬ控えが在る間は、新しい操作を受けぬ（`blocked`）
 * - **自動では再送せぬ**。再送は利用者の操作（`retry`）だけ
 * - unmount 後・持ち主（利用者 / 世帯）の交代後に届いた応答は捨てる。今の画面の状態・通知・
 *   再描画には一切使わぬ（例外: 同じ持ち主のまま画面を離れた後に届いた**確定の成功**だけ、
 *   その操作自身の端末控えを片付ける。画面の状態には触れぬ）
 * - 画面に出す控えは**端末の控えの写し**。別の画面（同じ文書の中で先に離れた画面）・別のタブが
 *   確定して端末から消した控えは、この画面からも外す。**この文書で今まさに送信中**の操作は
 *   「確認できていない」と出さぬ（`inFlightOps`。新しい操作は塞いだまま）。結果を捨てた送信が
 *   終われば、端末に残った控えを結果不明として出す
 * - 取り直しは `useChoresRefresh` を通す（`router.refresh()` を直に呼ばぬ。`refresh-gate.ts`）
 *
 * ## 編集セッション（R35。シートを持つ画面が `sessions` を渡した時だけ）
 * 応答は、送った時と今とで画面のシートが違いうる（A を保存 → 応答が遅れる → A を閉じて B を開いて入力 →
 * A の応答）。画面はシートを開くたびに新しい番号（レコード ID ではない）を番号札（`createChoreEditSessions`）
 * から振り、`send` の第 3 引数で渡す。hook は送信の時の番号を捕まえ、応答の時の番号札の今の番号と比べた
 * 結果を `outcome.origin` に載せる（持ち主・種類・操作 ID は従来どおり送信の時に固定済み）。
 * - **常に行う**（古い応答でも）: その操作自身の控えの確定・結果不明への更新、別の実体への知らせ、取り直し
 *   — DB で確定した事実は今の画面がどれでも正しく扱う
 * - **送ったシートが今も開いておる時だけ**（`origin.current`）: シートを閉じる・入力を初期化する（画面の
 *   責務）、触れた入力欄の記憶を捨てる（`clearUnsavedInput`）
 * - **操作した場所が今も同じ時だけ**（`origin.inPlace`）: 結果の文言（`message`）を出す。違えば文言を
 *   出さず、画面が「どの操作の結果か」を添えてシートの外に出す（`origin.label`）
 * - 「同じ操作で確認」（再送）は**どのシートの送信でもない**（`session` は undefined）。応答でシートを
 *   閉じぬ（結果不明の後に打ち直した入力を、先の内容の確定で消さぬ）。文言は押した場所に出す（`place`）
 * - 通信の中断（Abort）はサーバーでの取消しを保証せぬゆえ、古い応答を捨てる代わりに上の分け方で扱う
 * 番号は端末の控えに書かぬ（再読込の後に読んだ控えは、どのシートの送信でもない）。
 *
 * `run` は Server Action。`{ status: "saved" | "replayed" | "conflict" }` か
 * `{ error, failure: "rejected" | "unknown" | "conflict" }` を返す。Server の応答ゆえ形は信用せず、
 * どちらにも読めねば結果不明として扱う。
 */

export const CHORE_SAVE_MESSAGES = {
  saved: "保存しました。",
  conflict: "別の端末が先に更新していました。上書きはしていません。最新の内容を確認してください。",
  unknown: "保存結果を確認できません。同じ操作で確認し直してください。",
  storageFailed:
    "この端末に控えを残せていません。保存結果を確認するまで、この画面を閉じないでください。",
  storageUnavailable:
    "この端末では控えを残せません。保存結果が分からなくなった時は、画面の内容で確かめてください。",
  pendingFirst: "保存結果を確認中の操作があります。先に「同じ操作で確認」を押してください。",
  unreadable: "端末の控えを読めないため、新しい保存を止めています。",
  notReady: "端末の控えを確認しています。少し待ってからもう一度お試しください。",
  invalid: "入力内容を確認してください。",
  discarded: "控えを破棄しました。保存済みの内容を画面で確認してください。",
} as const

/**
 * 「確認をやめる」（結果不明のままの取り下げ）を出すまでに要る、結果不明に終わった確認の回数。
 * 圏外での確認は数えぬ（通信できる場所で確かめる余地が在る間は、取り下げへ誘導せぬ）。
 */
export const CHORE_UNKNOWN_RETRIES_BEFORE_WITHDRAW = 2

/**
 * 画面に出す控え（下の 3 つは画面だけの値。端末には保存せぬ）。
 * - `retryError` … 直近の再送が拒否された理由
 * - `unknownRetries` … この画面で「同じ操作で確認」が結果不明に終わった回数
 * - `memoryOnly` … 端末へ残せておらぬ（この画面の中にしか無い）
 */
export type ChorePendingItem<P extends object = Record<string, unknown>> = ChorePending<P> & {
  retryError?: string
  unknownRetries?: number
  memoryOnly?: boolean
  /** この操作を送ったシートの編集セッション（画面だけの値。再送・端末から読んだ控えは持たぬ） */
  session?: ChoreSaveSession
  /** この操作を行った場所の編集セッション（送信 = `session`、再送 = 押した時に開いておったシート） */
  place?: ChoreSaveSession
}

/** 編集セッション（シートを開くたびに増える番号。レコード ID ではない）。シートの外は undefined。 */
export type ChoreSaveSession = number | undefined

/**
 * 画面の編集セッションの番号札（画面ごとに 1 つ。`useState(createChoreEditSessions)` で持つ）。
 * シートの開閉と同時に書き換える（描画を待たぬ。応答はいつ届くか分からぬ）。
 */
export interface ChoreEditSessions {
  /** 新しいシートを開く（番号を振り、今のシートにする）。同じ項目を開き直しても別の番号 */
  begin(): number
  /** そのシートを閉じる。今のシートである時だけ効く（新しいシートを開いた後の終了で、新しい方を閉じぬ） */
  end(session: number): void
  /** 開いておるシートを閉じる */
  close(): void
  /** 今開いておるシートの番号（開いておらねば undefined） */
  current(): ChoreSaveSession
}

export function createChoreEditSessions(): ChoreEditSessions {
  let seq = 0
  let open: ChoreSaveSession
  return {
    begin() {
      seq += 1
      open = seq
      return seq
    },
    end(session) {
      if (open === session) open = undefined
    },
    close() {
      open = undefined
    },
    current() {
      return open
    },
  }
}

/** 応答の宛先（`sessions` を渡した画面でだけ `outcome.origin` に載る）。 */
export interface ChoreSaveOrigin {
  /** 送ったシートの編集セッション（シートの外から送った・再送は undefined） */
  session: ChoreSaveSession
  /** 操作した場所の編集セッション */
  place: ChoreSaveSession
  /** 応答の時点で、送ったシートが今も開いておる（閉じる・入力を初期化してよい） */
  current: boolean
  /** 応答の時点で、操作した場所が今も同じ（結果をそこに出してよい） */
  inPlace: boolean
  /** 控えの説明（「「浴室の排水口」を完了」等。場所の違う応答に「どの操作か」を添える） */
  label: string
}

/**
 * この文書（ページの寿命）で今まさに送信中の操作。画面を移っても送信は続くゆえ、hook の実体ではなく
 * module で持つ（移った先の画面が、送信中の操作を「確認できていない操作」と出さぬため）。
 */
const inFlightOps = new Set<string>()
/** 端末の控えが変わったことを、同じ文書の別の実体へ知らせる（`storage` イベントは同じ文書へは届かぬ）。 */
const deviceListeners = new Map<object, () => void>()

function opKey(entry: Pick<ChorePending, "id" | "owner" | "kind">): string {
  return `${entry.owner.userId}:${entry.owner.householdId}:${entry.kind}:${entry.id}`
}

function notifyDeviceChanged(self: object): void {
  for (const [token, listener] of [...deviceListeners]) {
    if (token !== self) listener()
  }
}

/** テスト用: module の状態を初期化する。 */
export function resetChoreSaveForTest(): void {
  inFlightOps.clear()
  deviceListeners.clear()
}

export type ChoreSaveOutcome<P extends object, S extends ChoreSaveSuccess> =
  /** 応答が確定した（conflict は「上書きしておらぬ。最新を読み直せ」）。控えは消えておる */
  | { kind: "settled"; status: RpcStatus; result: S; payload: P; origin?: ChoreSaveOrigin }
  /** 保存されておらぬと確定した（初回の拒否、または同じ内容では成立せぬ衝突）。控えは消えておる */
  | { kind: "rejected"; error: string; payload: P; origin?: ChoreSaveOrigin }
  /** 結果不明。控えは残っておる（楽観表示をしておれば、確定と偽らぬ表示へ戻すこと） */
  | { kind: "unknown"; payload: P; origin?: ChoreSaveOrigin }

export interface UseChoreSaveOptions<P extends object, S extends ChoreSaveSuccess> {
  owner: ChoreOwner
  kind: ChoreKind
  run: (payload: P) => Promise<S | ChoreSaveFailure>
  /** 送る値・端末から復元した値の型ガード（Action の検証と同じものを渡す）。落ちた控えは読めぬ扱い */
  isPayload?: (value: unknown) => value is P
  /** 今の画面に属する応答だけで呼ばれる（捨てた応答では呼ばれぬ） */
  onOutcome?: (outcome: ChoreSaveOutcome<P, S>) => void
  /** 応答が確定したら Server の内容を取り直す（既定 true。`useChoresRefresh` 経由） */
  refreshOnSettled?: boolean
  /**
   * 画面の編集セッションの番号札（`createChoreEditSessions`）。渡すと応答ごとに送った時の番号と今の番号を
   * 比べ、`outcome.origin` を載せる（上の「編集セッション」）。省略した画面は、全ての応答を今の画面のものと
   * して扱う
   */
  sessions?: ChoreEditSessions
}

export interface UseChoreSaveResult<P extends object> {
  /**
   * 新しい操作を送る。受け付けたら操作 ID、塞がれておる・値が不正なら null。
   * `session` は送ったシートの編集セッション（シートの外から送る時は省く）
   */
  send: (payload: P, label: string, session?: ChoreSaveSession) => string | null
  /** 結果不明の控えを、同じ操作 ID・同じ payload で確かめ直す */
  retry: (entry: ChorePendingItem<P>) => void
  /** 控えを破棄する（利用者の明示操作からだけ呼ぶ） */
  discard: (entry: ChorePendingItem<P>) => void
  /** 読めぬ控えを破棄する（利用者の明示操作からだけ呼ぶ） */
  discardUnreadable: () => void
  pending: ChorePendingItem<P>[]
  /** 読めぬ控えの件数 */
  unreadable: number
  /** 端末へ控えを残せておるか */
  storageOk: boolean
  /** 端末の控えを読み終えたか */
  ready: boolean
  saving: boolean
  /** 新しい操作を受けられぬ（読込前・送信中・確認待ち・読めぬ控えあり） */
  blocked: boolean
  message: string
  /** `message` の出し方（alert = 利用者の対応が要る） */
  messageTone: "status" | "alert"
  /**
   * `message` を出した操作の場所（編集セッション）。null は特定の操作に属さぬ文言（端末の控えを読めぬ等。
   * どのシートにも出してよい）。シートの中では、そのシートの番号か null の文言だけを出すこと
   */
  messageSession: ChoreSaveSession | null
}

interface State<P extends object> {
  /** この状態が属する持ち主と種類。今の props と違えば使わぬ */
  scope: string
  ready: boolean
  items: ChorePendingItem<P>[]
  /** 外枠は読めたが `isPayload` に落ちた控え（明示の破棄でだけ消す） */
  foreign: ChorePending[]
  /** 外枠から読めなんだ控えの件数 */
  unreadable: number
  storageOk: boolean
  message: string
  tone: "status" | "alert"
  /** `message` を出した操作の場所（null = 特定の操作に属さぬ） */
  messageSession: ChoreSaveSession | null
}

function blankState<P extends object>(scope: string): State<P> {
  return {
    scope,
    ready: false,
    items: [],
    foreign: [],
    unreadable: 0,
    storageOk: true,
    message: "",
    tone: "status",
    messageSession: null,
  }
}

/** 端末へ書く形（画面だけの `retryError` を落とす）。 */
function toStored<P extends object>(entry: ChorePendingItem<P>, phase: ChorePendingPhase): ChorePending {
  return {
    schema: 1,
    id: entry.id,
    owner: entry.owner,
    kind: entry.kind,
    label: entry.label,
    payload: entry.payload as Record<string, unknown>,
    phase,
    firstAttemptAt: entry.firstAttemptAt,
  }
}

export function useChoreSave<P extends object, S extends ChoreSaveSuccess = ChoreSaveSuccess>({
  owner,
  kind,
  run,
  isPayload,
  onOutcome,
  refreshOnSettled = true,
  sessions,
}: UseChoreSaveOptions<P, S>): UseChoreSaveResult<P> {
  const { refresh } = useChoresRefresh()
  const { userId, householdId } = owner
  const scope = `${userId}:${householdId}:${kind}`
  const [saving, startTransition] = useTransition()
  const [state, setState] = useState<State<P>>(() => blankState<P>(""))
  // この実体の名札（門の旗と、同じ文書の別の実体への知らせで自分を除くのに使う）
  const [token] = useState<object>(() => ({}))
  const aliveRef = useRef(false)
  const scopeRef = useRef("")
  const inFlightRef = useRef(false)
  // 型ガードは描画ごとに作り直されうるゆえ ref に退避する（控えの読み直しは持ち主・種類の交代時だけ）
  const guardRef = useRef(isPayload)
  // 画面の編集セッションの番号札（応答の時に読む。渡し直されうるゆえ退避する）
  const sessionsRef = useRef(sessions)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  useEffect(() => {
    guardRef.current = isPayload
  }, [isPayload])

  useEffect(() => {
    sessionsRef.current = sessions
  }, [sessions])

  // 持ち主の交代は commit と同期して記録する（passive effect だと、commit と effect の間に届いた
  // 古い応答が「今の持ち主のもの」に見える隙ができる）
  useLayoutEffect(() => {
    scopeRef.current = scope
  }, [scope])

  useEffect(() => {
    let cancelled = false
    void Promise.resolve().then(() => {
      if (cancelled) return
      const listed = listChorePending({ userId, householdId }, kind)
      const guard = guardRef.current
      const items: ChorePendingItem<P>[] = []
      const foreign: ChorePending[] = []
      for (const entry of listed.items) {
        if (guard && !guard(entry.payload)) foreign.push(entry)
        // 前の画面で送信中のまま終わった控えは、今は結果不明として出す。この文書で今も送信中の
        // 操作（送ってすぐ画面を移った）だけは送信中のまま持つ — 終われば下の読み直しが拾う
        else items.push({ ...(entry as ChorePending<P>), phase: inFlightOps.has(opKey(entry)) ? "sending" : "unknown" })
      }
      const blocked = listed.unreadable + foreign.length > 0
      setState({
        scope,
        ready: true,
        items,
        foreign,
        unreadable: listed.unreadable,
        storageOk: listed.storageReadable,
        message: blocked
          ? CHORE_SAVE_MESSAGES.unreadable
          : listed.storageReadable
            ? ""
            : CHORE_SAVE_MESSAGES.storageUnavailable,
        tone: blocked || !listed.storageReadable ? "alert" : "status",
        // 端末の控えについての文言は、どの操作にも属さぬ（どのシートにも出してよい）
        messageSession: null,
      })
    })
    return () => {
      cancelled = true
    }
  }, [scope, userId, householdId, kind])

  // 持ち主が替わった直後（読み直す前）の描画で、前の持ち主の控え・文言を出さぬ
  const current = state.scope === scope ? state : blankState<P>(scope)
  const unreadable = current.unreadable + current.foreign.length
  const blocked = !current.ready || saving || current.items.length > 0 || unreadable > 0

  // 今ハードナビゲーションが起きると失うものが在る間（送信中 = 応答、端末に残せておらぬ控え =
  // 控えそのもの）は、自動の再取得を見送らせる
  const fragile = saving || current.items.some((item) => item.memoryOnly === true)
  useEffect(() => {
    setChoreSaveBusy(token, fragile)
    return () => setChoreSaveBusy(token, false)
  }, [token, fragile])

  const itemsRef = useRef<ChorePendingItem<P>[]>([])
  const refreshRef = useRef(refresh)
  useEffect(() => {
    itemsRef.current = current.items
    refreshRef.current = refresh
  })

  // 端末の控えの読み直し。別の画面（この文書で先に離れた画面）・別のタブが確定・破棄して端末から
  // 消した控えを外し、結果を捨てた送信が終わって端末に残った控えを結果不明として出す。
  // 送信はせぬ（読むだけ）。この画面にしか無い控え（memoryOnly）と、送信中の操作には触れぬ
  useEffect(() => {
    const resync = (takeIn: boolean) => {
      const listed = listChorePending({ userId, householdId }, kind)
      // 端末を読めぬ時は何も外さぬ（「読めぬ」を「消えた」と言い換えぬ）
      if (!listed.storageReadable) return
      const guard = guardRef.current
      const storedIds = new Set(listed.items.map((entry) => entry.id))
      const goneElsewhere = itemsRef.current.some(
        (item) => item.memoryOnly !== true && !inFlightOps.has(opKey(item)) && !storedIds.has(item.id),
      )
      setState((prev) => {
        if (prev.scope !== scope || !prev.ready) return prev
        let changed = false
        const items: ChorePendingItem<P>[] = []
        for (const item of prev.items) {
          const flying = inFlightOps.has(opKey(item))
          if (!flying && item.memoryOnly !== true && !storedIds.has(item.id)) {
            changed = true
            continue
          }
          const phase: ChorePendingPhase = flying ? "sending" : "unknown"
          if (item.phase === phase) items.push(item)
          else {
            changed = true
            items.push({ ...item, phase })
          }
        }
        const known = new Set(prev.items.map((item) => item.id))
        const foreign: ChorePending[] = []
        for (const entry of listed.items) {
          if (guard && !guard(entry.payload)) foreign.push(entry)
          else if (!known.has(entry.id)) {
            changed = true
            items.push({ ...(entry as ChorePending<P>), phase: inFlightOps.has(opKey(entry)) ? "sending" : "unknown" })
          }
        }
        const wasUnreadable = prev.unreadable + prev.foreign.length
        const nowUnreadable = listed.unreadable + foreign.length
        if (!changed && wasUnreadable === nowUnreadable) return prev
        let { message, tone, messageSession } = prev
        if (nowUnreadable > 0 && wasUnreadable === 0) {
          message = CHORE_SAVE_MESSAGES.unreadable
          tone = "alert"
          messageSession = null
        } else if (nowUnreadable === 0 && message === CHORE_SAVE_MESSAGES.unreadable) {
          message = ""
          tone = "status"
        }
        return { ...prev, items, foreign, unreadable: listed.unreadable, message, tone, messageSession }
      })
      // この文書で先に離れた画面が確定した操作の結果を、この画面の内容へ取り込む（入力の途中なら
      // 見送る）。別のタブの分は、この画面へ戻った時の再取得（RefreshOnVisible）に任せる
      if (takeIn && goneElsewhere && refreshOnSettled) refreshRef.current("auto")
    }
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key.startsWith(CHORE_PENDING_PREFIX)) resync(false)
    }
    const onVisible = () => {
      if (document.visibilityState === "visible") resync(false)
    }
    deviceListeners.set(token, () => resync(true))
    window.addEventListener("storage", onStorage)
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      deviceListeners.delete(token)
      window.removeEventListener("storage", onStorage)
      document.removeEventListener("visibilitychange", onVisible)
    }
  }, [token, scope, userId, householdId, kind, refreshOnSettled])

  /** 送った時の持ち主の状態にだけ適用する更新。 */
  function patch(sentScope: string, update: (prev: State<P>) => State<P>) {
    setState((prev) => (prev.scope === sentScope ? update(prev) : prev))
  }

  /** 今の文言を出す。`session` はその文言を出した操作の場所（送ろうとしたシート） */
  function say(message: string, tone: "status" | "alert", session: ChoreSaveSession) {
    patch(scope, (prev) => ({ ...prev, message, tone, messageSession: session }))
  }

  /** 今開いておるシートの編集セッション（番号札を渡さぬ画面は undefined） */
  function readSession(): ChoreSaveSession {
    return sessionsRef.current?.current()
  }

  async function attempt(entry: ChorePendingItem<P>, isRetry: boolean, sentScope: string) {
    const isLive = () => aliveRef.current && scopeRef.current === sentScope

    let result: unknown = null
    try {
      result = await run(entry.payload)
    } catch {
      // 例外は常に結果不明（届かなかったのか、保存の後で応答だけが失われたのか区別できぬ）
      result = null
    } finally {
      inFlightOps.delete(opKey(entry))
    }
    const success = isChoreSaveSuccess(result) ? (result as S) : null
    const failure = isChoreSaveFailure(result) ? result : null
    // 分類つきの応答が返った = サーバーへ届いておる（直後の取り直しは確かめ直さずに呼べる）
    if (success || failure) noteServerReachable()

    if (!isLive()) {
      // 捨てる応答。同じ持ち主のまま画面を離れた後の「確定の成功」だけ、この操作自身の控えを片付ける
      if (success && success.status !== "conflict" && !aliveRef.current && scopeRef.current === sentScope) {
        removeChorePending(entry)
      }
      // 移った先の画面（同じ文書の別の実体）に、端末の控えを読み直させる
      notifyDeviceChanged(token)
      return
    }

    // 応答の宛先（R35）。送った時の編集セッションと今のを比べる。編集セッションを持たぬ画面は常に今の画面
    const tracked = sessionsRef.current !== undefined
    const now = readSession()
    const current = !tracked || entry.session === now
    const inPlace = !tracked || entry.place === now
    const origin: ChoreSaveOrigin | undefined = tracked
      ? { session: entry.session, place: entry.place, current, inPlace, label: entry.label }
      : undefined
    /**
     * 結果の文言。操作した場所が今も同じ時だけ出す。違えば出さず（画面が「どの操作か」を添えて
     * シートの外に出す）、この操作の場所の文言（送信中の警告等）が残っておれば下げる
     */
    const speak = (prev: State<P>, message: string, tone: "status" | "alert"): Partial<State<P>> => {
      if (inPlace) return { message, tone, messageSession: entry.place }
      return prev.messageSession === entry.place ? { message: "", tone: "status" } : {}
    }

    if (success) {
      removeChorePending(entry)
      const conflict = success.status === "conflict"
      patch(sentScope, (prev) => ({
        ...prev,
        items: prev.items.filter((item) => item.id !== entry.id),
        ...speak(prev, conflict ? CHORE_SAVE_MESSAGES.conflict : CHORE_SAVE_MESSAGES.saved, conflict ? "alert" : "status"),
      }))
      // 保存できた入力は Server に在る（衝突は保存されておらぬゆえ、入力の途中のまま）。送ったシートが
      // 閉じられた後なら、今開いておるシートの入力は別物ゆえ、触れた欄の記憶を捨てぬ
      if (!conflict && current) clearUnsavedInput()
      notifyDeviceChanged(token)
      onOutcome?.({ kind: "settled", status: success.status, result: success, payload: entry.payload, origin })
      if (refreshOnSettled) refresh("manual")
      return
    }

    if (failure && (failure.failure === "conflict" || (failure.failure === "rejected" && !isRetry))) {
      // 保存されておらぬと確定。初回の拒否と、同じ内容では成立せぬ衝突だけがここへ来る
      removeChorePending(entry)
      patch(sentScope, (prev) => ({
        ...prev,
        items: prev.items.filter((item) => item.id !== entry.id),
        ...speak(prev, failure.error, "alert"),
      }))
      notifyDeviceChanged(token)
      onOutcome?.({ kind: "rejected", error: failure.error, payload: entry.payload, origin })
      return
    }

    // 結果不明、または再送が拒否された（先の送信が成立しておるかもしれぬゆえ控えは残す）
    putChorePending(toStored(entry, "unknown"), true)
    const retryError = failure?.failure === "rejected" ? failure.error : undefined
    // 「確認をやめる」を出す条件に数えるのは、通信できる状態での確認が結果不明に終わった時だけ
    const countsAsUnknownRetry = isRetry && retryError === undefined && !isDeviceOffline()
    patch(sentScope, (prev) => ({
      ...prev,
      items: prev.items.map((item) =>
        item.id === entry.id
          ? {
              ...item,
              phase: "unknown",
              retryError,
              unknownRetries: (item.unknownRetries ?? 0) + (countsAsUnknownRetry ? 1 : 0),
            }
          : item,
      ),
      ...speak(prev, retryError ?? CHORE_SAVE_MESSAGES.unknown, "alert"),
    }))
    onOutcome?.({ kind: "unknown", payload: entry.payload, origin })
  }

  function begin(entry: ChorePendingItem<P>, isRetry: boolean) {
    if (inFlightRef.current) return false
    inFlightRef.current = true
    const sentScope = scope
    // 送信中の印は、控えを書く前に立てる（読み直しが、書いた直後の控えを「結果不明」と取り違えぬ）
    inFlightOps.add(opKey(entry))
    // 送信の**前に**、同期で控えを残す。再送は既存の控えの phase を進めるだけ（消えた控えを蘇らせぬ）。
    // transition の外で行う: transition 内の更新は Action の完了まで描画されず、警告が送信中に出ぬ
    const stored = putChorePending(toStored(entry, "sending"), isRetry)
    patch(sentScope, (prev) => ({
      ...prev,
      storageOk: isRetry ? prev.storageOk : stored,
      items: [
        { ...entry, phase: "sending", retryError: undefined, memoryOnly: isRetry ? entry.memoryOnly : !stored },
        ...prev.items.filter((item) => item.id !== entry.id),
      ],
      message: !isRetry && !stored ? CHORE_SAVE_MESSAGES.storageFailed : "",
      tone: !isRetry && !stored ? "alert" : "status",
      messageSession: entry.place,
    }))
    startTransition(async () => {
      try {
        await attempt(entry, isRetry, sentScope)
      } catch (err) {
        // attempt は Action の失敗を自分で握る。ここへ来るのは後処理（呼び出し側の onOutcome 等）の不具合
        console.error("[use-chore-save] 保存の後処理に失敗", {
          message: err instanceof Error ? err.message : String(err),
        })
      }
      // 上の catch が全てを握るゆえ、成否に関わらずここへ来る（次の操作を受けられるようにする）
      inFlightRef.current = false
    })
    return true
  }

  function send(payload: P, label: string, session?: ChoreSaveSession): string | null {
    if (!current.ready) {
      say(CHORE_SAVE_MESSAGES.notReady, "status", session)
      return null
    }
    if (unreadable > 0) {
      say(CHORE_SAVE_MESSAGES.unreadable, "alert", session)
      return null
    }
    if (current.items.length > 0) {
      say(CHORE_SAVE_MESSAGES.pendingFirst, "alert", session)
      return null
    }
    if (saving || inFlightRef.current) return null
    // 端末へ残す形（素の JSON）へ写してから送る。最初の送信と復元後の再送が同じ内容になる
    const draft = snapshotChorePending({
      schema: 1,
      id: newClientId(),
      owner: { userId, householdId },
      kind,
      // 説明の長さは保存を拒む理由にせぬ（控えの上限へ切り詰める。上限の数え方は chore-pending.ts）
      label: clipChorePendingLabel(label),
      payload,
      phase: "sending",
      firstAttemptAt: new Date().toISOString(),
    })
    if (!draft || (isPayload && !isPayload(draft.payload))) {
      say(CHORE_SAVE_MESSAGES.invalid, "alert", session)
      return null
    }
    // 送ったシートと操作した場所を、この送信に固定する（端末の控えには書かぬ）
    const entry: ChorePendingItem<P> = { ...(draft as ChorePendingItem<P>), session, place: session }
    return begin(entry, false) ? draft.id : null
  }

  function retry(entry: ChorePendingItem<P>) {
    if (saving || inFlightRef.current) return
    // 画面に出しておる今の持ち主の控えだけを再送する（渡された値ではなく、手元の控えを送る）
    const mine = current.items.find((item) => item.id === entry.id)
    if (!mine) return
    // 確かめ直しはどのシートの送信でもない（応答でシートを閉じぬ）。結果は押した場所に出す
    begin({ ...mine, session: undefined, place: readSession() }, true)
  }

  function discard(entry: ChorePendingItem<P>) {
    if (saving || inFlightRef.current) return
    const mine = current.items.find((item) => item.id === entry.id)
    if (!mine) return
    removeChorePending(mine)
    patch(scope, (prev) => ({
      ...prev,
      items: prev.items.filter((item) => item.id !== mine.id),
      message: CHORE_SAVE_MESSAGES.discarded,
      tone: "status",
      messageSession: readSession(),
    }))
    notifyDeviceChanged(token)
    // 破棄した操作が保存されておったかを、画面の内容で確かめられるようにする（同じ操作を
    // 新しい ID でやり直す前に、最新の内容を見せる）
    if (refreshOnSettled) refresh("manual")
  }

  function discardUnreadable() {
    if (saving || inFlightRef.current) return
    discardUnreadableChorePending({ userId, householdId }, kind)
    for (const entry of current.foreign) removeChorePending(entry)
    const left = listChorePending({ userId, householdId }, kind).unreadable
    patch(scope, (prev) => ({
      ...prev,
      foreign: [],
      unreadable: left,
      message: left > 0 ? CHORE_SAVE_MESSAGES.unreadable : CHORE_SAVE_MESSAGES.discarded,
      tone: left > 0 ? "alert" : "status",
      messageSession: left > 0 ? null : readSession(),
    }))
    notifyDeviceChanged(token)
  }

  return {
    send,
    retry,
    discard,
    discardUnreadable,
    pending: current.items,
    unreadable,
    storageOk: current.storageOk,
    ready: current.ready,
    saving,
    blocked,
    message: current.message,
    messageTone: current.tone,
    messageSession: current.messageSession,
  }
}
