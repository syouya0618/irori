import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { cleanup, renderHook, waitFor } from "@testing-library/react"
import { useFeedingAmounts } from "../use-feeding-amounts"

const db = vi.hoisted(() => ({ read: vi.fn(), claims: vi.fn(), filters: [] as unknown[][] }))
vi.mock("@/lib/supabase/client", () => ({ createClient: () => {
  const chain = {
    select: () => chain,
    eq: (...args: unknown[]) => { db.filters.push(args); return chain },
    order: () => chain, limit: () => chain, abortSignal: (signal: AbortSignal) => db.read(signal),
  }
  return { auth: { getClaims: db.claims }, from: () => chain }
} }))
beforeEach(() => {
  db.filters = []
  db.claims.mockResolvedValue({ data: { claims: { sub: "user-a" } }, error: null })
  db.read.mockResolvedValue({ data: [{ amount_ml: 120 }, { amount_ml: 60 }], error: null })
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

it("reads only the verified person's household and feeding kind with cancellation", async () => {
  const { result, unmount } = renderHook(() => useFeedingAmounts(true, "user-a", "household-a", "bottle"))
  await waitFor(() => expect(result.current.values).toEqual([120, 60]))
  expect(db.filters).toEqual([["user_id", "user-a"], ["household_id", "household-a"], ["feeding_type", "bottle"]])
  const signal = db.read.mock.calls[0][0]
  unmount()
  expect(signal.aborted).toBe(true)
})
it("does not read when closed and does not interpret an expired session as empty history", async () => {
  const { rerender, result } = renderHook(({ open }) => useFeedingAmounts(open, "user-a", "household-a", "bottle"), { initialProps: { open: false } })
  expect(db.read).not.toHaveBeenCalled()
  db.claims.mockResolvedValue({ data: null, error: new Error("expired") })
  rerender({ open: true })
  await waitFor(() => expect(result.current.status).toBe("error"))
  expect(db.read).not.toHaveBeenCalled()
})
it("discards a late result when the household or record kind changes", async () => {
  let finish!: (value: unknown) => void
  db.read.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
  const { rerender, result } = renderHook(({ kind }) => useFeedingAmounts(true, "user-a", "household-a", kind), { initialProps: { kind: "bottle" } })
  await waitFor(() => expect(db.read).toHaveBeenCalledOnce())
  rerender({ kind: "pumped" })
  await waitFor(() => expect(result.current.status).toBe("ready"))
  finish({ data: [{ amount_ml: 999 }], error: null })
  await waitFor(() => expect(result.current.values).toEqual([120, 60]))
})
