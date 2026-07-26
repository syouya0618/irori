# 育児中 UX 磨き込み + 夫婦の共有カレンダー / Google 同期 実装計画

> **For Claude:** REQUIRED SUB-SKILL: 実装時は superpowers:executing-plans を使い、タスク単位で進めること。

**Goal:** 育児中の夫婦（片手操作・細切れ時間・夜間の暗所・疲労）が使いやすく閲覧しやすい irori にするため、(A) 実在が証明されたバグを潰し、(B) 育児 UX を磨き、(C) 夫婦の共有カレンダーを新設し、(D) Google カレンダーから自動同期する。

**Architecture:** `calendar_events` を native/google 統合の単一テーブルとし、世帯 RLS で分離する。Google 同期は Supabase Auth と切り離した**独立 OAuth**（既存マジックリンクユーザーのアカウント分裂を回避）で refresh token を取得し、deny-all テーブルに保管、`syncToken` 増分ポーリングで `calendar_events` に upsert する。Realtime はクリティカルパスから外し、**楽観更新 + Server Action + refetch** を正とする（本番 Realtime 不達の issue #92 が未解決のため）。

**Tech Stack:** Next.js 16.2.9 (App Router) / React 19.2.7 / Tailwind v4 / Supabase (Auth, DB, Realtime) / Google Calendar API v3 / Vitest (node + jsdom) / Playwright (実 Supabase, モックなし) / Flutter (パリティ追従)

**調査規模:** 並列エージェント 11 体で `src/` 全域・`supabase/migrations/` 13 本・`flutter/`・テストインフラ・Google 公式仕様を実読（1.28M トークン / 536 tool calls）。設計は design → 敵対的検証 → 改訂の 3 段。**その上でなお、設計ドラフトには実機検証で覆った誤りが 3 件あった（§1）。**

---

## 0. 現状のベースライン（実測・この計画の前提）

| 項目 | 実測値 | 取得コマンド |
|---|---|---|
| ユニットテスト | **268 passed / 28 files / 2.24s** | `pnpm test:run` |
| Flutter テスト | 950 passed | `cd flutter && fvm flutter test` |
| E2E | 3 spec（実 Supabase + Mailpit、モックなし） | `pnpm e2e` |
| 既存 `REPLICA IDENTITY` | **0 件** | `grep -rn "REPLICA IDENTITY" supabase/migrations/` |
| Realtime publication | `meals`, `meal_reactions`, `shopping_items`, `stock_items`, `baby_logs` | grep |
| Google 連携 | **ゼロ**（`grep signInWithOAuth src/` → 0 件、service role は `src/` に 0 件） | grep |
| 本番 Web | 約 6/13 版（手動 `vercel --prod` 運用。main の dark mode 等が未反映） | MEMORY |
| 未解決 issue | **#92**（本番 postgres_changes 不達）、**#91**（DELETE は cross-client 反映不可） | `gh issue list` |

### ローカル検証環境の実態（**実装者への前提条件**）

`supabase start` は**ポート 54322 が別プロジェクト（inventory-hub）に占有され失敗する**:
```
Bind for 0.0.0.0:54322 failed: port is already allocated
```
E2E を伴うタスクの前に、実行者が次のいずれかを選ぶこと（**他プロジェクトのスタックを勝手に止めない**）:
- `supabase stop --project-id inventory-hub`（他の作業に影響しないと確認できる場合のみ）
- `supabase/config.toml` の db port を変更（リポジトリ変更を伴うため commit しないこと）

---

## 1. 設計ドラフトを実機検証で覆した 3 件（**この計画の核心**）

並列設計エージェントの成果物（うち calendar-feature は敵対的検証・改訂まで通過済み）に対し、独自に実機検証したところ**3 件の重大な誤り**が見つかった。実装前に潰しておく。詳細な再現手順は `docs/plans/verification-record.md` を参照。

### V1. 【致命的】PostgREST の upsert は partial unique index に効かない

**設計ドラフトの主張**: Google 行の冪等キーを部分ユニークインデックス（`... WHERE source = 'google'`）で定義し、`.upsert(rows, { onConflict: "household_id,google_calendar_id,google_event_id" })` で書く。

**検証**: 稼働中の Postgres 17 に一時テーブル + `ROLLBACK` で完全隔離して実行。

| # | index 構成 | `ON CONFLICT` の書き方 | 結果 |
|---|---|---|---|
| 1 | partial | `(cols)` のみ（**= PostgREST が出力する形**） | **`ERROR: there is no unique or exclusion constraint matching the ON CONFLICT specification`** |
| 2 | partial | `(cols) WHERE source='google'` | 成功・冪等（2 回 INSERT → 1 行） |
| 3 | 通常 UNIQUE | `(cols)` のみ | **成功・冪等**、かつ **native 行 `(uuid, NULL, NULL)` は 2 行共存**（NULLS DISTINCT が既定） |

PostgREST の `on_conflict` パラメータは**列名しか出力できず**、PostgreSQL は partial index の推論に `index_predicate` を要求する。**このまま実装すれば、同期エンジンの upsert は本番で 100% 失敗し、Google 予定が 1 件も入らなかった。**

**訂正（採用する形）**:
```sql
-- 通常 UNIQUE（NULLS DISTINCT 既定により native 行は (NULL, NULL) で無限に共存できる）
CREATE UNIQUE INDEX idx_calendar_events_google_unique
  ON calendar_events(household_id, google_calendar_id, google_event_id);

-- native 行が google 列を持たないことを DB で強制 → 通常 UNIQUE が partial と同義になる
CONSTRAINT chk_calendar_native_no_google CHECK (
  source = 'google' OR (google_event_id IS NULL AND google_calendar_id IS NULL)
)
```

### V2. 【重大】`REPLICA IDENTITY FULL` は DELETE 配信を解決しない

**設計ドラフトの主張**（敵対的検証を通過してなお残っていた）: 「`REPLICA IDENTITY FULL` にすれば `household_id` フィルタ付き購読へ DELETE が配信される」。

**一次情報**（Supabase 公式 docs `realtime/postgres-changes` を WebFetch）:
> **"You can't filter Delete events when tracking Postgres Changes."**
>
> "RLS policies are not applied to `DELETE` statements, because there is no way for Postgres to verify that a user has access to a deleted record."
>
> "When RLS is enabled and `replica identity` is set to `full` on a table, the `old` record contains only the primary key(s)."

**二重に誤り**: (a) DELETE はそもそもフィルタ不可、(b) RLS 有効下では old は PK のみ。本リポジトリの **issue #91 の結論が正しい**。

**訂正**: migration から `ALTER TABLE calendar_events REPLICA IDENTITY FULL` を**削除**する（WAL 量を増やすだけで何も買えない）。DELETE の反映は次の 3 段で担保する:
1. **自分の削除** → 楽観更新で即時反映。
2. **配偶者の削除** → `visibilitychange` / `focus` での refetch（自己回復。issue #92 への対策も兼ねる）。
3. **同期エンジンの削除** → **Realtime を使わない**（下の V7 参照）。`maybeScheduleSync()` が「同期を仕掛けたか」の boolean を返し、Server Component から client へ `syncScheduled` を渡す。true なら client が `last_synced_at` を Server Action で 1〜3 回だけ短間隔ポーリングし、前進したら events を refetch する。
   （**削除のみの同期サイクルでは `calendar_events` に INSERT/UPDATE が起きない**ため、この経路が必須）
4. 将来: 論理削除（`deleted_at`）化すれば DELETE が UPDATE になりフィルタ可・RLS 適用可（issue #91 が「最有力」と記す）。本計画ではスコープ外。

### V6. 【致命的・実機検証済み】google 行の CHECK が不完全で重複が積もる

当初の CHECK は `source = 'native' OR google_event_id IS NOT NULL` だった。これは **google 行で `google_calendar_id IS NULL` を許す**。UNIQUE index は NULLS DISTINCT 既定（V1 の実験 #3 で実証）ゆえ、その行は一意化されず `.upsert()` が ON CONFLICT を推論できずに INSERT へ落ちる。

**実機検証**（一時テーブル + ROLLBACK）:

| CHECK | google 行を 2 回 upsert（同期 2 巡） | 結果 |
|---|---|---|
| 不完全版（`google_event_id IS NOT NULL` のみ）+ `calendar_id=NULL` | `INSERT 0 1` × 2 | **2 行に増殖**（`v1,v2`） |
| 是正版（両方 NOT NULL）+ `calendar_id=NULL` | — | `ERROR: violates check constraint "chk_google_meta"`（DB が弾く） |
| 是正版 + 正しい `calendar_id` | `INSERT 0 1` × 2 | **1 行に収斂**（`v2`） |

**訂正**: `source = 'native' OR (google_event_id IS NOT NULL AND google_calendar_id IS NOT NULL)`。負の回帰テストを §6 C-2 の RLS SQL に同梱する。

> V1 の抜け穴は native 側ではなく **google 側**にあった。「native 行が (NULL, NULL) である限り成立する」という当初の推論は、google 行の側を検査していなかった。

### V7. 【重大】「同期完了シグナル」を publication に載せてはならない

当初案は `google_calendar_subscriptions` を Realtime publication に追加し、その UPDATE を同期完了シグナルとして購読するものだった。**三重に悪い**:

1. **秘密を wire に載せる**: 同テーブルは `sync_token` / `sync_lease_until` を持つ。列 REVOKE と walrus の列フィルタに賭けることになるが、**§0 のポート衝突でローカル stack が起動しない以上、これを実機検証できない**。検証できない安全性の主張はしない。
2. **計画の自己矛盾**: §7 D-2 の表は `google_connections` を「非機密」と自ら定義している。載せるならそちらであって、秘密を持つ subscriptions ではない。
3. **より深い矛盾**: §3 で「Realtime は #92 未解決ゆえクリティカルパスから外す」と宣言しながら、Google 削除の可視化**だけ**を Realtime に依存させていた。既知の壊れた土台の上に建てている。

**訂正（publication を 1 つも増やさない）**: `maybeScheduleSync()` の戻り値 `syncScheduled: boolean` を client へ渡し、true のときだけ `last_synced_at` を Server Action で 1〜3 回短間隔ポーリング → 前進したら refetch。**Realtime ゼロ・秘密の露出ゼロ・#92 と無関係に動く。**

### V8. 【致命的・実機検証済み】cron route は `proxy.ts` に食われてハンドラに到達しない

