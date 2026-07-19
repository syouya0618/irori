# irori カレンダー要望 対応計画（時間設定・ウィジェット化）

- 作成: 2026-07-18 / 対象 HEAD: main `e77a376` / 姉妹計画: `docs/plans/2026-07-18-babycare-ux.md`（育児UX、承認待ち）
- 経緯: ユーザー要望 2 件「1. カレンダー機能に時間設定を追加」「2. カレンダー機能をウィジェット化できないか？」を 5 エージェント（実装マップ C1 / 実現可能性調査 C2 / 設計 C3・C4 / 敵対的レビュー C5）で調査・設計。C5 の blocking 3 件は**本計画に反映済み**。
- 位置づけ: 調査成果物。コード変更・Issue/PR 作成は未実施。

---

## 0. 調査結果の要点

### 要望1「時間設定を追加」→ **時刻機能は既に実装済み**。真の欠落は別にある

スキーマ `start_at`/`end_at` TIMESTAMPTZ + CHECK（`supabase/migrations/20260709000002_calendar_events.sql:28-59`、本番適用済み）、フォームの time 入力（`calendar-event-form-sheet.tsx:164-187`）、アジェンダの HH:MM 表示、e2e の時刻ケース（`e2e/calendar.spec.ts:134-166`）まで PR #108 由来で実在する。**DB migration は不要**。真の欠落は:

1. **発見性**: フォーム既定が「終日」（form-sheet:58）で、チェックを外さないと時刻入力が現れない
2. **終了時刻が UI のどこにも表示されない**（`calendar-agenda.tsx:42-48` は start_at のみ）
3. **バグ**: 複数日にわたる時刻付きイベントの 2 日目以降にも初日の開始時刻（「14:00」）がそのまま表示される
4. **AUDIT-069（前回監査・未修正）**: `start_date` ↔ `start_at` の JST 日付整合が validation でも DB でも保証されない

> **人間確認（解釈の分岐点 — advisor 指摘で格上げ）**: 「時間設定を追加」には第 3 の解釈がある — **(c) 時刻になったら通知してほしい（リマインド）**。もし真意が (c) なら CAL-1〜3 は一切応えず、該当は §4 で「保留」にした Push 基盤そのもの（現 sw.js:8 は Push スコープ外宣言）。ゆえにユーザーへ「(a) 時刻入力が見つけにくかった / (b) 終了時刻が表示されない / (c) 時刻に通知が欲しい / (d) その他」を確認してから着手順を確定する。**(a)(b) なら下記 CAL-1〜3 が回答**。(c) なら Push 基盤の設計を別途起こす（本計画のスコープ外、前回計画の PWA Push 保留判断の再開）。

### 要望2「ウィジェット化」→ **ホーム画面ウィジェットは PWA では不可（iOS/Android）**。代替を推奨

- Web App Manifest の `widgets` メンバーは **Windows 11 Widgets Board 専用**の Microsoft 拡張で、Adaptive Cards 必須・MDN にページなし（非標準）。原文を 2026-07-18 に逐語確認: "the widget host, which currently is the Windows 11 Widgets Board"（https://learn.microsoft.com/en-us/microsoft-edge/progressive-web-apps/how-to/widgets）
- iOS のウィジェットは WidgetKit（ネイティブアプリ専用）。Android Chrome にも PWA ウィジェット実装なし。
- **Flutter 経由は技術的には可能だが XL**: `flutter/` に ios/android ターゲット不在・calendar 未移植（AUDIT-013 現存）・ウィジェット UI は SwiftUI/Kotlin ネイティブ実装必須（home_widget 公式）。web 主軸戦略（前回計画 §0）と不整合のため**非推奨**。
- **推奨**: (a) **アプリ内ウィジェット** =「今日・明日の予定」glass カードを `/meals`（PWA の start_url = 起動直後の画面）冒頭に置く（CAL-4、本命）。(b) **manifest shortcuts**（CAL-5、アイコン長押しメニュー。Android のみ体感）。
- 将来解禁の監視ポイント: aarongustafson/pwa-widgets 提案 repo / Microsoft Learn の widget host 拡張記述 / webkit.org・firt.dev 互換表 / chromestatus.com

