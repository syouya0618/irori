/**
 * 買い物の自動項目の同期（確定した献立 → 必要な材料 → `sync_grocery_auto_items`）と、
 * ごはんの Server Action が共有する DB エラーの分類。
 *
 * **サーバー専用**（Server Action から呼ぶ。カタログを import するので Client から値 import しない）。
 *
 * ## 契約
 * - **判定できないアレルギーの登録がある間は、同期そのものを送らない**（`held`。2026-11-11 製品判断）。その間は
 *   どの料理も当たるかを確かめられず、全ての確定の枠が保留になる。そのまま送ると、RPC が「不要になった」として
 *   未購入の自動項目を消し、購入した項目を「不要」にして出所を外す。今のリスト・購入量・手動項目・充当の台帳は
 *   そのまま残し、画面は「要再確認」と出す（`ShoppingView.autoHold`）。設定で選び直した後の同期で計算し直す。
 * - 使わない食材の設定での判定が「問題なし」でない確定の枠（`groceryHeldConflicts`）の材料は入れない（献立の状態は
 *   書き換えない）。除外を読めなければ同期を止める（空の除外で「問題なし」と見なさない）。外した枠の出所は、
 *   通常の「必要量から外れた出所」と同じ扱い（作った・日が過ぎた枠の充当は、除外とは別の事実として残る）。
 * - 対象は「今日以降の確定した枠」（提案・作った・作らなかった枠は含めない）。在庫は一度だけ差し引く
 *   （`grocery.ts`）。計算はサーバーの最新の献立・在庫・設定から行う。
 * - 書込は RPC 1 本。RPC は `item_key` で upsert し、購入量・メモ・売場の変更・手動項目を保持する
 *   （同じ内容を何度送っても行は増えない）。
 * - **作った料理への充当**: 購入は「これから作る料理の必要量」に対するもの。出所へ枠の ID と正味量
 *   （`entryId` / `buy`。`rows.ts` の `groceryNeedsToRpc`）を足して送り、RPC が「作った」枠・確定のまま
 *   日が過ぎた枠ぶんを、充当の台帳（`consumptions`）へ枠ごとに 1 回だけ記録する（作った後・翌週の必要量を
 *   相殺し続けない）。**購入の事実（`purchased_quantity` / `purchased`）は書き換えない**。「作った」を取り消すと、
 *   その枠の記録だけを外す（後から家族が足した購入は消えない。在庫は変えない）。過ぎた日の枠の「作らなかった」→
 *   取り消しでは、記録を眠らせて起こす（失わない）。台帳は同期だけでなく、枠の状態の保存・購入・補充の RPC も
 *   書く前に枠の状態へ合わせる（同期が失敗しても、使った分を在庫へ足せない）。
 *   献立の変更（削除・差し替え）で外れた分は記録しない。判定は DB の枠の状態から行う。出所に載せられるのは
 *   確定の枠だけで、buy の合計は必要量を超えられない（RPC が 22023 で拒む。この計算はどちらも満たす）。
 * - 計算と書込の間に献立が変わっていたら RPC が `conflict` を返す。そのときは**読み直して 1 回だけ**
 *   やり直す（古い必要量を書かない）。
 * - 送れない項目が 1 件でも在れば**同期を送らない**（一部だけ送ると、送らなかった自動項目を RPC が
 *   「不要になった」として消す）。読めない献立の行が在るときも同じ理由で送らない。
 * - throw しない。結果は `ok` と、失敗時は分類つきの応答で返す。
 */

import { failureOfRpcError, parseRpcStatus, rejectedResult, unknownResult, type ChoreSaveFailure } from "@/lib/domain/rpc-outcome"
import { logSupabaseErrorRedacted } from "@/lib/supabase/log-error"
import type { Json } from "@/lib/types/database"
import { isValidYmd, shiftYmd } from "@/lib/utils/date-jst"

import {
  buildExclusionSet,
  type ExclusionSet,
  findPlanConflicts,
  type PlanConflict,
  undeterminedAllergyLabels,
} from "../exclusions"
import { buildGroceryNeeds } from "../grocery"
import type { CatalogInput } from "../lookup"
import type { FoodExclusion, PlanEntry } from "../types"
import { type MealSupabase, loadMealContext } from "./context"
import { GROCERY_HORIZON_DAYS, groceryAutoHoldMessage } from "./plan-requests"
import { groceryNeedsToRpc, toFiniteNumber } from "./rows"
import { mealToday } from "./today"

