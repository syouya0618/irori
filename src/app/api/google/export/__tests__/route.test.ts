import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  auth: vi.fn(), admin: vi.fn(), manage: vi.fn(), status: vi.fn(),
  from: vi.fn(), eq: vi.fn(), select: vi.fn(), remove: vi.fn(), one: vi.fn(), rpc: vi.fn(),
}))
vi.mock("@/lib/supabase/auth-context", () => ({ getAuthContext: mocks.auth }))
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mocks.admin }))
vi.mock("@/lib/google/export-sync", () => ({ manageGoogleExport: mocks.manage, getGoogleExportStatus: mocks.status }))
import { GET, POST, DELETE } from "../route"

const id = "123e4567-e89b-42d3-a456-426614174000"
const owner = { connectionId: id, userId: "user", householdId: "house" }
const admin = { service: true }
const url = "https://irori.example/api/google/export"
function req(method: string, data: object, site = "same-origin") {
  return new Request(url, { method, body: JSON.stringify(data), headers: { "content-type": "application/json", "sec-fetch-site": site } })
}
beforeEach(() => {
  vi.resetAllMocks()
  const query = { eq: mocks.eq, select: mocks.select, delete: mocks.remove, maybeSingle: mocks.one }
  mocks.from.mockReturnValue(query)
  mocks.eq.mockReturnValue(query)
  mocks.select.mockReturnValue(query)
  mocks.remove.mockReturnValue(query)
  mocks.one.mockResolvedValue({ data: { id }, error: null })
  mocks.rpc.mockResolvedValue({ data: true, error: null })
  mocks.auth.mockResolvedValue({ error: null, context: { supabase: { from: mocks.from, rpc: mocks.rpc }, userId: owner.userId, householdId: owner.householdId } })
  mocks.admin.mockReturnValue(admin)
  mocks.manage.mockResolvedValue({ enabled: true, permission: true })
  mocks.status.mockResolvedValue({ enabled: false, permission: true })
})

describe("app-owned calendar sharing API", () => {
  it("blocks all sharing operations before the DB contract exists", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "PGRST202" } })
    for (const response of [
      await GET(new Request(url + "?connectionId=" + id)),
      await POST(req("POST", { connectionId: id, action: "enable" })),
      await DELETE(req("DELETE", { connectionId: id })),
    ]) {
      expect(response.status).toBe(503)
      expect(await response.json()).toMatchObject({ code: "sharing_not_ready" })
    }
    expect(mocks.from).not.toHaveBeenCalled()
    expect(mocks.admin).not.toHaveBeenCalled()
    expect(mocks.remove).not.toHaveBeenCalled()
  })

  it("reads the owner's connection without allowing a browser-supplied household", async () => {
    const res = await GET(new Request(url + "?connectionId=" + id + "&householdId=other"))
    expect(res.status).toBe(200)
    expect(mocks.eq.mock.calls).toEqual([["id", id], ["user_id", "user"], ["household_id", "house"]])
    expect(mocks.status).toHaveBeenCalledWith(admin, owner)
    expect(res.headers.get("cache-control")).toBe("private, no-store")
  })
  it.each(["enable", "sync", "stop"])("dispatches only the authorized owner's %s", async action => {
    expect((await POST(req("POST", { connectionId: id, action, householdId: "other" }))).status).toBe(200)
    expect(mocks.manage).toHaveBeenCalledWith(admin, owner, action)
  })
  it("does not create a service-role client for another member's connection", async () => {
    mocks.one.mockResolvedValue({ data: null, error: null })
    expect((await POST(req("POST", { connectionId: id, action: "enable" }))).status).toBe(404)
    expect(mocks.admin).not.toHaveBeenCalled()
    expect(mocks.manage).not.toHaveBeenCalled()
  })
  it("rejects unauthenticated requests before DB or service role access", async () => {
    mocks.auth.mockResolvedValue({ error: "login", reason: "unauthenticated", context: null })
    expect((await POST(req("POST", { connectionId: id, action: "enable" }))).status).toBe(401)
    expect(mocks.from).not.toHaveBeenCalled()
    expect(mocks.admin).not.toHaveBeenCalled()
  })
  it("rejects unsupported operations and cross-site mutations", async () => {
    expect((await POST(req("POST", { connectionId: id, action: "delete-all" }))).status).toBe(400)
    expect((await POST(req("POST", { connectionId: id, action: "enable" }, "cross-site"))).status).toBe(403)
    expect((await DELETE(req("DELETE", { connectionId: id }, "cross-site"))).status).toBe(403)
    expect(mocks.admin).not.toHaveBeenCalled()
    expect(mocks.remove).not.toHaveBeenCalled()
  })
  it("disconnects only the authenticated owner and never calls Google", async () => {
    const res = await DELETE(req("DELETE", { connectionId: id, householdId: "other" }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(mocks.remove).toHaveBeenCalledTimes(1)
    expect(mocks.eq.mock.calls).toEqual([["id", id], ["user_id", "user"], ["household_id", "house"]])
    expect(mocks.admin).not.toHaveBeenCalled()
  })
  it("reports a locked or missing connection without claiming disconnection", async () => {
    mocks.one.mockResolvedValueOnce({ data: null, error: { code: "55P03" } })
    expect((await DELETE(req("DELETE", { connectionId: id }))).status).toBe(409)
    mocks.one.mockResolvedValueOnce({ data: null, error: null })
    expect((await DELETE(req("DELETE", { connectionId: id }))).status).toBe(404)
  })
})