`src/proxy.ts` の matcher は **`/api/` を除外していない**:
```
matcher: ["/((?!_next/static|_next/image|favicon.ico|icons/|manifest\\.webmanifest|sw\\.js|offline$|.*\\.(?:svg|png|...)$).*)"]
```
そして `isPublicRoute = pathname === "/login" || pathname.startsWith("/auth/callback")`。

Vercel Cron は **cookie 無しの GET** を送る（`~/.claude/rules/nextjs-supabase.md`: 「Vercel Cron は GET を送信」）。よって `/api/cron/google-sync` は未認証と判定され **`/login` へ 307** され、**同期は一度も走らない**。

さらに §D-6 の認可テストは「Route Handler を**直接 import**」＝ proxy を通らない。→ **テストは緑、本番は 100% 不発。** これはグローバル規約が名指しする「テスト974緑のまま本番サーバ100%失敗が潜伏」と完全に同型。

> 既存 API route は `src/app/api/baby-report/route.ts` のみで、これは `getAuthContext()` によるセッション認証（cookie あり）ゆえ proxy を通過できる。**前例にならない。**

**訂正（D-5 に不可分で同梱。分割禁止）**:
1. `proxy.ts` の `isPublicRoute` に `/api/cron/` を追加（理由コメント必須）
2. ハンドラで `CRON_SECRET` 未設定 → **401 fail-closed**（`if (!secret) return 401`）
3. `timingSafeEqual` は**長さ不一致で throw する** → 長さを先に比較して短絡評価する
4. **GET ハンドラ**を定義する（Vercel Cron は GET。POST のみは 405）
5. **proxy を通す検証**を最低 1 本（dev サーバへ `fetch(url, { redirect: "manual" })` し、**307 が返らないこと** / secret 無しで 401 / 有りで 200）

> 「proxy を外すだけ」の PR と「secret 検証」の PR に割ってはならない。片方だけ入ると **cron が無認証で開く。**

### V9. 【データ消失シェイプ】世帯内で同一 Google カレンダーを二重購読すると片方の解除で予定が消える

`calendar_events` の UNIQUE キーは household スコープ、しかし `subscription_id` は `ON DELETE CASCADE`。夫婦が**同じ共有カレンダー**を各自トグル ON にすると、`connection_id` は別だが `(household_id, google_calendar_id, google_event_id)` が同一のため **1 行に収斂**し、`subscription_id` は last-writer のものになる。

片方が購読を解除 → CASCADE で **もう片方の予定も消える**。増分同期は `syncToken` を持つため、**410 か再連携まで永久に復活しない。**

さらに **`is_selected = false` にした時のミラー掃除が計画に無い**（購読を外しても予定が残り続ける）。

**訂正**:
- `subscription_id` を **`ON DELETE SET NULL`** にする。
- 購読解除（`is_selected=false` or 接続削除）時は、**他に同一 `google_calendar_id` を選択中の購読が無い場合にのみ** `google_calendar_id` で明示 DELETE する。
- この掃除ロジックを Server Action に置き、ユニットテストで「二重購読中は消えない / 最後の購読が外れたら消える」を固定する。

### V3. 【前提の誤り】`stock-form.ts` の `Number(...) || 1` はバグではなく契約

**設計ドラフトの主張**: 「意図と乖離した falsy バグゆえ置換可」。

**実ファイル** `src/lib/domain/stock-form.ts:18`:
```
 * - quantity: Number() で変換し、falsy (欠落 / "" / "0" / NaN) は 1 に倒す
```
**ピン止めテスト** `src/lib/domain/__tests__/stock-form.test.ts`:
```ts
['"0" (falsy 衝突)', "0", 1],   // ← テストが「falsy 衝突」と明示ラベルして意図的に固定
["非数値 (NaN)", "abc", 1],     // ← NaN 防御を兼ねる
["負数", "-2", -2],             // ← 負数は素通り
```
**導入意図の追跡**（グローバル規約: 防御コード削除前の必須手順）:
```
$ git log -S 'Number(formData.get("quantity")) || 1' --oneline
b4444d1 refactor(stock): actions のロジックを lib へ抽出 (挙動不変、export 面不変) (R4) (#27)
a722980 refactor: Phase 1.5 コードレビュー指摘を反映
2bac600 feat: Phase 1.5 在庫管理 + レシピ提案機能を実装
```
**DB** `supabase/migrations/20260406000001_initial_schema.sql`: `quantity NUMERIC NOT NULL DEFAULT 1`（**CHECK なし**）。

**訂正**: これは契約であり、**真の穴は負数素通り**。「0 許容」は仕様変更 PR（ピン止めテストとドキュメントコメントを同時更新）、「負数拒否 + DB `CHECK (quantity >= 0)`」は別 PR に分離する。バグ修正として扱わない。

### V4. 設計間の統合矛盾（並列設計の副作用）

calendar-feature と gcal-sync が**独立に同じ `calendar_events` を、別スキーマで、同じ migration 連番で**定義していた。

| 項目 | calendar-feature | gcal-sync | **採用** |
|---|---|---|---|
| 位置づけ | native + google 統合の単一テーブル | google 読み取り専用ミラー | **統合単一テーブル** |
| 終日列 | `is_all_day` | `all_day` | `is_all_day` |
| `source` 列 | あり（`native`/`google`） | なし | **あり** |
| google 連結 | `google_calendar_id`, `google_event_id`, `etag`, `ical_uid` | `subscription_id` FK, `source_user_id` FK | **両方**（後者は §5 の ALTER で追加） |
| 冪等キー | partial unique（**V1 で棄却**） | `(subscription_id, google_event_id)` | **通常 UNIQUE + CHECK**（V1） |
| RLS | 4 分離（SELECT 両方 / IUD は native 限定） | SELECT のみ | **4 分離** |
| migration | `20260708000001_calendar_events.sql` | `20260708000001_...`（**連番衝突**） | `...0001` / `...0002` に分離 |

その他:
- `jstWallClockToIso` を calendar-feature と ux-prs PR-4 が**両方「新規追加」**しようとしている → **Phase B の PR-4 が先に追加**し、Phase C は依存する（§7 の実装順）。
- gcal-sync の `maybeScheduleSync` は「service role を描画経路で使わない」と自ら宣言しながら、**render 中に `createAdminClient()` を呼ぶ**（自己矛盾）。
  → **訂正**: staleness は authenticated client で `google_connections`（household RLS で SELECT 可・非機密）から読み、admin client は `after()` の内側でのみ生成する。
- gcal-sync の 410 フル再同期は `delete().eq("subscription_id", ...)` → 統合テーブルでは防御的に `.eq("source", "google")` も付ける。

### V5. 記憶ではなく実機で確認した事実（設計ドラフトが正しかった点）

| 主張 | 検証 | 結果 |
|---|---|---|
| `after` は `next/server` から export される | `grep -n after node_modules/next/server.d.ts` | `21:export { after } from 'next/dist/server/after'` ✅ |
| `getAppOrigin(request?)` のシグネチャ | 実ファイル | 一致 ✅ |
| `logSupabaseError(scope, summary, error: PostgrestError, ctx?)` | 実ファイル | 一致 ✅（`error!` の非 null 断言を避ける設計が正しい） |
| syncToken と併用不可のパラメータ | Google 公式 events.list リファレンス | `iCalUID`/`orderBy`/`privateExtendedProperty`/`q`/`sharedExtendedProperty`/`timeMin`/`timeMax`/`updatedMin` ✅ |

---

## 2. 全体構成とフェーズ

```
マイルストーン 1（既存の傷を治す — ユーザー行動待ちゼロ）
  Phase A  バグ潰し（実在＋到達性が証明されたもののみ）  … §4
  Phase B  育児 UX 磨き込み                              … §5
  PR-0     jstWallClockToIso（純関数 + テスト・極小 PR）  … 下記

マイルストーン 2（新機能 — GCP 公開というユーザー行動待ちを含む）
  Phase C  夫婦の共有カレンダー（アプリ内ネイティブ）    … §6
  Phase D  Google カレンダー自動同期                     … §7

独立トラック（どのフェーズもブロックしない）
  Phase 0  #92 診断の観測対象を一致させる                 … §3
```

> **マイルストーンを分ける理由**（S7）: A/B は既存の傷の治療で、今すぐ出荷できる。C/D は新機能で、**GCP 同意画面の In production 公開というユーザーの手作業**を待つ。1 マイルストーンに束ねると、治療の出荷が新機能の待ちに人質に取られる。

**依存関係**:
- Phase A / B は独立、並行可（ただし B-1 と B-2 は同一ファイルを触るため逐次。A-4 → A-8、A-3 → A-6 → A-7 も同様）。
- **PR-0（`jstWallClockToIso` 単独 PR）**: 純関数 + node テストのみ。**B-4 と C-2 の双方がこれに依存する。**
  当初は「C-2 が B-4 に依存する」としていたが、**UX PR のレビューが機能 PR を人質に取るのは不健全**。極小 PR に切り出す。
- Phase D は Phase C（`calendar_events` テーブル）に依存。
- Phase 0 は**どのフェーズもブロックしない**（advisor 裁定: Realtime をクリティカルパスから外す）。

---

## 3. Phase 0: #92 診断の前提を整える（**advisor 裁定により非ブロッキング**）

**当初案の誤り**: 「カレンダーは Realtime 前提だから #92 を先に直す」→ advisor に棄却された。理由:
1. **本番 Web は約 6/13 版であり、Realtime 可観測化（`095842c` #95）は main にしか無い。未デプロイのビルドに WS フレーム観測を当てても計測対象が違う。**
2. Supabase support という**外部依存を工程の直列に置くな**。夫婦 2 人のカレンダーに Realtime は必須でない。

**よってこの計画では**:
- カレンダーは **楽観更新 + Server Action + refetch** で設計する（Realtime は enhancement）。#92 が未解決でも機能する。
- `shopping`/`stock` の楽観更新欠如は **#92 の帰趨に関わらず直す**（Phase A-5）。

**#92 診断を進めるなら**（本計画とは独立に実行可能）:
1. **先に `vercel --prod` で main をデプロイし、観測対象を一致させる。**
2. WS フレーム観測より**安い仮説を先に潰す**: 本番の `NEXT_PUBLIC_SUPABASE_ANON_KEY` の prefix を確認（legacy `eyJ...` か新形式 `sb_publishable_...` か）。1 コマンドで済む。
3. それでも不明なら、prod URL + prod anon key に対して DevTools → Network → WS → Messages でフレームを目視。

---

## 4. Phase A: バグ潰し（PR 群）

各 PR は **red → green** を強制する（advisor 指定: 「必ず検証できる手段で検証」への最短の答え）。すなわち **先に落ちるテストを書き、落ちることを確認してから**修正する。

