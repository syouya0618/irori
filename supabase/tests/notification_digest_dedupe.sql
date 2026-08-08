-- 毎朝ダイジェスト（B-5）が**キューの規律に乗っておること**を機械で固定する。
--
-- ## この表で守っておるもの
-- 1. **`UNIQUE NULLS NOT DISTINCT` が digest 行に効くこと**。ダイジェスト行は
--    `event_key IS NULL` ゆえ、既定の `NULLS DISTINCT` に戻った瞬間 NULL 同士が
--    衝突せず `ON CONFLICT DO NOTHING` が効かなくなる —— cron の重複起動と
--    5 分ごとの再展開のたびに行が積もり、**毎朝のまとめが 5 分ごとに鳴る**。
--    Safari は可視通知の雪崩に権限剥奪で応じるゆえ被害が二乗になる。
--    ⚠️ **この機能の生死を分ける 1 点じゃ。**
-- 2. **衝突が「広すぎ」もせぬこと**。鍵から `subscription_key` が落ちれば
--    配偶者のまとめが 1 通目に吸われて**片方にしか届かぬ**。`dedupe_day` が
--    落ちれば**翌日のまとめが永久に来ぬ**。どちらも「1 通は届く」ゆえ
--    衝突の assert だけでは検出できぬ — **対照（入る側）を同じ文脈に置く**。
-- 3. **`digest_time` が TZ を持たぬ TIME であり、JST として起こす契約**である
--    こと。UTC として起こせば 9 時間ずれ、朝のまとめが夕方に鳴る。
--    COMMENT の存在は B-2 の A-16 が見ておるゆえ、ここでは**算術そのもの**を撃つ。
--
-- ## 既存テストとの分担（重複を避けるための断り）
-- `notification_deliveries_rls.sql` の C-8/C-9 が「同一鍵の digest 行が 1 本に
-- なること」を既に固定しておる（B-3 が B-5 を見越して置いた）。本ファイルが足すのは
-- **2 人ぶん・2 日ぶんの対照**と**JST 算術**、すなわち B-5 が新たに持ち込む形じゃ。
--
-- ## information_schema を使わぬ理由（既存テストと同じ）
-- 走らせるロール次第で黙って 0 行になり偽緑になるため、catalog を直読みする。
--
-- ## 偽緑を潰す三段（既存テストの型を踏襲）
-- (P) positive control: relacl が NULL でないことを先に固定する。
-- (S) seed の固定: 件数 assert は**必ず seed した世帯へ限定**し、先に入ったことを assert。
-- (C) 対照: 「衝突する」だけでなく「衝突せぬ」を同じ文脈で assert する。
BEGIN;
SELECT plan(19);

-- ══════════════════════════════════════════════════════════════
-- A. 契約（静的・ロール切替なし）
-- ══════════════════════════════════════════════════════════════

-- ── A-0. positive control ─────────────────────────────────────
SELECT isnt(
  (SELECT relacl FROM pg_class WHERE oid = 'notification_deliveries'::regclass),
  NULL,
  'A-0: notification_deliveries の relacl は NULL でない（以降の前提）'
);

-- ── A-1. 冪等キーは NULLS NOT DISTINCT ────────────────────────
-- ⚠️ false なら NULL を含む鍵が衝突せぬ既定に戻っておる＝まとめが積もる。
SELECT ok(
  (SELECT i.indnullsnotdistinct
     FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
    WHERE c.relname = 'uq_notification_deliveries'),
  'A-1: uq_notification_deliveries は NULLS NOT DISTINCT（digest 行の生死を分ける）'
);

-- ── A-2. kind の allowlist に 'digest' が在る ─────────────────
SELECT ok(
  (SELECT pg_get_constraintdef(oid) FROM pg_constraint
    WHERE conname = 'chk_notification_deliveries_kind') LIKE '%digest%',
  'A-2: kind の CHECK が ''digest'' を許しておる'
);

