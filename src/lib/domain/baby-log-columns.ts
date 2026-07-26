/**
 * `baby_logs` の SELECT カラム（`BabyLogData` を満たす一式）。
 *
 * **なぜ独立モジュールに置くか**: この定数は Server Component（`baby/page.tsx` の
 * 5 クエリ）と Client Component（`baby-dashboard.tsx` の refetch 2 箇所）の両方から
 * 使う。`"use client"` を持つファイルに置いて Server 側から**値として** import すると、
 * Next.js がそれを client reference へ差し替えるため実行時に壊れる。しかも
 * **`tsc --noEmit` も `next build` も通ってしまい、実ブラウザ（e2e）で初めて落ちる**。
 * ゆえに境界指令を持たない中立モジュールへ置く（型だけなら `import type` で
 * ビルド時に消えるため `"use client"` ファイルからでも安全）。
 *
 * 先例: `calendar-event-columns.ts`（同じ罠を踏んで分離した）。
 *
 * カラムを増やす時はここ 1 箇所を直す。`BabyLogData`（`src/lib/types/baby.ts`）に
 * フィールドを足して SELECT に足し忘れると、型は通るのに実体が `undefined` になる
 * ため、両者は常に対で更新すること。
 */
export const BABY_LOG_COLUMNS =
  "id, log_type, logged_at, logged_by, feeding_type, amount_ml, breast_left_count, breast_right_count, diaper_type, ended_at, temperature, weight_g, height_cm, duration_min, duration_sec, memo, created_at"
