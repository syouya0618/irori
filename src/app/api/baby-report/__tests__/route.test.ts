/**
 * baby-report route の**診断可能性**の検証（I-15b）。
 *
 * この route は「小児科の受診当日に PDF が出せずに詰む」導線じゃ。従前は失敗が
 * 二重に握り潰されていた:
 *   1. DB エラーを `logSupabaseError` を通さず 500 に潰していた
 *      → Supabase の error は class Error 非継承の plain object ゆえ、
 *        ログに残さねば真因は**永久に**分からない
 *   2. `.limit(5000)` に達しても無音で切り詰めていた
 *      → 「出せた PDF が実は全件ではない」は受診の判断材料そのものを歪める
 *
 * ここで固定するのは「壊れたときに気づけるか / 原因に辿り着けるか」であり、
 * PDF の中身の正しさ（集計）は baby-log-aggregation の担当じゃ。
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

const getAuthContext = vi.fn()
const logSupabaseError = vi.fn()
const generateBabyReport = vi.fn()

vi.mock("@/lib/supabase/auth-context", () => ({
  getAuthContext: () => getAuthContext(),
}))
vi.mock("@/lib/supabase/log-error", () => ({
  logSupabaseError: (...args: unknown[]) => logSupabaseError(...args),
}))
vi.mock("@/lib/pdf/baby-report", () => ({
  generateBabyReport: (input: unknown) => generateBabyReport(input),
}))

import { GET, maxDuration } from "../route"
import { todayJstString } from "@/lib/utils/date-jst"

/**
 * 種データの日付は**今日（JST）**に置く。
 *
 * ⚠️ かつてここは `2026-08-01` を直書きしておった。route は period から
 * `shiftYmd(today, -7)` 等の**移動窓**を作って絞るため、実時刻が種から 7 日以上
 * 離れた日に**種が窓の外へ落ち、集計が 0 になって落ちる時限爆弾**じゃった
 * （2026-08-09 に実際に爆ぜ、main が赤くなった）。
 *
 * これらのテストの関心事は「取得上限で切り詰めること」であって日付ではない。
 * ゆえに窓の内側に必ず入る値を使い、期限切れを構造的に無くす。
 */
const TODAY_JST = todayJstString()

type Row = Record<string, unknown>

/**
 * households / baby_logs の 2 系統を返す最小 Supabase モック。
 * 実装のチェーン（select→eq→gte→lt→order→limit）をそのまま辿れる形にする。
 */
function makeSupabase(opts: {
  household?: { data: Row | null; error: unknown }
  logs?: { data: Row[] | null; error: unknown }
  onLimit?: (n: number) => void
}) {
  const householdResult = opts.household ?? {
    data: { baby_name: "みかん", baby_birth_date: "2026-01-01" },
    error: null,
  }
  const logsResult = opts.logs ?? { data: [], error: null }

  return {
    from(table: string) {
      if (table === "households") {
        return {
          select: () => ({
            eq: () => ({ single: async () => householdResult }),
          }),
        }
      }
      return {
        select: () => ({
          eq: () => ({
            gte: () => ({
              lt: () => ({
                order: () => ({
                  limit: async (n: number) => {
                    opts.onLimit?.(n)
                    return logsResult
                  },
                }),
              }),
            }),
          }),
        }),
      }
    },
  }
}

function req(period = "1week") {
  return new Request(`https://example.test/api/baby-report?period=${period}`)
}

beforeEach(() => {
  getAuthContext.mockReset()
  logSupabaseError.mockReset()
  generateBabyReport.mockReset()
  generateBabyReport.mockResolvedValue(Buffer.from("%PDF-1.4 fake"))
})

/** 認証済み・世帯ありの文脈を返す */
function authOk(supabase: unknown) {
  getAuthContext.mockResolvedValue({
    error: null,
    reason: null,
    context: { supabase, userId: "user-1", householdId: "house-1" },
  })
}