-- ── A-3. digest_time は **TZ を持たぬ** TIME ──────────────────
-- timetz へ化けておれば「JST として解釈する」契約そのものが崩れる。
SELECT is(
  (SELECT format_type(a.atttypid, a.atttypmod) FROM pg_attribute a
    WHERE a.attrelid = 'notification_preferences'::regclass
      AND a.attname = 'digest_time'),
  'time without time zone',
  'A-3: digest_time は time without time zone（JST 壁時計として解釈する前提）'
);

-- ── A-4/A-5. JST 契約の算術（9 時間ずれを固定する）────────────
-- 配信ジョブ（digestScheduledAtForDay）が導く値と**同じ瞬間**を DB 側でも撃つ。
SELECT is(
  ((DATE '2026-08-10' + TIME '07:00') AT TIME ZONE 'Asia/Tokyo'),
  '2026-08-09T22:00:00Z'::timestamptz,
  'A-4: 2026-08-10 07:00 JST は UTC では **前日 22:00**'
);
-- 対照（negative control）: UTC として起こせば別の瞬間になる。この 9 時間が急所じゃ。
SELECT isnt(
  ((DATE '2026-08-10' + TIME '07:00') AT TIME ZONE 'UTC'),
  '2026-08-09T22:00:00Z'::timestamptz,
  'A-5: **対照** — UTC として起こせば 9 時間ずれる（素の now()::time 比較の罠）'
);

-- ══════════════════════════════════════════════════════════════
-- B. seed（**2 世帯 × 夫婦 2 人**。1 人だと片翼への縮退を見逃す）
-- ══════════════════════════════════════════════════════════════
INSERT INTO households (id, name) VALUES
  ('11111111-1111-1111-1111-111111111111', 'H1'),
  ('33333333-3333-3333-3333-333333333333', 'H2');
INSERT INTO auth.users (id, email) VALUES
  ('22222222-2222-2222-2222-222222222222', 'u1@example.com'),
  ('88888888-8888-8888-8888-888888888888', 'u2@example.com'),
  ('44444444-4444-4444-4444-444444444444', 'u3@example.com');
UPDATE profiles SET household_id = '11111111-1111-1111-1111-111111111111',
                    display_name = 'U1', role = 'owner', is_approved = true
  WHERE id = '22222222-2222-2222-2222-222222222222';
UPDATE profiles SET household_id = '11111111-1111-1111-1111-111111111111',
                    display_name = 'U2', role = 'member', is_approved = true
  WHERE id = '88888888-8888-8888-8888-888888888888';
UPDATE profiles SET household_id = '33333333-3333-3333-3333-333333333333',
                    display_name = 'U3', role = 'owner', is_approved = true
  WHERE id = '44444444-4444-4444-4444-444444444444';

INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth) VALUES
  ('55555555-0000-0000-0000-000000000001',
   '22222222-2222-2222-2222-222222222222', 'https://fcm.googleapis.com/u1', 'k1', 'a1'),
  ('55555555-0000-0000-0000-000000000002',
   '88888888-8888-8888-8888-888888888888', 'https://fcm.googleapis.com/u2', 'k2', 'a2'),
  ('55555555-0000-0000-0000-000000000003',
   '44444444-4444-4444-4444-444444444444', 'https://fcm.googleapis.com/u3', 'k3', 'a3');

-- 夫婦それぞれの時刻（**利用者ごと**の設定であることの記録）。
INSERT INTO notification_preferences (user_id, digest_time) VALUES
  ('22222222-2222-2222-2222-222222222222', '07:00'),
  ('88888888-8888-8888-8888-888888888888', '08:00');

