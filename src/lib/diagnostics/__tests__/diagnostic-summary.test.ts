/**
 * 診断要約の非機密性（E4・AC27 の log-review 層を unit で）。
 *
 * 端末の保存領域に日記本文・子の名前・メール・授乳の量・token・URL を置いた状態で組み、
 * 出来上がった文面にそれらが一つも載らぬことを確かめる。UA の版番号も載せぬ。
 */
import { describe, it, expect, beforeEach } from "vitest"
import {
  appendDiagnostic,
  buildDiagnosticSummary,
  coarseDeviceKind,
  newTraceId,
  readRecentFailures,
  recordClientFailure,
  RECENT_FAILURES_KEY,
  DIAGNOSTIC_HEADER,
} from "../diagnostic-summary"

const SECRETS = [
  "hana@example.test",
  "みかんちゃん",
  "今日は夜泣きがひどかった日記本文",
  "ミルク 160ml",
  "eyJhbGciOiJIUzI1NiJ9.secret-token",
  "https://irori.example/baby?date=2026-10-27&token=abc",
  "11111111-1111-4111-8111-111111111111",
]

const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.7 Mobile/15E148 Safari/604.1"

class MemoryStorage {
  private map = new Map<string, string>()
  getItem(k: string) {
    return this.map.has(k) ? this.map.get(k)! : null
  }
  setItem(k: string, v: string) {
    this.map.set(k, String(v))
  }
  removeItem(k: string) {
    this.map.delete(k)
  }
  clear() {
    this.map.clear()
  }
}

beforeEach(() => {
  ;(globalThis as { sessionStorage?: unknown }).sessionStorage = new MemoryStorage()
})

describe("recordClientFailure / readRecentFailures", () => {
  it("列挙した値だけを記録し、時刻は分で切る・経過は秒の整数", () => {
    recordClientFailure({ op: "export", kind: "timeout", elapsedMs: 45_321, nowMs: Date.parse("2026-10-27T14:40:59.999Z") })
    expect(readRecentFailures()).toEqual([
      { op: "export", kind: "timeout", elapsedSec: 45, at: "2026-10-27T14:40Z" },
    ])
  })

  it("⭐ 保存領域に自由文・メール・URL を混ぜ込んでも、読み出しで落とす", () => {
    sessionStorage.setItem(
      RECENT_FAILURES_KEY,
      JSON.stringify([
        { op: "export", kind: "network", elapsedSec: 3, at: "2026-10-27T14:40Z", message: SECRETS[0] },
        { op: SECRETS[2], kind: "network", elapsedSec: 3, at: "2026-10-27T14:40Z" },
        { op: "save", kind: SECRETS[3], elapsedSec: 3, at: "2026-10-27T14:40Z" },
        { op: "save", kind: "network", elapsedSec: 3, at: SECRETS[5] },
      ]),
    )
    const failures = readRecentFailures()
    expect(failures).toEqual([{ op: "export", kind: "network", elapsedSec: 3, at: "2026-10-27T14:40Z" }])
    expect(JSON.stringify(failures)).not.toContain("example.test")
  })

  it("未知の値は記録せぬ（呼び出しの誤りで本文が入らぬ）", () => {
    recordClientFailure({ op: SECRETS[2] as never, kind: "network" })
    recordClientFailure({ op: "save", kind: SECRETS[1] as never })
    expect(readRecentFailures()).toEqual([])
  })

  it("直近 5 件だけ残す", () => {
    for (let i = 0; i < 8; i++) recordClientFailure({ op: "save", kind: "network", elapsedMs: i * 1000 })
    const failures = readRecentFailures()
    expect(failures).toHaveLength(5)
    expect(failures.at(-1)?.elapsedSec).toBe(7)
  })

  it("壊れた JSON は空として扱う", () => {
    sessionStorage.setItem(RECENT_FAILURES_KEY, "{broken")
    expect(readRecentFailures()).toEqual([])
  })
})

describe("coarseDeviceKind", () => {
  it.each([
    [IPHONE_UA, 0, { os: "iPhone", browser: "Safari" }],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0 Mobile/15E148 Safari/604.1", 0, { os: "iPhone", browser: "Chrome" }],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15", 5, { os: "iPad", browser: "Safari" }],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15", 0, { os: "Mac", browser: "Safari" }],
    ["Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36", 5, { os: "Android", browser: "Chrome" }],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Edg/130.0", 0, { os: "Windows", browser: "Edge" }],
    ["curl/8.0", 0, { os: "不明", browser: "不明" }],
  ])("%s → 名前だけ", (ua, touch, expected) => {
    expect(coarseDeviceKind(ua, touch)).toEqual(expected)
  })
})

describe("buildDiagnosticSummary（AC27: 本文・名前・token を載せぬ）", () => {
  it("⭐ 版・端末の種類・起動方法・失敗の分類・追跡 id だけを出し、機密の値も UA の版番号も出さぬ", () => {
    // 端末に機密が散らばっておる状態を作る（下書き・計測・失敗の記録の自由文）
    sessionStorage.setItem("irori:feedback-draft:v1:u1", JSON.stringify({ title: SECRETS[2], body: SECRETS[0] }))
    sessionStorage.setItem(
      RECENT_FAILURES_KEY,
      JSON.stringify([{ op: "export", kind: "timeout", elapsedSec: 45, at: "2026-10-27T14:40Z", detail: SECRETS[5] }]),
    )
    const text = buildDiagnosticSummary({
      releaseName: "2026年10月の更新",
      buildId: "abc1234",
      device: coarseDeviceKind(IPHONE_UA),
      standalone: true,
      failures: readRecentFailures(),
      traceId: newTraceId(),
    })
    expect(text.split("\n")[0]).toBe(DIAGNOSTIC_HEADER)
    expect(text).toContain("版: 2026年10月の更新 / abc1234")
    expect(text).toContain("端末: iPhone・Safari（ホーム画面から起動）")
    expect(text).toContain("- 書き出し・時間切れ・45秒（10/27 23:40）")
    expect(text).toMatch(/追跡ID: [0-9a-f]{12}$/)
    for (const secret of SECRETS) expect(text).not.toContain(secret)
    // UA の版番号・機種の細目を載せぬ
    for (const fragment of ["18_7_1", "18.7", "15E148", "604.1", "AppleWebKit", "Mozilla"]) {
      expect(text).not.toContain(fragment)
    }
    // URL を載せぬ
    expect(text).not.toMatch(/https?:\/\//)
  })

  it("失敗が無い時は「なし」と、記録の範囲（このタブ）を添える", () => {
    const text = buildDiagnosticSummary({
      releaseName: "r",
      buildId: "dev",
      device: { os: "Mac", browser: "Safari" },
      standalone: null,
      failures: [],
      traceId: "000000000000",
    })
    expect(text).toContain("直近の失敗: なし（この画面を開いているタブで記録されたもの）")
    expect(text).toContain("起動方法は不明")
  })

  it("追跡 id はその場で作る乱数（毎回違う）", () => {
    const ids = new Set(Array.from({ length: 20 }, () => newTraceId()))
    expect(ids.size).toBe(20)
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{12}$/)
  })
})

describe("appendDiagnostic", () => {
  it("本文の後に空行 1 つで付ける。添えぬ時は本文のまま", () => {
    expect(appendDiagnostic("本文", "診断")).toBe("本文\n\n診断")
    expect(appendDiagnostic("", "診断")).toBe("診断")
    expect(appendDiagnostic("本文", null)).toBe("本文")
  })
})