> 詳細な TDD 手順・落ちるテストのコード全文・修正 diff は `docs/plans/phase-a-bugfix.md` を参照（本ファイルは PR 分割と根拠のみ）。

### ⚠️ 自動スイープのラベルを到達性で検証し直した（**筆頭 high が死コードだった**）

| スイープの主張 | 検証コマンド | 結果 |
|---|---|---|
| `[high]` 外食記録のデータ消失 | `grep -rn "EatingOutForm\|eating-out-form" src/` | **import 元ゼロ = 死コード。実行経路なし** → **latent へ降格** |
| `[high]` 授乳タイマーの `isSaving` 永久 true | `grep -rn "FeedingTimer" src/` | `baby-dashboard.tsx:11,275` で使用 → **到達可能。真の筆頭** |
| 「間食」が週ビューに出ない | `meal-form-sheet.tsx:222` が `MEAL_TYPES`(4種) を map / `meal-day-row.tsx:10` は 3 種のみ / `initial_schema.sql:134` に `UNIQUE(household_id,date,meal_type)` | **到達可能。ユーザーが詰む** → **high へ昇格** |
| `+09:00` 欠如 | `grep -rn 'T00:00:00' src/` | **2 箇所**（`low-stock.ts:40`, `stock/actions.ts:205`）。他 6 箇所は正しく `+09:00` 付き |

### PR 一覧（到達性で並べ替え済み）

| PR | 関心事 | 到達性 | 深刻度 | 主なファイル |
|---|---|---|---|---|
| **A-1** | server action の裸 `await` で**永久ローディング**（通信断でボタンが永久 disabled）。**4 箇所**: 授乳タイマー / setup / 世帯参加 / 招待受諾。後ろ 2 つは**夫婦のオンボーディングが詰む** | ✅ | **high** | `feeding-timer.tsx`, `setup-form.tsx`, `join-by-invite-form.tsx`, `invite-accept-form.tsx` |
| **A-2** | 「間食」が保存できるが**どこにも表示されず**、再登録が `23505` で詰む（削除手段なし） | ✅ | **high** | `meal-types.ts`, `meal-day-row.tsx`, `meal-form-sheet.tsx` |
| **A-3** | 消費レート算出の週窓が **9 時間ズレる**（`+09:00` 欠如・2 箇所） | ✅ | medium | `low-stock.ts:40`, `stock/actions.ts:205` |
| **A-4** | 楽観削除のロールバック欠如（UI から消えたまま DB に残存） | ✅ | medium | `shopping-item.tsx`, `stock-item.tsx` |
| **A-5** | 週送り連打の**応答順逆転 race**（別週のデータが表示中の週に載る） | ✅ | medium | `use-week-meals.ts` |
| **A-6a** | **meals ドメイン**の握り潰し + 偽の空状態（`meals/page.tsx` の空週 fallback、`getTemplates` の `error:null`、`saveAsTemplate` の空 ingredients 無音生成） | ✅ | medium | `meals/page.tsx`, `meals/actions.ts` |
| **A-6b** | **shopping/stock ドメイン**の握り潰し（`shopping/actions.ts:90` の空 catch、`low-stock.ts:53` の 4 クエリ無ログ） | ✅ | medium | `shopping/actions.ts`, `low-stock.ts` |
| **A-6c** | **baby ドメイン**の握り潰し + 偽の空状態（`baby-dashboard.tsx:176` の `.then(({data}))`、`baby/page.tsx` の空ダッシュボード） | ✅ | medium | `baby-dashboard.tsx`, `baby/page.tsx` |
| **A-8** | shopping/stock の追加・編集を楽観更新化（**自分の操作すら画面に出ない**） | ✅ | medium | `shopping-list.tsx`, `stock-list.tsx` |
| **A-9** | web 週間サマリーのエラー時に**全ゼロのグラフを黙って表示**（#99 の web 版） | ✅ | medium | `baby/weekly-summary/` |
| **A-10** | eating-out の**潜在**データ消失 + `uploadPhoto` の所有権/MIME 未検証 | ⚠️ **死コード** | latent | `eating-out-actions.ts` |

> **A-6 を 3 分割した理由**（S7。旧 A-6d=setup は同一 defect class ゆえ A-1 に統合）: 当初の「エラー握り潰しの一掃」は 5 ファイル・4 ドメイン横断の**雑巾がけであって関心事ではない**。A-8 と `low-stock.ts` を、A-7 と `meals/page.tsx` / `baby/page.tsx` を重複して触り、コンフリクトとレビュー発散を自作していた。ドメイン単位に割り、「偽の空状態」は各ドメインの握り潰し修正に**吸収**する（error 伝播と UI 表示は同じ関心事）。

**A-10 は方針の判断が要る**（§10-6）: (a) 死コードのまま欠陥だけ塞ぐ【推奨】/ (b) 塞いで配線する / (c) 削除する。

### 触ってはならない防御コード（誤削除の回避）

- `use-week-meals.ts:48,136` の `new Date(ymd + "T00:00:00")` は**意図的な UTC 罠回避**（`new Date("2026-07-08")` は UTC 解釈、`"...T00:00:00"` はローカル解釈）。コメントで明記。**A-3 の grep 一掃から除外する。**
- `use-week-meals.ts` の `else` 分岐（真値が取れない時に temp 楽観行のみ除去し確定 id 行は残す）はコメント付きの防御。**A-5 の修正で潰さない。**

**スコープ外に切り出すもの**（過剰修正でスコープを膨らませない）:
- `stock-form.ts` の quantity 契約変更（**V3**。「0 許容」＝仕様変更 PR、「負数拒否 + DB CHECK」＝別 PR）
- `ui/` プリミティブ 4 ファイルの `transition-all`（focus ring / translate-y アニメを壊す恐れ。`transition-[color,box-shadow,transform]` の限定列挙に置換して挙動を検証する専用 PR）
- `autoAddToStock` の read-modify-write TOCTOU、`sort_order` の TOCTOU（実害小、別 issue）
- `EatingOutForm` の配線（A-10 (a) の後に別 PR。`eating-out-photos` の public 読み取り見直しを同梱）

---

## 5. Phase B: 育児中 UX 磨き込み（PR 群）

**インパクト（育児中 UX への効き）と実装順（依存・リスク）を分離**する。核心の破綻（日付跨ぎ睡眠）はインパクト最上位だが、リスクゼロで夜間毎日効く dark: / 44px を先に出荷する。

| PR | 関心事 | インパクト | 実装順 | 工数 | Flutter 波及 |
|---|---|---|---|---|---|
| **B-1** | dark: 変種補完（**挙動保存・追加のみ**） | 高（夜間授乳が主要シーン） | 1 | S | なし |
| **B-2** | 44px タッチターゲット + **機械検証** | 高（片手誤タップ） | 2 | S | なし |
| **B-3** | **日付跨ぎサマリー救済**（アクティブ睡眠 + 最終授乳） | **最高（唯一の整合バグ・毎晩詰む）** | 3 | M | **あり（同罪）** |
| **B-4** | baby ログの時刻編集（`logged_at`）+ 過去日追記 | 高（記録アプリの生命線） | 4 | M | あり |
| **B-5** | baby クイックアクションの楽観更新 | 高（1 日 10 回超の最頻操作） | 5 | M | あり |
| **B-6** | `stock` / `settings` に `loading.tsx` | 中 | 並行可 | S | なし |
| **B-7** | safe-area 修正（nav 余白 / sheet / notch） | 中 | 並行可 | S | なし |
| **B-8** | manifest（`start_url` / bg / maskable / shortcuts） | 中 | 並行可 | S | なし |
| **B-9** | meals 週ビューで今日へ自動スクロール | 中 | 並行可 | S | なし |
| **B-10** | 授乳タイマーの swipe-dismiss を非破棄化 | 中 | B-5 後 | S | 要確認 |

### B-3 が最優先の理由（唯一のデータ整合バグ）

21 時「ねんね」→ 翌朝、昨日 `logged_at` のアクティブ睡眠が**今日のログに無い**ため「起きてる」と誤表示され、トグルが「ねんね」になる。押すと `idx_one_active_sleep` の unique 制約違反（`23505`）で**詰む**。**UI から終了する手段がゼロ**で、ユーザーは記録を削除するしかない。理論上**毎晩発生しうる**。

**実装上の地雷**（advisor 指摘・必須）: サーバ取得のアクティブ睡眠を**静的 prop で渡すと起床後に stale 化する**（昨日開始の睡眠は今日の `logs` に無いため、`endSleep` しても Realtime UPDATE ハンドラが `no-op` になり「睡眠中」が残る）。→ **cross-day アクティブ睡眠は state で保持し（prop で初期化）、`endSleep` 成功時に楽観クリア + id で照合**する。

### B-1 の分割（advisor 裁定）

「dark: 補完（挙動保存・grep で検証可能）」と「`categories.ts` 等への一元マップ化（リファクタ）」は**別 PR**。B-1 は追加のみ。

**dark: の正準マッピング**（既存 `baby-timeline-item.tsx` L26-31 等から抽出。独自色を持ち込まない）:

| light | 追加する dark: | 用途 |
|---|---|---|
| `bg-{c}-100` | `dark:bg-{c}-900/40` | 塗りバッジ |
| `text-{c}-700` | `dark:text-{c}-300` | バッジ文字 |
| `bg-{c}-50` | `dark:bg-{c}-900/30` | 淡い面 |
| `bg-gray-100` | `dark:bg-gray-800` | ニュートラル面 |

### B-2 の機械検証（**わっちの当初案は不健全だったので差し替えた**）

当初案「interactive 要素の `h-8|w-8|size-8` を grep 禁止」は**偽陰性と偽陽性の両方を持つ**:
- **偽陰性**: 実際の違反は呼び出し側の `<Button size="icon-sm">` であり、`size-7`/`size-6` は `button.tsx` 内にしか無い（call-site grep で捕まらない）。
- **偽陽性**: `size-8` は `baby-summary-bar` 等の**装飾アイコン円**で正当使用されている。

**差し替え後（健全）**:
1. **本命ゲート**: Playwright モバイル（360×780）で `button, a, [role=button]` を走査し `boundingBox().height >= 44` を `expect.soft` で assert（`e2e/touch-targets.spec.ts`）。
2. **CI 回帰ロック（スタック不要）**: jsdom で対象コンポーネントを render → `className` が `/size-11|min-h-11/` を含むことを assert（twMerge の後勝ちが生き残ったかを検証）。

