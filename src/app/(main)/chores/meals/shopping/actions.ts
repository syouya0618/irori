"use server"

/**
 * 買い物リストの Server Action（献立からの同期・購入の記録・手動項目・メモと売場・削除・在庫への補充）。
 *
 * ## 契約
 * - 冒頭で `getAuthContext()`。世帯 ID は受け取らない。書込は SECURITY DEFINER の RPC だけ。
 * - 自動項目の必要量はサーバーが献立と在庫から計算する（クライアントの量を信用しない）。
 *   同期は `item_key` の upsert で冪等（何度送っても行は増えず、購入量・メモ・手動項目は残る）。
 * - **「購入済み」「在庫へ足した」「作った料理に使った」は別の事実**。購入の記録は購入量だけを書き、在庫は変えない。
 *   在庫へ足すのは `restockPantryFromGrocery` だけで、確認した量を、クライアントが固定した在庫の行 ID で
 *   1 度だけ反映する（同じ ID の再送は二重に足さない）。作った料理への充当は同期の RPC だけが書く。
 * - 量はすべて「その項目の単位」で受ける。購入量は**事実の合計**（作った料理に使った分を含む）。
 *   残り = 必要量 −（購入量 − 在庫へ足した量 − 作った料理に使った量）。
 * - 結果は `{ status }`（saved / replayed / conflict）か `{ error, failure }`。例外は結果不明として返す。
 */

import { randomUUID } from "node:crypto"

import { revalidatePath } from "next/cache"

import { MEALS_REVALIDATE_PATH } from "@/components/chores/meals/shared/meal-routes"
import { isRecord } from "@/lib/domain/child-sharing"
import {
  failureOfRpcError,
  parseRpcOutcome,
  parseRpcStatus,
  rejectedResult,
  unknownResult,
  type ChoreSaveFailure,
  type RpcStatus,
} from "@/lib/domain/rpc-outcome"
import { STORE_SECTIONS } from "@/lib/meals/catalog/sections"
import { GROCERY_ITEM_COLUMNS, getMealLookup } from "@/lib/meals/server/context"
import {
  DINNER_MESSAGES,
  type DinnerActor,
  dinnerFailureOf,
  logDinnerError,
  syncGroceryAutoItems,
} from "@/lib/meals/server/grocery-sync"
import { settleMealAction } from "@/lib/meals/server/meal-input"
import {
  type DeleteGroceryItemRequest,
  GROCERY_SYNC_FAILED_MESSAGE,
  type GroceryRequest,
  type GrocerySaveResult,
  type GrocerySaveSuccess,
  type GrocerySyncReport,
  type RestockPantryFromGroceryRequest,
  type SaveGroceryManualItemRequest,
  type SetGroceryPurchaseRequest,
  type SyncGroceryListRequest,
  type UpdateGroceryItemMetaRequest,
  isDeleteGroceryItemRequest,
  isGroceryRequest,
  isRestockPantryFromGroceryRequest,
  isSaveGroceryManualItemRequest,
  isSetGroceryPurchaseRequest,
  isSyncGroceryListRequest,
  isUpdateGroceryItemMetaRequest,
  withoutOp,
} from "@/lib/meals/server/plan-requests"
import { type StoredGroceryItem, groceryItemFromRow, isDeletedEntity } from "@/lib/meals/server/rows"
import { roundAmount } from "@/lib/meals/units"
import { getAuthContext } from "@/lib/supabase/auth-context"

const MESSAGES = {
  ...DINNER_MESSAGES,
  goneItem: "この項目は既に削除されています。最新の買い物リストを確認してください。",
  numericOnly: "この項目は量で記録します。「必要量まで購入」を押すか、買った量を入れてください。",
  checkOnly: "この項目は量を追えないため、チェックで記録してください。",
  belowRestocked: "在庫へ足した量より少なくはできません。先に食材の画面で在庫を直してください。",
  belowUsed:
    "在庫へ足した量と、作った料理に使った量の合計より少なくはできません。料理を作っていなければ、先に献立で「作った」を取り消してください。",
  nothingToRestock: "買った分は、作った料理に使ったか、すでに在庫へ追加済みです。",
  tooLarge: "量が大きすぎます。量と単位を確認してください。",
  unknownSection: "この売場は選べません。",
  notPurchased: "購入済みにしてから、在庫へ追加してください。",
  overRestock: "購入した量を超えて在庫へ追加することはできません。買った量を直してから追加してください。",
  needsUnit: "この項目は単位が無いため、量を指定せずに在庫へ追加してください。",
} as const

