/**
 * `shopping_items` の SELECT カラム（`ShoppingItemData` を満たす一式）。
 *
 * **なぜ独立モジュールに置くか**: この定数は Server Component（`shopping/page.tsx`）と
 * Server Action（`shopping/actions.ts` の楽観挿入用 `.select()`）の両方から使う。
 * `"use server"` ファイルは全 export が async 関数であることを要求されるため定数を
 * そこへ置けず、`"use client"` ファイルへ置けば Server 側の値 import が client
 * reference へ化けて実行時に壊れる（`calendar-event-columns.ts` と同じ理由）。
 * ゆえに境界指令を持たない中立モジュールへ置く。
 *
 * SSR の初期行と Server Action が返す楽観行の**形が同一である**ことが、この定数を
 * 共有する目的そのものじゃ（片方だけ列が増減すると楽観挿入した行だけ欠けた表示になる）。
 * `select("*")` は使わない（リポジトリ全体で 0 件の規約）。
 */
export const SHOPPING_ITEM_COLUMNS =
  "id, name, quantity, category, store_type, is_checked, checked_by, checked_at, sort_order"