---

## 1. PR 計画

> **実行順は直列固定**: CAL-1 → CAL-0 → CAL-2 → CAL-3 → CAL-4 → CAL-5（共有ファイル `e2e/calendar.spec.ts`・`calendar-event-form-sheet.tsx`・`e2e/offline.spec.ts` の書き換え依存を解消する唯一順序 — C5 レビュー結論）。
> 共通規律は babycare 計画 §7 と同一: fail-red 先行・no-regression ゲート・1PR=1関心事。**テストベースラインは固定値を引用せず、各 PR 着手時に `pnpm test:run` の実出力（ファイル数/テスト数/全緑)を PR 本文に記録して照合先とする**（C5 BLK-3 の解消 — 参考値: 2026-07-18 実測 48 files / 354 tests @ e77a376）。

### CAL-1 [S] calendar-validation 整合強化（AUDIT-069 の完全クローズ）

- **対象**: `src/lib/domain/calendar-validation.ts:22-79`。timed 時に `toJstDateString(startAt) === startDate`（endAt↔endDate も同様）+ 日付/ISO 形式検証 + 順序比較の getTime 化（現行 :64-65 は文字列比較）。Server Action は同関数経由（`calendar/actions.ts:18-20,59-62`）ゆえ両層で自動強制。
- **検証**: fail-red vitest — 不整合入力（startAt の JST 日 ≠ startDate）が現状素通り → 赤 → 修正で緑。**JST 日跨ぎ境界（15:30Z = JST 翌日 00:30）と +09:00 形式 ISO のケース必須**。既存 validation テスト 6 本は無修正緑（C5 が実測で事前確認済み）。
- **消し込み**: 前回計画 P3 の AUDIT-069 行は**本 PR が唯一の更新者**（C4 側からの二重クローズ記録禁止 — C5 S-7）。

### CAL-0 [S] I-10 部分消化: sw.js APP_PAGES へ /calendar（本 PR が I-10 の唯一の実行者）

> **正直ラベル（advisor 指摘）**: 本項はどちらの要望への直接回答でもなく、**「ついでに拾う隣接バックログ」**（CAL-4 のカード導線先がオフラインで /offline に落ちるのを防ぐ前提整備）。採否は独立に人間が判断してよい。

- **対象**: `public/sw.js:27`（APP_PAGES に /calendar 欠落 — オフラインで /calendar が /offline に落ちる）+ `sw-logic.test.ts:78-84`（toEqual 完全一致 assert の false green を**先に赤で実証**してから期待値更新）。
- **分界**: I-10 の残余（onboarding STEPS・docs 群）は I-10 に残す旨を Issue 改訂（部分消化の記録）。babycare 計画は I-10 をスコープ外と明記済み（同計画 §7c）で二重予約なし。C3 設計の「I-10 独立先行推奨」は本 PR へ委譲で一本化（C5 S-3）。
- **検証**: fail-red（期待値更新前に赤）→ 緑。e2e/offline.spec.ts に「/calendar がオフラインで表示される」を追加。**同ファイルは babycare B-07 も編集予定 → B-07 が先にマージされていたら rebase、先行する場合は append 位置の調整のみ**（C5 BLK-2 の解消）。
- **受け入れ**: オフライン状態で /calendar が他タブ同様に表示されれば合格。/offline へ落ちたら不合格。

### CAL-2 [S-M] agenda 終了時刻表示 + 多日イベント「14:00 引きずり」バグ修正

- **対象**: `calendar-agenda.tsx:42-48`（時刻を開始/終了の 2 段表示に）+ `selectedDate` prop 追加 + google read-only 詳細シートに日時行。`sortDayEvents`（calendar-grid.ts:88-98、終日→時刻順は既成立）は不変更。
- **表示分岐の完全表**（C5 BLK-1 の解消 — 「end_at なし多日 timed」は今日でも作成可能な到達状態のためフォールバック行を明記）:

