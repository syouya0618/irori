/**
 * `createAdminClient()` の fail-closed 契約。
 *
 * `SUPABASE_SERVICE_ROLE_KEY` を `src/` から使うのはこれが初めてゆえ、
 * **RLS バイパス経路が「黙って anon へ落ちる」ことが無い**ことを機械で固定する。
 * 落ちれば同期は 0 行になり、「同期したのに何も入らぬ」が無音で起きる。
 *
 * `@supabase/supabase-js` の `createClient` は差し替えて引数だけを検査する
 * （実 Supabase へは接続せぬ）。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

const createClientMock = vi.fn(() => ({ __client: true }))
vi.mock("@supabase/supabase-js", () => ({
  createClient: (...args: unknown[]) => createClientMock(...(args as [])),
}))

import { createAdminClient } from "../admin"

let originalUrl: string | undefined
let originalKey: string | undefined

beforeEach(() => {
  vi.clearAllMocks()
  originalUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  originalKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  // 末尾改行を混ぜる（`?.trim()` 防御が効いていることを同時に見る）。
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co\n"
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key\n"
})

afterEach(() => {
  if (originalUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL
  else process.env.NEXT_PUBLIC_SUPABASE_URL = originalUrl
  if (originalKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY
  else process.env.SUPABASE_SERVICE_ROLE_KEY = originalKey
})

describe("createAdminClient", () => {
  it("env を trim して service role キーで生成する", () => {
    createAdminClient()

    expect(createClientMock).toHaveBeenCalledTimes(1)
    const [url, key, options] = createClientMock.mock.calls[0] as unknown as [
      string,
      string,
      { auth: Record<string, unknown> },
    ]
    expect(url).toBe("https://example.supabase.co")
    expect(key).toBe("service-role-key")
    // サーバでは cookie セッションを持たぬ。
    expect(options.auth).toMatchObject({
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    })
  })

  it("SUPABASE_SERVICE_ROLE_KEY 未設定なら throw する（anon へ落とさぬ）", () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY

    expect(() => createAdminClient()).toThrow(/SUPABASE_SERVICE_ROLE_KEY/)
    // anon キーで代替生成していないこと。
    expect(createClientMock).not.toHaveBeenCalled()
  })

  it("空白のみの SUPABASE_SERVICE_ROLE_KEY も未設定とみなす", () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = "  \n"

    expect(() => createAdminClient()).toThrow(/SUPABASE_SERVICE_ROLE_KEY/)
    expect(createClientMock).not.toHaveBeenCalled()
  })

  it("NEXT_PUBLIC_SUPABASE_URL 未設定なら throw する", () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL

    expect(() => createAdminClient()).toThrow(/NEXT_PUBLIC_SUPABASE_URL/)
    expect(createClientMock).not.toHaveBeenCalled()
  })

  it("ブラウザ環境では理由を名指しして throw する", () => {
    vi.stubGlobal("window", {})
    try {
      expect(() => createAdminClient()).toThrow(/サーバでのみ/)
      expect(createClientMock).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
