export type SharedRow = Record<string, string | number | null>
export type ShareSummary = { id: string; child_name: string; allow_daily: boolean; allow_diary: boolean; allow_health: boolean; allow_custom: boolean; expires_at: string | null; revoked_at: string | null; accepted: boolean; viewer_name?: string | null }
export type SharedSnapshot = { child_name: string; daily: SharedRow[]; health: SharedRow[]; diary: SharedRow[]; expires_at: string | null; valid_for_ms: number; window_note: string; medical?: SharedRow[]; sleep?: SharedRow[]; custom?: SharedRow[] }
export function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) }
function rows(value: unknown): value is SharedRow[] {
  return Array.isArray(value) && value.length <= 500 && value.every(v => isRecord(v) && Object.values(v).every(x => x === null || typeof x === "string" || (typeof x === "number" && Number.isFinite(x))))
}
export function parseSharedSnapshot(value: unknown): SharedSnapshot | null {
  if (!isRecord(value) || typeof value.child_name !== "string" || typeof value.window_note !== "string" ||
    typeof value.valid_for_ms !== "number" || !Number.isFinite(value.valid_for_ms) || value.valid_for_ms <= 0 || value.valid_for_ms > 15000 ||
    !rows(value.daily) || !rows(value.health) || !rows(value.diary) ||
    !(value.expires_at === null || typeof value.expires_at === "string")) return null
  if ([value.medical,value.sleep,value.custom].some(v => v !== undefined && !rows(v))) return null
  return value as SharedSnapshot
}
export function parseShareList(value: unknown): ShareSummary[] | null {
  if (!Array.isArray(value) || !value.every(v => isRecord(v) && typeof v.id === "string" && typeof v.child_name === "string" &&
    [v.allow_daily,v.allow_diary,v.allow_health,v.allow_custom,v.accepted].every(x => typeof x === "boolean") &&
    (v.expires_at === null || typeof v.expires_at === "string") && (v.revoked_at === null || typeof v.revoked_at === "string"))) return null
  return value as ShareSummary[]
}
