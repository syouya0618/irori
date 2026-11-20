/**
 * メモを既存の買い物RPCに格納するための非破壊的な表示アダプタ。
 * DBは品名40文字、メモ200文字。合計220文字までを安全な1件として保存する。
 * 新規メモだけに付くタグで、旧来の買い物項目の注釈とは区別する。
 * 改行とバックスラッシュをエスケープして、サーバー/DBの「制御文字禁止」を満たす。
 */
import { GROCERY_NAME_MAX, GROCERY_NOTE_MAX } from "@/lib/meals/server/plan-requests"

export const FREE_MEMO_TEXT_MAX = 220
const CONTINUATION_MARKER = "【irori-note-v1】"

export interface FreeMemoFields {
  name: string
  note: string | null
}

export type MemoEncodeResult =
  | { ok: true; fields: FreeMemoFields }
  | { ok: false; error: string }

function encodeLineBreaks(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\r\n", "\n").replaceAll("\r", "\n").replaceAll("\n", "\\n")
}

function decodeLineBreaks(value: string): string {
  let result = ""
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i]
    if (ch === "\\" && i + 1 < value.length) {
      const next = value[++i]
      result += next === "n" ? "\n" : next
    } else {
      result += ch
    }
  }
  return result
}

export function encodeFreeMemo(value: string): MemoEncodeResult {
  const cleaned = value.replaceAll("\r\n", "\n").replaceAll("\r", "\n").trim()
  if (cleaned === "") return { ok: false, error: "メモを入力してください。" }
  if ([...cleaned].length > FREE_MEMO_TEXT_MAX) {
    return { ok: false, error: `メモは1件${FREE_MEMO_TEXT_MAX}文字以内で書いてください。` }
  }
  const encoded = [...encodeLineBreaks(cleaned)]
  // ふつうの短い買い物名は既存の買い物データと同じ形式で保存する。
  if (encoded.length <= GROCERY_NAME_MAX && !cleaned.includes("\n") && !cleaned.includes("\\")) {
    return { ok: true, fields: { name: cleaned, note: null } }
  }
  let cut = Math.min(encoded.length - 1, GROCERY_NAME_MAX)
  // DBのp_nameはtrimされるため、分割位置を空白に置かない。
  while (cut > 1 && /\s/u.test(encoded[cut - 1])) cut -= 1
  const name = encoded.slice(0, cut).join("")
  const remainder = encoded.slice(cut).join("")
  const note = CONTINUATION_MARKER + remainder
  if (name === "" || [...note].length > GROCERY_NOTE_MAX) {
    return { ok: false, error: "改行や記号が多いため保存できません。少し短く分けてください。" }
  }
  return { ok: true, fields: { name, note } }
}

/** 新式のメモだけ連結し、古い買い物項目は「品名 + 補足メモ」のまま表示する。 */
export function displayFreeMemo(item: FreeMemoFields): { text: string; legacyNote: string | null } {
  if (item.note?.startsWith(CONTINUATION_MARKER)) {
    return { text: decodeLineBreaks(item.name + item.note.slice(CONTINUATION_MARKER.length)), legacyNote: null }
  }
  return { text: item.name, legacyNote: item.note }
}
