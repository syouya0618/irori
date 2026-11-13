/**
 * ごはんの Server Action のテスト用の、メモリ上の DB の代役。
 *
 * `supabase/migrations/20261111100003_dinner_tables.sql` の RPC のうち、Action が頼る性質だけを写す:
 * 世帯での絞り込み、版（`updated_at`）の検査、同じ内容の再送（replayed）、固定枠・作った枠を
 * 上書きしない作り直し、`item_key` での upsert、同じ在庫 ID の補充を二重に足さないこと、
 * 「作った・日が過ぎた」枠への購入の充当（出所の `entryId` / `buy` → 台帳 `consumptions`。購入の事実
 * `purchased_quantity` / `purchased` は書き換えず、取り消した枠の記録だけを外す・眠らせる。台帳を合わせるのは
 * `settle`（= `irori_private.dinner_grocery_settle`）で、同期・状態の変わった枠の保存・購入・補充の各 RPC が呼ぶ）、
 * 取り消しで戻す先（`prior_status`）の保持と画面が出す遷移だけを受けること、使い終えた印の買い直しを replayed に
 * 吸わないこと、購入は「購入の事実を最後に書いた後の版」なら通すこと、購入の合計の下限、補充の上限。
 * **DB の検証そのものは pgTAP（`supabase/tests/dinner_tables.sql`）が担う。** ここは Action が
 * 「何を送り、応答をどう扱うか」を確かめるための道具で、DB の代わりにはならない。
 */

import { shiftYmd } from "@/lib/utils/date-jst"

import type { MealSupabase } from "../context"

export type Row = Record<string, unknown>
export interface Reply {
  data: unknown
  error: { code?: string; message?: string; details?: string; hint?: string } | null
}

const TABLES = [
  "dinner_settings",
  "pantry_items",
  "food_exclusions",
  "food_preferences",
  "dish_feedback",
  "dinner_plan_state",
  "dinner_plan_entries",
  "grocery_items",
  "children",
  "profiles",
] as const
type Table = (typeof TABLES)[number]

const ENTRY_CONTENT = [
  "plan_date",
  "role",
  "position",
  "recipe_id",
  "recipe_version",
  "custom_title",
  "custom_ingredients",
  "servings",
  "pinned",
  "status",
  "origin",
] as const
const PANTRY_CONTENT = [
  "ingredient_id",
  "name",
  "quantity",
  "unit",
  "status",
  "use_soon",
  "storage",
  "expires_on",
  "confirmed_on",
] as const

const ok = (data: unknown): Reply => ({ data, error: null })
const fail = (code: string, message: string): Reply => ({ data: null, error: { code, message, details: "", hint: "" } })
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const pick = (row: Row, keys: readonly string[]) => Object.fromEntries(keys.map((key) => [key, row[key] ?? null]))
const round = (value: number, digits: number) => Number(`${Math.round(Number(`${value}e${digits}`))}e-${digits}`)

export interface FakeDinnerDb {
  supabase: MealSupabase
  householdId: string
  userId: string
  tables: Record<Table, Row[]>
  calls: { rpc: [string, Record<string, unknown>][]; from: string[] }
  /** RPC の応答を差し替える（1 回の呼出しごとに評価。undefined を返せば本来の処理へ進む）。 */
  intercept: (name: string, handler: (args: Record<string, unknown>) => Reply | undefined) => void
  /** 表の読みを失敗させる。 */
  failTable: (table: Table) => void
  /** DB の「今日（JST）」を進める（`vi.setSystemTime` と一緒に使う）。 */
  setToday: (date: string) => void
  entries: () => Row[]
  grocery: () => Row[]
  revision: () => number
  rpcNames: () => string[]
}

