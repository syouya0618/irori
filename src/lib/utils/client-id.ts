/**
 * 記録系 Server Action の冪等 id（P2-08）。
 *
 * 「保存は DB で成立したが応答だけが失われ、利用者が再試行して同じ記録が二重に増える」を
 * 止めるため、**操作の意図ごとに 1 回だけ** id を作り、再試行では同じ id を送る。サーバは
 * これを baby_logs の主キーとして INSERT し、重複（23505）なら既存行を「既に記録済み」と
 * して返す。ゆえに id は UUID v4 の形でなければならぬ（サーバが形を検証する）。
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function isClientId(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value)
}

export function newClientId(): string {
  const c = globalThis.crypto
  if (c && typeof c.randomUUID === "function") return c.randomUUID()
  // randomUUID が無い古い環境: getRandomValues から v4 を組む（衝突確率は同等）
  const bytes = new Uint8Array(16)
  if (c && typeof c.getRandomValues === "function") {
    c.getRandomValues(bytes)
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256)
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