type DbError = Parameters<typeof logSupabaseErrorRedacted>[2]

/** Action が DB へ触るのに要る最小の文脈（`getAuthContext()` の context から作る）。 */
export interface DinnerActor {
  supabase: MealSupabase
  householdId: string
  userId: string
}

export const DINNER_MESSAGES = {
  invalid: "入力内容を確認してください。",
  readFailed: "最新の状態を確認できませんでした。通信状況を確認して、もう一度お試しください。",
  saveFailed: "保存できませんでした。通信状況を確認して、もう一度お試しください。",
  notAllowed: "この操作を行えません。再読み込みして、権限を確認してください。",
  idConflict: "同じ操作が別の内容で記録済みでした。上書きはしていません。画面の内容を確認してください。",
  slotTaken: "移動先・保存先の枠が埋まっています。再読み込みして確認してください。",
  futureCooked: "未来の日の料理は「作った」にできません。",
  neededItem: "献立で必要な項目は削除できません。献立を変えると、買い物リストから外れます。",
  tooManyRestocks: "この項目は在庫へ追加できる回数の上限に達しています。",
} as const

/**
 * DB の拒否を、利用者向けの文と失敗の分類へ直す（生のエラーは返さない。呼び出し側がログへ出す）。
 * 23505（同じ操作 ID に別の内容・枠の衝突）は、同じ内容を送り直しても成立しない衝突。
 */
export function dinnerFailureOf(error: { code?: string | null; message?: string | null }): ChoreSaveFailure {
  const code = error.code ?? ""
  const message = error.message ?? ""
  if (code === "23505") {
    return { error: message.includes("slot") ? DINNER_MESSAGES.slotTaken : DINNER_MESSAGES.idConflict, failure: "conflict" }
  }
  if (code === "42501") return failureOfRpcError(error, DINNER_MESSAGES.notAllowed)
  if (code === "22023") {
    return failureOfRpcError(error, message.includes("future") ? DINNER_MESSAGES.futureCooked : DINNER_MESSAGES.invalid)
  }
  if (code === "23514") {
    if (message.includes("needed auto item")) return failureOfRpcError(error, DINNER_MESSAGES.neededItem)
    if (message.includes("too many restocks")) return failureOfRpcError(error, DINNER_MESSAGES.tooManyRestocks)
    return failureOfRpcError(error, DINNER_MESSAGES.invalid)
  }
  return failureOfRpcError(error, DINNER_MESSAGES.saveFailed)
}

/** RPC・読み取りの失敗をログへ出す（家庭の入力を載せうる details / hint は出さない）。 */
export function logDinnerError(summary: string, error: DbError, actor: Pick<DinnerActor, "userId">): void {
  logSupabaseErrorRedacted("meals", summary, error, { userId: actor.userId })
}

// ── 献立の版と、直近の操作 ID ──────────────────────────────────────

export interface PlanOperationState {
  /** 献立全体の版（行が無い世帯は 0）。 */
  revision: number
  /** 最後に成立した「献立の作り直し（apply_dinner_plan）」の操作 ID。 */
  lastOperationId: string | null
  /** 最後に成立した「買い物の同期」の操作 ID。 */
  groceryOperationId: string | null
  groceryRevision: number | null
}

/**
 * 献立の版と、直近に成立した操作 ID を読む。応答を失った再送が「既に成立した自分の操作」かを、
 * 計算し直す前に確かめるために使う（計算し直すと、内容が変わって別の操作として拒まれうる）。
 */