export function createFakeDinnerDb(options: { householdId: string; userId: string; today: string }): FakeDinnerDb {
  const { householdId, userId } = options
  // DB の「今日（JST）」。日をまたぐ流れを確かめるテストは `setToday` で進める
  let today = options.today
  const tables = Object.fromEntries(TABLES.map((table) => [table, [] as Row[]])) as Record<Table, Row[]>
  const calls: FakeDinnerDb["calls"] = { rpc: [], from: [] }
  const interceptors = new Map<string, (args: Record<string, unknown>) => Reply | undefined>()
  const failing = new Set<string>()
  let tick = 0
  const stamp = () => {
    tick += 1
    return `2026-11-11T01:00:00.${String(tick).padStart(6, "0")}+00:00`
  }
  let serial = 0
  const serverId = () => {
    serial += 1
    return `aaaaaaaa-0000-4000-8000-${String(serial).padStart(12, "0")}`
  }

  const state = (): Row => {
    let row = tables.dinner_plan_state.find((candidate) => candidate.household_id === householdId)
    if (!row) {
      row = {
        household_id: householdId,
        revision: 0,
        last_operation_id: null,
        last_request_hash: null,
        grocery_operation_id: null,
        grocery_request_hash: null,
        grocery_revision: null,
      }
      tables.dinner_plan_state.push(row)
    }
    return row
  }
  const bump = () => {
    const row = state()
    row.revision = (row.revision as number) + 1
    return row.revision as number
  }
  const mine = (table: Table) => tables[table].filter((row) => row.household_id === householdId)
  const gone = (id: unknown) => ({ id, deleted: true })
  const ledgerOf = (row: Row): Row[] => (Array.isArray(row.consumptions) ? (row.consumptions as Row[]) : [])
  const sumOf = (records: readonly Row[]) => records.reduce((sum, record) => round(sum + (record.q as number), 3), 0)
  const hasRecord = (row: Row) =>
    (row.purchased_quantity as number) > 0 ||
    row.purchased === true ||
    row.note !== null ||
    (row.restocked_quantity as number) > 0 ||
    (row.restock_ids as unknown[]).length > 0 ||
    ledgerOf(row).length > 0
  const entryOf = (id: unknown) => mine("dinner_plan_entries").find((candidate) => candidate.id === id)
  const isConsumed = (entry: Row | undefined): entry is Row =>
    entry !== undefined &&
    (entry.status === "cooked" || (entry.status === "confirmed" && (entry.plan_date as string) < today))
  const sourceSpent = (source: Row) =>
    typeof source.entryId === "string" ? isConsumed(entryOf(source.entryId)) : (source.date as string) < today
  const isOn = (record: Row) => record.on === true

  /**
   * `irori_private.dinner_grocery_settle` の写し: 1 行の充当の台帳を、献立の枠の今の状態へ合わせる。
   * `next` = その項目の新しい出所（同期）。null は「今の出所のうち消費済みでないものが載っている」（同期を待たない合わせ方）。
   * 記録 {k, q, m, d, on, pc}: on=false は眠り（作らなかった・取り消しで数えるのをやめた記録と、作らなかった枠の需要）。
   */
  function settle(row: Row, nextSources: Row[] | null): boolean {
    if (row.origin !== "auto") return false
    const sources = Array.isArray(row.sources) ? (row.sources as Row[]) : []
    const before = ledgerOf(row)
    const next = nextSources ?? sources.filter((source) => !sourceSpent(source))
    const purchased = row.purchased_quantity as number
    const wasConsumed = row.purchase_consumed === true
    let settled = 0
    let reverted = false
    let revertedMark = false
    let addedQty = false
    let wokeMark = false
    let wokePc = false
    const ledger: Row[] = []
    const wake: Row[] = []
    // (1) 既にある記録を見直す
    for (const record of before) {
      const q = record.q as number
      if (record.k === "settled") {
        settled = round(settled + q, 3)
        continue
      }
      const entry = entryOf(record.k)
      if (!entry || (entry.plan_date as string) < shiftYmd(today, -35)) {
        if (isOn(record)) settled = round(settled + q, 3)
        continue
      }
      if (next.some((candidate) => candidate.entryId === record.k)) {
        if (isOn(record)) {
          reverted = true
          if (record.m === true) revertedMark = true
        }
        continue
      }
      if (isConsumed(entry)) {
        if (isOn(record)) ledger.push(record)
        else wake.push(record)
      } else if (isOn(record)) {
        ledger.push({ k: record.k, q, m: record.m, d: record.d ?? null, on: false, pc: record.m === true && wasConsumed })
        reverted = true
        if (record.m === true) revertedMark = true
      } else {
        ledger.push(record)
      }
    }
    // (2) 充てられる量。消費済みに戻った眠りを日付の順に起こす
    let avail = Math.max(0, round(purchased - (row.restocked_quantity as number) - settled - sumOf(ledger.filter(isOn)), 3))
    for (const record of [...wake].sort(
      (a, b) => String(a.d).localeCompare(String(b.d)) || String(a.k).localeCompare(String(b.k)),
    )) {
      const q = round(Math.min(record.q as number, avail), 3)
      ledger.push({ k: record.k, q, m: record.m, d: record.d ?? null, on: true })
      avail = round(avail - q, 3)
      if (q > 0) addedQty = true
      if (record.m === true) wokeMark = true
      if (record.pc === true) wokePc = true
    }
    // (3) 済んだ出所を、記録の無い枠に限り 1 回だけ記録する
    const tickAlive = row.purchased === true && purchased === 0 && !wasConsumed
    let allSpent = sources.length > 0
    const ordered = sources
      .map((source, index) => ({ source, index }))
      .sort(
        (a, b) =>
          String(a.source.date).localeCompare(String(b.source.date)) ||
          String(a.source.entryId ?? "").localeCompare(String(b.source.entryId ?? "")) ||
          a.index - b.index,
      )
    for (const { source } of ordered) {
      const key = typeof source.entryId === "string" ? source.entryId : null
      const buy = round(typeof source.buy === "number" ? source.buy : 0, 3)
      const listed =
        key !== null
          ? next.some((candidate) => candidate.entryId === key)
          : next.some(
              (candidate) =>
                typeof candidate.entryId !== "string" &&
                candidate.date === source.date &&
                candidate.recipeId === source.recipeId &&
                candidate.title === source.title,
            )
      if (listed) {
        allSpent = false
        continue
      }
      const entry = key === null ? undefined : entryOf(key)
      const spent = key === null ? (source.date as string) < today : isConsumed(entry)
      if (key !== null && ledger.some((record) => record.k === key)) {
        if (!spent) allSpent = false
        continue
      }
      if (!spent) {
        allSpent = false
        if (entry && entry.status === "skipped" && (entry.plan_date as string) >= shiftYmd(today, -35)) {
          ledger.push({ k: key, q: buy, m: tickAlive, d: entry.plan_date, on: false, pc: false })
        }
        continue
      }
      const q = round(Math.min(buy, avail), 3)
      if (key === null) settled = round(settled + q, 3)
      else if (q > 0 || tickAlive || entry?.status === "cooked") {
        ledger.push({ k: key, q, m: tickAlive, d: entry?.plan_date ?? null, on: true })
      }
      avail = round(avail - q, 3)
      if (q > 0) addedQty = true
    }
    const consumptions = settled > 0 ? [{ k: "settled", q: settled, m: false, on: true }, ...ledger] : ledger
    const consumed = sumOf(consumptions.filter(isOn))
    let purchaseConsumed: boolean
    if (row.purchased !== true) purchaseConsumed = false
    else if (purchased > 0) purchaseConsumed = reverted ? false : addedQty ? true : wasConsumed
    else if (revertedMark) purchaseConsumed = false
    else if (wokePc) purchaseConsumed = true
    else if (tickAlive && allSpent) purchaseConsumed = true
    else if (wokeMark && tickAlive && next.length === 0 && !consumptions.some((record) => record.m === true && !isOn(record))) {
      purchaseConsumed = true
    } else purchaseConsumed = wasConsumed
    if (same(consumptions, before) && consumed === (row.consumed_quantity ?? 0) && purchaseConsumed === wasConsumed) return false
    Object.assign(row, { consumptions, consumed_quantity: consumed, purchase_consumed: purchaseConsumed, updated_at: stamp() })
    return true
  }

  function parseEntry(payload: Row): Row | Reply {
    const entry = pick(payload, ENTRY_CONTENT)
    if (entry.status === "cooked" && (entry.plan_date as string) > today) return fail("22023", "future dish cannot be cooked")
    const isRecipe = entry.recipe_id !== null
    if (isRecipe ? entry.custom_title !== null || entry.recipe_version === null : entry.custom_title === null) {
      return fail("22023", "recipe and custom dish are exclusive")
    }
    return entry
  }
  const isReply = (value: Row | Reply): value is Reply => "error" in value && "data" in value

  const handlers: Record<string, (args: Record<string, unknown>) => Reply> = {
    apply_dinner_plan(args) {
      const st = state()
      const start = args.p_range_start as string
      const end = args.p_range_end as string
      const incoming = args.p_entries as Row[]
      const inRange = (row: Row) => (row.plan_date as string) >= start && (row.plan_date as string) <= end
      for (const item of incoming) {
        if (!inRange(item) || (item.status !== "proposed" && item.status !== "confirmed")) {
          return fail("22023", "entry outside the plan")
        }
      }
      const hash = JSON.stringify({ start, end, incoming })
      const list = () => mine("dinner_plan_entries").filter(inRange)
      if (st.last_operation_id === args.p_operation_id) {
        if (st.last_request_hash !== hash) return fail("23505", "operation id conflict")
        return ok({ status: "replayed", revision: st.revision, entries: list(), skipped: [] })
      }
      if (st.revision !== args.p_expected_revision) {
        return ok({ status: "conflict", revision: st.revision, entries: list(), skipped: [] })
      }
      tables.dinner_plan_entries = tables.dinner_plan_entries.filter(
        (row) => !(row.household_id === householdId && inRange(row) && row.pinned !== true && row.status !== "cooked"),
      )
      const skipped: Row[] = []
      for (const item of incoming) {
        const parsed = parseEntry(item)
        if (isReply(parsed)) return parsed
        const kept = list().find(
          (row) =>
            row.id === item.id ||
            (row.plan_date === parsed.plan_date && row.role === parsed.role && row.position === parsed.position),
        )
        if (kept) {
          skipped.push({ id: item.id, kept_id: kept.id, reason: kept.status === "cooked" ? "cooked" : "pinned" })
          continue
        }
        if (tables.dinner_plan_entries.some((row) => row.id === item.id)) return fail("23505", "entry id in use")
        tables.dinner_plan_entries.push({ id: item.id, household_id: householdId, ...parsed, updated_at: stamp() })
      }
      st.revision = (st.revision as number) + 1
      st.last_operation_id = args.p_operation_id
      st.last_request_hash = hash
      return ok({ status: "saved", revision: st.revision, entries: list(), skipped })
    },

    save_dinner_entry(args) {
      const parsed = parseEntry(args.p_entry as Row)
      if (isReply(parsed)) return parsed
      const st = state()
      const row = tables.dinner_plan_entries.find((candidate) => candidate.id === args.p_id)
      if (row) {
        if (row.household_id !== householdId) return fail("42501", "not allowed")
        if (same(pick(row, ENTRY_CONTENT), parsed)) return ok({ status: "replayed", entry: row, revision: st.revision })
        if (args.p_version === null || row.updated_at !== args.p_version) {
          return ok({ status: "conflict", entry: row, revision: st.revision })
        }
      } else if (args.p_version !== null) {
        return ok({ status: "conflict", entry: gone(args.p_id), revision: st.revision })
      }
      const occupied = mine("dinner_plan_entries").some(
        (candidate) =>
          candidate.id !== args.p_id &&
          candidate.plan_date === parsed.plan_date &&
          candidate.role === parsed.role &&
          candidate.position === parsed.position,
      )
      if (occupied) return fail("23505", "slot occupied")
      // 画面が出す遷移だけ: 新しい枠は提案・確定、作った ↔ 作らなかった は直に行き来しない
      const active = (status: unknown) => status === "proposed" || status === "confirmed"
      if (!row && !active(parsed.status)) return fail("22023", "a new entry must be proposed or confirmed")
      if (row && !active(row.status) && !active(parsed.status) && row.status !== parsed.status) {
        return fail("22023", "cooked and skipped cannot be switched directly")
      }
      // 取り消しで戻す先: 提案・確定 → 作った・作らなかった で直前を保ち、戻ると消す
      const prior = active(parsed.status)
        ? null
        : row && active(row.status)
          ? row.status
          : (row?.prior_status ?? null)
      const moved = row !== undefined && (row.status !== parsed.status || row.plan_date !== parsed.plan_date)
      let saved: Row
      if (row) {
        Object.assign(row, parsed, { prior_status: prior, updated_at: stamp() })
        saved = row
      } else {
        saved = { id: args.p_id, household_id: householdId, ...parsed, prior_status: prior, updated_at: stamp() }
        tables.dinner_plan_entries.push(saved)
      }
      // 状態・日付が変わった枠を出所か台帳に持つ行を、同期を待たずに合わせる
      if (moved) {
        for (const grocery of mine("grocery_items")) {
          const sources = Array.isArray(grocery.sources) ? (grocery.sources as Row[]) : []
          if (sources.some((source) => source.entryId === args.p_id) || ledgerOf(grocery).some((record) => record.k === args.p_id)) {
            settle(grocery, null)
          }
        }
      }
      return ok({ status: "saved", entry: saved, revision: bump() })
    },

    delete_dinner_entry(args) {
      const st = state()
      const row = tables.dinner_plan_entries.find((candidate) => candidate.id === args.p_id)
      if (!row) return ok({ status: "replayed", id: args.p_id, revision: st.revision })
      if (row.household_id !== householdId) return fail("42501", "not allowed")
      if (row.updated_at !== args.p_version) return ok({ status: "conflict", entry: row, revision: st.revision })
      tables.dinner_plan_entries = tables.dinner_plan_entries.filter((candidate) => candidate !== row)
      return ok({ status: "saved", id: args.p_id, revision: bump() })
    },

    confirm_dinner_entries(args) {
      const st = state()
      const rows: Row[] = []
      for (const item of args.p_entries as Row[]) {
        const row = tables.dinner_plan_entries.find((candidate) => candidate.id === item.id)
        if (row && row.household_id !== householdId) return fail("42501", "not allowed")
        const conflict = (detail: string) => ok({ status: "conflict", revision: st.revision, detail })
        if (st.revision !== args.p_expected_revision) return conflict("stale_plan")
        if (!row) return conflict("gone")
        if (row.updated_at !== item.version || row.status !== "proposed") return conflict("row_changed")
        rows.push(row)
      }
      // 全件を確かめてから書く（1 つでも合わなければ何も書かない）。版は 1 回だけ進む
      for (const row of rows) Object.assign(row, { status: "confirmed", updated_at: stamp() })
      return ok({ status: "saved", revision: bump(), confirmed: rows.length })
    },

    sync_grocery_auto_items(args) {
      const st = state()
      const items = args.p_items as Row[]
      const hash = JSON.stringify({ r: args.p_plan_revision, items })
      if (st.grocery_operation_id === args.p_operation_id) {
        if (st.grocery_request_hash !== hash) return fail("23505", "operation id conflict")
        return ok({ status: "replayed", revision: st.revision })
      }
      if (st.revision !== args.p_plan_revision) return ok({ status: "conflict", revision: st.revision })
      const keys = items.map((item) => item.item_key)
      // 出所に載せられるのは確定の枠だけ。buy の合計は必要量を超えない（RPC と同じ 22023）
      for (const item of items) {
        const sources = (item.sources as Row[] | undefined) ?? []
        const buys = sources.reduce((sum, source) => (typeof source.buy === "number" ? round(sum + source.buy, 3) : sum), 0)
        if (buys > ((item.required_quantity as number | null) ?? 0)) return fail("22023", "sources buy more than the item needs")
        if (sources.some((source) => {
          const entry = typeof source.entryId === "string" ? entryOf(source.entryId) : undefined
          return entry !== undefined && entry.status !== "confirmed"
        })) {
          return fail("22023", "a source names an entry that is not confirmed")
        }
      }
      // 作った料理への充当（台帳）。購入の事実（purchased_quantity / purchased）には触れない
      for (const row of mine("grocery_items")) {
        const sources = Array.isArray(row.sources) ? (row.sources as Row[]) : []
        if (row.origin !== "auto" || (sources.length === 0 && ledgerOf(row).length === 0)) continue
        settle(row, (items.find((item) => item.item_key === row.item_key)?.sources as Row[] | undefined) ?? [])
      }
      for (const item of items) {
        const content = {
          ingredient_id: item.ingredient_id,
          name: item.name,
          required_quantity: item.required_quantity,
          unit: item.unit,
          required_note: item.required_note,
          needs_stock_check: item.needs_stock_check,
          sources: item.sources,
          still_needed: true,
        }
        const existing = mine("grocery_items").find((row) => row.item_key === item.item_key)
        if (existing) {
          const changed = !same(pick(existing, Object.keys(content)), content)
          const unitChanged = existing.unit !== content.unit
          Object.assign(existing, content, { plan_revision: args.p_plan_revision })
          if (changed) {
            const now = stamp()
            existing.updated_at = now
            // 単位が変われば購入量の意味が変わる（RPC と同じく、購入の事実を書いた時刻も進める）
            if (unitChanged) existing.purchase_updated_at = now
          }
        } else {
          tables.grocery_items.push({
            id: serverId(),
            household_id: householdId,
            origin: "auto",
            item_key: item.item_key,
            section: null,
            purchased_quantity: 0,
            purchased: false,
            purchased_at: null,
            restocked_quantity: 0,
            restock_ids: [],
            consumptions: [],
            consumed_quantity: 0,
            purchase_consumed: false,
            note: null,
            plan_revision: args.p_plan_revision,
            ...content,
            updated_at: stamp(),
          })
        }
      }
      let retained = 0
      let removed = 0
      tables.grocery_items = tables.grocery_items.filter((row) => {
        if (row.household_id !== householdId || row.origin !== "auto" || keys.includes(row.item_key)) return true
        if (hasRecord(row)) {
          if (row.still_needed === true) {
            row.still_needed = false
            row.sources = []
            row.updated_at = stamp()
            retained += 1
          }
          return true
        }
        removed += 1
        return false
      })
      st.grocery_operation_id = args.p_operation_id
      st.grocery_request_hash = hash
      st.grocery_revision = args.p_plan_revision
      return ok({ status: "saved", revision: st.revision, synced: keys.length, retained, removed })
    },

    set_grocery_purchase(args) {
      const row = tables.grocery_items.find((candidate) => candidate.id === args.p_id)
      if (!row) return ok({ status: "conflict", item: gone(args.p_id) })
      if (row.household_id !== householdId) return fail("42501", "not allowed")
      const quantity = round(args.p_purchased_quantity as number, 3)
      settle(row, null)
      // 同じ内容かは「量の事実」と「画面の印（使い終えた印は false）」で見る（使い終えた後の買い直しを吸わない）
      const shownChecked = row.purchased === true && row.purchase_consumed !== true
      if (row.purchased_quantity === quantity && shownChecked === args.p_purchased) return ok({ status: "replayed", item: row })
      // 版は「購入の事実を最後に書いた時刻以後・今の版以前」なら通す（必要量・充当・補充だけが変わった版の違いでは止めない）
      // 版の表記は時刻の順に並ぶ（`stamp()` の桁数は固定）
      const version = args.p_version as string | null
      const factsAt = (row.purchase_updated_at as string | null | undefined) ?? null
      if (version === null || version > (row.updated_at as string) || (factsAt !== null && version < factsAt)) {
        return ok({ status: "conflict", item: row })
      }
      const floor = round((row.restocked_quantity as number) + ((row.consumed_quantity as number | undefined) ?? 0), 3)
      if (quantity < (row.purchased_quantity as number) && quantity < floor) {
        return fail("22023", "purchase below restocked and used")
      }
      const any = quantity > 0 || args.p_purchased === true
      const now = stamp()
      Object.assign(row, {
        purchased_quantity: quantity,
        purchased: args.p_purchased,
        purchase_consumed: false,
        purchased_at: any ? now : null,
        purchase_updated_at: now,
        updated_at: now,
      })
      return ok({ status: "saved", item: row })
    },

    save_grocery_manual_item(args) {
      const content = {
        name: (args.p_name as string).trim(),
        required_quantity: args.p_quantity === null ? null : round(args.p_quantity as number, 3),
        unit: args.p_unit,
        section: args.p_section,
        note: args.p_note,
      }
      const row = tables.grocery_items.find((candidate) => candidate.id === args.p_id)
      if (row) {
        if (row.household_id !== householdId) return fail("42501", "not allowed")
        if (row.origin !== "manual") return fail("22023", "not a manual item")
        if (same(pick(row, Object.keys(content)), content)) return ok({ status: "replayed", item: row })
        if (args.p_version === null || row.updated_at !== args.p_version) return ok({ status: "conflict", item: row })
        // 品名・単位が変われば購入量の意味が変わる。購入の事実を書いた時刻も同じ時刻で進める（RPC と同じ）
        const now = stamp()
        const meaningChanged = row.name !== content.name || row.unit !== content.unit
        Object.assign(row, content, {
          updated_at: now,
          ...(meaningChanged ? { purchase_updated_at: now } : {}),
        })
        return ok({ status: "saved", item: row })
      }
      if (args.p_version !== null) return ok({ status: "conflict", item: gone(args.p_id) })
      const created = {
        id: args.p_id,
        household_id: householdId,
        origin: "manual",
        item_key: `manual|${String(args.p_id)}`,
        ingredient_id: null,
        required_note: null,
        needs_stock_check: false,
        sources: [],
        purchased_quantity: 0,
        purchased: false,
        purchased_at: null,
        restocked_quantity: 0,
        restock_ids: [],
        consumptions: [],
        consumed_quantity: 0,
        purchase_consumed: false,
        plan_revision: null,
        still_needed: true,
        ...content,
        updated_at: stamp(),
      }
      tables.grocery_items.push(created)
      return ok({ status: "saved", item: created })
    },

    update_grocery_item_meta(args) {
      const row = tables.grocery_items.find((candidate) => candidate.id === args.p_id)
      if (!row) return ok({ status: "conflict", item: gone(args.p_id) })
      if (row.household_id !== householdId) return fail("42501", "not allowed")
      if (row.note === args.p_note && row.section === args.p_section) return ok({ status: "replayed", item: row })
      if (row.updated_at !== args.p_version) return ok({ status: "conflict", item: row })
      Object.assign(row, { note: args.p_note, section: args.p_section, updated_at: stamp() })
      return ok({ status: "saved", item: row })
    },

    delete_grocery_item(args) {
      const row = tables.grocery_items.find((candidate) => candidate.id === args.p_id)
      if (!row) return ok({ status: "replayed", id: args.p_id })
      if (row.household_id !== householdId) return fail("42501", "not allowed")
      if (row.origin === "auto" && row.still_needed === true) return fail("23514", "needed auto item cannot be deleted")
      if (row.updated_at !== args.p_version) return ok({ status: "conflict", item: row })
      tables.grocery_items = tables.grocery_items.filter((candidate) => candidate !== row)
      return ok({ status: "saved", id: args.p_id })
    },

    restock_pantry_from_grocery(args) {
      const item = tables.grocery_items.find((candidate) => candidate.id === args.p_grocery_id)
      const pantry = tables.pantry_items.find((candidate) => candidate.id === args.p_pantry_item_id)
      if (item && item.household_id !== householdId) return fail("42501", "not allowed")
      if (!item) return ok({ status: "conflict", item: gone(args.p_grocery_id), pantry_item: pantry ?? null })
      // 上限の前に、充当の台帳を枠の今の状態へ合わせる（変われば、それを見ていない版は下で conflict）
      settle(item, null)
      if ((item.restock_ids as unknown[]).includes(args.p_pantry_item_id)) {
        return ok({ status: "replayed", item, pantry_item: pantry ?? null })
      }
      if (item.updated_at !== args.p_grocery_version) return ok({ status: "conflict", item, pantry_item: null })
      if (pantry) return fail("23505", "pantry id in use")
      const quantity = args.p_quantity === null ? null : round(args.p_quantity as number, 2)
      if (quantity !== null && item.unit === null) return fail("22023", "quantity needs a unit")
      // 補充の上限（RPC と同じ式）: 量で追う購入は 購入 − 補充済み − 作った料理への充当 まで
      const purchased = item.purchased_quantity as number
      if (purchased > 0) {
        const restocked = Math.min(purchased, item.restocked_quantity as number)
        const avail = Math.max(0, round(purchased - restocked - ((item.consumed_quantity as number | undefined) ?? 0), 3))
        if (avail <= 0) return fail("22023", "nothing to restock")
        if (quantity !== null && quantity > avail) return fail("22023", "restock exceeds purchase")
      } else if (!(item.purchased === true && item.purchase_consumed !== true)) {
        return fail("22023", "not purchased")
      }
      const created = {
        id: args.p_pantry_item_id,
        household_id: householdId,
        ingredient_id: item.ingredient_id,
        name: item.name,
        quantity,
        unit: quantity === null ? null : item.unit,
        status: "have",
        use_soon: false,
        storage: null,
        expires_on: null,
        confirmed_on: today,
        updated_at: stamp(),
      }
      tables.pantry_items.push(created)
      Object.assign(item, {
        restocked_quantity: round((item.restocked_quantity as number) + (quantity ?? 0), 3),
        restock_ids: [...(item.restock_ids as unknown[]), args.p_pantry_item_id],
        updated_at: stamp(),
      })
      return ok({ status: "saved", item, pantry_item: created })
    },

    save_pantry_item(args) {
      const content = pick(args.p_item as Row, PANTRY_CONTENT)
      const row = tables.pantry_items.find((candidate) => candidate.id === args.p_id)
      if (row) {
        if (row.household_id !== householdId) return fail("42501", "not allowed")
        if (same(pick(row, PANTRY_CONTENT), content)) return ok({ status: "replayed", item: row })
        if (args.p_version === null || row.updated_at !== args.p_version) return ok({ status: "conflict", item: row })
        Object.assign(row, content, { updated_at: stamp() })
        return ok({ status: "saved", item: row })
      }
      if (args.p_version !== null) return ok({ status: "conflict", item: gone(args.p_id) })
      const created = { id: args.p_id, household_id: householdId, ...content, updated_at: stamp() }
      tables.pantry_items.push(created)
      return ok({ status: "saved", item: created })
    },

    save_dish_feedback(args) {
      const content = {
        taste: args.p_taste,
        effort: args.p_effort,
        again: args.p_again,
        exclude_from_learning: args.p_exclude_from_learning,
      }
      const row = tables.dish_feedback.find((candidate) => candidate.id === args.p_id)
      if (row) {
        if (row.household_id !== householdId || row.profile_id !== userId) return fail("42501", "not allowed")
        if (same(pick(row, Object.keys(content)), content)) return ok({ status: "replayed", feedback: row })
        if (args.p_version === null || row.updated_at !== args.p_version) return ok({ status: "conflict", feedback: row })
        Object.assign(row, content, { updated_at: stamp() })
        return ok({ status: "saved", feedback: row })
      }
      if (args.p_version !== null) return ok({ status: "conflict", feedback: gone(args.p_id) })
      const twin = mine("dish_feedback").find(
        (candidate) =>
          candidate.profile_id === userId &&
          candidate.eaten_on === args.p_eaten_on &&
          candidate.recipe_id === args.p_recipe_id &&
          candidate.dish_title === args.p_dish_title,
      )
      if (twin) return ok({ status: "conflict", feedback: twin })
      const created = {
        id: args.p_id,
        household_id: householdId,
        profile_id: userId,
        recipe_id: args.p_recipe_id,
        dish_title: args.p_dish_title,
        eaten_on: args.p_eaten_on,
        ...content,
        updated_at: stamp(),
      }
      tables.dish_feedback.push(created)
      return ok({ status: "saved", feedback: created })
    },

    claim_dinner_ai_call(args) {
      return ok({ status: "ok", used: 1, limit: args.p_limit })
    },

    dinner_ai_status() {
      return ok({ used: 0, provider_exhausted: false, resets_at: null })
    },
  }

  const supabase = {
    from(table: string) {
      calls.from.push(table)
      const filters: ((row: Row) => boolean)[] = []
      let single = false
      const settle = (): Reply => {
        if (failing.has(table)) return fail("42501", "denied")
        const rows = (tables[table as Table] ?? []).filter((row) => filters.every((filter) => filter(row)))
        return ok(single ? (rows[0] ?? null) : rows.map((row) => ({ ...row })))
      }
      const builder = {
        select: () => builder,
        eq(column: string, value: unknown) {
          filters.push((row) => row[column] === value)
          return builder
        },
        neq(column: string, value: unknown) {
          filters.push((row) => row[column] !== value)
          return builder
        },
        gte(column: string, value: string) {
          filters.push((row) => (row[column] as string) >= value)
          return builder
        },
        lte(column: string, value: string) {
          filters.push((row) => (row[column] as string) <= value)
          return builder
        },
        order: () => builder,
        abortSignal: () => builder,
        maybeSingle() {
          single = true
          return builder
        },
        then(resolve: (value: Reply) => unknown, reject: (reason: unknown) => unknown) {
          return Promise.resolve()
            .then(settle)
            .then(resolve, reject)
        },
      }
      return builder
    },
    async rpc(name: string, args: Record<string, unknown> = {}): Promise<Reply> {
      calls.rpc.push([name, args])
      const intercepted = interceptors.get(name)?.(args)
      if (intercepted !== undefined) return intercepted
      const handler = handlers[name]
      if (!handler) return fail("42883", `unexpected rpc: ${name}`)
      // 送った値が JSON として往復できる形か（undefined・関数を紛れ込ませない）
      return handler(JSON.parse(JSON.stringify(args)) as Record<string, unknown>)
    },
  }

  return {
    supabase: supabase as unknown as MealSupabase,
    householdId,
    userId,
    tables,
    calls,
    intercept: (name, handler) => {
      interceptors.set(name, handler)
    },
    failTable: (table) => {
      failing.add(table)
    },
    setToday: (date) => {
      today = date
    },
    entries: () => mine("dinner_plan_entries"),
    grocery: () => mine("grocery_items"),
    revision: () => state().revision as number,
    rpcNames: () => calls.rpc.map(([name]) => name),
  }
}

