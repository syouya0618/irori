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
  "id, title, memo, is_all_day, start_date, end_date, start_at, end_at, source, series_id, updated_at, child_id, medical_record_id"

/**
 * 上の一式に、予定の**用途（ごみの日）を引くための鍵**を足したもの（`src/lib/domain/garbage.ts`
 * の `seriesKeyOf` / `eventKeyOf` が読む）。予定を一覧で描く 4 箇所（カレンダーの SSR / client
 * refetch、育児ホームの SSR / client refetch）が使う。
 *
 * **足したのは既存の列だけ**じゃ（`event_uid` は 20260808100002、`google_calendar_id` は
 * 20260709000002、`recurring_event_id` は 20260802100001）。家事機能の migration より先に
 * コードが出ても、この SELECT は落ちぬ（新設の表 `event_purposes` は別のクエリで引き、
 * 失敗しても予定の表示は倒さぬ）。新設の列をここへ足してはならぬ — 足した瞬間、migration が
 * 未適用の環境で 4 画面が同時に落ちる。
 *
 * 既存の `CALENDAR_EVENT_COLUMNS` は変えぬ（鍵を要らぬ呼び出し元・既存のテストの期待をそのまま保つ）。
 */
export const CALENDAR_EVENT_COLUMNS_WITH_KEYS = `${CALENDAR_EVENT_COLUMNS}, event_uid, google_calendar_id, recurring_event_id`
