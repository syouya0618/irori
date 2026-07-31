/**
 * `stock_items` の SELECT カラム（`StockItemData` を満たす一式）。
 *
 * **なぜ独立モジュールに置くか**: SSR の初期取得（`cached-queries.ts` = server 専用）
 * と Client Component の復帰時 refetch（`stock-list.tsx`）の両方から使う。
 * `cached-queries.ts` は `@/lib/supabase/server` を import するためクライアントから
 * 参照できず、`"use client"` 側に置けば server からの値 import が client reference
 * へ化ける（`calendar-event-columns.ts` と同じ理由）。ゆえに境界指令を持たない
 * 中立モジュールへ置き、初期行と refetch 行の形を一致させる。
 */
export const STOCK_ITEM_COLUMNS =
  "id, name, category, quantity, unit, expires_at, created_by, created_at, updated_at"