export async function loadPlanOperationState(
  actor: DinnerActor,
): Promise<{ ok: true; state: PlanOperationState } | { ok: false; failure: ChoreSaveFailure }> {
  const { data, error } = await actor.supabase
    .from("dinner_plan_state")
    .select("revision, last_operation_id, grocery_operation_id, grocery_revision")
    .eq("household_id", actor.householdId)
    .maybeSingle()
  if (error) {
    logDinnerError("plan state lookup failed", error, actor)
    return { ok: false, failure: failureOfRpcError(error, DINNER_MESSAGES.readFailed) }
  }
  if (data === null) {
    return { ok: true, state: { revision: 0, lastOperationId: null, groceryOperationId: null, groceryRevision: null } }
  }
  const revision = toFiniteNumber(data.revision)
  if (revision === null || !Number.isInteger(revision) || revision < 0) {
    // 版を 0 と言い換えると、古い版で献立を上書きする要求を作ってしまう
    console.error("[meals] plan state row could not be read", { userId: actor.userId })
    return { ok: false, failure: rejectedResult(DINNER_MESSAGES.readFailed) }
  }
  return {
    ok: true,
    state: {
      revision,
      lastOperationId: typeof data.last_operation_id === "string" ? data.last_operation_id : null,
      groceryOperationId: typeof data.grocery_operation_id === "string" ? data.grocery_operation_id : null,
      groceryRevision: toFiniteNumber(data.grocery_revision),
    },
  }
}

// ── 買い物の同期 ───────────────────────────────────────────────────

/** 買い物の自動計算が対象にする範囲（今日から `GROCERY_HORIZON_DAYS` 日ぶん。両端を含む）。 */
export function groceryRange(today: string): { from: string; to: string } | null {
  if (!isValidYmd(today)) return null
  return { from: today, to: shiftYmd(today, GROCERY_HORIZON_DAYS - 1) }
}

export type GrocerySyncOutcome =
  | { ok: true; status: "saved" | "replayed"; revision: number | null }
  /**
   * `held` = 判定できないアレルギーの登録のために、同期を送らなかった（何も書いていない）。`failure.error` は
   * 理由と直す場所を言う文（「献立から更新を押して」とは言わない。押しても同じ理由で止まる）。
   */
  | { ok: false; failure: ChoreSaveFailure; held?: true }

/**
 * 買い物の自動計算に入れない確定の枠: 使わない食材の設定での判定が「問題なし」でないもの（当たる・確かめられない）。
 * 献立の画面・設定の重なりの一覧と同じ判定（`findPlanConflicts`）。献立の状態は変えない。
 * 除外を読めなかったときに空の除外で呼ばないこと（「問題なし」と見なして材料を入れてしまう）。
 */
export function groceryHeldConflicts(
  entries: readonly PlanEntry[],
  exclusions: readonly FoodExclusion[],
  catalog: CatalogInput,
): PlanConflict[] {
  return groceryHeldConflictsIn(entries, buildExclusionSet(exclusions, catalog))
}

/** `groceryHeldConflicts` の判定そのもの（除外の和集合を作り終えた呼び出し側が、理由の文にも同じ集合を使うため）。 */
export function groceryHeldConflictsIn(entries: readonly PlanEntry[], set: ExclusionSet): PlanConflict[] {
  return findPlanConflicts(
    entries.filter((entry) => entry.status === "confirmed"),
    set,
  )
}

export const GROCERY_SYNC_MESSAGES = {
  unreadablePlan: "献立に読めない記録があるため、買い物リストを更新できません。献立の画面で確認してください。",
  unreadableExclusions:
    "使わない食材の設定を読めないため、買い物リストを更新していません（当たる料理の材料を入れないためです）。少し待ってから、もう一度お試しください。",
  unsendable: "買い物リストへ載せられない材料があるため、更新を止めました。献立の料理と人数を確認してください。",
  busy: "献立が続けて更新されたため、買い物リストを更新できませんでした。少し待ってからもう一度お試しください。",
} as const

/**
 * 確定した献立から必要な材料を計算し、買い物の自動項目を同期する。
 *
 * @param operationId 利用者の明示の操作（「献立から更新」）は、クライアントが固定した ID を渡す
 *   （応答を失った再送が二重の操作にならない）。献立を変えた後の自動の同期は、その都度の新しい ID でよい
 *   （RPC は内容で upsert するので、ID が違っても行は増えない）。
 */
