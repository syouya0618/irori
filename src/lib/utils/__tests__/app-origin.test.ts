import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { getAppOrigin } from "../app-origin"

// Request は Node 組込み (undici) を使用。host ヘッダが construction で
// 落ちる環境差異が出た場合、このテスト自体が検知する。
function makeRequest(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, { headers })
}

beforeEach(() => {
  // 第2引数に undefined を渡しても JS の default parameter は発動し
  // process.env.NEXT_PUBLIC_APP_URL (app-origin.ts:17) が評価されるため、
  // 実環境の env からテストを密閉する。vitest 4 の stubEnv(name, undefined)
  // は env 変数を削除する (vi.stubEnv 実装が value === undefined で
  // delete を行い、metaEnv Proxy 経由で process.env 本体に透過する) ので、
  // 「env 未設定」テストは default 引数経由でも真の undefined を受け取る。
  vi.stubEnv("NEXT_PUBLIC_APP_URL", undefined)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe("getAppOrigin", () => {
  it("env (NEXT_PUBLIC_APP_URL) があればその origin を最優先で返す", () => {
    expect(getAppOrigin(undefined, "http://127.0.0.1:3000")).toBe(
      "http://127.0.0.1:3000"
    )
  })

  it("env に path・末尾スラッシュが付いていても origin のみを返す", () => {
    expect(getAppOrigin(undefined, "https://irori.example.com/app/")).toBe(
      "https://irori.example.com"
    )
  })

  it("env の末尾改行・空白は trim して有効値として扱う（ペースト事故防御）", () => {
    expect(getAppOrigin(undefined, "http://127.0.0.1:3000\n")).toBe(
      "http://127.0.0.1:3000"
    )
  })

  it("env が不正な URL なら console.error して request 系フォールバックに落ちる", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const request = makeRequest("http://localhost:3000/auth/callback", {
      host: "127.0.0.1:3000",
    })
    expect(getAppOrigin(request, "not-a-url")).toBe("http://127.0.0.1:3000")
    expect(errorSpy).toHaveBeenCalledOnce()
  })

  it("env がスキーム無し値 (localhost:3000) でも console.error してフォールバックする", () => {
    // WHATWG URL は "localhost:3000" を scheme="localhost:" として解釈し、
    // origin が文字列 "null" になる（throw しない）ため、catch では拾えない。
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const request = makeRequest("http://localhost:3000/auth/callback", {
      host: "127.0.0.1:3000",
    })
    expect(getAppOrigin(request, "localhost:3000")).toBe("http://127.0.0.1:3000")
    expect(errorSpy).toHaveBeenCalledOnce()
  })

  it("env が無ければ x-forwarded-host / x-forwarded-proto を優先する", () => {
    const request = makeRequest("http://localhost:3000/meals", {
      host: "127.0.0.1:3000",
      "x-forwarded-host": "fwd.example.com",
      "x-forwarded-proto": "https",
    })
    expect(getAppOrigin(request, undefined)).toBe("https://fwd.example.com")
  })

  it("x-forwarded-host / x-forwarded-proto がカンマ列挙なら先頭を採用する", () => {
    const request = makeRequest("http://localhost:3000/meals", {
      "x-forwarded-host": "a.example, b.example",
      "x-forwarded-proto": "https, http",
    })
    expect(getAppOrigin(request, undefined)).toBe("https://a.example")
  })

  it("request.url が localhost に正規化されていても host ヘッダの 127.0.0.1 を返す（issue #16 核心回帰）", () => {
    // NextRequest は loopback host を一律 'localhost' に書き換える
    // (next/dist/server/web/next-url.js の REGEX_LOCALHOST_HOSTNAME) ため、
    // request.url の origin は信用できない。host ヘッダは正規化を受けず
    // 実アクセス値を保持する。
    const request = makeRequest("http://localhost:3000/auth/callback?code=x", {
      host: "127.0.0.1:3000",
    })
    expect(getAppOrigin(request, undefined)).toBe("http://127.0.0.1:3000")
  })

  it("env もヘッダも無ければ request.url の origin にフォールバックする（現状互換）", () => {
    const request = makeRequest("http://example.com:8080/auth/callback")
    expect(getAppOrigin(request, undefined)).toBe("http://example.com:8080")
  })

  it("request も env も無ければ http://localhost:3000 を返す（generateInvite 現行挙動の温存）", () => {
    expect(getAppOrigin(undefined, undefined)).toBe("http://localhost:3000")
  })

  it("空文字・空白のみの env はログ無しでフォールバックする", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    expect(getAppOrigin(undefined, "")).toBe("http://localhost:3000")
    expect(getAppOrigin(undefined, "   ")).toBe("http://localhost:3000")
    expect(errorSpy).not.toHaveBeenCalled()
  })
})
