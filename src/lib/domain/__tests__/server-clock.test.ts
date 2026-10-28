/**
 * サーバの時刻のサンプルから押した時刻を推定する（2026-10-28 N3。`../server-clock`）。
 * 各「使わぬ」条件は、境界の内（使う）と外（使わぬ）を対にして確かめる。
 */
import { describe, it, expect, vi, afterEach } from "vitest"
import {
  deviceTimeToServerTimeMs,
  estimateServerTimeMs,
  fetchServerTimeSample,
  parseServerTime,
  significantDeviceSkewMs,
  DEVICE_SKEW_NOTICE_MIN_MS,
  MAX_CLOCK_DISAGREEMENT_MS,
  MAX_SAMPLE_AGE_MS,
  MAX_SAMPLE_RTT_MS,
  type DeviceClocks,
  type ServerTimeSample,
} from "../server-clock"

const SERVER = Date.parse("2026-10-28T03:00:00.000Z")
// 端末の壁時計は 10 分進んでおる（推定はこれに引きずられてはならぬ）
const SKEW = 10 * 60_000

function sample(over: Partial<ServerTimeSample> = {}): ServerTimeSample {
  return { serverMs: SERVER, monoMid: 5_000, wallMid: SERVER + SKEW, rttMs: 200, ...over }
}

/** サンプルから elapsed ms 経った端末（壁時計は wallDrift だけ余計に進む） */
function clocksAfter(elapsed: number, wallDrift = 0): DeviceClocks {
  return { monoNow: () => 5_000 + elapsed, wallNow: () => SERVER + SKEW + elapsed + wallDrift }
}

describe("deviceTimeToServerTimeMs（走っておるタイマーの開始を写す。v8 N3-01）", () => {
  it.each([
    ["+10 分", 10 * 60_000],
    ["-10 分", -10 * 60_000],
    ["±0", 0],
  ])("端末 %s: 端末の時計の過去の時刻を、ずれの分だけ写す（対称）", (_label, skew) => {
    const s: ServerTimeSample = { serverMs: SERVER, monoMid: 5_000, wallMid: SERVER + skew, rttMs: 200 }
    const clocks: DeviceClocks = { monoNow: () => 5_000 + 60_000, wallNow: () => SERVER + skew + 60_000 }
    // 端末の時計で 3 分前に始めた
    const startDevice = SERVER + skew + 60_000 - 3 * 60_000
    expect(deviceTimeToServerTimeMs(startDevice, s, clocks)).toBe(SERVER + 60_000 - 3 * 60_000)
  })

  it("サンプルの後に時計を変えた（食い違いが 2 秒超）・古い・往復の長いサンプルでは写さぬ（有界）。境界の内は写す", () => {
    const start = SERVER + SKEW - 60_000
    expect(deviceTimeToServerTimeMs(start, sample(), clocksAfter(60_000, MAX_CLOCK_DISAGREEMENT_MS))).not.toBeNull()
    expect(deviceTimeToServerTimeMs(start, sample(), clocksAfter(60_000, MAX_CLOCK_DISAGREEMENT_MS + 1))).toBeNull()
    expect(deviceTimeToServerTimeMs(start, sample(), clocksAfter(MAX_SAMPLE_AGE_MS + 1))).toBeNull()
    expect(deviceTimeToServerTimeMs(start, sample({ rttMs: MAX_SAMPLE_RTT_MS + 1 }), clocksAfter(1_000))).toBeNull()
  })

  it("端末の今より後の時刻（写す時刻の後に端末の時計が戻された）は写さぬ — 未来の開始を作らぬ（v8rc2 INFO）", () => {
    const clocks = clocksAfter(60_000)
    const nowDevice = clocks.wallNow()
    expect(deviceTimeToServerTimeMs(nowDevice + 6 * 60_000, sample(), clocks)).toBeNull()
    // 対照: ちょうど今は写す
    expect(deviceTimeToServerTimeMs(nowDevice, sample(), clocks)).toBe(SERVER + 60_000)
  })

  it("数でない時刻は写さぬ", () => {
    expect(deviceTimeToServerTimeMs(Number.NaN, sample(), clocksAfter(1_000))).toBeNull()
  })
})

describe("estimateServerTimeMs", () => {
  it("押した時刻 = サーバの時刻 + サンプルからの経過（端末の時計のずれに引きずられぬ）", () => {
    expect(estimateServerTimeMs(sample(), clocksAfter(90_000))).toBe(SERVER + 90_000)
  })

  it("往復が上限ちょうどなら使い、越えたら使わぬ", () => {
    expect(estimateServerTimeMs(sample({ rttMs: MAX_SAMPLE_RTT_MS }), clocksAfter(1_000))).toBe(
      SERVER + 1_000,
    )
    expect(estimateServerTimeMs(sample({ rttMs: MAX_SAMPLE_RTT_MS + 1 }), clocksAfter(1_000))).toBeNull()
    expect(estimateServerTimeMs(sample({ rttMs: -1 }), clocksAfter(1_000))).toBeNull()
  })

  it("古さが上限ちょうどなら使い、越えたら使わぬ。経過が負（再読込で経過の時計が戻った）も使わぬ", () => {
    expect(estimateServerTimeMs(sample(), clocksAfter(MAX_SAMPLE_AGE_MS))).toBe(
      SERVER + MAX_SAMPLE_AGE_MS,
    )
    expect(estimateServerTimeMs(sample(), clocksAfter(MAX_SAMPLE_AGE_MS + 1))).toBeNull()
    expect(estimateServerTimeMs(sample(), clocksAfter(-1))).toBeNull()
  })

  it("壁時計と経過の時計の食い違いが上限の内なら使い、越えたら（時計の変更・スリープ）使わぬ", () => {
    expect(
      estimateServerTimeMs(sample(), clocksAfter(60_000, MAX_CLOCK_DISAGREEMENT_MS)),
    ).toBe(SERVER + 60_000)
    // 利用者が時計を 10 分進めた（壁時計だけが跳ぶ）
    expect(estimateServerTimeMs(sample(), clocksAfter(60_000, 10 * 60_000))).toBeNull()
    // 時計を戻した
    expect(estimateServerTimeMs(sample(), clocksAfter(60_000, -10 * 60_000))).toBeNull()
    // 端末が 10 分眠り、経過の時計が止まっておった（壁時計だけが 10 分進む）
    expect(estimateServerTimeMs(sample(), clocksAfter(1_000, 10 * 60_000))).toBeNull()
  })
})

