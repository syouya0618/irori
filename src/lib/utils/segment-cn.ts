/**
 * セグメント（設定の「ライト/ダーク/システム」等）の共通クラス。
 *
 * `min-h-11`（44px）は CLAUDE.md「Touch targets: min 44px」/
 * DESIGN_SYSTEM.md:99 の担い手じゃ。**ここへ置く理由**: 呼び出しは 9 箇所あり、
 * 実測では設定の 4 群（開始ページ / OCR / 保存期間 / テーマ）が 36px しか無かった。
 * 呼び出し側で足す形だと漏れる — 実際 `calendar-event-form-sheet` の 2 箇所だけが
 * ` min-h-11` を継ぎ足しており、**気づいた者が局所的に貼った跡**が残っておった。
 */
export function segmentCn(active: boolean): string {
  return `flex-1 min-h-11 rounded-lg px-2 py-2 text-sm font-medium transition-colors duration-200 ${
    active
      ? "bg-primary text-primary-foreground"
      : "bg-muted text-muted-foreground hover:text-foreground"
  }`
}