-- ダイジェスト行: H1 の夫の端末へ 1 本、H2 へ 1 本。**event_key は NULL** じゃ。
--
-- ⚠️ **H2 は敢えて別の日にしてある。** 同じ日に固めると、冪等キーから
-- `subscription_key` を落とす仕込みを入れたとき **seed 自身が 23505 で落ち**、
-- トランザクションごと死んで「名前のある赤」が 1 本も出ぬ（＝ どの契約が壊れたか
-- 分からぬ）。日を分けておけば、その仕込みは狙いどおり C-3（配偶者の行）で赤くなる。
INSERT INTO notification_deliveries
  (household_id, kind, event_key, subscription_id, subscription_key,
   dedupe_day, scheduled_at)
VALUES
  ('11111111-1111-1111-1111-111111111111', 'digest', NULL,
   '55555555-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000001',
   '2026-08-10', '2026-08-09T22:00:00Z'),
  ('33333333-3333-3333-3333-333333333333', 'digest', NULL,
   '55555555-0000-0000-0000-000000000003', '55555555-0000-0000-0000-000000000003',
   '2026-08-12', '2026-08-11T22:00:00Z');

-- (S) seed が入ったことを先に固定する（0 件なら以降の「衝突する」は空回りする）。
-- ⚠️ **必ず seed した世帯へ限定する**。素の count(*) は開発機に残った行を数え、
-- 外部の状態でテストが割れる（approval_functions.sql が #201 で同じ直しを受けた）。
SELECT is(
  (SELECT count(*) FROM notification_deliveries
    WHERE kind = 'digest'
      AND household_id IN ('11111111-1111-1111-1111-111111111111',
                           '33333333-3333-3333-3333-333333333333')),
  2::bigint,
  'B-0: digest 行が 2 世帯ぶん入った（1 世帯 seed だと分離の縮退を見逃す）'
);
SELECT is(
  (SELECT count(*) FROM notification_preferences
    WHERE user_id IN ('22222222-2222-2222-2222-222222222222',
                      '88888888-8888-8888-8888-888888888888')
      AND digest_time IS NOT NULL),
  2::bigint,
  'B-1: 夫婦 2 人ぶんの digest_time が入った（**時刻は利用者ごと**）'
);

-- ══════════════════════════════════════════════════════════════
-- C. 冪等キーの実挙動（owner 権限。RLS は関係せぬ）
-- ══════════════════════════════════════════════════════════════

-- ── C-1. 同じ鍵の 2 行目は弾かれる（NULL 同士が衝突する）──────
-- 制約名で見る（`throws_ok` は errmsg を完全一致で比べるため、名前だけ渡すと落ちる）。
SELECT throws_like(
  $$ INSERT INTO notification_deliveries
       (household_id, kind, event_key, subscription_id, subscription_key,
        dedupe_day, scheduled_at)
     VALUES ('11111111-1111-1111-1111-111111111111', 'digest', NULL,
             '55555555-0000-0000-0000-000000000001',
             '55555555-0000-0000-0000-000000000001',
             '2026-08-10', '2026-08-09T22:05:00Z') $$,
  '%uq_notification_deliveries%',
  'C-1: **event_key が NULL でも 2 行目は弾かれる**（NULLS DISTINCT なら通る）'
);
-- SQLSTATE でも固定する（メッセージ文面の変化に依らぬ層）。
SELECT throws_ok(
  $$ INSERT INTO notification_deliveries
       (household_id, kind, event_key, subscription_id, subscription_key,
        dedupe_day, scheduled_at)
     VALUES ('11111111-1111-1111-1111-111111111111', 'digest', NULL,
             '55555555-0000-0000-0000-000000000001',
             '55555555-0000-0000-0000-000000000001',
             '2026-08-10', '2026-08-09T22:10:00Z') $$,
  '23505',
  'duplicate key value violates unique constraint "uq_notification_deliveries"',
  'C-2: 同じ鍵の衝突は 23505（unique_violation）'
);

