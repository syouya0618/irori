# 設計検証記録（実機・一次情報）

計画書に組み込む「検証済み事実」と「設計ドラフトの誤りの訂正」。全て実行コマンドと出力で裏づけ済み。

---

## V1. PostgREST の upsert は partial unique index に効かない（**設計欠陥を発見・訂正**）

### 何を疑ったか
calendar-feature 設計は Google 行の冪等キーを **部分ユニークインデックス** で定義した:
```sql
CREATE UNIQUE INDEX idx_calendar_events_google_unique
  ON calendar_events(household_id, google_calendar_id, google_event_id)
  WHERE source = 'google';
```
一方 gcal-sync 設計は supabase-js で `.upsert(rows, { onConflict: "..." })` を呼ぶ。
PostgREST の `on_conflict` は**列名しか出力しない**（`WHERE` 述語を出せない）。
PostgreSQL は partial index を推論するのに `index_predicate` を要求する。→ 実行時に落ちるのでは？

### 実機検証（稼働中 Postgres 17 に一時テーブル + ROLLBACK で完全隔離）
```sql
CREATE TEMP TABLE t (household_id uuid NOT NULL, gcal_id text, gev_id text,
                     source text NOT NULL DEFAULT 'native', title text);
CREATE UNIQUE INDEX t_partial ON t(household_id, gcal_id, gev_id) WHERE source='google';
INSERT INTO t VALUES (...,'google','v1')
  ON CONFLICT (household_id,gcal_id,gev_id) DO UPDATE SET title=EXCLUDED.title;
```

**結果:**
```
ERROR:  there is no unique or exclusion constraint matching the ON CONFLICT specification
```

### 対照実験
| # | 構成 | ON CONFLICT の書き方 | 結果 |
|---|---|---|---|
| 1 | partial index | `(cols)` のみ（= PostgREST 相当） | **ERROR 42P10** |
| 2 | partial index | `(cols) WHERE source='google'` | 成功・冪等（2 回 INSERT → 1 行, title=v2） |
| 3 | 通常 UNIQUE index | `(cols)` のみ | **成功・冪等**（google 1 行に収斂）かつ **native 行 (uuid, NULL, NULL) は 2 行共存**（NULLS DISTINCT が既定） |

### 結論（計画に反映する訂正）
partial index は**採用しない**。代わりに:
```sql
-- 通常 UNIQUE（NULLS DISTINCT 既定により native 行は NULL,NULL で無限に共存できる）
CREATE UNIQUE INDEX idx_calendar_events_google_unique
  ON calendar_events(household_id, google_calendar_id, google_event_id);

-- native 行が google 列を持たないことを DB で強制 → 通常 UNIQUE が partial と同義になる
CONSTRAINT chk_calendar_native_no_google CHECK (
  source = 'google'
  OR (google_event_id IS NULL AND google_calendar_id IS NULL)
)
```
これで PostgREST の `.upsert(..., { onConflict: "household_id,google_calendar_id,google_event_id" })` が動く。
（別解: partial index のまま `SECURITY DEFINER` RPC で生 SQL の `ON CONFLICT ... WHERE source='google'` を書く。コード量が増えるため非採用。）

**もしこれを検証せずに実装していたら**: 同期エンジンの upsert が本番で 100% 失敗し、Google 予定が 1 件も入らなかった。

---

## V2. `REPLICA IDENTITY FULL` は DELETE 配信を解決しない（**設計の誤りを訂正**）

### 何を疑ったか
calendar-feature 設計（design→敵対検証→改訂を通過済み）が主張:
> `REPLICA IDENTITY FULL` は DELETE イベントの old レコードに全列を載せる。これが無いと DEFAULT(PK のみ)により household_id フィルタ付き購読へ DELETE が配信されず、配偶者デバイスで削除が反映されない。

しかし本リポジトリの issue #91 は逆の結論（「REPLICA IDENTITY FULL でも解決しない」）を docs 一次検証済みとして記録している。

