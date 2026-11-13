"use server"

import { revalidatePath } from "next/cache"

import { MEALS_REVALIDATE_PATH } from "@/components/chores/meals/shared/meal-routes"
import { isRecord } from "@/lib/domain/child-sharing"
import { parseRpcOutcome, parseRpcStatus, rejectedResult, unknownResult, type ChoreSaveResult } from "@/lib/domain/rpc-outcome"
import { foldName, parseBulkInput, resolveIngredientId, type ParsedIngredientInput } from "@/lib/meals/normalize"
import { getMealLookup, type MealLookup } from "@/lib/meals/server/context"
import { MEAL_INVALID_MESSAGE, isMealLabel, mealFailureOf, settleMealAction } from "@/lib/meals/server/meal-input"
import {
  PANTRY_BULK_MAX,
  PANTRY_INPUT_MESSAGES,
  PANTRY_NAME_MAX,
  PANTRY_QUANTITY_MIN,
  PANTRY_TEXT_MAX,
  addPantryItemsIssue,
  deletePantryItemIssue,
  savePantryItemIssue,
  type AddPantryItemsRequest,
  type DeletePantryItemRequest,
  type PantryBulkSaveSuccess,
  type PantryDeleteSuccess,
  type PantryItemFields,
  type PantryItemSaveSuccess,
  type PantryPreviewIssue,
  type PantryPreviewItem,
  type PantryPreviewResult,
  type SavePantryItemRequest,
} from "@/lib/meals/server/pantry-requests"
import {
  PANTRY_QUANTITY_MAX,
  isDeletedEntity,
  pantryItemFromRow,
  pantryItemToRpc,
  toFiniteNumber,
  type PantryItemRpc,
  type StoredPantryItem,
} from "@/lib/meals/server/rows"
import { mealToday } from "@/lib/meals/server/today"
import { unitFamily } from "@/lib/meals/units"
import { getAuthContext } from "@/lib/supabase/auth-context"
import { logSupabaseErrorRedacted } from "@/lib/supabase/log-error"

/** 在庫が変わると「今あるもので」・献立の充足・買い物の差し引きが変わる。ごはんの全画面と家事の入口を読み直す。 */
function revalidateMeals(): void {
  revalidatePath(MEALS_REVALIDATE_PATH, "layout")
  revalidatePath("/chores")
}

function previewItem(parsed: ParsedIngredientInput, lookup: MealLookup): PantryPreviewItem {
  const name = parsed.name.trim()
  const issues: PantryPreviewIssue[] = []
  if (!isMealLabel(name, PANTRY_NAME_MAX)) issues.push("name_invalid")

  // 照合は正規化後の完全一致だけ。部位・加工品・似た名前へ寄せない（解決できなければ名前のまま）
  const ingredientId = resolveIngredientId(name, lookup.index)
  if (ingredientId === null && lookup.index.ambiguousNames.has(foldName(name))) issues.push("ambiguous_name")

  let quantity: PantryPreviewItem["quantity"] = null
  if (parsed.quantity !== null) {
    const { amount, unit } = parsed.quantity
    if (amount === null || unitFamily(unit) === "none") {
      issues.push("quantity_not_countable")
    } else {
      // DB は小数 2 桁で持つ。確認画面に出す量と保存される量を同じにする
      const rounded = Math.round(amount * 100) / 100
      if (rounded >= PANTRY_QUANTITY_MIN && rounded <= PANTRY_QUANTITY_MAX) quantity = { amount: rounded, unit }
      else issues.push("quantity_unreadable")
    }
  } else if (parsed.quantityText !== null) {
    // 単位の無い数字（「豚こま 300」）を、推測で g や個にしない
    issues.push("quantity_unreadable")
  }

  return {
    name,
    ingredientId,
    ingredientName: ingredientId === null ? null : (lookup.index.byId.get(ingredientId)?.name ?? null),
    quantity,
    quantityText: parsed.quantityText,
    issues,
  }
}

/**
 * まとめ入力（「玉ねぎ 2個、牛乳200ml、卵」）を 1 件ずつに分け、食材の一覧へ解決できた食材・
 * 解決できなかった名前・読み取れた数量を返す。**保存しない**（DB も読まない）。
 *
 * 画面はこの結果を 1 件ずつ確認・編集させてから `addPantryItems` を呼ぶ。
 */