const QUANTITY_MAX = 9_999_999

function revalidateMeals(): void {
  revalidatePath(MEALS_REVALIDATE_PATH, "layout")
  revalidatePath("/chores")
}

async function runGroceryAction(
  action: string,
  run: (actor: DinnerActor) => Promise<GrocerySaveResult>,
): Promise<GrocerySaveResult> {
  const auth = await getAuthContext()
  if (auth.error !== null) return rejectedResult(auth.error)
  const { supabase, userId, householdId } = auth.context
  const actor: DinnerActor = { supabase, userId, householdId }
  return settleMealAction(action, userId, () => run(actor))
}

function conflictResult(detail: NonNullable<GrocerySaveSuccess["detail"]>, notices: string[] = []): GrocerySaveSuccess {
  return { status: "conflict", detail, notices }
}

function isKnownSection(section: string | null): boolean {
  return section === null || STORE_SECTIONS.some((def) => def.id === section)
}

/** 1 項目を、世帯で絞って読む（RLS と二重）。別世帯の ID は「見つからない」と同じ応答にする。 */
async function loadGroceryItem(
  actor: DinnerActor,
  id: string,
): Promise<
  | { ok: true; item: StoredGroceryItem | null; restockIds: string[] }
  | { ok: false; failure: ChoreSaveFailure }
> {
  const { data, error } = await actor.supabase
    .from("grocery_items")
    .select(GROCERY_ITEM_COLUMNS)
    .eq("id", id)
    .eq("household_id", actor.householdId)
    .maybeSingle()
  if (error) {
    logDinnerError("grocery item lookup failed", error, actor)
    return { ok: false, failure: failureOfRpcError(error, MESSAGES.readFailed) }
  }
  if (data === null) return { ok: true, item: null, restockIds: [] }
  const index = getMealLookup().index
  const row = groceryItemFromRow(data, (ingredientId) => index.byId.get(ingredientId)?.section)
  // 行は在るが読めない。量を「0」と言い換えて書くと購入の記録を壊すので、書かずに止める
  if (!row.ok) return { ok: false, failure: rejectedResult(MESSAGES.readFailed) }
  const raw: unknown = isRecord(data) ? data.restock_ids : null
  const restockIds = Array.isArray(raw) ? raw.filter((value): value is string => typeof value === "string") : []
  return { ok: true, item: row.value, restockIds }
}

/** `{ status, item }` を返す RPC の戻り値を読む。行が要求の項目でなければ結果不明。 */
function itemOutcome(data: unknown, id: string): { ok: true; status: RpcStatus; gone: boolean } | { ok: false } {
  const outcome = parseRpcOutcome(data, "item")
  if (!outcome) return { ok: false }
  if (isDeletedEntity(outcome.entity)) {
    return outcome.status === "conflict" && outcome.entity.id === id ? { ok: true, status: "conflict", gone: true } : { ok: false }
  }
  const row = groceryItemFromRow(outcome.entity)
  if (!row.ok || row.value.id !== id) return { ok: false }
  return { ok: true, status: outcome.status, gone: false }
}

function resultOf(outcome: ReturnType<typeof itemOutcome>, extra: Partial<GrocerySaveSuccess> = {}): GrocerySaveResult {
  if (!outcome.ok) return unknownResult()
  revalidateMeals()
  if (outcome.status === "conflict") {
    return conflictResult(outcome.gone ? "gone" : "row_changed", outcome.gone ? [MESSAGES.goneItem] : [])
  }
  return { status: outcome.status, notices: [], ...extra }
}