### 一次情報（Supabase 公式 docs / realtime / postgres-changes を WebFetch）
> **"You can't filter Delete events when tracking Postgres Changes."**
>
> "RLS policies are not applied to `DELETE` statements, because there is no way for Postgres to verify that a user has access to a deleted record."
>
> "When RLS is enabled and `replica identity` is set to `full` on a table, the `old` record contains only the primary key(s)."

### 結論（計画に反映する訂正）
- calendar-feature の主張は**二重に誤り**: (a) DELETE はそもそもフィルタ不可、(b) RLS 有効下では old は PK のみ。
- issue #91 の結論が正しい。**`ALTER TABLE calendar_events REPLICA IDENTITY FULL` を migration から削除する**（WAL 量を増やすだけで何も買えない）。
- 既存テーブルへの `REPLICA IDENTITY` は 0 件（`grep -rn "REPLICA IDENTITY" supabase/migrations/` → 0）。現状のままで正しい。

### 代替の DELETE 反映策（計画に採用）
1. **自分の削除**: 楽観更新で即時反映（既に設計済み）。
2. **配偶者の削除**: `visibilitychange` / `focus` での refetch（自己回復）。これは issue #92（本番 postgres_changes 不達）への対策も兼ねる。
3. **同期エンジンの削除**: 同期完了時に `google_calendar_subscriptions.last_synced_at` を UPDATE →
   同テーブルを publication に載せ、その UPDATE を「同期完了シグナル」として購読 → クライアントが refetch。
   （削除のみの同期サイクルでも `calendar_events` に INSERT/UPDATE が起きないため、この signal 経路が必要）
4. 将来: 論理削除（`deleted_at`）化すれば DELETE が UPDATE になりフィルタ可・RLS 適用可（issue #91 が「最有力」と記す）。本計画ではスコープ外。

---

## V3. `stock-form.ts` の `Number(...) || 1` は「バグ」ではなく明文化された契約

### 実ファイル（`src/lib/domain/stock-form.ts:18`）
```
 * - quantity: Number() で変換し、falsy (欠落 / "" / "0" / NaN) は 1 に倒す
```
`:35` → `quantity: Number(formData.get("quantity")) || 1,`

### ピン止めテスト（`src/lib/domain/__tests__/stock-form.test.ts`）
```
["欠落", undefined, 1], ["空文字", "", 1], ['"0" (falsy 衝突)', "0", 1],
["数値文字列", "3", 3], ["小数", "2.5", 2.5], ["負数", "-2", -2], ["非数値 (NaN)", "abc", 1],
```
テストが `"0" → 1` を **「falsy 衝突」と明示的にラベルして意図的に固定**している。NaN 防御も兼ねる。

### git log -S による導入意図の追跡（グローバル規約: 防御コード削除前の必須手順）
```
$ git log -S 'Number(formData.get("quantity")) || 1' --oneline
b4444d1 refactor(stock): actions のロジックを lib へ抽出 (挙動不変、export 面不変) (R4) (#27)
a722980 refactor: Phase 1.5 コードレビュー指摘を反映
2bac600 feat: Phase 1.5 在庫管理 + レシピ提案機能を実装
```

### DB 側（`supabase/migrations/20260406000001_initial_schema.sql`）
```sql
quantity        NUMERIC NOT NULL DEFAULT 1,   -- CHECK 制約なし
```

### 結論（計画に反映する訂正）
- ux-prs ドラフトの「意図と乖離した falsy バグゆえ置換可」という前提は**誤り**。契約であり、変更するなら**仕様変更**として扱う（ピン止めテストとドキュメントコメントの同時更新が必要）。
- **真の穴は負数素通り**（`"-2" → -2` がテストで固定され、DB にも CHECK が無い）。
- 「0 許容 / 負数拒否 / NaN 最保守（=1）」の新契約を一枚に書き、テストを書き換える PR と、DB `CHECK (quantity >= 0)` を足す PR を分離する。

---

## V4. 設計間の統合矛盾（並列設計の副作用）

calendar-feature と gcal-sync が**独立に同じ `calendar_events` を、別スキーマで、同じ migration 連番で**定義していた。

