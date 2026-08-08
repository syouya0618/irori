import { describe, expect, it } from "vitest"
import {
  ALLOWED_PUSH_HOSTS,
  isAllowedPushEndpoint,
  summarizeUserAgent,
} from "../push-endpoint"

describe("isAllowedPushEndpoint", () => {
  // ⚠️ この関数は **SSRF と open relay に対する唯一の防御**じゃ。
  // 通す側だけ書くと「何でも通る実装」でも緑になるため、必ず対で置く。

  it("実在する 3 つの push サービスを通す（対照）", () => {
    expect(
      isAllowedPushEndpoint("https://web.push.apple.com/QABC123"),
    ).toBe(true)
    expect(
      isAllowedPushEndpoint("https://fcm.googleapis.com/fcm/send/abc123"),
    ).toBe(true)
    expect(
      isAllowedPushEndpoint(
        "https://updates.push.services.mozilla.com/wpush/v2/abc",
      ),
    ).toBe(true)
  })

  it("内部アドレスを弾く（SSRF の本体）", () => {
    // クラウドのメタデータ・localhost・プライベート帯
    for (const url of [
      "https://169.254.169.254/latest/meta-data/",
      "https://127.0.0.1/admin",
      "https://localhost:54321/rest/v1/profiles",
      "https://10.0.0.1/",
      "https://192.168.1.1/",
      "https://metadata.google.internal/computeMetadata/v1/",
    ]) {
      expect(isAllowedPushEndpoint(url), url).toBe(false)
    }
  })

  it("http:// は許可ホストでも弾く（平文で内部を叩かせぬ）", () => {
    expect(isAllowedPushEndpoint("http://fcm.googleapis.com/fcm/send/x")).toBe(
      false,
    )
  })

  it("許可ホストを名乗るだけの別ドメインを弾く", () => {
    // サフィックス一致の実装が甘いと通ってしまう典型
    for (const url of [
      "https://fcm.googleapis.com.evil.example/x",
      "https://evil-fcm.googleapis.com.attacker.test/x",
      "https://notpush.apple.com.evil.test/x",
      "https://push.apple.com.evil.test/x",
    ]) {
      expect(isAllowedPushEndpoint(url), url).toBe(false)
    }
  })

  it("URL として解釈できない文字列を弾く（throw もしない）", () => {
    for (const bad of ["", "not a url", "javascript:alert(1)", "//evil.test/x"]) {
      expect(isAllowedPushEndpoint(bad), bad).toBe(false)
    }
  })

  it("Apple はサブドメイン一致・他は完全一致", () => {
    // Apple は地域ごとにサブドメインが変わる（web.push.apple.com 等）
    expect(isAllowedPushEndpoint("https://api.push.apple.com/x")).toBe(true)
    // 完全一致の側にサブドメインを足すと通らぬ
    expect(isAllowedPushEndpoint("https://a.fcm.googleapis.com/x")).toBe(false)
  })

  it("allowlist は 3 件（増減がそのまま差分に出る）", () => {
    expect([...ALLOWED_PUSH_HOSTS]).toEqual([
      ".push.apple.com",
      "fcm.googleapis.com",
      "updates.push.services.mozilla.com",
    ])
  })
})

describe("summarizeUserAgent", () => {
  it("iPhone の Safari を判別する", () => {
    expect(
      summarizeUserAgent(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1",
      ),
    ).toBe("iPhone/iPad の Safari")
  })

  it("Android の Chrome を判別する", () => {
    expect(
      summarizeUserAgent(
        "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36",
      ),
    ).toBe("Android の Chrome")
  })

  it("Edge を Chrome と誤らぬ（判定順が load-bearing）", () => {
    // Edge の UA は Chrome/ も Safari/ も含む。広い方から見ると化ける。
    expect(
      summarizeUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0",
      ),
    ).toBe("Windows の Edge")
  })

  it("Chrome を Safari と誤らぬ", () => {
    expect(
      summarizeUserAgent(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
      ),
    ).toBe("Mac の Chrome")
  })

  it("未知・空は null へ退化する（落とさぬ）", () => {
    expect(summarizeUserAgent(null)).toBeNull()
    expect(summarizeUserAgent(undefined)).toBeNull()
    expect(summarizeUserAgent("")).toBeNull()
    expect(summarizeUserAgent("curl/8.0")).toBeNull()
  })

  it("片方しか判らねば判った方を返す", () => {
    expect(summarizeUserAgent("Mozilla/5.0 (Linux; Android 15)")).toBe("Android")
  })
})