**既知の例外（文書化する）**: `meal-reactions` は 3-up 週グリッド内で幅 44px が物理的に不可能（360px 端末で 1 カード ≈106px ÷ 3 ≈ 35px）。**高さのみ 44px を保証**し、boundingBox 検証から幅チェックを除外する。真の 44×44 はリアクションをカード外へ出す再設計が要り、本 PR の非目標。

### B-8 の既知の制約（**約束できないことを約束しない**）

- `background_color` は**テーマ非依存の単一静的値**。manifest にメディアクエリは無く、「ダークスプラッシュ」は約束できない。純白の夜間フラッシュを緩和する暖色ニュートラル（`#faf9f7`）に留める。
- `start_url: '/'` は**既存インストール済み PWA には再インストールまで反映されない** + redirect 1 hop の起動遅延。実機で体感速度を確認すること。
- `maskable` は**セーフゾーン付きアセット**が前提。現行 512px 画像が余白不足なら安全域外がクロップされる。**アセット未用意なら `purpose: "maskable"` の追加を保留**し、アセット作成を別 issue 化する。

### 検討事項（採否提案）

| # | 案 | 判定 |
|---|---|---|
| a | ドメイン横断「今日」ダッシュボード | **Phase C 以降へ延期**（L 工数・影響大。Phase B の「安く効く」方針から外れる） |
| b | 週ビュー左右スワイプ | **採用（別 PR）**。ただし `fetchMeals` の応答順逆転ガード（A-4）を**前提**とする |
| c | 在庫 +1/-1 ステッパー + `quantity=0` 許容 | **採用（別 PR）**。**V3 により「仕様変更」として扱い**、ピン止めテストとコメントを同時更新 |
| d | viewport `userScalable` 解禁 | **採用だが単純なフラグ反転は不可**。`text-sm`(14px) の入力が残ると iOS が暴発ズームする。「全 `<Input>`/`<Textarea>` を ≥16px に監査 → 解禁 → 実機 iOS 確認」を 1 関心事として別 PR |

---

## 6. Phase C: 夫婦の共有カレンダー（アプリ内ネイティブ）

### C-0. BottomNav: 6 タブ化を採用

現状 5 タブ（献立/買い物/在庫/育児/設定）。`予定`(CalendarDays) を「育児」と「設定」の間に挿入する。

| 案 | 長所 | 短所 | 判定 |
|---|---|---|---|
| 既存タブへ統合 | タブ数据え置き | 夫婦の共有カレンダーという **first-class な共有機能**が 2 タップ以上に沈む。献立（食事計画）との同居は意味論が別で認知負荷増 | ✗ |
| **6 タブ化** | 既存 0〜3 番の位置が不変＝**毎日使うアプリの筋肉記憶を壊さない**。設定のみ 4→5 へ後退（低頻度） | 375px 端末で 1 タブ幅 ≈62px | **✓** |

**密度リスクの明示**: 62×44px は最小タッチ基準を満たすが、6 タブ化は密度が上がり、疲れた親の暗所・片手操作では誤タップ率が上がりうる。**「日セルタップ＝アジェンダ更新のみ（Sheet を開かない）」**という誤操作コストの低いタップモデルで緩和する。実運用で問題化したら「予定を設定オーバーフローへ退避」を fallback として残す。

ラベルは折り返し回避のため「カレンダー」(5字) ではなく **「予定」(2字)**（他タブ 2〜3 字と揃う）。

**footgun**: Flutter 側は `router.dart` の branches 順・`AppShell.kSettingsBranchIndex`・`destinations` の **3 箇所同期**が必要（コード内コメントで相互参照が明記されている）。

### C-1. DB マイグレーション

`supabase/migrations/20260708000001_calendar_events.sql`

**設計判断**:
- **JST 非正規化 DATE バケット**: `start_date`/`end_date`（DATE, NOT NULL, JST 暦日, **包含的**）を常に持たせ、月グリッド範囲クエリを `AT TIME ZONE` 演算なしの単純 DATE 比較で済ませる（既存 `meals.date DATE` と同じ思想。TZ 罠を DB から排除）。
- 時刻付きは `start_at`/`end_at`（TIMESTAMPTZ, nullable）に厳密な瞬間を持つ。
- `start_date ↔ start_at` の整合は**書き込み側が所有**（`AT TIME ZONE` は STABLE ゆえ CHECK 化できない）。この不変条件は node テストで固定する。
- **RLS の mutation を `source='native'` にスコープ**: UI だけでなく DB 層で「Google 行はユーザーが書き換え不可」を強制。SELECT は両 source 可、INSERT/UPDATE/DELETE は native 限定。これで 4 分離 RLS が実効的に異なる。
- **`REPLICA IDENTITY FULL` は付けない**（**V2**）。
- **冪等キーは通常 UNIQUE + CHECK**（**V1**）。

```sql
-- ============================================================
-- 夫婦の共有カレンダー: calendar_events
-- 設計: 単一テーブル / JST 非正規化 DATE バケット + 時刻付きは TIMESTAMPTZ
--       source(native/google) で mutation を RLS スコープ
-- ============================================================
CREATE TABLE calendar_events (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id       UUID NOT NULL REFERENCES households(id) ON DELETE CASCADE,

  title              TEXT NOT NULL,
  memo               TEXT,

  is_all_day         BOOLEAN NOT NULL DEFAULT true,
  start_date         DATE NOT NULL,               -- JST 暦日（バケット）
  end_date           DATE NOT NULL,               -- JST 暦日（包含的）
  start_at           TIMESTAMPTZ,                 -- 時刻付きのみ
  end_at             TIMESTAMPTZ,

  source             TEXT NOT NULL DEFAULT 'native'
                       CHECK (source IN ('native', 'google')),

  -- Google 同期メタ（native 行では NULL。Phase D で subscription_id 等を ALTER 追加）
  google_event_id    TEXT,
  google_calendar_id TEXT,
  etag               TEXT,
  ical_uid           TEXT,

  created_by         UUID REFERENCES profiles(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT chk_calendar_title CHECK (char_length(btrim(title)) BETWEEN 1 AND 200),
  CONSTRAINT chk_calendar_memo CHECK (memo IS NULL OR char_length(memo) <= 1000),
  CONSTRAINT chk_calendar_date_order CHECK (end_date >= start_date),
  CONSTRAINT chk_calendar_all_day CHECK (
    (is_all_day AND start_at IS NULL AND end_at IS NULL)
    OR (NOT is_all_day AND start_at IS NOT NULL)
  ),
  CONSTRAINT chk_calendar_time_order CHECK (
    end_at IS NULL OR (start_at IS NOT NULL AND end_at >= start_at)
  ),
  -- V6（実機検証済み）: google 行は google_event_id **と google_calendar_id の両方**が
  -- NOT NULL でなければならない。片方でも NULL だと UNIQUE index は NULLS DISTINCT
  -- 既定によりその行を一意化せず、.upsert() が ON CONFLICT を推論できずに INSERT へ落ちて
  -- 同期のたび重複が積もる（実測: 2 回 upsert → 2 行）。
  CONSTRAINT chk_calendar_google_meta CHECK (
    source = 'native'
    OR (google_event_id IS NOT NULL AND google_calendar_id IS NOT NULL)
  ),
  -- V1: native 行が google 列を持たないことを強制 →
  --     通常 UNIQUE インデックスが partial index と同義になる
  CONSTRAINT chk_calendar_native_no_google CHECK (
    source = 'google' OR (google_event_id IS NULL AND google_calendar_id IS NULL)
  )
);

CREATE INDEX idx_calendar_events_household_range
  ON calendar_events(household_id, start_date, end_date);

-- V1（実機検証済み）: PostgREST の on_conflict は列名しか出力できず、
-- PostgreSQL は partial index の推論に index_predicate を要求するため、
-- partial unique index に対する .upsert() は 42P10 で失敗する。
-- 通常 UNIQUE なら NULLS DISTINCT 既定により native 行 (NULL, NULL) は
-- 無限に共存でき、google 行だけが一意化される。
CREATE UNIQUE INDEX idx_calendar_events_google_unique
  ON calendar_events(household_id, google_calendar_id, google_event_id);

-- RLS: SELECT / INSERT / UPDATE / DELETE 分離（FOR ALL 禁止）
-- SELECT は native / google 両方を閲覧可。IUD は source='native' 限定。
-- google 行は同期エンジンが service_role（RLS バイパス）でのみ書く。
-- UPDATE の WITH CHECK は省略 = Postgres は USING を流用するため、
-- 新行も source='native' かつ自世帯に拘束され、google 化・世帯移動は不可。
ALTER TABLE calendar_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "calendar_events_select" ON calendar_events
  FOR SELECT USING (household_id = get_my_household_id());

CREATE POLICY "calendar_events_insert" ON calendar_events
  FOR INSERT WITH CHECK (household_id = get_my_household_id() AND source = 'native');

CREATE POLICY "calendar_events_update" ON calendar_events
  FOR UPDATE USING (household_id = get_my_household_id() AND source = 'native');

CREATE POLICY "calendar_events_delete" ON calendar_events
  FOR DELETE USING (household_id = get_my_household_id() AND source = 'native');

CREATE TRIGGER trg_calendar_events_updated_at
  BEFORE UPDATE ON calendar_events
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- V2: REPLICA IDENTITY FULL は付けない。
--     Supabase docs: "You can't filter Delete events when tracking Postgres Changes."
--     "When RLS is enabled and replica identity is set to full, the old record
--      contains only the primary key(s)."
--     → DELETE の反映は楽観更新 + visibilitychange refetch で担保する（issue #91）。
ALTER PUBLICATION supabase_realtime ADD TABLE calendar_events;
```

**`src/lib/types/database.ts`** は手書き管理のため、**同一 PR で型を追記する**（忘れると静かに乖離する。現に `default_page` の union 落ちが存在）。

### C-2. RLS の検証（**service_role では証明できない性質を証明する**）

敵対的検証の指摘: `e2e/fixtures/auth.ts` が公開するのは `adminClient()`（service_role）のみで、**RLS を丸ごとバイパスするため「native 許可 / google 拒否」を区別できない**。素の anon client も `get_my_household_id()=NULL` で両者を一律全弾きし、やはり区別できない。

→ **`authenticated` ロール + JWT claims 注入の SQL** で検証する（`supabase/tests/calendar_events_rls.sql`、本 PR で新設）。PKCE/magiclink のログイン経路を回避しつつ `get_my_household_id()` を実際に通す。