| 状態 | 表示 |
|---|---|
| 終日 | 「終日」 |
| timed・selectedDate に開始・end 同日 or なし | 「14:00」（+終了あれば 2 段目「〜15:00」） |
| timed・selectedDate に開始・end 翌日以降 | 「14:00 →」 |
| timed・開始日 < selectedDate・end の JST 日 > selectedDate | 「→」（継続中） |
| timed・開始日 < selectedDate・end の JST 日 = selectedDate | 「→ 02:00」 |
| **timed・開始日 < selectedDate・end_at なし** | **「→」（継続中扱いフォールバック）** |

- **検証**: fail-red vitest — 上記**全 6 分岐**（end_at なし多日 timed 含む。現行は「14:00 引きずり」で赤）。google 行の終日/timed 両書式 assert 2 本（calendar-view.test.tsx:90 の拡張 — C5 S-2）。e2e: 終了時刻 assert + 終日→時刻順の並び assert。
- **受け入れ**: 14:00〜15:00 の予定がアジェンダで両時刻とも見え、3 日間イベントの中日に「14:00」が出なければ合格。

### CAL-3 [S] フォームを「終日｜時刻あり」セグメントに（発見性の解消）

- **対象**: `calendar-event-form-sheet.tsx:131-139` の checkbox をセグメントトグル化（segmentCn の**呼び出し側**に min-h-11 追記 — 共有 util 非接触、babycare UX-09 と同方針）。既定は「終日」維持（現行動作の互換）。
- **e2e 追従**: `e2e/calendar.spec.ts:144` の `getByRole("checkbox")` 操作の書き換えを含む（**CAL-2 の後・CAL-4 より先の直列必須** — C5 BLK-2）。
- **検証**: vitest — トグル切替で時刻入力の出現/値クリアの分岐。e2e 追従後全緑。
- **受け入れ**: フォームを開いた瞬間に「時刻あり」の選択肢が見える（チェックボックスの解読不要）。

### CAL-4 [S-M] 「今日・明日の予定」カードを /meals 冒頭に（アプリ内ウィジェット・本命）

- **対象**: `meals/page.tsx`（`calendar/page.tsx:15-23` 同型の 2 日 overlap クエリ + logSupabaseError）+ 新規 client コンポーネント。既存資産再利用: `eventsForDate`/`sortDayEvents`/`formatTimeJst`。鮮度は visibilitychange/focus refetch（`use-month-events.ts:169-179` の実証済みパターン移植、AbortController 維持）。
- **UI**: glass + rounded-2xl カード全体を Link 化（→ /calendar 該当日、44px 確保）、CalendarDays（Lucide）、transition-colors のみ。継続中イベントは CAL-2 と**同一語彙「→」**（C5 S-5）。
- **0 件時**: **クライアントコンポーネント内部で `return null`**（page 側の条件レンダリングだと 0 件時に mount されず refetch が永久停止 —「朝 0 件で開いたまま→配偶者が予定追加→復帰しても出ない」を防ぐ。C5 S-1）。
- **e2e**: **新規 `e2e/meals-upcoming.spec.ts`**（calendar.spec.ts 非接触 — C5 BLK-2 の解消。/meals 面のテストゆえ配置も自然）。
- **検証**: vitest 5 本（0 件 null / 当日・翌日振り分け / 並び順 / 継続中「→」表記 / Link 先）+ e2e 1 本（予定作成 → /meals でカード表示）。
- **受け入れ**: /meals を開いた瞬間に今日・明日の予定が時刻付きで見え、タップで /calendar の該当日に飛べば合格。

### CAL-5 [XS] manifest shortcuts（アイコン長押しメニュー）

- **対象**: `src/app/manifest.ts` に `shortcuts`（「予定を見る」→ /calendar、「買い物リスト」→ /shopping 等）。Next.js の `MetadataRoute.Manifest` は shortcuts をサポート（`node_modules/next/dist/lib/metadata/types/manifest-types.d.ts:64` 実体確認済み）。
- **制約の明示**: 体感できるのは Android のみ。**iOS のホーム画面 Web アプリでは出ない見込み**（二次情報 firt.dev 依拠のため断定しない・要実機確認。非対応環境では無視されるだけで無害 — C5 S-4）。
- **検証**: unit（manifest 生成値の assert）+ Android 実機 1 回（アイコン長押しでショートカットが出れば合格）。

