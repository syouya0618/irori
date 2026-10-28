import { VERSION_ENDPOINT } from "@/lib/pwa/app-version"

/**
 * 押した瞬間の時刻を、端末の時計ではなくサーバの時計で推定する（2026-10-28 製品判断 N3）。
 *
 * ## なぜ要るか
 * 母乳の手動記録の開始時刻は「記録するを最初に押した実時刻」（PR #244）。端末の時計（`new Date()`）を
 * 送ると、時計が進んだ端末は「未来の時刻」で拒まれ、遅れた端末は黙って誤った時刻で残る。押した後に
 * 送り直しても同じ時刻でなければならぬ（同じ id・同じ内容の照合）ゆえ、DB の `now()`（届いた時刻）に
 * 任せることもできぬ — 初回が届かなかった時、送り直した時刻に化ける。
 *
 * ## 方式（最小）
 * - サーバの時刻のサンプルを `GET /api/version` の `serverTime` から取る（新しい経路は足さぬ）。
 *   要求を出した時と応答が届いた時の経過の時計（`performance.now`）を測り、サーバの時刻は往復の
 *   中点にあったとみなす。誤差は往復の半分以内
 * - 押した時刻 = サーバの時刻 + （押した時の経過の時計 − 往復の中点の経過の時計）
 * - サンプルは画面の寿命の間だけ持つ（端末に保存せぬ）。経過の時計は再読込で 0 に戻るゆえ、
 *   持ち越すと嘘になる
 *
 * ## 使わぬ（推定できぬ = null）時
 * - サンプルが無い（圏外・取得失敗・ログインの門・壊れた応答）
 * - 往復が長すぎる（`MAX_SAMPLE_RTT_MS`。誤差が大きい）
 * - 古すぎる（`MAX_SAMPLE_AGE_MS`）
 * - サンプルの後で、端末の壁時計の進みと経過の時計の進みが食い違った
 *   （`MAX_CLOCK_DISAGREEMENT_MS`）。利用者が時計を変えた（壁時計だけが跳ぶ）、端末が眠って経過の
 *   時計が止まった（iOS の `performance.now` はスリープ中に進まぬことがある）のどちらも、この 1 本の
 *   判定で拾う。どちらの時計が正しいかは決めつけず、サンプルを捨てる
 *
 * 推定できぬ時、呼び出し側は時刻を**送らず**、サーバが受け取った時刻（DB の `now()`）へ退化させ、
 * そう利用者に伝える（「押した時刻」とは偽らぬ）。押下を新しいサンプルの取得で待たせることはせぬ
 * （圏外で記録の操作が詰まるため）。
 */

export interface ServerTimeSample {
  /** サーバが答えた時刻（epoch ms） */
  serverMs: number
  /** 往復の中点の経過の時計（performance.now の値） */
  monoMid: number
  /** 往復の中点の端末の壁時計（Date.now の値）。時計の変更・スリープを見分けるためだけに使う */
  wallMid: number
  /** 往復の時間（ms）。推定の誤差はこの半分以内 */
  rttMs: number
}

/** 端末の 2 つの時計（試験で差し替えられるよう注入する） */
export interface DeviceClocks {
  monoNow: () => number
  wallNow: () => number
}

const defaultClocks: DeviceClocks = {
  monoNow: () => performance.now(),
  wallNow: () => Date.now(),
}

/** これより長い往復のサンプルは使わぬ（誤差が 1.5 秒を越えうる） */
export const MAX_SAMPLE_RTT_MS = 3_000
/** これより古いサンプルは使わぬ（端末の水晶のずれは ppm 程度ゆえ、本当の限りは食い違いの判定） */
export const MAX_SAMPLE_AGE_MS = 30 * 60_000
/** 壁時計と経過の時計の進みがこれ以上食い違ったら、時計の変更・スリープとみなして捨てる */
export const MAX_CLOCK_DISAGREEMENT_MS = 2_000
/** サンプルの取得の期限 */
export const SERVER_TIME_FETCH_TIMEOUT_MS = 5_000

// 2020-01-01（壊れた応答・0・秒単位の値で時刻を作らぬための下限）
const MIN_PLAUSIBLE_SERVER_MS = Date.UTC(2020, 0, 1)

/** `/api/version` の応答からサーバの時刻を取り出す。無い・壊れておれば null。 */
export function parseServerTime(body: unknown): number | null {
  if (typeof body !== "object" || body === null) return null
  const value = (body as Record<string, unknown>).serverTime
  return typeof value === "number" && Number.isFinite(value) && value > MIN_PLAUSIBLE_SERVER_MS
    ? value
    : null
}

/** 今のサーバの時刻（epoch ms）の推定。使えぬサンプルなら null（上の「使わぬ時」）。 */
export function estimateServerTimeMs(
  sample: ServerTimeSample,
  clocks: DeviceClocks = defaultClocks,
): number | null {
  if (!(sample.rttMs >= 0 && sample.rttMs <= MAX_SAMPLE_RTT_MS)) return null
  const elapsedMono = clocks.monoNow() - sample.monoMid
  const elapsedWall = clocks.wallNow() - sample.wallMid
  if (!(elapsedMono >= 0 && elapsedMono <= MAX_SAMPLE_AGE_MS)) return null
  if (!(Math.abs(elapsedWall - elapsedMono) <= MAX_CLOCK_DISAGREEMENT_MS)) return null
  return Math.round(sample.serverMs + elapsedMono)
}