**⚠️ 素朴な `BEGIN; ... ROLLBACK;` は動かない（実機で確認済み）**: 否定ケースが例外を投げた瞬間にトランザクションが aborted になり、後続は `current transaction is aborted, commands ignored until end of transaction block` で**実行すらされない**。

```
$ psql -c "BEGIN; INSERT ...(例外); UPDATE ...; SELECT ...; ROLLBACK;"
ERROR:  invalid input syntax ...
ERROR:  current transaction is aborted, commands ignored until end of transaction block   ← UPDATE
ERROR:  current transaction is aborted, commands ignored until end of transaction block   ← SELECT
```

→ **否定ケースは `SAVEPOINT` / `ROLLBACK TO` で包む**（または pgTAP の `throws_ok` を使う）:

```sql
BEGIN;
-- service_role で seed: households(:H), profiles(:U, household_id=:H), calendar_events(:G, source='google')

SET LOCAL role authenticated;
SELECT set_config('request.jwt.claims',
  json_build_object('sub', :'U', 'role', 'authenticated')::text, true);

-- (a) native CRUD は成功する
INSERT INTO calendar_events (household_id, title, is_all_day, start_date, end_date, source)
  VALUES (:'H', 'native ok', true, '2026-07-08', '2026-07-08', 'native');

-- (b) source='google' の INSERT は WITH CHECK 違反で失敗する
--     SAVEPOINT で包まないと、以降の (c)(d) が aborted で実行されない
SAVEPOINT sp_google_insert;
DO $$ BEGIN
  INSERT INTO calendar_events (household_id, title, is_all_day, start_date, end_date, source,
                               google_event_id, google_calendar_id)
    VALUES (:'H', 'blocked', true, '2026-07-08', '2026-07-08', 'google', 'g2', 'cal1');
  RAISE EXCEPTION 'FAIL: google 行の INSERT が RLS を突破した';
EXCEPTION WHEN insufficient_privilege OR check_violation THEN
  RAISE NOTICE 'PASS: google INSERT は拒否された';
END $$;
ROLLBACK TO SAVEPOINT sp_google_insert;

-- (c) V6 の負の回帰テスト: google 行で calendar_id NULL は CHECK 違反
SAVEPOINT sp_null_cal;
DO $$ BEGIN
  INSERT INTO calendar_events (household_id, title, is_all_day, start_date, end_date, source, google_event_id)
    VALUES (:'H', 'no cal id', true, '2026-07-08', '2026-07-08', 'google', 'g3');
  RAISE EXCEPTION 'FAIL: google_calendar_id NULL が通った（重複増殖の穴）';
EXCEPTION WHEN check_violation OR insufficient_privilege THEN
  RAISE NOTICE 'PASS: google_calendar_id NULL は拒否された';
END $$;
ROLLBACK TO SAVEPOINT sp_null_cal;

-- (d) 既存 google 行の UPDATE / DELETE は USING 不一致で影響 0 行（例外にならない）
UPDATE calendar_events SET title = 'x' WHERE id = :'G';   -- expect: UPDATE 0
DELETE FROM calendar_events WHERE id = :'G';              -- expect: DELETE 0
ROLLBACK;
```

**前提条件（実装者への注意）**:
- **`supabase/tests/` は現存しない**（`ls supabase/tests` → 存在せず）。`supabase/config.toml` にも test 設定が無い。C-1 で `supabase test db` の実行手順ごと新設すること。
- **§0 のポート衝突が解けない限り、このゲートは一度も回らない。** その事実を PR 説明に明記し、「未実行」を「合格」と誤認しないこと。

### C-3. UI 設計

`/calendar` は「月ナビ → 月グリッド → 選択日アジェンダ」の縦積み、右下に FAB（親指圏）。ヘッダーは `pt-12`（既存タブと統一。meals の `pt-4` 不統一は踏襲しない）。

```
┌─────────────────────────┐
│ [<]  2026年7月  [>]  [今日] │  glass カード
│  [ 月 ] [ リスト ]          │  segmented（transition-colors のみ）
├─────────────────────────┤
│ 月 火 水 木 金 土 日        │
│  6週 × 7日 固定グリッド     │  高さ固定でレイアウトシフト無し
│  各セル: 日付 + dot 最大3 + +N │
├─────────────────────────┤
│ 7月8日(火) の予定           │  選択日アジェンダ
│  ・終日  検診               │  終日を先頭
│  ・14:00 保育園見学          │  時刻付きは start_at 昇順
│  ・(google) 会議  ↗         │  google 行は淡色 + read-only バッジ
└─────────────────────────┘
              (＋)  ← FAB: fixed bottom-right, 親指圏, 56px, warm orange
```

- **タップモデル**: 日セルタップ → その日を選択しアジェンダを更新（**Sheet は開かない**＝誤操作でモーダルが出ない）。アジェンダのイベントタップ → native は編集 Sheet、**google は read-only 詳細 Sheet**（編集/削除ボタンを出さない）。
- 全 Sheet は `side="bottom"`・保存/削除は `SheetFooter`（親指圏）で既存フォームと一貫。
- dot は native=warm orange / google=muted、`is_all_day` は塗り・timed は輪郭で区別（**絵文字は使わない**。meal reaction 専用の規約を厳守）。
- **dark: 変種を初日から全要素へ**。バッジ類は `bg-*-100` を避け `bg-primary/10 text-primary` 等のトークンで組む（`categories.ts` の dark 欠落の轍を踏まない）。
- `src/app/(main)/calendar/loading.tsx` を**初日から同梱**（stock/settings の欠落を繰り返さない）。
- エラー境界は `(main)/error.tsx`（`unstable_retry` 対応の共通 `ErrorView`）を自動継承するため `calendar/error.tsx` は不要。

**react-day-picker の評価 → 自前グリッドを採用**:
- `react-day-picker@10.0.1` は導入済みだが**実利用ゼロの dead code**（`src/components/ui/calendar.tsx` のみ）。`timeZone` prop は experimental。
- **不採用の理由**: (1) 日付**選択**部品でありイベント密度表示（dot/多日バー）には custom component で終始逆張りが要る、(2) 「月グリッド生成の純関数を vitest でテスト」という要求に対し自前 `buildMonthGrid`（TZ 非依存の文字列演算）の方が優る、(3) `timeZone` が experimental で家族アプリの中核に据えるにはリスク。
- **dead code の除去（`ui/calendar.tsx` + 未使用依存）は別 PR**（1 PR = 1 関心事）。
- **フォームの日付入力**は既存 `<Input type="date">` を流用。**ただし時刻入力（`type="time"`）はリポジトリに前例ゼロで net-new**。

### C-4. Server Actions + 楽観更新（Realtime は enhancement）

純ドメイン関数の置き場は `src/lib/domain/`（`matching`/`scoring`/`stock-form` 等が集約されている規約に従う）:
- `src/lib/domain/calendar-grid.ts`: `buildMonthGrid`（月曜始まり・常に 6週×7日=42セル）、`shiftMonth`、`eventOverlapsDate`、`sortDayEvents`、`bucketEventsByDate`。全て文字列演算で TZ 非依存。
- `src/lib/domain/calendar-validation.ts`: `validateCalendarEventInput`（DB CHECK と同じ不変条件をクライアント側でも弾き、日本語メッセージで返す）。

Server Actions（`src/app/(main)/calendar/actions.ts`、`meals/actions.ts` を範に）:
- `getAuthContext()` → 検証 → `source='native'` 所有確認 → `logSupabaseError` → `revalidatePath`。
- **`.update()` / `.delete()` は 0 行でも `error: null`** を返すため、`.select("id")` で行数を検証し **silent fail を作らない**。0 行なら「この予定は編集できません（同期予定か、権限がありません）。」を返す。
- `logSupabaseError` の 3 引数目は非 null `PostgrestError` ゆえ **`error!` の非 null 断言を使わない**。`if (error)` と `if (!data)` の 2 分岐に分け、後者は `console.error`。

**楽観更新**（`meal-week-view.tsx` を範に）: temp id で楽観挿入 → `startTransition` で Server Action → 成功で確定 id 差し替え / 失敗で remove + `toast.error`。**#92 が未解決でも自分の操作は即時反映される。**

**自己回復（V2 の帰結）**: `visibilitychange` / `focus` で現在の月グリッド範囲を refetch。配偶者の削除・Google 同期の削除はこれで拾う。

### C-5. Flutter 追従（**ユーザーの判断が要る**）

web だけに新機能を足すと「**片方の親にだけ見えないカレンダー**」が生まれ、夫婦の共有カレンダーという機能の存在意義が消える。「別 issue 化」では不足で、次のいずれかを**ユーザーが選ぶ**:

| 案 | 内容 | コスト |
|---|---|---|
| **(a) web 先行 + 同一マイルストーンで追従** | web 3 PR → 安定後に Flutter 6 点セット（model/repository/notifier/page/router/test）。DB/RLS は共有なのでスキーマ分岐なし | 追加 **M〜L**（baby 移植より軽い） |
| **(b) web 限定で合意** | Flutter ユーザーは予定を閲覧すらできない。BottomNav が web 6 / Flutter 5 でズレる | パリティ負債（MEMORY の「トップレベル機能パリティ達成」が崩れる） |

**推奨は (a)**。ただし Phase C の web PR 完了時点で必ず parity gap を issue 化して追跡すること。

### C-6. PR 分割

| PR | 含むもの | 依存 |
|---|---|---|
| **C-1** | `20260708000001_calendar_events.sql` / `database.ts` 型追記 / `supabase/tests/calendar_events_rls.sql` | なし |
| **C-2** | `src/lib/domain/calendar-grid.ts` / `calendar-validation.ts` / `calendar/actions.ts` + node テスト | C-1、**PR-0**（`jstWallClockToIso` の極小 PR。B-4 にも依存させない） |
| **C-3** | `page.tsx`/`loading.tsx`/`calendar-view.tsx`/`calendar-month-view.tsx`/`calendar-agenda.tsx`/`calendar-event-form-sheet.tsx`/`use-month-events.ts`/`bottom-nav.tsx` + jsdom + `e2e/calendar.spec.ts` | C-2 |

**BottomNav の 6 タブ化は C-3 に同梱**（`/calendar` ルートが同 PR で生えるため atomic。route 無しでタブだけ足すと 404 導線になる）。

---

## 7. Phase D: Google カレンダー自動同期

### D-0. 方式決定（**ICS 案を併記。最終選択はユーザー**）

**採用: 独立 Google OAuth + `syncToken` 増分ポーリング**。ログインはマジックリンクのまま据え置き、**Supabase Auth の Google provider は使わない**（既存 email ユーザーの identity 分裂を避ける）。