---

## 2. 検証戦略

- babycare 計画 §7 と同一のゲート: `pnpm lint` / `tsc --noEmit` / `pnpm test:run` / e2e / `pnpm build` 全緑（ベースラインは各 PR 着手時に実測記録）。
- 全 PR fail-red 先行（各項に赤の根拠を明記済み）。要実機観測は 2 点のみ: iOS time input の操作感（CAL-3）と shortcuts の実機挙動（CAL-5）— いずれも合否条件付き。

## 3. 人間判断が必要な項目

| # | 判断事項 | 関連 |
|---|---|---|
| 1 | **時間設定の真意（解釈の分岐点）**: (a) 発見性 / (b) 終了時刻表示 / (c) **時刻通知（リマインド）** / (d) その他。(c) なら CAL-1〜3 でなく Push 基盤設計へ分岐 | CAL-1〜3 vs Push |
| 2 | 世帯の端末構成（iPhone / Android）— shortcuts の実効価値と実機確認先が決まる | CAL-5 |
| 3 | **babycare B-01（Critical・毎晩発生の睡眠袋小路）は未回答のまま残っている** — 本件と並行可能（交差は e2e/offline.spec.ts のみ）だが、着手順の采配は人間 | babycare 計画 |
| 4 | CAL-0（隣接バックログ）の採否 — 要望への直接回答ではないため独立判断 | CAL-0 |

## 4. 却下・保留した選択肢と理由

| 案 | 判定 | 理由 |
|---|---|---|
| PWA ホーム画面ウィジェット | **不可** | manifest widgets は Windows 11 専用（一次情報逐語確認済み）。iOS=WidgetKit native のみ、Android Chrome 未実装 |
| Flutter + home_widget | 非推奨（XL） | ios/android ターゲット不在・calendar 未移植・ネイティブ UI 実装必須。夫婦 2 人運用の対価に不釣り合い |
| Badging API | 保留 | iOS 16.4+ でも通知許可 + Push 基盤前提。現 sw.js:8 は Push スコープ外宣言。Push 導入時に再設計 |
| TIME カラム追加 / timestamptz 一本化 migration | 却下 | 既存 TIMESTAMPTZ 設計で充足。二重管理・日跨ぎ不能・終日 TZ 罠を招くだけ |
| 月ビューへの時刻テキスト表示 | 却下 | セル密度が許さない（dot 分業維持、calendar-month-view.tsx 変更ゼロ） |
| DB trigger による start_date↔start_at 整合強制 | 不採用 | native 書込は actions.ts の validate 1 経路で足りる（CAL-1）。設計判断として記録 |

## 5. ユーザー回答による確定事項（2026-07-18 追記）

- **時間設定の真意 = (a) 時刻入力が見つけにくい**（確認済み）→ **CAL-3 が価値の本命**。実行順は共有ファイル依存（CAL-2 → CAL-3 の e2e 直列）を維持しつつ、CAL-2/3 を最優先ペアに格上げ。通知（Push）解釈は否定されたためスコープ外のまま。
- **ウィジェット化 = Flutter ネイティブ本格検討**（ユーザー選択）→ CAL-4（アプリ内カード）/ CAL-5（shortcuts）は**中断なしの代替・つなぎ案として温存**（Flutter 検討の結論が出るまで着手保留）。Flutter ルートの実現計画は別文書（flutter-widget-roadmap）で策定。前回計画 §0「web 主軸は仮置き・確定は人間」の戦略設問に対する人間側の初シグナルでもある。
- **世帯端末 = iPhone / Android 混在** → Flutter ウィジェットは WidgetKit（iOS）+ Glance/RemoteViews（Android）の両対応が必須。iOS の家族配布方法（Apple Developer Program 等）が主要論点。
- **babycare B-01 = 単独先行せず**、babycare 計画の実装開始時に Wave 先頭で対応（実装開始の明示号令待ち）。

## 付録: 根拠成果物（セッション scratchpad、ephemeral）

C1-calendar-map.md / C2-widget-research.md（出典 URL 12 件）/ C3-time-design.md / C4-widget-design.md / C5-review.md（blocking 3 件 → 本計画で全解消）