| 項目 | calendar-feature | gcal-sync | 採用 |
|---|---|---|---|
| 位置づけ | native + google の統合単一テーブル | google 読み取り専用ミラー | **統合単一テーブル** |
| 終日列 | `is_all_day` | `all_day` | `is_all_day` |
| source 列 | `source`('native'\|'google') | なし | あり |
| google 連結 | `google_calendar_id`,`google_event_id`,`etag`,`ical_uid` | `subscription_id` FK,`source_user_id` FK | 両方（後者は ALTER で追加） |
| 冪等キー | partial unique（→ **V1 で棄却**） | `(subscription_id, google_event_id)` | 通常 UNIQUE `(household_id, google_calendar_id, google_event_id)` + CHECK |
| RLS | 4 分離（SELECT 両方 / IUD は native 限定） | SELECT のみ | **4 分離** |
| migration | `20260708000001_calendar_events.sql` | `20260708000001_google_calendar_sync.sql`（**連番衝突**） | `...0001` / `...0002` に分離 |

その他の重複・矛盾:
- `jstWallClockToIso` を calendar-feature §4.1 と ux-prs PR-4 が**両方「新規追加」**しようとしている → 先に出る PR が追加し、後続は依存する。
- gcal-sync の `maybeScheduleSync` は「service role を描画経路で使わない」と自ら宣言しながら、**render 中に `createAdminClient()` を呼んで staleness を読む**（自己矛盾）。
  → 訂正: staleness は authenticated client で `google_connections`（household RLS で SELECT 可・非機密）から読み、admin client は `after()` の内側だけで生成する。
- gcal-sync の 410 フル再同期は `delete().eq("subscription_id", ...)` だが、統合テーブルでは防御的に `.eq("source","google")` も付ける。

---

## V6. 【致命的】google 行の CHECK が不完全だと重複が積もる（advisor S2 の実機再現）

### 何を疑ったか
V1 の訂正で入れた CHECK は `source = 'native' OR google_event_id IS NOT NULL` だった。
これは **google 行で `google_calendar_id IS NULL` を許す**。UNIQUE index は NULLS DISTINCT 既定（V1 の実験 #3 で実証済み）ゆえ、その行は一意化されない。

### 実機検証（一時テーブル + ROLLBACK）
```sql
-- 不完全 CHECK
CONSTRAINT chk_google_meta CHECK (source='native' OR google_event_id IS NOT NULL)
CREATE UNIQUE INDEX ce_uniq ON ce(household_id, google_calendar_id, google_event_id);

INSERT INTO ce VALUES ('...', NULL, 'ev1', 'google', 'v1') ON CONFLICT (...) DO UPDATE ...;
INSERT INTO ce VALUES ('...', NULL, 'ev1', 'google', 'v2') ON CONFLICT (...) DO UPDATE ...;
```

**結果:**
| CHECK | 2 回 upsert（同期 2 巡） | 行数 |
|---|---|---|
| 不完全版 + `calendar_id=NULL` | `INSERT 0 1` × 2 | **2 行**（`v1,v2`）← 重複増殖 |
| 是正版 + `calendar_id=NULL` | — | `ERROR: violates check constraint "chk_google_meta"` |
| 是正版 + 正しい `calendar_id` | `INSERT 0 1` × 2 | **1 行**（`v2`）← 冪等 |

### 結論
```sql
CONSTRAINT chk_calendar_google_meta CHECK (
  source = 'native' OR (google_event_id IS NOT NULL AND google_calendar_id IS NOT NULL)
)
```
V1 の抜け穴は native 側ではなく **google 側**にあった。「native 行が (NULL,NULL) である限り成立する」という推論は、google 行の側を検査していなかった。

---

## V7. RLS 検証 SQL は書いたとおりには走らない（advisor S6 の実機再現）

### 実機検証
```sql
BEGIN;
CREATE TEMP TABLE s (id int, v text);
INSERT INTO s VALUES (1,'a');
INSERT INTO s VALUES ('not-an-int','b');   -- わざと例外
UPDATE s SET v='x' WHERE id=1;             -- 走るか？
SELECT count(*) FROM s;
ROLLBACK;
```

**結果:**
```
ERROR:  invalid input syntax for type integer: "not-an-int"
ERROR:  current transaction is aborted, commands ignored until end of transaction block   ← UPDATE
ERROR:  current transaction is aborted, commands ignored until end of transaction block   ← SELECT
```

