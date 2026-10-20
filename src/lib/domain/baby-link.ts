import { isValidYmd } from "@/lib/utils/date-jst"

/**
 * `/baby?date=YYYY-MM-DD` の読み書き（機能 B: 日付へ直接移動・検索結果からの着地）。
 *
 * クエリ名は書く側（検索結果のリンク・日付ジャンプ）と読む側（baby/page.tsx）で
 * このモジュールだけが知る。読む側で綴りをリテラルに書くと、定数を改名しても
 * 全テストが緑のまま着地が今日へ戻る（calendar-link.ts と同じ理由）。
 */
export const BABY_DATE_PARAM = "date"

export type BabySearchParams = { [key: string]: string | string[] | undefined }

export function babyDateHref(ymd: string): string {
  return `/baby?${BABY_DATE_PARAM}=${encodeURIComponent(ymd)}`
}

/**
 * 着地する日を決める。不正・未来・配列（`?date=a&date=b`）は今日へ倒す
 * （未来の日は date nav でも進めぬ契約。過去は何日でも遡れる）。
 */
export function resolveBabyDate(
  searchParams: BabySearchParams,
  today: string,
): string {
  const raw = searchParams[BABY_DATE_PARAM]
  if (typeof raw !== "string" || !isValidYmd(raw)) return today
  // YYYY-MM-DD は辞書順 = 暦順
  return raw > today ? today : raw
}