describe("parseServerTime", () => {
  it("妥当な epoch ms だけを受ける", () => {
    expect(parseServerTime({ serverTime: SERVER })).toBe(SERVER)
    expect(parseServerTime({ serverTime: SERVER / 1000 })).toBeNull() // 秒単位の値
    expect(parseServerTime({ serverTime: 0 })).toBeNull()
    expect(parseServerTime({ serverTime: "1761620400000" })).toBeNull()
    expect(parseServerTime({ serverTime: Number.NaN })).toBeNull()
    expect(parseServerTime({ buildId: "abc1234" })).toBeNull() // 古いサーバ（時刻を持たぬ）
    expect(parseServerTime(null)).toBeNull()
  })
})

describe("fetchServerTimeSample", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  function clockPair(start = 10_000) {
    let mono = start
    return {
      clocks: { monoNow: () => mono, wallNow: () => SERVER + SKEW + (mono - start) },
      tick: (ms: number) => {
        mono += ms
      },
    }
  }

  it("往復の中点・往復の時間を測り、no-store・redirect を追わずに /api/version を引く", async () => {
    const { clocks, tick } = clockPair()
    const fetchMock = vi.fn(async () => {
      tick(300)
      return Response.json({ buildId: "abc1234", releaseName: "x", serverTime: SERVER })
    })
    vi.stubGlobal("fetch", fetchMock)
    const got = await fetchServerTimeSample({ clocks })
    expect(got).toEqual({ serverMs: SERVER, monoMid: 10_150, wallMid: SERVER + SKEW + 150, rttMs: 300 })
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/version",
      expect.objectContaining({ cache: "no-store", redirect: "manual" }),
    )
  })

  it("ログインの門（opaqueredirect / 3xx / 401）・失敗・JSON でない・時刻の無い応答は null", async () => {
    const { clocks } = clockPair()
    const responses: Array<() => Response> = [
      () => new Response(null, { status: 401 }),
      () => new Response(null, { status: 503 }),
      () => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } }),
      () => Response.json({ buildId: "abc1234", releaseName: "x" }),
    ]
    for (const make of responses) {
      vi.stubGlobal("fetch", vi.fn(async () => make()))
      expect(await fetchServerTimeSample({ clocks })).toBeNull()
    }
    const redirect = Object.defineProperty(new Response(null, { status: 200 }), "type", {
      value: "opaqueredirect",
    })
    vi.stubGlobal("fetch", vi.fn(async () => redirect))
    expect(await fetchServerTimeSample({ clocks })).toBeNull()
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("Failed to fetch")
    }))
    expect(await fetchServerTimeSample({ clocks })).toBeNull()
  })

  it("往復の間に壁時計が跳んだサンプルは使わぬ（対照: 跳ばねば使う）", async () => {
    let mono = 0
    let wall = SERVER
    const clocks = { monoNow: () => mono, wallNow: () => wall }
    vi.stubGlobal("fetch", vi.fn(async () => {
      mono += 200
      wall += 200 + 10 * 60_000
      return Response.json({ serverTime: SERVER })
    }))
    expect(await fetchServerTimeSample({ clocks })).toBeNull()
    vi.stubGlobal("fetch", vi.fn(async () => {
      mono += 200
      wall += 200
      return Response.json({ serverTime: SERVER })
    }))
    expect(await fetchServerTimeSample({ clocks })).not.toBeNull()
  })

  it("期限を越えたら取り消して null（押下はこれを待たぬ）", async () => {
    vi.useFakeTimers()
    const { clocks } = clockPair()
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))
          }),
      ),
    )
    const pending = fetchServerTimeSample({ clocks, timeoutMs: 5_000 })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(await pending).toBeNull()
  })
})

describe("significantDeviceSkewMs（停め忘れの注記の証拠。時刻は直さぬ）", () => {
  it("往復の誤差を除いても 1 分以上ずれておる時だけ、符号つきのずれを返す（± に同じく）", () => {
    expect(significantDeviceSkewMs(sample())).toBe(SKEW)
    expect(significantDeviceSkewMs(sample({ wallMid: SERVER - SKEW }))).toBe(-SKEW)
  })

  it("境界: |ずれ| − 往復の半分 が 1 分ちょうどなら出し、1ms 足りねば出さぬ", () => {
    const rtt = 2_000
    expect(significantDeviceSkewMs(sample({ rttMs: rtt, wallMid: SERVER + DEVICE_SKEW_NOTICE_MIN_MS + rtt / 2 }))).not.toBeNull()
    expect(significantDeviceSkewMs(sample({ rttMs: rtt, wallMid: SERVER + DEVICE_SKEW_NOTICE_MIN_MS + rtt / 2 - 1 }))).toBeNull()
  })

  it("往復が長すぎる・負のサンプルは証拠にせぬ", () => {
    expect(significantDeviceSkewMs(sample({ rttMs: MAX_SAMPLE_RTT_MS + 1 }))).toBeNull()
    expect(significantDeviceSkewMs(sample({ rttMs: -1 }))).toBeNull()
  })
})
