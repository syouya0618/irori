import { beforeEach, expect, it, vi } from "vitest"
const { auth, redirect, client } = vi.hoisted(() => ({ auth: vi.fn(), redirect: vi.fn((path: string) => { throw new Error(`redirect:${path}`) }), client: vi.fn() }))
vi.mock("react", () => ({ cache: <T>(fn: T) => fn }))
vi.mock("next/navigation", () => ({ redirect }))
vi.mock("next/headers", () => ({ cookies: vi.fn() }))
vi.mock("../auth-context", () => ({ getAuthContext: auth }))
vi.mock("../server", () => ({ createClient: client }))
import { getChildContext } from "../child-context"
beforeEach(() => vi.clearAllMocks())
it.each([
 ["no-household", "/setup"], ["unauthenticated", "/login"], ["not-approved", "/pending-approval"], ["shared-only", "/shared"],
])("routes %s consistently with the layout before querying children", async (reason, path) => {
 auth.mockResolvedValue({ error: "synthetic expected denial", reason, context: null })
 await expect(getChildContext()).rejects.toThrow(`redirect:${path}`)
 expect(client).not.toHaveBeenCalled()
})
it("keeps an unknown profile lookup failure closed instead of treating it as a missing household", async () => {
 auth.mockResolvedValue({ error: "synthetic lookup failed", reason: "lookup-failed", context: null })
 await expect(getChildContext()).rejects.toThrow("synthetic lookup failed")
 expect(redirect).not.toHaveBeenCalled()
 expect(client).not.toHaveBeenCalled()
})
