/**
 * 家事（ごみ・掃除・ごはん）の RPC を、実 Auth（GoTrue のパスワードサインイン）→ PostgREST → DB で、
 * **Server Action を通さず**利用者の JWT のまま直に叩く（X-07 / X-08 / X-09 / X-10 の実スタックでの確認）。
 *
 * - 呼び出しは全て anon キー + 利用者のセッション（`userClient`）。service_role へ切り替えて通すことはしない。
 *   service_role（`adminClient`）は fixture の用意（2 人目の世帯参加）と後片付けにだけ使う。
 * - 確かめること:
 *   * 正規の家族メンバー（owner / member）の保存は通り、同じ世帯の別アカウントから見える
 *   * 別世帯・子ども閲覧招待の受諾者（viewer）・未ログイン（anon）の RPC は 42501
 *   * 表への直接 DML は 42501（書込は RPC だけ）
 *   * 同じ操作の再送は replayed、古い版は conflict、同じ回の同時完了は 1 行（already_closed）
 * - PGlite の pgTAP（単一接続・認証スタブ）では見えぬ、本物の GoTrue の JWT と PostgREST の権限解決を通す。
 *   2 接続の真の競合は `scripts/test-chores-concurrency.py`（CI の E2E ジョブ）が別に見る。
 */
import { randomUUID } from "node:crypto"
import type { SupabaseClient } from "@supabase/supabase-js"
import { test, expect } from "./fixtures/test"
import { adminClient, cleanupUser, createPasswordUser, uniqueEmail, userClient, type E2eUser } from "./fixtures/auth"

/** JST の今日（"YYYY-MM-DD"。日付文字列を Date へ渡さぬ）。 */
function todayJst(): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date())
}

interface RpcResult {
  data: unknown
  error: { code?: string; message?: string } | null
}

async function rpc(client: SupabaseClient, fn: string, args: Record<string, unknown>): Promise<RpcResult> {
  const { data, error } = await client.rpc(fn, args)
  return { data, error }
}

/** 成功した RPC の `status`（saved / replayed / conflict / already_closed）。失敗なら原因つきで落とす。 */
function statusOf(result: RpcResult, label: string): string {
  expect(result.error, `${label}: ${JSON.stringify(result.error)}`).toBeNull()
  const status = (result.data as { status?: unknown } | null)?.status
  expect(typeof status, `${label}: status`).toBe("string")
  return status as string
}

function expectDenied(result: RpcResult, label: string): void {
  expect(result.error, `${label} must be refused`).not.toBeNull()
  expect(result.error?.code, `${label}: ${JSON.stringify(result.error)}`).toBe("42501")
}

function field<T>(result: RpcResult, key: string, inner: string): T {
  const value = (result.data as Record<string, Record<string, unknown>> | null)?.[key]?.[inner]
  expect(value, `${key}.${inner}`).toBeDefined()
  return value as T
}

