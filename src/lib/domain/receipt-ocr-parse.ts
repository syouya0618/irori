/**
 * OCR で得たレシート生テキストから商品名候補を抽出するパーサ。
 * Tesseract.js（端末内）と Google Vision（クラウド）の両 OCR provider が生成する
 * 生テキストを共通でこの関数に通す。ヒューリスティックゆえ完璧ではなく、
 * 結果はレビュー UI（ReceiptEntrySheet）でユーザーが確認・修正する前提。
 *
 * 参考: OCR パーサは NFKC 正規化を入口で行い、非商品行を除外する（learnings/11）。
 */

export interface ScannedReceiptItem {
  name: string
  quantity: number | null
}

/** 商品行ではない（合計・税・支払い・店舗情報など）と判定するキーワード */
const NOISE_KEYWORDS = [
  "小計", "合計", "消費税", "内税", "外税", "税抜", "税込", "お預", "預り",
  "預かり", "お釣", "おつり", "つり", "点数", "現金", "クレジット", "カード",
  "電子マネー", "ポイント", "レジ", "領収", "割引", "値引", "電話", "TEL",
  "バーコード", "責", "係", "登録番号", "発行", "ありがとう",
  // 店舗ヘッダ（商品名が「店」を含むことはレシート上ほぼ無い）
  "店", "センター", "マート", "ストア",
]

/** NFKC 正規化 + 空白畳み込み（全角スペース・全角数字を吸収） */
function normalizeLine(line: string): string {
  return line.normalize("NFKC").replace(/\s+/g, " ").trim()
}

function isNoiseLine(line: string): boolean {
  if (NOISE_KEYWORDS.some((k) => line.includes(k))) return true
  // 日付: 2026/07/16 / 2026年7月16日 / 2026-07-16
  if (/\d{4}\s*[\/年.\-]\s*\d{1,2}\s*[\/月.\-]\s*\d{1,2}/.test(line)) return true
  // 時刻: 先頭が HH:MM
  if (/^\d{1,2}:\d{2}/.test(line)) return true
  // 電話番号
  if (/\d{2,4}-\d{2,4}-\d{3,4}/.test(line)) return true
  // No.12345 / 番号
  if (/^no\.?\s*\d+/i.test(line)) return true
  return false
}

const HAS_WORD_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}A-Za-z]/u

function extractItem(line: string): ScannedReceiptItem | null {
  let s = line
  let quantity: number | null = null

  // 数量表記を抽出して名前から外す
  const qtyPatterns = [/(\d+)\s*個/, /(\d+)\s*コ/, /[×xX]\s*(\d+)/, /(\d+)\s*点/]
  for (const p of qtyPatterns) {
    const m = s.match(p)
    if (m) {
      quantity = Number(m[1])
      s = s.replace(p, " ")
      break
    }
  }

  // 価格を除去（¥198 / 298円 / 末尾の連続数字）— 名前中の 500ml 等は残す
  s = s.replace(/[¥￥]\s*[\d,]+/g, " ")
  s = s.replace(/[\d,]+\s*円/g, " ")
  s = s.replace(/\s[\d,]{2,}\s*$/g, " ")

  // 税マーク・記号を除去
  s = s.replace(/[※*＊]/g, " ")
  s = s.replace(/(内|外|軽)\s*$/g, " ")
  s = s.replace(/[-—─＝=・]{2,}/g, " ")

  const name = s.replace(/\s+/g, " ").trim()
  if (name === "") return null
  // 純粋な数字・記号だけの行は商品名でない
  if (!HAS_WORD_CHAR.test(name)) return null

  return { name, quantity }
}

export function parseReceiptText(raw: string): ScannedReceiptItem[] {
  if (!raw) return []

  const items: ScannedReceiptItem[] = []
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = normalizeLine(rawLine)
    if (line === "") continue
    if (isNoiseLine(line)) continue
    const item = extractItem(line)
    if (item) items.push(item)
  }
  return items
}