/**
 * 端末の時計で測った**過去の**時刻（例: 走っておるタイマーの開始）を、サーバの時計の時刻へ写す
 * （独立レビュー v7 N3-01）。今の端末の壁時計とサーバの時刻の推定の差（= 端末の時計のずれ）を足す。
 *
 * - 対称: 進んだ時計も遅れた時計も同じ式で写す（ずれの符号を問わぬ）
 * - 有界: 誤差は往復の半分（≤ MAX_SAMPLE_RTT_MS / 2）と、許す壁時計と経過の時計の食い違い
 *   （≤ MAX_CLOCK_DISAGREEMENT_MS）の和以内（≤ 3.5 秒）。写した時刻は推定の今を越えぬ。サンプルの後に時計を変えた・眠った
 *   （食い違いが MAX_CLOCK_DISAGREEMENT_MS 超）・古い・無いサンプルでは写さず null — 呼び出し側は
 *   端末の時刻のまま送る（validateLogTime の 5 分の規則はサーバがそのまま効かせる）
 * - 前提: 写す時刻と今の間に端末の時計が変わっておらぬこと（同じ画面のサンプルの後の変更は上の
 *   判定で拾う。サンプルより前・再読込の前の変更は拾えぬ = 既知の限界。経過の時計は再読込で 0 に
 *   戻るゆえ、画面を跨いだ変更を知る手段が無い）
 */
export function deviceTimeToServerTimeMs(
  deviceMs: number,
  sample: ServerTimeSample,
  clocks: DeviceClocks = defaultClocks,
): number | null {
  if (!Number.isFinite(deviceMs)) return null
  const wallNow = clocks.wallNow()
  // 端末の今より後の「過去の時刻」は、写す時刻の後に端末の時計が戻された印 — 写すと未来の開始を作る。
  // 写さず端末の時刻の経路へ退く（v8rc2 INFO: 写した時刻は推定の今を越えぬ、を常に保つ）
  if (deviceMs > wallNow) return null
  const serverNow = estimateServerTimeMs(sample, clocks)
  if (serverNow === null) return null
  return Math.round(deviceMs + (serverNow - wallNow))
}

/** 端末の時計のずれを「ずれておる」と伝える下限（往復の誤差を除いてもこれ以上ずれておる時だけ） */
export const DEVICE_SKEW_NOTICE_MIN_MS = 60_000

/**
 * サンプルが示す端末の時計のずれ（端末 − サーバ。正 = 端末が進んでおる）。往復の誤差（半分）を除いても
 * DEVICE_SKEW_NOTICE_MIN_MS 以上ずれておる時だけ値を返す（それ以外・使えぬサンプルは null）。
 *
 * 停め忘れた授乳の開始時刻（端末の時計で測った過去の時刻。2026-10-28 製品判断）を**写さず**に、
 * 「この時刻は端末の時計によるもので、ずれておるかもしれぬ」と伝えるための**証拠**にだけ使う。
 * 今のずれが開始の時にもあったかは分からぬ（再読込の前の時計の変更は拾えぬ）ゆえ、時刻を直す根拠には
 * せぬ。サンプルが無い時は null — ずれが無いとも言わず、確かめられぬとする。
 */
export function significantDeviceSkewMs(sample: ServerTimeSample): number | null {
  if (!(sample.rttMs >= 0 && sample.rttMs <= MAX_SAMPLE_RTT_MS)) return null
  const skew = sample.wallMid - sample.serverMs
  if (!Number.isFinite(skew)) return null
  return Math.abs(skew) - sample.rttMs / 2 >= DEVICE_SKEW_NOTICE_MIN_MS ? Math.round(skew) : null
}

/**
 * サーバの時刻のサンプルを 1 つ取る。期限（5 秒）と取消し（`signal`）を持ち、例外は投げぬ
 * （取れなければ null — 呼び出し側は受信時刻へ退化する）。ログインの門（307）を追わぬ。
 */
export async function fetchServerTimeSample(
  options: { signal?: AbortSignal; timeoutMs?: number; clocks?: DeviceClocks } = {},
): Promise<ServerTimeSample | null> {
  const clocks = options.clocks ?? defaultClocks
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? SERVER_TIME_FETCH_TIMEOUT_MS)
  const onOuterAbort = () => controller.abort()
  if (options.signal) {
    if (options.signal.aborted) controller.abort()
    else options.signal.addEventListener("abort", onOuterAbort, { once: true })
  }
  try {
    const mono0 = clocks.monoNow()
    const wall0 = clocks.wallNow()
    const res = await fetch(VERSION_ENDPOINT, {
      cache: "no-store",
      redirect: "manual",
      signal: controller.signal,
      headers: { accept: "application/json" },
    })
    const mono1 = clocks.monoNow()
    const wall1 = clocks.wallNow()
    if (res.type === "opaqueredirect" || !res.ok) return null
    if (!(res.headers.get("content-type") ?? "").includes("application/json")) return null
    const serverMs = parseServerTime(await res.json())
    if (serverMs === null) return null
    // 往復の間に壁時計が跳んだ（時計の変更）・経過の時計が止まったサンプルは使わぬ
    if (!(Math.abs(wall1 - wall0 - (mono1 - mono0)) <= MAX_CLOCK_DISAGREEMENT_MS)) return null
    return {
      serverMs,
      monoMid: (mono0 + mono1) / 2,
      wallMid: (wall0 + wall1) / 2,
      rttMs: mono1 - mono0,
    }
  } catch (err) {
    if (!controller.signal.aborted) {
      console.warn("[server-clock] サーバ時刻の取得に失敗", {
        message: err instanceof Error ? err.message : String(err),
      })
    }
    return null
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener("abort", onOuterAbort)
  }
}
