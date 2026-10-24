/**
 * `calendar_events` の SELECT カラム（`CalendarEventRecord` を満たす一式）。
 *
 * **なぜ独立モジュールに置くか**: この定数は Server Component（`baby/page.tsx`・
 * `calendar/page.tsx`）と Client Component（`use-month-events.ts`・
 * `upcoming-events-card.tsx`）の両方から使う。`"use client"` を持つファイルに
 * 置いて Server 側から**値として** import すると、Next.js がそれを client
 * reference へ差し替えるため実行時に壊れる。しかも **`tsc --noEmit` も
 * `next build` も通ってしまい、実ブラウザ（e2e）で初めて落ちる**。
 * ゆえに境界指令を持たない中立モジュールへ置く（型だけなら `import type` で
 * ビルド時に消えるため `"use client"` ファイルからでも安全）。
 *
 * `updated_at` は予定の更新の版（楽観的排他）。編集シートを開いた時点の版を
 * `updateCalendarEvent` へ渡し、配偶者が先に直した予定を古い画面から巻き戻さぬ。
 */
export const CALENDAR_EVENT_COLUMNS =
  "id, title, memo, is_all_day, start_date, end_date, start_at, end_at, source, series_id, updated_at"