| 観点 | 案A 独立 OAuth（採用） | 案C ICS 秘密アドレス |
|---|---|---|
| 導入摩擦 | GCP プロジェクト + 同意画面公開 + 初回同意タップ | Google 設定から秘密 URL をコピペ（最小） |
| 増分同期 | `syncToken` で差分のみ（削除も届く） | 不可。毎回フルフィード fetch + iCal パース |
| 鮮度保証 | events.list の一貫性保証あり | **公式に無保証**（undocumented） |
| 資格情報 | refresh token（deny-all 保護、失効・再発行可） | **URL 自体が bearer credential**（漏洩＝全予定読取） |
| 繰り返し予定 | `singleEvents=true` で Google 側が展開 | **RRULE の自前展開が必要**（「記憶で書かない」規約と相性が悪い） |
| キャンセル検知 | `status=cancelled` が増分で必ず届く | フィード差分を自前算出、削除検知が曖昧 |

**退けた決定的理由**: 鮮度が公式無保証で「開いた瞬間に最新」を保証できない / URL bearer の漏洩粒度が粗い / RRULE 自前展開の沼。**案C は OAuth を嫌うユーザー向けのフォールバックとして将来 `source='ics'` で後付け可能**（本計画のスコープ外）。

### D-1. 前提条件（**不変条件として明記**）

- **GCP は「In production」公開が必須**。Testing のままだと `calendar.readonly`（sensitive スコープ）の refresh token が **7 日で失効**し、夫婦が毎週再同意する羽目になる。公開すれば「未確認アプリ」警告 1 回タップ + 生涯 100 ユーザー上限（家族には十分）と引き換えに、失効なしの refresh token を得る。
- refresh token は `access_type=offline` + `prompt=consent` の**初回同意時にしか返らない**。取り逃したら再同意が必要 → **再接続導線を最初から実装**する。
- Vercel Hobby は **cron 1 日 1 回・±59 分精度**、かつ**手動デプロイ運用**ゆえ「**デプロイせねば cron は存在せぬ**」。鮮度の主役はオンデマンド同期、cron はバックストップ。
- **鮮度 SLA**: オンデマンド（前回同期から 5 分で stale → `after()` で増分）。cron 単独では最悪 24h + ±59min。

### D-2. テーブル（`supabase/migrations/20260708000002_google_calendar_sync.sql`）

**`calendar_events` は CREATE しない**（V4）。Phase C のテーブルに ALTER で列を足し、3 テーブルを新設する。

| テーブル | 機密性 | RLS |
|---|---|---|
| `google_connections` | 非機密（`google_email`, `connection_status`, `last_synced_at`） | household SELECT + 本人 DELETE。**INSERT/UPDATE ポリシーを作らない**（service role のみ） |
| `google_tokens` | **機密**（`refresh_token`, `access_token`） | **RLS 有効・ポリシー 0 本 = deny-all**。加えて `REVOKE ALL ... FROM anon, authenticated`（多層防御） |
| `google_calendar_subscriptions` | 混在 | household SELECT + `is_selected` のみ UPDATE 可。**機密列（`sync_token`, `sync_lease_until`）は列権限 REVOKE**（既存 `profiles` H1-b と同型） |

**トークン暗号化は採用しない**（advisor 裁定）。理由: Supabase Vault の `vault.decrypted_secrets` ビューは**grant を持つ者が平文を読める**（誤 grant で RLS が正しくても漏洩）。夫婦 2 人・家族専用インスタンスには運用重量が過剰。**平文カラム + deny-all RLS + service role 限定**とする。アプリ層 AES-256-GCM は将来の hardening 候補（鍵管理の同時設計が必須なので別 PR）。

**`calendar_events` への ALTER**:
```sql
ALTER TABLE calendar_events
  -- V9: CASCADE にしてはならない。夫婦が同一の共有 Google カレンダーを各自購読すると
  --     行は 1 つに収斂し subscription_id は last-writer のものになる。CASCADE だと
  --     片方の購読解除でもう片方の予定まで消え、syncToken 増分同期のため永久に復活しない。
  ADD COLUMN subscription_id UUID REFERENCES google_calendar_subscriptions(id) ON DELETE SET NULL,
  ADD COLUMN source_user_id  UUID REFERENCES profiles(id) ON DELETE SET NULL,
  ADD COLUMN location        TEXT,
  ADD COLUMN html_link       TEXT,
  ADD COLUMN recurring_event_id TEXT,
  ADD COLUMN google_updated  TIMESTAMPTZ,
  ADD COLUMN synced_at       TIMESTAMPTZ;
-- Google の description は既存 memo 列にマップする（列を増やさない）
```

**V7: publication は 1 つも増やさない。** `google_calendar_subscriptions` は `sync_token` / `sync_lease_until` という秘密を持ち、列 REVOKE と walrus の列フィルタに安全性を賭けることになる（**§0 のポート衝突でローカル検証できない**）。同期完了の通知は §D-4 のポーリングで行う。

**ミラー掃除（V9）**: 購読解除・接続削除の Server Action で、**他に同一 `google_calendar_id` を選択中の購読が無い場合にのみ**明示 DELETE する:
```ts
// is_selected=false / 接続削除 の後に呼ぶ
const { data: stillSelected } = await admin
  .from("google_calendar_subscriptions")
  .select("id")
  .eq("household_id", householdId)
  .eq("google_calendar_id", calendarId)
  .eq("is_selected", true)
  .limit(1)

if (!stillSelected?.length) {
  await admin.from("calendar_events").delete()
    .eq("household_id", householdId)
    .eq("google_calendar_id", calendarId)
    .eq("source", "google")          // native 行を絶対に巻き込まない
}
```
ユニットテストで「二重購読中は消えない / 最後の購読が外れたら消える」を固定すること。

### D-3. 同期パイプライン（純関数コア + I/O シェル）

**純関数コア** `src/lib/domain/google-calendar-sync.ts`（Google API を呼ばない・vitest で実体テスト）:
- `classifyEvent(raw)`: `status === 'cancelled'` → `{op:'delete'}`（**normalize を呼ばない** — cancelled は start/end を欠く場合がある）。それ以外 → `{op:'upsert', event: normalizeEvent(raw)}`。
- `normalizeEvent(raw)`:
  - **罠1**: all-day の `end.date` は**排他的**（1 日イベントは `start=07-08, end=07-09`）。包含の最終日にするため `shiftYmd(end.date, -1)`（**`new Date` 演算は使わない**）。
  - **罠2**: 時刻付き `dateTime` を **string slice で日付化しない**。JST 日付バケットは `toJstDateString(ISO)` で求める（UTC 罠回避）。

**I/O シェル** `src/lib/google/`（`fetch` + `AbortController` + timeout 10s + 構造化ログ）:
- `oauth.ts`: `exchangeCodeForTokens` / `refreshAccessToken` / `fetchGoogleUserInfo`。**`invalid_grant` を型（`GoogleAuthError.kind`）で区別**し、握り潰さず `connection_status='needs_reauth'` へ遷移させる。
- `calendar-client.ts`: `fetchCalendarList` / `fetchEventsPage`。**410 → `kind='gone'`、403/429 → `kind='quota'`**。

**`syncToken` の一次情報（Google 公式 events.list リファレンスを WebFetch で確認済み）**:
- **併用不可パラメータ**: `iCalUID` / `orderBy` / `privateExtendedProperty` / `q` / `sharedExtendedProperty` / **`timeMin`** / `timeMax` / `updatedMin`。
  → **「未来のみ `timeMin`」で増分同期が壊れる罠**。`timeMin` は**フル同期の初回のみ**付ける。
- `singleEvents` は syncToken 併用可 → **増分・フル両方で `true` 固定**（繰り返しを Google 側に展開させる）。`showDeleted`/`maxResults` も全リクエストで同一に保つ。
- **410 GONE**: "the client should clear its storage and perform a full synchronization without any syncToken."
- **削除**: 増分同期は "the result will always contain deleted entries"（`showDeleted` に依らず `status=cancelled` が必ず届く）。
- **ページネーション**: `nextSyncToken` は**最終ページのみ**に載る。`nextPageToken` を辿って全ページ取得してから保存。

**`upsert` の `onConflict`**（V1 の訂正を反映）:
```ts
await admin.from("calendar_events").upsert(rows, {
  onConflict: "household_id,google_calendar_id,google_event_id",  // 通常 UNIQUE を指す
})
```

**二重同期防止（atomic リース）**:
```ts
const { data: leased } = await admin.from("google_calendar_subscriptions")
  .update({ sync_lease_until: leaseUntil })
  .eq("id", sub.id)
  .or(`sync_lease_until.is.null,sync_lease_until.lt.${nowIso}`)
  .select("id")
if (!leased?.length) continue   // 別実行が進行中 → skip
```
READ COMMITTED 下で 2 つ目の UPDATE は EvalPlanQual により述語を再評価し、0 行で弾かれる。

**410 フル再同期**: `sync_token=NULL` にし、`delete().eq("subscription_id", sub.id).eq("source", "google")`（V4: 統合テーブルなので `source` を防御的に付ける）でミラーを掃除 → 次回フル同期。**このパスを最初から実装しテストしないと、失効後に静かに同期が止まる。**

### D-4. 同期トリガー

- **オンデマンド（鮮度の主役）**: カレンダーページの Server Component で `maybeScheduleSync(householdId)` → `after()`（`next/server` からの export を実機確認済み）でレスポンス後にバックグラウンド同期。
  **V4 の訂正**: staleness 判定は **authenticated client** で `google_connections`（household RLS で SELECT 可・非機密）から読む。**`createAdminClient()` は `after()` の内側でのみ生成する**（描画経路に service role を置かない）。
  ページに `export const maxDuration = 30`。
  **V7 の訂正**: `maybeScheduleSync()` は **`syncScheduled: boolean` を返す**。Server Component から client へ渡し、true のときだけ client が `last_synced_at` を Server Action で 1〜3 回短間隔ポーリングし、前進したら events を refetch する。**Realtime を使わない**（削除のみの同期サイクルは `calendar_events` に INSERT/UPDATE を生まないため、この経路が削除反映の唯一の担保）。