function amountOf(quantity: { amount: number | null } | null): number {
  return quantity !== null && typeof quantity.amount === "number" ? quantity.amount : 0
}

// ── 献立からの同期 ─────────────────────────────────────────────────

/**
 * 今日以降の確定した献立から必要な材料を計算し直し、自動項目を同期する（「献立から更新」）。
 * 計算の後に献立が変わっていたら、読み直して 1 回だけやり直す。
 */
export async function syncGroceryList(request: SyncGroceryListRequest): Promise<GrocerySaveResult> {
  if (!isSyncGroceryListRequest(request)) return rejectedResult(MESSAGES.invalid)
  return runGroceryAction("sync_grocery_list", async (actor) => {
    const outcome = await syncGroceryAutoItems(actor, request.operationId)
    if (!outcome.ok) return outcome.failure
    revalidateMeals()
    return { status: outcome.status, notices: [] }
  })
}

// ── 購入の記録 ─────────────────────────────────────────────────────

/**
 * 購入の記録。数値で追える項目は「必要量まで購入」か「買った合計量」、追えない項目はチェック。
 * 購入量は**事実の合計**として DB へ送る（`amount` も、画面が事実の合計で送る）。必要量が後から増えても、
 * 料理を作っても書き換えない（300 買った後に 500 必要になれば、残り 200 と出る）。
 * 版は画面が読んだ時点のもの。DB は「その後に購入の事実が変わっていなければ」通す（必要量・充当・補充だけが
 * 変わった版の違いでは止めない。作る前に開いた画面から、作った後の買い足しを記録できる）。
 * **在庫は変えない**（在庫へ足すのは `restockPantryFromGrocery`）。
 */
export async function setGroceryPurchase(request: SetGroceryPurchaseRequest): Promise<GrocerySaveResult> {
  if (!isSetGroceryPurchaseRequest(request)) return rejectedResult(MESSAGES.invalid)
  return runGroceryAction("set_grocery_purchase", async (actor) => {
    const loaded = await loadGroceryItem(actor, request.id)
    if (!loaded.ok) return loaded.failure
    const { item } = loaded
    if (item === null) return conflictResult("gone", [MESSAGES.goneItem])

    const numeric = item.required !== null && item.unit !== null
    const required = amountOf(item.required)
    const purchasedNow = amountOf(item.purchased)
    const restocked = amountOf(item.restocked)
    const used = amountOf(item.consumed ?? null)
    const { purchase } = request
    let quantity: number
    let purchased: boolean
    if (purchase.kind === "check") {
      if (numeric) return rejectedResult(MESSAGES.numericOnly)
      quantity = purchasedNow
      purchased = purchase.checked
    } else {
      if (!numeric) return rejectedResult(MESSAGES.checkOnly)
      if (purchase.kind === "full") {
        // 残りが 0 になる合計（在庫へ足した分・作った料理に使った分は、今の必要に充てられない）。買った量は減らさない
        quantity = Math.max(purchasedNow, roundAmount(required + restocked + used))
      } else {
        quantity = purchase.amount
        // 合計を「在庫へ足した量 + 作った料理に使った量」より下へ**下げる**ことはできない（上げる・同じ量は通す）。
        // DB（set_grocery_purchase）も同じ式で拒む。DB は書く前に充当を枠の今の状態へ合わせるので、こちらが古くても守られる
        if (quantity < purchasedNow && quantity < roundAmount(restocked + used)) {
          return rejectedResult(quantity < restocked ? MESSAGES.belowRestocked : MESSAGES.belowUsed)
        }
      }
      if (quantity > QUANTITY_MAX) return rejectedResult(MESSAGES.tooLarge)
      // 印は「残りが 0 か」。残り = 必要量 −（購入量 − 在庫へ足した量 − 作った料理に使った量）
      purchased = quantity > 0 && roundAmount(required - Math.max(0, quantity - restocked - used)) <= 0
    }

    const { data, error } = await actor.supabase.rpc("set_grocery_purchase", {
      p_id: request.id,
      p_version: request.version,
      p_purchased_quantity: quantity,
      p_purchased: purchased,
    })
    if (error) {
      logDinnerError("set_grocery_purchase failed", error, actor)
      // 読んだ後に「作った」・日の経過で使った量が増えていた（DB が書く前に数え直して拒んだ）
      if (error.code === "22023" && (error.message ?? "").includes("below restocked and used")) {
        return rejectedResult(MESSAGES.belowUsed)
      }
      return dinnerFailureOf(error)
    }
    return resultOf(itemOutcome(data, request.id))
  })
}

