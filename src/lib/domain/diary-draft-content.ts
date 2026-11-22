/** 育児日記の端末下書きの検証を、入力画面の大きなクライアントチャンクから分離する。 */
export interface DiaryDraftContent {
  text: string
}

/** 不正な端末保存を表示・復元しないための型検証。 */
export function isDiaryDraftContent(v: unknown): v is DiaryDraftContent {
  return typeof v === "object" && v !== null && typeof (v as { text?: unknown }).text === "string"
}