-- ⚠️ **ここから先の順序は load-bearing じゃ。**
-- 「入る側」の対照（C-3〜C-5）は、`ON CONFLICT (…4 列…)` を含む文（C-6）より
-- **前**に置かねばならぬ。鍵の列を落とす仕込みを入れると、その ON CONFLICT が
-- 先に 42P10（no unique constraint matching）で落ち、**トランザクションごと死んで
-- 対照の assert に一度も到達せぬ** —— しかも `not ok` すら出ぬゆえ、件数だけ見る
-- harness には「静かな緑」に映る。実測でこれを踏み、順序を入れ替えた。
-- （`notification_deliveries_rls.sql` の C-2/C-3 が同じ注意書きを持っておる。）

-- ── C-3. **対照** 配偶者の端末は別行として入る ───────────────
-- 鍵から subscription_key が落ちれば、ここが赤くなる
-- （＝ 妻のまとめが夫の 1 通目に吸われて片翼にしか届かぬ状態の検出器じゃ）。
SELECT lives_ok(
  $$ INSERT INTO notification_deliveries
       (household_id, kind, event_key, subscription_id, subscription_key,
        dedupe_day, scheduled_at)
     VALUES ('11111111-1111-1111-1111-111111111111', 'digest', NULL,
             '55555555-0000-0000-0000-000000000002',
             '55555555-0000-0000-0000-000000000002',
             '2026-08-10', '2026-08-09T23:00:00Z') $$,
  'C-3: **対照** — 配偶者の端末宛は別行として入る（08:00 の設定ぶん）'
);

-- ── C-4. **対照** 翌日のまとめは別行として入る ───────────────
-- 鍵から dedupe_day が落ちれば、ここが赤くなる
-- （＝ 初日以降のまとめが永久に来ぬ状態の検出器じゃ）。
SELECT lives_ok(
  $$ INSERT INTO notification_deliveries
       (household_id, kind, event_key, subscription_id, subscription_key,
        dedupe_day, scheduled_at)
     VALUES ('11111111-1111-1111-1111-111111111111', 'digest', NULL,
             '55555555-0000-0000-0000-000000000001',
             '55555555-0000-0000-0000-000000000001',
             '2026-08-11', '2026-08-10T22:00:00Z') $$,
  'C-4: **対照** — 翌日ぶんは別行として入る（連日のまとめが 1 通で終わらぬ）'
);

-- ── C-5. **対照** 予定通知は NULL 同士の衝突に巻き込まれぬ ───
-- 同じ購読・同じ日でも event_key が異なれば共存する（「NULL 同士**だけ**が
-- 衝突しておる」ことの確認。全部が衝突しておるのではない）。
SELECT lives_ok(
  $$ INSERT INTO notification_deliveries
       (household_id, kind, event_key, subscription_id, subscription_key,
        dedupe_day, scheduled_at)
     VALUES ('11111111-1111-1111-1111-111111111111', 'event', 'ev-1',
             '55555555-0000-0000-0000-000000000001',
             '55555555-0000-0000-0000-000000000001',
             '2026-08-10', '2026-08-10T00:50:00Z'),
            ('11111111-1111-1111-1111-111111111111', 'event', 'ev-2',
             '55555555-0000-0000-0000-000000000001',
             '55555555-0000-0000-0000-000000000001',
             '2026-08-10', '2026-08-10T01:50:00Z') $$,
  'C-5: **対照** — 予定通知は event_key が異なれば同じ日・同じ端末でも共存する'
);

-- ── C-6. 展開の再実行は DO NOTHING に吸われる ────────────────
-- 配信ジョブが 5 分ごとに撃つ形そのもの。行が増えねば「1 日 1 通」が保たれる。
INSERT INTO notification_deliveries
  (household_id, kind, event_key, subscription_id, subscription_key,
   dedupe_day, scheduled_at)
VALUES ('11111111-1111-1111-1111-111111111111', 'digest', NULL,
        '55555555-0000-0000-0000-000000000001',
        '55555555-0000-0000-0000-000000000001',
        '2026-08-10', '2026-08-09T22:15:00Z')