// ── 手動項目・メモ・売場・削除 ─────────────────────────────────────

/** 手動で足した項目の作成・編集（献立からの再計算では消えない）。 */
export async function saveGroceryManualItem(request: SaveGroceryManualItemRequest): Promise<GrocerySaveResult> {
  if (!isSaveGroceryManualItemRequest(request)) return rejectedResult(MESSAGES.invalid)
  if (!isKnownSection(request.section)) return rejectedResult(MESSAGES.unknownSection)
  return runGroceryAction("save_grocery_manual_item", async (actor) => {
    const { data, error } = await actor.supabase.rpc("save_grocery_manual_item", {
      p_id: request.id,
      p_version: request.version,
      p_name: request.name.trim(),
      p_quantity: request.quantity,
      p_unit: request.unit,
      p_section: request.section,
      p_note: request.note === null ? null : request.note.trim(),
    })
    if (error) {
      logDinnerError("save_grocery_manual_item failed", error, actor)
      return dinnerFailureOf(error)
    }
    return resultOf(itemOutcome(data, request.id))
  })
}

/** メモと売場の変更（自動・手動どちらの項目にも使える。献立からの再計算で消えない）。 */
export async function updateGroceryItemMeta(request: UpdateGroceryItemMetaRequest): Promise<GrocerySaveResult> {
  if (!isUpdateGroceryItemMetaRequest(request)) return rejectedResult(MESSAGES.invalid)
  if (!isKnownSection(request.section)) return rejectedResult(MESSAGES.unknownSection)
  return runGroceryAction("update_grocery_item_meta", async (actor) => {
    const { data, error } = await actor.supabase.rpc("update_grocery_item_meta", {
      p_id: request.id,
      p_version: request.version,
      p_note: request.note === null ? null : request.note.trim(),
      p_section: request.section,
    })
    if (error) {
      logDinnerError("update_grocery_item_meta failed", error, actor)
      return dinnerFailureOf(error)
    }
    return resultOf(itemOutcome(data, request.id))
  })
}

/** 項目の削除。消せるのは手動項目と、献立から不要になって残っている自動項目だけ（DB が検証する）。 */
export async function deleteGroceryItem(request: DeleteGroceryItemRequest): Promise<GrocerySaveResult> {
  if (!isDeleteGroceryItemRequest(request)) return rejectedResult(MESSAGES.invalid)
  return runGroceryAction("delete_grocery_item", async (actor) => {
    const { data, error } = await actor.supabase.rpc("delete_grocery_item", {
      p_id: request.id,
      p_version: request.version,
    })
    if (error) {
      logDinnerError("delete_grocery_item failed", error, actor)
      return dinnerFailureOf(error)
    }
    const status = parseRpcStatus(data)
    if (status === null) return unknownResult()
    revalidateMeals()
    return status === "conflict" ? conflictResult("row_changed") : { status, notices: [] }
  })
}

// ── 在庫への補充 ───────────────────────────────────────────────────

/**
 * 買ったものを在庫へ足す。**確認した量だけ**を、新しい在庫の行（`pantryItemId`）として 1 度だけ反映する。
 * 同じ `pantryItemId` の再送は replayed（二重に足さない）。購入の記録には触れない。
 * 在庫が変わるので、成立した後に買い物の必要量を計算し直す（失敗しても補充の成功は変えない）。
 */
