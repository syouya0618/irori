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

/**
 * 商品行ではない（合計・税・支払い・店舗情報など）と判定するキーワード。
 * 「税込」「税抜」は正当な商品行（「牛乳 198 税込」等）を巻き込むため行判定からは外し、
 * extractItem 内で税表記として除去する。「レジ」「店」は「レジ袋」「店内調理〜」等の
 * 商品を潰すため文脈条件（isNoiseLine 内）へ移した。
 */
const NOISE_KEYWORDS = [
  "小計", "合計", "消費税", "内税", "外税", "お預", "預り",
  "預かり", "お釣", "おつり", "つり", "点数", "現金", "クレジット", "カード",
  "電子マネー", "ポイント", "領収", "割引", "値引", "電話", "TEL",
  "バーコード", "責", "係", "登録番号", "発行", "ありがとう",
  // 集計・軽減税率まわり（OCR の字間スペースは isNoiseLine で畳んでから照合）
  "軽減税率", "買上", "対象計", "取引", "明細", "釣銭",
  // 店舗ヘッダ系サフィックス（「店」単体は行末判定で扱う）
  "センター", "マート", "ストア",
]

/** NFKC 正規化 + 空白畳み込み（全角スペース・全角数字を吸収） */
function normalizeLine(line: string): string {
  return line.normalize("NFKC").replace(/\s+/g, " ").trim()
}

function isNoiseLine(line: string): boolean {
  // OCR は「合 計」のように字間へ偽スペースを挿入する。空白を畳んでから照合する
  const compact = line.replace(/\s+/g, "")
  if (NOISE_KEYWORDS.some((k) => compact.includes(k))) return true
  // レジ番号ヘッダ（後続が番号のもののみ。「レジ袋」は商品として残す）
  if (/レジ\s*(?:no\.?|[#＃])?\s*\d/i.test(line)) return true
  // 店舗名ヘッダ（行末が「店」。「店内調理〜」等は商品として残す）
  if (/店\s*$/.test(line)) return true
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

/**
 * 数量表記の抽出パターン（先勝ち）。「2X198」等の数量×単価は × の前の数を数量とする。
 * 「×2」形（× の後が数量）は単価（×198 等）と紛れるため、× の前が数字でなく後続が
 * 2 桁以内のときだけ数量とみなす（task 4「/[×xX]\s*(\d+)/ を数量から外す」は、既存の
 * 「×2 → 2」を回帰させないためこの限定形に絞る形で踏襲する）。
 */
const QTY_PATTERNS = [
  /(\d+)\s*個/,
  /(\d+)\s*コ/,
  /(\d+)\s*[×xX]/,
  /(?<![\d,.])[×xX]\s*(\d{1,2})(?![\d,.])/,
  /(\d+)\s*点/,
]

function extractItem(line: string): ScannedReceiptItem | null {
  let s = line

  // 行頭の部門コード（3桁以上 + 空白）を除去（「123456 ハクサイ」→「ハクサイ」）
  s = s.replace(/^\d{3,}\s+/, " ")

  // 数量表記を抽出して名前から外す（100 以上は数量として非現実的ゆえ null）
  let quantity: number | null = null
  for (const p of QTY_PATTERNS) {
    const m = s.match(p)
    if (m) {
      const q = Number(m[1])
      quantity = Number.isInteger(q) && q >= 1 && q < 100 ? q : null
      s = s.replace(p, " ")
      break
    }
  }

  // 記号ゴミ（罫線・装飾・括弧記号）を除去。単独の「・」は商品名の区切りゆえ runs のみ
  s = s.replace(/[|｜「」『』【】〈〉《》〔〕~〜☆★◎●○◯■□▲△▼▽◆◇]/g, " ")
  s = s.replace(/[-—─＝=・]{2,}/g, " ")

  // 税マーク・税表記を除去（価格除去より前）。「(税込108円)」のような括弧内注記は
  // 開き括弧だけ食うと閉じ括弧が名前に残るため、括弧ごと丸ごと除去する
  s = s.replace(/[（(][^（()）]*税[込抜][^（()）]*[)）]/g, " ")
  s = s.replace(/税[込抜]/g, " ")
  s = s.replace(/[※*＊]/g, " ")
  s = s.replace(/(内|外|軽)\s*$/g, " ")

  // 価格を除去（¥198 / 298円 / ×単価 / 密着価格 / 空白区切りの末尾数字）
  s = s.replace(/[¥￥]\s*[\d,]+/g, " ")
  s = s.replace(/[\d,]+\s*円/g, " ")
  s = s.replace(/[×xX]\s*[\d,]+/g, " ")
  // 密着価格: CJK 直後の末尾 2〜4 桁のみ（「555ml」等の単位付きは末尾が数字でないため残る）
  s = s.replace(/(?<=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー])\d{2,4}\s*$/u, " ")
  // 空白区切りの末尾価格（複数列。1 桁の「レジ袋 5」も価格ゆえ {2,} でなく + で拾う）
  s = s.replace(/(?:\s+[\d,]+)+\s*$/g, " ")

  // 税注記・数量・価格の除去で中身が空になった括弧ペアは残さない（「ポテト(108円)」対策）
  s = s.replace(/[（(]\s*[)）]/g, " ")

  // 各種除去で対応相手を失った孤児括弧は商品名に残さない（「ミックスナッツ(小)」のような
  // 揃った括弧は商品名の一部として残す）
  const hasOpen = /[（(]/.test(s)
  const hasClose = /[)）]/.test(s)
  if (hasOpen !== hasClose) {
    s = s.replace(/[（()）]/g, " ")
  }

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