describe("baby-report: 失敗時に真因がログへ残る（握り潰さない）", () => {
  it("households の取得失敗を logSupabaseError で構造化ログに残してから 500", async () => {
    const supabase = makeSupabase({
      household: {
        data: null,
        error: { message: "connection reset", code: "08006" },
      },
    })
    authOk(supabase)

    const res = await GET(req())

    expect(res.status).toBe(500)
    expect(logSupabaseError).toHaveBeenCalledWith(
      "baby-report",
      "household lookup failed",
      expect.objectContaining({ message: "connection reset" }),
      expect.objectContaining({ householdId: "house-1", period: "1week" }),
    )
  })

  it("baby_logs の取得失敗も同様に残す（期間も文脈に含める）", async () => {
    const supabase = makeSupabase({
      logs: { data: null, error: { message: "statement timeout", code: "57014" } },
    })
    authOk(supabase)

    const res = await GET(req("3months"))

    expect(res.status).toBe(500)
    expect(logSupabaseError).toHaveBeenCalledWith(
      "baby-report",
      "baby_logs lookup failed",
      expect.objectContaining({ message: "statement timeout" }),
      expect.objectContaining({ householdId: "house-1", period: "3months" }),
    )
  })

  it("正常時は logSupabaseError を呼ばない（ログを異常だけに保つ）", async () => {
    authOk(makeSupabase({}))
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(logSupabaseError).not.toHaveBeenCalled()
  })
})

describe("baby-report: 取得上限の fail-loud", () => {
  /** limit は「上限 + 1」で要求される。ちょうど上限件数との弁別に必要じゃ。 */
  it("上限より 1 件多く要求する（ちょうど 5000 件を偽陽性にしないため）", async () => {
    const onLimit = vi.fn()
    authOk(makeSupabase({ onLimit }))
    await GET(req())
    expect(onLimit).toHaveBeenCalledWith(5001)
  })

  it("上限を超えたら header・PDF・サーバログの三重で「全件ではない」と分かる", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    // 上限 +1 件返る = 切り詰められた
    const rows = Array.from({ length: 5001 }, () => ({
      log_type: "feeding",
      logged_at: `${TODAY_JST}T00:00:00+09:00`,
    }))
    authOk(makeSupabase({ logs: { data: rows, error: null } }))

    const res = await GET(req())

    expect(res.status).toBe(200)
    // 1. レスポンスヘッダ
    expect(res.headers.get("X-Report-Truncated")).toBe("1")
    // 2. PDF 本体（印刷しても残る）
    expect(generateBabyReport).toHaveBeenCalledWith(
      expect.objectContaining({ truncated: true }),
    )
    // 3. サーバログ
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("取得上限"),
      expect.objectContaining({ limit: 5000, householdId: "house-1" }),
    )

    error.mockRestore()
  })

  it("ちょうど上限件数は切り詰めではない（偽陽性を出さない）", async () => {
    const rows = Array.from({ length: 5000 }, () => ({
      log_type: "feeding",
      logged_at: `${TODAY_JST}T00:00:00+09:00`,
    }))
    authOk(makeSupabase({ logs: { data: rows, error: null } }))

    const res = await GET(req())

    expect(res.headers.get("X-Report-Truncated")).toBeNull()
    expect(generateBabyReport).toHaveBeenCalledWith(
      expect.objectContaining({ truncated: false }),
    )
  })

  it("切り詰め時に集計へ渡すのは上限ちょうど（+1 件目を混ぜない）", async () => {
    const rows = Array.from({ length: 5001 }, (_, i) => ({
      log_type: "diaper",
      diaper_type: "pee",
      logged_at: `${TODAY_JST}T00:00:${String(i % 60).padStart(2, "0")}+09:00`,
    }))
    authOk(makeSupabase({ logs: { data: rows, error: null } }))

    await GET(req())

    // 集計結果そのものではなく「+1 件目が混ざっていない」ことを見る。
    // 実装が slice を忘れると 5001 件が集計へ流れる。
    const input = generateBabyReport.mock.calls[0][0] as {
      diapers: { totalCount: number }[]
    }
    const total = input.diapers.reduce((s, d) => s + d.totalCount, 0)
    expect(total).toBe(5000)
  })
})

describe("baby-report: タイムアウト設定", () => {
  /**
   * PDF 生成は DB 2 クエリ + フォント埋め込み + レイアウトを直列で行う。
   * maxDuration 未設定だとプラットフォーム既定で無言に中断されうる。
   */
  it("maxDuration が明示されている", () => {
    expect(maxDuration).toBe(30)
  })
})

describe("baby-report: 既存の入口ガードを壊していない", () => {
  it("未認証は 401", async () => {
    getAuthContext.mockResolvedValue({
      error: "認証されていません",
      reason: "unauthenticated",
      context: null,
    })
    const res = await GET(req())
    expect(res.status).toBe(401)
  })

  it("不正な period は 400", async () => {
    authOk(makeSupabase({}))
    const res = await GET(req("10years"))
    expect(res.status).toBe(400)
  })
})