export async function restockPantryFromGrocery(request: RestockPantryFromGroceryRequest): Promise<GrocerySaveResult> {
  if (!isRestockPantryFromGroceryRequest(request)) return rejectedResult(MESSAGES.invalid)
  return runGroceryAction("restock_pantry_from_grocery", async (actor) => {
    const loaded = await loadGroceryItem(actor, request.groceryId)
    if (!loaded.ok) return loaded.failure
    const { item, restockIds } = loaded
    if (item === null) return conflictResult("gone", [MESSAGES.goneItem])

    // 既に反映済みの ID（応答を失った再送）は、量の検査をせずに RPC へ渡す（replayed が返る）
    if (!restockIds.includes(request.pantryItemId)) {
      const purchasedAmount = amountOf(item.purchased)
      // 印（item.checked）は作った料理で使い終えると false。量の購入は量で判定する
      if (purchasedAmount <= 0 && !item.checked) return rejectedResult(MESSAGES.notPurchased)
      // 量で追える購入は、購入量 − 反映済みの量 − 作った料理に使った量までしか足せない
      // （買っていない分・使った分を在庫にしない。「作った」の取り消しでも在庫は増えない）
      const restockable =
        purchasedAmount > 0
          ? Math.max(
              0,
              roundAmount(
                purchasedAmount -
                  Math.min(purchasedAmount, amountOf(item.restocked)) -
                  amountOf(item.consumed ?? null),
              ),
            )
          : null
      if (restockable !== null && restockable <= 0) return rejectedResult(MESSAGES.nothingToRestock)
      if (request.quantity !== null) {
        if (item.unit === null) return rejectedResult(MESSAGES.needsUnit)
        if (restockable !== null && request.quantity > restockable) return rejectedResult(MESSAGES.overRestock)
      }
    }

    const { data, error } = await actor.supabase.rpc("restock_pantry_from_grocery", {
      p_grocery_id: request.groceryId,
      p_grocery_version: request.version,
      p_pantry_item_id: request.pantryItemId,
      p_quantity: request.quantity,
    })
    if (error) {
      logDinnerError("restock_pantry_from_grocery failed", error, actor)
      // 補充の上限は RPC 自身も守る（この Action の検査と同じ式。読んだ後に別の端末が補充した等で食い違ったとき）
      if (error.code === "22023") {
        const message = error.message ?? ""
        if (message.includes("exceeds purchase")) return rejectedResult(MESSAGES.overRestock)
        if (message.includes("nothing to restock")) return rejectedResult(MESSAGES.nothingToRestock)
        if (message.includes("not purchased")) return rejectedResult(MESSAGES.notPurchased)
      }
      return dinnerFailureOf(error)
    }
    const outcome = itemOutcome(data, request.groceryId)
    if (!outcome.ok || outcome.status === "conflict") return resultOf(outcome)

    let grocery: GrocerySyncReport
    try {
      const synced = await syncGroceryAutoItems(actor, randomUUID())
      grocery = synced.ok ? { ok: true, status: synced.status } : { ok: false, message: GROCERY_SYNC_FAILED_MESSAGE }
    } catch (err) {
      console.error("[meals] grocery sync threw", {
        userId: actor.userId,
        message: err instanceof Error ? err.message : String(err),
      })
      grocery = { ok: false, message: GROCERY_SYNC_FAILED_MESSAGE }
    }
    return resultOf(outcome, { grocery })
  })
}

// ── 1 つの入口（useChoreSave 用） ──────────────────────────────────

/** 買い物の保存操作をまとめて受ける入口（`op` で振り分ける）。個々の Action と同じ検証・認証を通る。 */
export async function saveGroceryRequest(request: GroceryRequest): Promise<GrocerySaveResult> {
  if (!isGroceryRequest(request)) return rejectedResult(MESSAGES.invalid)
  switch (request.op) {
    case "sync":
      return syncGroceryList(withoutOp(request))
    case "purchase":
      return setGroceryPurchase(withoutOp(request))
    case "manual_item":
      return saveGroceryManualItem(withoutOp(request))
    case "meta":
      return updateGroceryItemMeta(withoutOp(request))
    case "delete":
      return deleteGroceryItem(withoutOp(request))
    case "restock":
      return restockPantryFromGrocery(withoutOp(request))
    default:
      return rejectedResult(MESSAGES.invalid)
  }
}