test.describe("家事の RPC（実 Auth・PostgREST・利用者の JWT）", () => {
  test("家族は保存・共有でき、別世帯・閲覧招待・未ログイン・直接 DML は拒まれ、再送と古い版が守られる", async ({}, testInfo) => {
    const password = `e2e-${randomUUID()}`
    const users: { user: E2eUser; householdId?: string }[] = []
    const make = async (label: string, approved: boolean): Promise<E2eUser> => {
      const user = await createPasswordUser(`${label}-${uniqueEmail(testInfo.workerIndex)}`, password, { approved })
      users.push({ user })
      return user
    }

    try {
      const ownerA = await make("chores-owner-a", true)
      const memberA = await make("chores-member-a", true)
      const ownerB = await make("chores-owner-b", true)
      const shareViewer = await make("chores-share-viewer", false)

      const a1 = await userClient(ownerA.email, password)
      const a2 = await userClient(memberA.email, password)
      const b1 = await userClient(ownerB.email, password)
      const viewer = await userClient(shareViewer.email, password)
      const anon = await userClient()

      // ── 世帯: owner は自分の RPC で作る。2 人目は fixture として service_role で同じ世帯の member にする ──
      const createdA = await rpc(a1, "create_household", { p_name: "synthetic chores rpc A" })
      expect(createdA.error, JSON.stringify(createdA.error)).toBeNull()
      const householdA = createdA.data as string
      users[0].householdId = householdA
      const createdB = await rpc(b1, "create_household", { p_name: "synthetic chores rpc B" })
      expect(createdB.error, JSON.stringify(createdB.error)).toBeNull()
      users[2].householdId = createdB.data as string
      const { error: joinError } = await adminClient()
        .from("profiles")
        .update({ household_id: householdA, role: "member", is_approved: true })
        .eq("id", memberA.id)
        .select("id")
        .single()
      expect(joinError, JSON.stringify(joinError)).toBeNull()

      // ── 子ども閲覧招待の受諾者（世帯を持たぬ viewer）: owner A の招待を実 RPC で受ける ──
      const { data: legacyChild, error: childError } = await a1.from("children").select("id").eq("is_legacy", true).single()
      expect(childError, JSON.stringify(childError)).toBeNull()
      const share = await rpc(a1, "create_child_share", {
        p_child_id: (legacyChild as { id: string }).id,
        p_daily: true,
        p_diary: false,
        p_health: false,
        p_custom: false,
      })
      expect(share.error, JSON.stringify(share.error)).toBeNull()
      const accepted = await rpc(viewer, "accept_child_share", { p_token: (share.data as { token: string }).token })
      expect(accepted.error, JSON.stringify(accepted.error)).toBeNull()
      const { data: viewerProfile, error: viewerProfileError } = await adminClient()
        .from("profiles")
        .select("role,household_id")
        .eq("id", shareViewer.id)
        .single()
      expect(viewerProfileError).toBeNull()
      expect(viewerProfile).toEqual({ role: "viewer", household_id: null })

      const today = todayJst()

      await test.step("掃除: 保存・再送・共有・同じ回の重複完了・古い版", async () => {
        const routineId = randomUUID()
        const routineArgs = {
          p_id: routineId,
          p_version: null,
          p_name: "synthetic e2e drain",
          p_location: null,
          p_cadence_unit: "week",
          p_cadence_interval: 1,
          p_schedule_mode: "fixed",
          p_anchor_date: today,
          p_archived: false,
        }
        const saved = await rpc(a1, "save_cleaning_routine", routineArgs)
        expect(statusOf(saved, "owner creates a routine")).toBe("saved")
        const firstVersion = field<string>(saved, "routine", "updated_at")
        expect(statusOf(await rpc(a1, "save_cleaning_routine", routineArgs), "same request again")).toBe("replayed")

        const { data: seenByMember, error: memberReadError } = await a2.from("cleaning_routines").select("id").eq("id", routineId)
        expect(memberReadError).toBeNull()
        expect(seenByMember).toHaveLength(1)
        const { data: seenByOther, error: otherReadError } = await b1.from("cleaning_routines").select("id").eq("id", routineId)
        expect(otherReadError).toBeNull()
        expect(seenByOther).toHaveLength(0)

        const doneArgs = (id: string) => ({
          p_id: id,
          p_routine_id: routineId,
          p_routine_version: firstVersion,
          p_kind: "done",
          p_done_on: today,
          p_occurrence: today,
          p_note: null,
        })
        expectDenied(await rpc(b1, "record_cleaning_log", doneArgs(randomUUID())), "other household completes A's routine")
        expectDenied(await rpc(viewer, "record_cleaning_log", doneArgs(randomUUID())), "child-share viewer completes")
        expectDenied(await rpc(anon, "record_cleaning_log", doneArgs(randomUUID())), "anon completes")
        expectDenied(await rpc(viewer, "save_cleaning_routine", { ...routineArgs, p_id: randomUUID() }), "child-share viewer creates")

        const direct = await a2.from("cleaning_logs").insert({
          id: randomUUID(),
          household_id: householdA,
          routine_id: routineId,
          kind: "done",
          done_on: today,
          occurrence: today,
        })
        expectDenied({ data: null, error: direct.error }, "member inserts into cleaning_logs directly")

        const firstDone = randomUUID()
        expect(statusOf(await rpc(a1, "record_cleaning_log", doneArgs(firstDone)), "owner completes")).toBe("saved")
        expect(statusOf(await rpc(a1, "record_cleaning_log", doneArgs(firstDone)), "owner resends")).toBe("replayed")
        const second = await rpc(a2, "record_cleaning_log", doneArgs(randomUUID()))
        expect(statusOf(second, "member completes the same occurrence")).toBe("already_closed")
        expect(field<string>(second, "log", "id")).toBe(firstDone)
        const { data: validLogs, error: logReadError } = await a2
          .from("cleaning_logs")
          .select("id")
          .eq("routine_id", routineId)
          .is("voided_at", null)
        expect(logReadError).toBeNull()
        expect(validLogs).toHaveLength(1)

        const renamed = await rpc(a2, "save_cleaning_routine", { ...routineArgs, p_version: firstVersion, p_name: "synthetic e2e drain 2" })
        expect(statusOf(renamed, "member renames with the current version")).toBe("saved")
        const stale = await rpc(a1, "save_cleaning_routine", { ...routineArgs, p_version: firstVersion, p_name: "synthetic e2e stale" })
        expect(statusOf(stale, "owner renames with the old version")).toBe("conflict")
        const { data: kept } = await a1.from("cleaning_routines").select("name").eq("id", routineId).single()
        expect(kept).toEqual({ name: "synthetic e2e drain 2" })
      })

      await test.step("ごはん: 在庫と買い物の保存・共有・古い版・境界", async () => {
        const pantryId = randomUUID()
        const pantryItem = {
          ingredient_id: null,
          name: "synthetic e2e carrot",
          quantity: 2,
          unit: "本",
          status: "have",
          use_soon: false,
          storage: "fridge",
          expires_on: null,
          confirmed_on: today,
        }
        const saved = await rpc(a1, "save_pantry_item", { p_id: pantryId, p_version: null, p_item: pantryItem })
        expect(statusOf(saved, "owner adds pantry")).toBe("saved")
        const pantryVersion = field<string>(saved, "item", "updated_at")
        expect(statusOf(await rpc(a1, "save_pantry_item", { p_id: pantryId, p_version: null, p_item: pantryItem }), "resend")).toBe("replayed")
        const { data: memberPantry } = await a2.from("pantry_items").select("id").eq("id", pantryId)
        expect(memberPantry).toHaveLength(1)
        const { data: otherPantry } = await b1.from("pantry_items").select("id").eq("id", pantryId)
        expect(otherPantry).toHaveLength(0)

        expectDenied(await rpc(b1, "delete_pantry_item", { p_id: pantryId, p_version: pantryVersion }), "other household deletes A's pantry")
        expectDenied(await rpc(viewer, "save_pantry_item", { p_id: randomUUID(), p_version: null, p_item: pantryItem }), "viewer adds pantry")
        expectDenied(await rpc(anon, "save_pantry_item", { p_id: randomUUID(), p_version: null, p_item: pantryItem }), "anon adds pantry")
        const direct = await a2.from("pantry_items").insert({ id: randomUUID(), household_id: householdA, name: "synthetic direct", status: "have", use_soon: false, confirmed_on: today })
        expectDenied({ data: null, error: direct.error }, "member inserts into pantry_items directly")

        const updated = await rpc(a2, "save_pantry_item", { p_id: pantryId, p_version: pantryVersion, p_item: { ...pantryItem, quantity: 1 } })
        expect(statusOf(updated, "member updates with the current version")).toBe("saved")
        const stalePantry = await rpc(a1, "save_pantry_item", { p_id: pantryId, p_version: pantryVersion, p_item: { ...pantryItem, quantity: 5 } })
        expect(statusOf(stalePantry, "owner updates with the old version")).toBe("conflict")

        const groceryId = randomUUID()
        const grocery = await rpc(a1, "save_grocery_manual_item", {
          p_id: groceryId,
          p_version: null,
          p_name: "synthetic e2e milk",
          p_quantity: 1,
          p_unit: "本",
          p_section: null,
          p_note: null,
        })
        expect(statusOf(grocery, "owner adds a shopping item")).toBe("saved")
        const groceryVersion = field<string>(grocery, "item", "updated_at")
        const bought = await rpc(a2, "set_grocery_purchase", { p_id: groceryId, p_version: groceryVersion, p_purchased_quantity: 1, p_purchased: true })
        expect(statusOf(bought, "member marks it bought")).toBe("saved")
        expect(statusOf(await rpc(a2, "set_grocery_purchase", { p_id: groceryId, p_version: groceryVersion, p_purchased_quantity: 1, p_purchased: true }), "member resends")).toBe("replayed")
        const staleUnbuy = await rpc(a1, "set_grocery_purchase", { p_id: groceryId, p_version: groceryVersion, p_purchased_quantity: 0, p_purchased: false })
        expect(statusOf(staleUnbuy, "owner un-buys from an old screen")).toBe("conflict")
        const { data: shared } = await a1.from("grocery_items").select("purchased_quantity,purchased").eq("id", groceryId).single()
        expect(Number((shared as { purchased_quantity: number | string }).purchased_quantity)).toBe(1)
        expect((shared as { purchased: boolean }).purchased).toBe(true)
        expectDenied(await rpc(b1, "set_grocery_purchase", { p_id: groceryId, p_version: groceryVersion, p_purchased_quantity: 0, p_purchased: false }), "other household edits A's shopping")
        expectDenied(await rpc(viewer, "set_grocery_purchase", { p_id: groceryId, p_version: groceryVersion, p_purchased_quantity: 0, p_purchased: false }), "viewer edits shopping")
      })

      await test.step("ごみの分類: 閲覧招待・未ログインは拒まれる", async () => {
        const args = {
          p_event_id: randomUUID(),
          p_scope: "event",
          p_action: "garbage",
          p_garbage_kind: "synthetic burnable",
          p_reminder: "keep",
          p_seen_series: null,
          p_seen_event: null,
        }
        expectDenied(await rpc(viewer, "save_event_purpose", args), "viewer classifies an event")
        expectDenied(await rpc(anon, "save_event_purpose", args), "anon classifies an event")
      })
    } finally {
      // 2 人目・閲覧者を先に、世帯の owner を後に消す（cleanupUser は owner の世帯ごと消す）
      const order = [...users].sort((left, right) => Number(left.householdId !== undefined) - Number(right.householdId !== undefined))
      for (const entry of order) await cleanupUser(entry.user.id, entry.householdId)
    }
  })
})