export async function previewPantryText(text: string): Promise<PantryPreviewResult> {
  const auth = await getAuthContext()
  if (auth.error !== null) return { ok: false, error: auth.error }
  if (typeof text !== "string") return { ok: false, error: MEAL_INVALID_MESSAGE }
  if (text.length > PANTRY_TEXT_MAX) {
    return { ok: false, error: `一度に読み取れるのは${PANTRY_TEXT_MAX}文字までです。分けて入力してください。` }
  }

  const parsed = parseBulkInput(text)
  const lookup = getMealLookup()
  const all = parsed.items.filter((item) => item.name.trim() !== "")
  if (all.length === 0) return { ok: false, error: "食材の名前を入力してください。" }

  const items = all.slice(0, PANTRY_BULK_MAX).map((item) => previewItem(item, lookup))
  return {
    ok: true,
    items,
    resolvedCount: items.filter((item) => item.ingredientId !== null).length,
    unresolvedNames: items.filter((item) => item.ingredientId === null).map((item) => item.name),
    truncated: parsed.truncated || all.length > PANTRY_BULK_MAX,
  }
}

/**
 * 在庫 1 件の内容を、カタログと今日の日付で確かめて RPC の形へ写す。
 *
 * - `ingredientId` が null … 名前を食材の一覧へ解決する（完全一致だけ。解決できなければ null のまま）。
 * - `ingredientId` が在る … 一覧に在る食材であること。名前が**別の**食材に完全一致するなら拒む
 *   （名前を直した後に、前の食材との結び付きが残ったまま保存されるのを止める）。
 */
function prepareItem(
  fields: PantryItemFields,
  lookup: MealLookup,
  today: string,
): { ok: true; rpc: PantryItemRpc } | { ok: false; error: string } {
  const name = fields.name.trim()
  const resolved = resolveIngredientId(name, lookup.index)
  if (fields.ingredientId !== null) {
    const chosen = lookup.index.byId.get(fields.ingredientId)
    if (!chosen) return { ok: false, error: `「${name}」に選んだ食材が食材の一覧にありません。選び直してください。` }
    if (resolved !== null && resolved !== fields.ingredientId) {
      return {
        ok: false,
        error: `「${name}」は、選んだ食材（${chosen.name}）と名前が一致しません。食材を選び直してください。`,
      }
    }
  }
  if (fields.confirmedOn > today) {
    return { ok: false, error: `「${name}」の最終確認日は、今日までの日付を選んでください。` }
  }
  const rpc = pantryItemToRpc({ ...fields, name, ingredientId: fields.ingredientId ?? resolved })
  // 入力された数量を、黙って「数量不明」として保存しない
  if (fields.quantity !== null && rpc.quantity === null) {
    return { ok: false, error: `「${name}」: ${PANTRY_INPUT_MESSAGES.quantity}` }
  }
  return { ok: true, rpc }
}

function bulkOutcome(data: unknown, request: AddPantryItemsRequest): ChoreSaveResult<PantryBulkSaveSuccess> {
  const status = parseRpcStatus(data)
  // まとめ入力は「作成か、同じ内容の再送」だけ。それ以外の応答は読めたことにしない
  if (!isRecord(data) || (status !== "saved" && status !== "replayed")) return unknownResult()
  const rows = data.items
  if (!Array.isArray(rows) || rows.length !== request.items.length) return unknownResult()
  const items: StoredPantryItem[] = []
  for (const [index, row] of rows.entries()) {
    const mapped = pantryItemFromRow(row)
    if (!mapped.ok || mapped.value.id !== request.items[index].id) return unknownResult()
    items.push(mapped.value)
  }
  const saved = toFiniteNumber(data.saved)
  const replayed = toFiniteNumber(data.replayed)
  if (saved === null || replayed === null || saved + replayed !== items.length) return unknownResult()
  revalidateMeals()
  return { status, items, saved, replayed }
}

/**
 * まとめ入力で確認した食材を登録する（最大 50 件・1 トランザクション）。
 *
 * - 行 ID はクライアントが採番して `items[].id` に固定する。同じ ID・同じ内容の再送は `replayed`
 *   （二重に増えない）。同じ ID・別の内容は `conflict` の失敗で、**全体を登録しない**。
 * - 世帯は DB が `auth.uid()` から導出する（要求に世帯の項目は無い）。
 */