### 結論
否定ケース（RLS 違反・CHECK 違反）を含む検証 SQL は、`SAVEPOINT` / `ROLLBACK TO` で包むか pgTAP の `throws_ok` を使う。素朴な `BEGIN; ... ROLLBACK;` では**後続の assert が一度も実行されない**（＝「エラーが出なかった」を「合格」と誤読する）。

補足: `supabase/tests/` も `supabase/config.toml` の test 設定も**現存しない**（`ls supabase/tests` → 存在せず）。新設が必要。

---

## V8. 【致命的】cron route は `proxy.ts` に食われる（advisor S1 の実機確認）

### 実ファイル（`src/proxy.ts`）
```
matcher: ["/((?!_next/static|_next/image|favicon.ico|icons/|manifest\.webmanifest|sw\.js|offline$|.*\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"]
```
→ **`/api/` を除外していない。**

```
const isPublicRoute = pathname === "/login" || pathname.startsWith("/auth/callback")
```
→ `/api/cron/*` は public でない → 未認証（cookie 無し）→ `/login` へ 307。

`~/.claude/rules/nextjs-supabase.md:30`: 「**Vercel Cron は GET を送信**」（cookie を持たない）。

### 結論
`/api/cron/google-sync` は**ハンドラに到達しない**。しかも認可テストが Route Handler を直接 import する設計だったため、**テストは緑、本番は 100% 不発**になるところだった。

是正は「`proxy.ts` の `/api/cron/` 除外」+「ハンドラの fail-closed `CRON_SECRET`」の**不可分な 1 PR**。片方だけ入ると cron が無認証で開く。
検証は dev サーバへ `fetch(url, { redirect: "manual" })` して **307 が返らないこと**を assert する（直接 import では proxy を通らない）。

`timingSafeEqual` は**長さ不一致で throw する**ため、長さを先に比較して短絡評価すること。

---

## V9. 記憶で書かれていないことの確認（実機 grep）

| 主張 | 検証コマンド | 結果 |
|---|---|---|
| `after` は `next/server` から export される | `grep -n "after" node_modules/next/server.d.ts` | `21:export { after } from 'next/dist/server/after'` ✅ 設計は正しい |
| `getAppOrigin(request?)` のシグネチャ | `cat src/lib/utils/app-origin.ts` | `getAppOrigin(request?: Request, envAppUrl = process.env.NEXT_PUBLIC_APP_URL)` ✅ |
| `logSupabaseError(scope, summary, error, ctx?)` で error は非 null `PostgrestError` | `cat src/lib/supabase/log-error.ts` | 一致 ✅（`error!` の非 null 断言を避ける設計が正しい） |
| 既存 `REPLICA IDENTITY` | `grep -rn "REPLICA IDENTITY" supabase/migrations/` | **0 件** |
| 既存 publication 対象 | grep | `meals`, `meal_reactions`, `shopping_items`, `stock_items`, `baby_logs` |
| テストのベースライン | `pnpm test:run` | **268 passed / 28 files / 2.24s** |
| `stock_items.quantity` の DB 制約 | initial_schema.sql | `NUMERIC NOT NULL DEFAULT 1`（CHECK なし） |

---

## V6. ローカル検証環境の実態（計画の「検証手段」の前提）

- `supabase start` は**ポート 54322 が別プロジェクト（inventory-hub）に占有され失敗**する。
  ```
  Bind for 0.0.0.0:54322 failed: port is already allocated
  ```
- irori の E2E（実 Supabase + Mailpit）を走らせるには、先に `supabase stop --project-id inventory-hub` するか、
  `supabase/config.toml` の db port を変える必要がある。**計画の E2E タスクにこの前提条件を明記する。**
- 他プロジェクトのスタックは**勝手に止めない**（別作業を巻き込む）。実行者が判断すること。
- 本検証では、稼働中 Postgres に一時テーブル + ROLLBACK で完全隔離して SQL 意味論のみを確認した（他データへの影響ゼロ、`docker ps -a | grep irori` → なし）。