export async function syncGroceryAutoItems(
  actor: DinnerActor,
  operationId: string,
  options: { today?: string } = {},
): Promise<GrocerySyncOutcome> {
  const today = options.today ?? mealToday()
  const range = groceryRange(today)
  if (range === null) return { ok: false, failure: rejectedResult(DINNER_MESSAGES.readFailed) }

  // 応答を失った自分の再送か。成立済みなら計算し直さない（在庫が変わっていると別の内容になり、拒まれる）
  const state = await loadPlanOperationState(actor)
  if (!state.ok) return { ok: false, failure: state.failure }
  if (state.state.groceryOperationId === operationId) {
    return { ok: true, status: "replayed", revision: state.state.revision }
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const loaded = await loadMealContext(actor.supabase, actor.householdId, {
      include: ["settings", "pantry", "plan", "exclusions"],
      planRange: range,
      today,
    })
    if (!loaded.ok) {
      // 使わない食材の設定を読めない（通信・権限・読めない行）。空の除外で「問題なし」と見なして当たる料理の材料を
      // 入れることはしない（fail-closed）。同期そのものを止め、理由を返す
      const exclusionsFailed = loaded.failures.some((failure) => failure.part === "exclusions")
      return {
        ok: false,
        failure: rejectedResult(exclusionsFailed ? GROCERY_SYNC_MESSAGES.unreadableExclusions : DINNER_MESSAGES.readFailed),
      }
    }
    const context = loaded.context
    // 読めない枠を「無い」として計算すると、その料理の材料を「不要になった」として消してしまう
    if ((context.unreadable.plan ?? 0) > 0) {
      return { ok: false, failure: rejectedResult(GROCERY_SYNC_MESSAGES.unreadablePlan) }
    }

    const set = buildExclusionSet(context.exclusions, context.lookup)
    // 判定できないアレルギーの間は、どの料理も確かめられない。全てを外した必要量を送ると、RPC が未購入の自動項目を
    // 消し、購入した項目を「不要」にする。送らずに止め、今のリストを残す（要再確認）
    if (set.holdsAutoConfirm) {
      return { ok: false, held: true, failure: rejectedResult(groceryAutoHoldMessage(undeterminedAllergyLabels(set))) }
    }
    const held = groceryHeldConflictsIn(context.plan.entries, set)
    const result = buildGroceryNeeds({
      entries: context.plan.entries,
      from: range.from,
      to: range.to,
      pantry: context.pantry,
      today,
      stapleIngredientIds: context.settings.stapleIngredientIds,
      catalog: context.lookup,
      heldEntryIds: new Set(held.map((conflict) => conflict.entryId)),
    })
    // 出所へ枠の ID と正味量を足す（DB が「作った・日が過ぎた」料理ぶんの購入の記録を使い終えたものとして扱う）
    const { items, rejected } = groceryNeedsToRpc(result.needs, context.plan.entries)
    if (rejected.length > 0) {
      console.error("[meals] grocery needs could not be sent", {
        userId: actor.userId,
        rejected: rejected.slice(0, 20),
      })
      return { ok: false, failure: rejectedResult(GROCERY_SYNC_MESSAGES.unsendable) }
    }

    const { data, error } = await actor.supabase.rpc("sync_grocery_auto_items", {
      p_operation_id: operationId,
      p_plan_revision: context.plan.revision,
      p_items: items as unknown as Json,
    })
    if (error) {
      // 献立の行と版は並べて読む（`loadMealContext`）。その間に「作った」等が挟まると、古い行（確定）と新しい版の組で
      // 送り、DB が「確定でない枠を出所に載せた」と拒む（22023）。何も書かれていない。conflict と同じく読み直す
      if (error.code === "22023" && (error.message ?? "").includes("not confirmed")) continue
      logDinnerError("sync_grocery_auto_items failed", error, actor)
      return { ok: false, failure: dinnerFailureOf(error) }
    }
    const status = parseRpcStatus(data)
    if (status === null) return { ok: false, failure: unknownResult() }
    // 計算の後に献立が変わった。古い必要量は書かれていない。読み直して 1 回だけやり直す
    if (status === "conflict") continue
    const revision = toFiniteNumber((data as { revision?: unknown }).revision)
    return { ok: true, status, revision }
  }
  return { ok: false, failure: rejectedResult(GROCERY_SYNC_MESSAGES.busy) }
}