export async function addPantryItems(request: AddPantryItemsRequest): Promise<ChoreSaveResult<PantryBulkSaveSuccess>> {
  const auth = await getAuthContext()
  if (auth.error !== null) return rejectedResult(auth.error)
  const issue = addPantryItemsIssue(request)
  if (issue !== null) return rejectedResult(PANTRY_INPUT_MESSAGES[issue])
  const { supabase, userId } = auth.context

  const today = mealToday()
  const lookup = getMealLookup()
  const items: (PantryItemRpc & { id: string })[] = []
  for (const item of request.items) {
    const prepared = prepareItem(item, lookup, today)
    if (!prepared.ok) return rejectedResult(prepared.error)
    items.push({ id: item.id, ...prepared.rpc })
  }

  return settleMealAction("add_pantry_items", userId, async () => {
    const { data, error } = await supabase.rpc("add_pantry_items", { p_items: items.map((item) => ({ ...item })) })
    if (error) {
      logSupabaseErrorRedacted("meals", "add_pantry_items failed", error, { userId, count: items.length })
      return mealFailureOf(error)
    }
    return bulkOutcome(data, request)
  })
}

/**
 * 食材 1 件の作成（`version: null`）・編集（数量・単位・状態・早く使いたい・保管場所・期限・最終確認日）。
 *
 * 編集は開いた時点の版を送る。家族が先に変えていれば `conflict`（上書きしない。最新の行を返す）、
 * 既に削除されていれば `conflict` + `deleted: true`。
 */
export async function savePantryItem(request: SavePantryItemRequest): Promise<ChoreSaveResult<PantryItemSaveSuccess>> {
  const auth = await getAuthContext()
  if (auth.error !== null) return rejectedResult(auth.error)
  const issue = savePantryItemIssue(request)
  if (issue !== null) return rejectedResult(PANTRY_INPUT_MESSAGES[issue])
  const { supabase, userId } = auth.context

  const prepared = prepareItem(request.item, getMealLookup(), mealToday())
  if (!prepared.ok) return rejectedResult(prepared.error)
  const item = prepared.rpc

  return settleMealAction("save_pantry_item", userId, async () => {
    const { data, error } = await supabase.rpc("save_pantry_item", {
      p_id: request.id,
      p_version: request.version,
      p_item: { ...item },
    })
    if (error) {
      logSupabaseErrorRedacted("meals", "save_pantry_item failed", error, { userId })
      return mealFailureOf(error)
    }
    const outcome = parseRpcOutcome(data, "item")
    if (!outcome) return unknownResult()
    if (isDeletedEntity(outcome.entity)) {
      // 「行が既に無い」印は、版つきで届いた保存の conflict にだけ付く
      if (outcome.status !== "conflict" || outcome.entity.id !== request.id) return unknownResult()
      revalidateMeals()
      return { status: "conflict", item: null, deleted: true }
    }
    const mapped = pantryItemFromRow(outcome.entity)
    if (!mapped.ok || mapped.value.id !== request.id) return unknownResult()
    revalidateMeals()
    return { status: outcome.status, item: mapped.value, deleted: false }
  })
}

/**
 * 食材 1 件の削除。開いた時点の版を送る（家族が直した後の行を、古い画面から消さない）。
 * 既に無い行の削除は `replayed`（応答を失った自分の再送）。
 */
export async function deletePantryItem(request: DeletePantryItemRequest): Promise<ChoreSaveResult<PantryDeleteSuccess>> {
  const auth = await getAuthContext()
  if (auth.error !== null) return rejectedResult(auth.error)
  const issue = deletePantryItemIssue(request)
  if (issue !== null) return rejectedResult(PANTRY_INPUT_MESSAGES[issue])
  const { supabase, userId } = auth.context

  return settleMealAction("delete_pantry_item", userId, async () => {
    const { data, error } = await supabase.rpc("delete_pantry_item", { p_id: request.id, p_version: request.version })
    if (error) {
      logSupabaseErrorRedacted("meals", "delete_pantry_item failed", error, { userId })
      return mealFailureOf(error)
    }
    const status = parseRpcStatus(data)
    if (!isRecord(data) || status === null) return unknownResult()
    if (status === "conflict") {
      const mapped = pantryItemFromRow(data.item)
      if (!mapped.ok || mapped.value.id !== request.id) return unknownResult()
      revalidateMeals()
      return { status, id: request.id, item: mapped.value }
    }
    if (data.id !== request.id) return unknownResult()
    revalidateMeals()
    return { status, id: request.id, item: null }
  })
}