let rowSerial = 0
const VERSION = "2026-11-10T00:00:00.123456+00:00"

function rowId(prefix: string): string {
  rowSerial += 1
  return `${prefix}-0000-4000-8000-${String(rowSerial).padStart(12, "0")}`
}

/** 献立の 1 枠の行（既定はカタログのレシピ・提案・自動）。 */
export function entryRow(householdId: string, overrides: Row & { plan_date: string }): Row {
  return {
    id: rowId("e0000000"),
    household_id: householdId,
    role: "main",
    position: 0,
    recipe_id: "nikujaga",
    recipe_version: 1,
    custom_title: null,
    custom_ingredients: null,
    servings: 2,
    pinned: false,
    status: "proposed",
    prior_status: null,
    origin: "auto",
    updated_at: VERSION,
    ...overrides,
  }
}

/** 在庫の 1 行（既定は「ある・今日確認・冷蔵」）。 */
export function pantryRow(householdId: string, overrides: Row & { ingredient_id: string | null; name: string }): Row {
  return {
    id: rowId("b0000000"),
    household_id: householdId,
    quantity: null,
    unit: null,
    status: "have",
    use_soon: false,
    storage: "fridge",
    expires_on: null,
    confirmed_on: "2026-11-11",
    updated_at: VERSION,
    created_at: VERSION,
    ...overrides,
  }
}

/** 必須除外の 1 行。 */
export function exclusionRow(householdId: string, overrides: Row = {}): Row {
  return {
    id: rowId("c0000000"),
    household_id: householdId,
    subject_kind: "household",
    subject_profile_id: null,
    subject_child_id: null,
    reason: "allergy",
    target_kind: "allergen",
    target_id: "egg",
    custom_label: null,
    updated_at: VERSION,
    created_at: VERSION,
    ...overrides,
  }
}

/** 買い物の自動項目の 1 行。 */
export function groceryRow(householdId: string, overrides: Row & { name: string }): Row {
  const id = rowId("d0000000")
  return {
    id,
    household_id: householdId,
    origin: "auto",
    item_key: "pork_komagire|mass",
    ingredient_id: "pork_komagire",
    section: null,
    required_quantity: null,
    unit: null,
    required_note: null,
    needs_stock_check: false,
    sources: [],
    purchased_quantity: 0,
    purchased: false,
    purchased_at: null,
    restocked_quantity: 0,
    restock_ids: [],
    consumptions: [],
    consumed_quantity: 0,
    purchase_consumed: false,
    note: null,
    plan_revision: 0,
    still_needed: true,
    updated_at: VERSION,
    created_at: VERSION,
    ...overrides,
  }
}