- **cron（バックストップ）**: `vercel.json` に `{ "path": "/api/cron/google-sync", "schedule": "0 21 * * *" }`（UTC 21:00 = JST 06:00）。Hobby で毎時式（`0 * * * *`）は**デプロイが失敗する**。

  **V8: `proxy.ts` の除外とハンドラの fail-closed 認可は不可分の 1 PR**（片方だけ入ると cron が無認証で開く）:

  ```ts
  // src/proxy.ts — isPublicRoute に追加
  const isPublicRoute =
    pathname === "/login" ||
    pathname.startsWith("/auth/callback") ||
    // Vercel Cron は cookie 無しの GET を送るため、承認ゲートを通すと /login へ 307 され
    // ハンドラに到達しない。認可はハンドラ側の CRON_SECRET(fail-closed) が担う。
    pathname.startsWith("/api/cron/")
  ```

  ```ts
  // src/app/api/cron/google-sync/route.ts
  import { timingSafeEqual } from "node:crypto"
  export const runtime = "nodejs"
  export const maxDuration = 60

  function safeEqual(a: string, b: string): boolean {
    const ab = Buffer.from(a), bb = Buffer.from(b)
    // timingSafeEqual は長さ不一致で throw する。先に長さを比較して短絡する。
    return ab.length === bb.length && timingSafeEqual(ab, bb)
  }

  // Vercel Cron は GET を送る（POST のみだと 405）
  export async function GET(request: Request) {
    const secret = process.env.CRON_SECRET?.trim()
    // fail-closed: 未設定なら誰も通さない（proxy を外した経路を無認証で開かない）
    if (!secret) {
      console.error("[cron-google-sync] CRON_SECRET 未設定のため拒否")
      return new Response("Unauthorized", { status: 401 })
    }
    const provided = request.headers.get("authorization")?.replace(/^Bearer\s+/, "") ?? ""
    if (!safeEqual(provided, secret)) return new Response("Unauthorized", { status: 401 })
    ...
  }
  ```

  **検証（Route Handler の直接 import では不十分）**: dev サーバを立て、`fetch(url, { redirect: "manual" })` で
  (a) **307 が返らないこと**（proxy を通過している）、(b) secret 無しで 401、(c) 正しい secret で 200、を assert する。
  > 直接 import のテストは proxy を通らないため、**緑のまま本番 100% 不発**になる（グローバル規約が名指しする事故と同型）。

- **明示トリガ**: `POST /api/google/sync`（**session 認証** `getAuthContext`。CRON_SECRET は使わない。`/api/cron/` 配下ではないので proxy の承認ゲートを通る＝正しい）。設定カードの「今すぐ同期」ボタンから。

> **proxy の fail-closed 承認ゲートは維持される**: matcher が `/api` を含むため、`/api/google/oauth/start` と `/callback` も承認ゲートを通る（良い設計）。意図的に認証を外すのは `/api/cron/` ただ一つで、そこはハンドラ側の fail-closed `CRON_SECRET` が防壁になる。

### D-5. エラーモデル（**握り潰し禁止 — 全経路を UI に露出させる**）

| 経路 | 検知 | UI 表示 |
|---|---|---|
| `invalid_grant`（refresh 失効/取消） | `GoogleAuthError.kind==='invalid_grant'` | `connection_status='needs_reauth'` → 設定カードに warm orange バナー「**再連携が必要です**」+ 再接続ボタン |
| 410 GONE（syncToken 失効） | `GoogleCalendarError.kind==='gone'` | ユーザー操作不要。自動フル再同期。`sync_status='error'` を一時表示 |
| quota / rate（403/429） | `kind==='quota'` | 「同期が混み合っています。しばらくして再度お試しください」。次回トリガで自動回復 |
| ネットワーク断 / timeout | `AbortError` → `kind==='network'` | `sync_status='error'`。恒久失敗ではないので再接続導線は出さない |
| **refresh_token 取り逃し**（接続時） | callback で `!tokens.refresh_token` | `?google=no_refresh_token` → 「もう一度接続してください」+ 再接続ボタン |
| CSRF state 不一致 | callback で state ≠ cookie | `?google=csrf` → 「接続に失敗しました」 |

全 catch で Supabase error は `{ message, code, details, hint }` を、fetch error は `{ message }` を構造化ログ。

### D-6. テスト計画

| 層 | 対象 | 手段 |
|---|---|---|
| **純関数（本命）** | all-day 単日（`end.date` 排他 → 包含）/ all-day 複数日 / 時刻付き / **時刻付き UTC 跨ぎ**（`2026-07-08T16:30:00Z` → JST `2026-07-09`）/ cancelled（start/end 無しでも落ちない）/ summary 欠落 → `(無題)` / `diffPage` の振り分け | vitest node。**Google API を呼ばない実体テスト** |
| **URL 契約** | **増分リクエストに `timeMin` が絶対に含まれない**（syncToken 併用禁止の回帰防止）/ フル同期は `timeMin` を含み `syncToken` を含まない / 両モードで `singleEvents=true` / 410→`gone`, 403/429→`quota` | vitest + `global.fetch` stub |
| **認可** | cron: CRON_SECRET 不一致→401 / 一致→200。`POST /api/google/sync`: 未認証→401 | Route Handler を直接 import |
| **RLS / 世帯分離** | seed した他世帯の `calendar_events` が**出ない** | Playwright（実 Supabase） |
| **OAuth**（自動化不能） | 手動スモーク手順書 §D-7 | 手動 |

> **`vi.mock` の断り書き**（グローバル規約「ブラウザ専用 I/O を mock で回避禁止」との関係）: ここでの `global.fetch` stub は**ネットワーク境界の stub** であって、ブラウザ専用 I/O（相対 URL fetch / localStorage 等）の隠蔽ではない。このコードは node/サーバ実行前提で、本番も同じ `fetch` API を使う（`fetch('/relative')` のような本番で動かない相対 URL は使っていない）。ゆえに本則には抵触しない。

### D-7. 手動スモーク手順書（OAuth の自動化不能部分）

1. GCP: OAuth 同意画面を **In production 公開**、スコープに `calendar.readonly` を追加、承認済みリダイレクト URI に本番と `http://localhost:3000/api/google/oauth/callback` の両方を登録。
2. `.env.local` に `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `CRON_SECRET`（`openssl rand -hex 32`）。**末尾改行を入れない**（全 env 参照は `?.trim()`）。
3. `pnpm dev` → 設定 → 「Google カレンダーを接続」→ 同意（警告画面 1 回タップ）→ `?google=connected` で戻る。
4. 設定にカレンダー一覧が出る → 対象カレンダーをトグル ON。
5. カレンダーページを開く → 実イベントが数秒後に表示される。
6. Google 側で予定を 1 件追加/削除 → 5 分以内にページ再表示で反映（増分同期・削除反映）。
7. `google_tokens.refresh_token` を故意に壊す → 同期が `needs_reauth` になり**再接続バナーが出る**（invalid_grant 経路）。
8. cron 手動発火: `curl -H "Authorization: Bearer $CRON_SECRET" https://<app>/api/cron/google-sync` → 200。secret 無し → **401**。

### D-8. env 追加手順

```
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
CRON_SECRET=          # openssl rand -hex 32
```
- redirect URI は `NEXT_PUBLIC_APP_URL` から `getAppOrigin()` で導出（専用 env を増やさない）。**本番では `NEXT_PUBLIC_APP_URL` の設定が必須**。
- Vercel: `vercel env add ...` は **auto redeploy しない**。追加後に fresh build を焼くこと（`supabase-env-rotate` スキルの作法）。
- `SUPABASE_SERVICE_ROLE_KEY` を**初めて `src/` から使う**ことになる。RLS バイパスの新経路が生まれるため、**使用箇所を OAuth callback の書き込みと同期処理に限定**し、`household_id`/`user_id` を常に明示指定する（OSS 公開 × 家族専用インスタンスの不変条件を壊さない）。

### D-9. PR 分割

| PR | 関心事 | 依存 |
|---|---|---|
| **D-1** | 3 テーブル + `calendar_events` ALTER + 型追記 | C-1 |
| **D-2** | 純関数コア（日付正規化・差分・cancelled）+ vitest | なし |
| **D-3** | I/O シェル（`oauth.ts` / `calendar-client.ts` / `admin.ts` / `token-store.ts`）+ URL 契約テスト | D-1, D-2 |
| **D-4** | OAuth 接続フロー（start/callback route + 設定カード + 再接続導線） | D-3 |
| **D-5** | 同期エンジン + トリガ（`sync.ts` / `sync-trigger.ts` / cron / `vercel.json`）+ 認可テスト | D-4 |

案B（`events.watch` push 通知）は**別 issue**（チャンネル TTL が公式非公開・自動更新なし。再 watch を怠ると通知が静かに止まる。webhook には `X-Goog-Channel-Token` 検証が必須）。

---

## 8. 全体の検証ゲート

各 PR の完了条件:

```bash
pnpm test:run     # 期待: 既存 268 + 新規 が全 pass
pnpm lint         # 期待: 0 error（transition-all 未混入・絵文字未使用）
pnpm build        # 期待: 成功（database.ts 型・"use server" 非関数 export 無し）
```

**機械検証（主張を機械で固定する — S8 の是正）**。「dark: を足した」「44px にした」を人間の目視だけで担保しない:

| PR | 主張 | 機械検証 |
|---|---|---|
| **B-1** | dark: 変種を補完した | `src/lib/utils/__tests__/dark-variants.test.ts`（新規）: `src/**/*.tsx` と `categories.ts` を走査し、§5 の正準マッピング表をテーブル駆動で適用。`bg-(\w+)-100` を含みかつ対応する `dark:bg-\1-900/40` を欠く箇所の**件数が 0** であることを assert（既知の例外は allowlist に明示） |
| **B-2** | タッチターゲットを 44px にした | (1) `e2e/touch-targets.spec.ts`: 360×780 で `boundingBox().height >= 44`（`expect.soft`）。(2) jsdom: 対象コンポーネントの `className` が `/size-11\|min-h-11/` を含む |
| **B-7** | safe-area を修正した | jsdom: `(main)/layout.tsx` の `<main>` が `pb-nav` を持つ / `stock-form-sheet` の `SheetContent` が `safe-bottom` を持つ。**加えて** Playwright の iPhone device profile でスクリーンショット目視 |
| **B-8** | manifest を直した | `src/app/__tests__/manifest.test.ts`: `manifest().start_url === "/"`、`shortcuts.length >= 2`、maskable エントリの有無（**アセット未用意なら maskable は追加しない**） |
| **B-9** | 今日へ自動スクロールする | jsdom: `Element.prototype.scrollIntoView` を `vi.fn()` に差し替え、現週レンダーで today 行に対し **1 回だけ**呼ばれる / 週送り後は呼ばれない |
| **B-10** | swipe で計測が消えない | jsdom: タイマー開始 → `handleOpenChange(false)` → `localStorage` キーが**残存** / 明示「キャンセル」では破棄される |
| **A-3** | `+09:00` を全箇所に付けた | `grep -rn 'T00:00:00' src/ \| grep -v '+09:00' \| grep -v 'new Date'` → **0 件** |
| **A-6a〜c** | エラー握り潰しを一掃した | `./scripts/check-supabase-error-destructure.py --strict` → exit 0。**`--strict` 必須**（`return 1 if strict else 0` ゆえ、付けないと違反があっても exit 0 で素通りする。CI は `ci.yml:44` で `--strict` を使っている）。**加えて検出器の盲点を塞ぐ**: 現状 `.then(({ data }) =>` を検出できず（`baby-dashboard.tsx:176` の実在する握り潰しを見逃す）、`--strict` でも exit 0 になる。**A-6c で検出パターンを追加し、先に赤くしてから直す** |
| **D-5** | cron が proxy を通る | dev サーバへ `fetch(url, { redirect: "manual" })` → **307 が返らない** / secret 無しで 401 / 正しい secret で 200 |