ON CONFLICT (kind, event_key, subscription_key, dedupe_day) DO NOTHING;
-- ⚠️ 数えるのは「その端末・その日」の 1 本じゃ。世帯ぜんぶを数えると、上の
-- 対照で足した配偶者ぶん・翌日ぶんまで混ざって意味が濁る。
SELECT is(
  (SELECT count(*) FROM notification_deliveries
    WHERE kind = 'digest'
      AND subscription_key = '55555555-0000-0000-0000-000000000001'
      AND dedupe_day = '2026-08-10'),
  1::bigint,
  'C-6: 同じ日に何度展開しても 1 行（cron の重複起動で二重に鳴らぬ）'
);

-- ══════════════════════════════════════════════════════════════
-- D. RLS（まとめの履歴は**世帯**で見える）
-- ══════════════════════════════════════════════════════════════
SET LOCAL role authenticated;
SELECT set_config('request.jwt.claims',
  json_build_object('sub', '22222222-2222-2222-2222-222222222222',
                    'role', 'authenticated')::text, true);

-- ⚠️ **世帯単位であることの対照**。配偶者宛の digest 行が見えねば、設定カードの
-- 「最終配信」が夫婦で食い違い、片方の画面だけが「止まっておる」と読める。
SELECT is(
  (SELECT count(*) FROM notification_deliveries
    WHERE kind = 'digest' AND dedupe_day = '2026-08-10'),
  2::bigint,
  'D-1: 自世帯の digest 行 2 件（**配偶者宛も見える**）'
);
SELECT is(
  (SELECT count(*) FROM notification_deliveries
    WHERE kind = 'digest'
      AND subscription_key = '55555555-0000-0000-0000-000000000003'),
  0::bigint,
  'D-2: 他世帯の digest 行は 1 件も見えぬ（対照: 上で 2 件は見えておる）'
);
-- まとめの時刻は**個人設定**ゆえ、配偶者のぶんは見えぬ（世帯では開かぬ）。
SELECT is(
  (SELECT count(*) FROM notification_preferences),
  1::bigint,
  'D-3: digest_time は自分の 1 件のみ可視（**行は世帯・時刻は個人**の非対称）'
);

-- ── D-4. 設定カードの保存経路**そのもの** ─────────────────────
-- ⚠️ `updateDigestTime` の vitest は Supabase を丸ごと mock しておるゆえ、
-- **列 GRANT も RLS も一切見えぬ**。列 GRANT を (user_id, digest_time) より
-- 狭めれば、単体テストは緑のまま**本番の保存だけが 42501 で落ちる**。
-- ここが唯一の検出器じゃ（`event_reminders_grants_rls.sql` の F-17 が同じ理由で
-- 置かれておる —— あちらは「M16 の変異が A-10 でしか捕まらなかった」と実測を残す）。
--
-- 文は PostgREST が `.upsert({ onConflict: "user_id" })` から組み立てる形をそのまま
-- 写す: **送った 2 列だけ**を DO UPDATE の SET に並べる（`event_default_minutes` を
-- 混ぜると、まとめの時刻を変えるたびに予定通知の既定が消える）。
SELECT lives_ok(
  $$ INSERT INTO notification_preferences (user_id, digest_time)
     VALUES ('22222222-2222-2222-2222-222222222222', '08:30')
     ON CONFLICT (user_id) DO UPDATE
       SET user_id = excluded.user_id, digest_time = excluded.digest_time
     RETURNING user_id $$,
  'D-4: 設定カードの upsert（2 列・DO UPDATE・RETURNING）が authenticated で通る'
);
SELECT is(
  (SELECT digest_time FROM notification_preferences
    WHERE user_id = '22222222-2222-2222-2222-222222222222'),
  '08:30'::time,
  'D-5: 既存行への upsert が実際に書き換わっておる（0 行の静かな失敗でない）'
);

SELECT * FROM finish();
ROLLBACK;
