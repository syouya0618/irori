// 週境界（月曜起点）の計算はここに置かない。かつてここにあった週境界関数は
// プロセスのローカル TZ に依存し Vercel (UTC) で前週を返すバグの温床だったため
// 削除済み (issue #23)。週境界は date-jst.ts の weekStartMonday /
// currentWeekRangeJst（JST 固定・TZ 非依存）を使うこと。

export function addDays(d: Date, days: number): Date {
  const result = new Date(d)
  result.setDate(result.getDate() + days)
  return result
}

export function formatDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}