DB を触る PR に追加:
```bash
supabase db reset                          # 全マイグレーション再適用（構文・順序）
supabase test db                           # supabase/tests/ の SQL（C-1 で新設）
```
> ⚠️ **`supabase/tests/` も `config.toml` の test 設定も現存しない。** C-1 で新設すること。
> ⚠️ **§0 のポート衝突が解けない限り、この 2 つのゲートは一度も回らない。** 「未実行」を「合格」と読み替えないこと。PR 説明に実行有無を明記する。

E2E を伴う PR に追加:
```bash
pnpm e2e:build && pnpm e2e   # 実 Supabase + Mailpit、モックなし
E2E_OFFLINE=1 pnpm e2e       # PWA オフライン検証（ローカルでは opt-in ゲート）
```

Flutter に波及する PR に追加:
```bash
cd flutter && fvm flutter test   # 期待: 既存 950 + 新規 が全 pass
```

**注意**: `flutter.yml` は `paths: flutter/**` でのみ発火する。**web 側の変更が Flutter との動作パリティ前提（共有スキーマ・RPC 契約）を壊しても Flutter CI は走らない。** 共有スキーマを触る PR では手動で `flutter test` を回すこと。

**注意**: CI 全緑 ≠ 本番反映。本番デプロイは手動 `vercel --prod` 運用。

---

## 9. 完了前チェックリスト（各 PR 適用）

1. 変更ファイルにエラー握り潰しが無い（Supabase error は `logSupabaseError` で全フィールド構造化ログ。`.single()`/`.maybeSingle()` の `error` を必ず受け取る）
2. 同一パターンを `grep` で全箇所確認
3. 外部 API 呼び出しに `AbortController` + timeout
4. 新エンドポイントに認証 + 入力バリデーション + 日本語エラーレスポンス
5. 数値デフォルト `0` が falsy 判定と衝突しないか
6. 環境変数を `.trim()` で防御
7. 既存テストが通る（`pnpm test:run`）
8. 変更に対応するテストを追加（または追加不要な理由を説明）
9. `createServerClient` / service role を適切に使用（service role は同期処理と OAuth callback に限定）
10. **`new Date('YYYY-MM-DD')` を使っていない**（`src/lib/utils/date-jst.ts` の文字列演算のみ）
11. `useEffect` 内の fetch に `AbortController`（Supabase 購読は cleanup で `removeChannel`）
12. `resetForm()` で全 `useState`（`saving`/`loading` 含む）をリセット
13. **`transition-all` 未導入**（`transition-colors duration-200` のみ）、絵文字は meal reaction のみ
14. RLS は SELECT/INSERT/UPDATE/DELETE 分離（**`FOR ALL` 禁止**）、`SECURITY DEFINER` は `SET search_path = public`
15. feature ブランチで作業（main 直接コミット禁止）、**1 PR = 1 関心事**

---

## 10. ユーザーの判断が要る事項

| # | 論点 | 選択肢 | 推奨 |
|---|---|---|---|
| 1 | **Flutter パリティ**（§C-5） | (a) 同一マイルストーンで追従 / (b) web 限定で合意 | **(a)** — 「片方の親にだけ見えないカレンダー」は機能の存在意義を消す |
| 2 | **Google 同期の方式**（§D-0） | 案A 独立 OAuth / 案C ICS 秘密アドレス | **案A** — 鮮度が公式保証され、資格情報の失効・再発行ができる |
| 3 | **GCP の公開**（§D-1） | In production 公開（警告 1 回 + 100 ユーザー上限） / Testing のまま（**7 日ごとに再同意**） | **In production 公開** |
| 4 | **Phase 0（#92）の扱い**（§3） | 本計画と並行で進める / 後回し | **並行**（本計画をブロックしない。ただし先に `vercel --prod` で観測対象を一致させる） |
| 5 | **ローカル E2E のポート衝突**（§0） | inventory-hub を停止 / `config.toml` の port 変更 | 実行者が他作業への影響を見て判断 |
| 6 | **eating-out の死コード**（A-10） | (a) 欠陥だけ塞ぐ / (b) 塞いで配線し機能を完成させる / (c) 削除する | **(a)** — 安く地雷を撤去でき、将来の配線 PR が安全に書ける。配線するなら別 PR |
| 7 | **「間食」の扱い**（A-2） | (a) 週ビューに表示する（1日4スロットへ） / (b) フォームから除外する | **(b)** — 週ビューは朝昼夕の 3 スロット前提。間食の first-class 化は「一目で今日の夕飯」を損なう |

---

## 11. advisor レビューの反映記録

計画書を「本質の番人」（read-only・全履歴を読むレビュアー）に諮った結果、**判定 STOP**。8 件の指摘のうち **7 件が妥当**で、うち 3 件は**実機で再現を確認**した。1 件は古い観測に基づく誤指摘だった。

| # | 指摘 | わっちの検証 | 判定 |
|---|---|---|---|
| **S1** | cron route は `proxy.ts` に食われハンドラに到達しない。認可テストが直接 import ゆえ**緑のまま本番 100% 不発** | `proxy.ts` の matcher が `/api/` を除外しないこと、`isPublicRoute` が `/login` と `/auth/callback` のみであることを実読で確認。「Vercel Cron は GET を送信」も user rules で確認 | **妥当 → V8 として反映**。proxy 除外 + fail-closed CRON_SECRET を**不可分の 1 PR** に |
| **S2** | CHECK が `google_calendar_id IS NULL` を許し、NULLS DISTINCT で重複が積もる | **実機再現**: 不完全 CHECK + `calendar_id=NULL` で 2 回 upsert → **2 行に増殖**。是正版は DB が弾き、正しい行は 1 行に収斂 | **妥当 → V6 として反映**。負の回帰テストも追加 |
| **S3** | 同期完了シグナルを publication に載せるのは三重に悪い（秘密を wire に載せる / 自己矛盾 / 壊れた Realtime に依存） | 計画自身が `google_calendar_subscriptions` を「機密列を持つ」と定義し、`google_connections` を「非機密」としていた矛盾を確認。列フィルタの安全性は§0 のポート衝突で**実機検証できない** | **妥当 → V7 として反映**。publication を増やさず、ポーリングに置換 |
| **S4** | `docs/plans/phase-a-bugfix.md` が存在しない | `ls docs/plans/` → **存在する**（20:12 作成）。advisor の Glob が作成前に走った | **誤指摘（古い観測）**。ただし指摘の趣旨（Phase A の red→green が計画の中核）は正しく、既に反映済み |
| **S5** | 世帯内で同一 Google カレンダーを二重購読すると、片方の解除で CASCADE により予定が消える。`is_selected=false` のミラー掃除も無い | 設計を読み直し、household スコープの UNIQUE と `subscription_id` CASCADE の組み合わせで成立することを確認 | **妥当 → V9 として反映**。`ON DELETE SET NULL` + 条件付き明示 DELETE |
| **S6** | RLS 検証 SQL は書いたとおりには走らない（例外でトランザクションが aborted） | **実機再現**: 例外後の UPDATE / SELECT が `current transaction is aborted, commands ignored` になることを確認。`supabase/tests/` も config も**現存しない**ことを確認 | **妥当 → SAVEPOINT / ROLLBACK TO に修正**。ゲート未実行の事実も明記 |
| **S7** | A-7 は関心事でなく雑巾がけ / C-2 が B-4 に依存するのは不健全 / A・B と C・D を 1 マイルストーンに束ねている | 計画を読み直し、A-7 が A-8 と `low-stock.ts` を、`meals/page.tsx` を重複して触ることを確認 | **妥当 → A-6a〜d にドメイン分割**、`jstWallClockToIso` を **PR-0** に切り出し、**マイルストーンを 2 つに分離** |
| **S8** | B-1 を「grep で検証可能」と称しながら、§8 のゲートに dark: のチェックが 1 行も無い。B-7/B-9/B-10 は検証手段が皆無 | §8 を読み直し、確認 | **妥当 → 機械検証の表を §8 に追加**（B-1 のテーブル駆動 dark: テスト等） |

### 着手可否（advisor の裁定 + 上記反映後）

| 状態 | 対象 |
|---|---|
| **着手可** | PR-0、A-1〜A-10、B-1〜B-10（S8 の機械検証を各 PR に含めること） |
| **S2/S6 反映済みにつき着手可** | C-1、C-2、C-3 |
| **S1/S3/S5 反映済み。ただし GCP 公開（ユーザー行動）が前提** | D-1〜D-5 |
| **独立トラック** | Phase 0（#92）。先に `vercel --prod` で観測対象を一致させること |

> advisor の結びを記録しておく: 「**S1 は主が最も繰り返してきた失敗——『テストが緑ゆえ動くと信じる』——の形をしておる。**」

---

## 付録: 参照ファイル

- 実機検証の再現手順: `docs/plans/verification-record.md`
- Phase A の TDD 詳細: `docs/plans/phase-a-bugfix.md`
- デザインシステム: `docs/DESIGN_SYSTEM.md`（**5 タブ時代の記述が 3 タブのまま。実装と乖離しており別 PR で同期が必要**）
- 楽観更新の正典: `src/components/meals/meal-week-view.tsx`
- Server Action 単体テストの idiom: `src/app/(main)/meals/__tests__/actions.test.ts`
- JST ユーティリティ: `src/lib/utils/date-jst.ts`
- RLS 雛形: `supabase/migrations/20260410000001_baby_logs.sql`
- 列権限 REVOKE の前例: `supabase/migrations/20260603000001_security_hardening_rls.sql`（profiles H1-b）
