-- notification_deliveries / notification_heartbeat の **権限カタログ・世帯分離・
-- 冪等キー・FK の向き** を機械で固定する（B-3）。
--
-- ## この表で守っておるもの
-- 1. **UNIQUE NULLS NOT DISTINCT が効くこと**。既定の NULLS DISTINCT では
--    NULL を含む行が何行でも共存し `ON CONFLICT DO NOTHING` が効かぬ。
--    B-5 のダイジェスト行（event_key IS NULL）が 5 分ごとに鳴る形で表に出る。
-- 2. **世帯単位で見えること**。夫が受けた配信は妻からも見える（「最終配信」は
--    世帯の状態ゆえ）。ユーザー単位へ縮退すると、片方の画面だけが空になる。
--    ⚠️ `push_subscriptions` 経由の EXISTS で書くとこれが起きる — あちらの
--    SELECT ポリシーは `user_id = auth.uid()` ゆえ、**ポリシー式から参照した先にも
--    RLS が効く**。1 人 seed のテストでは永久に緑になるゆえ、**必ず夫婦 2 人**を撒く。
-- 3. **端末を失効させても履歴が残ること**（FK は SET NULL であって CASCADE でない）。
--    CASCADE だと MAX(sent_at) が過去へ巻き戻り、主は「通知基盤が死んだ」と誤読する。
--    さらに skip_reason='gone' の行がその DELETE で消えるため **'gone' は原理的に
--    一度も観測できぬ**。
-- 4. **2 台目の失効が 23505 で中断せぬこと**（本 migration の核 ③）。計画書は
--    冪等キーに `subscription_id` を入れよと書いておったが、SET NULL と噛み合わず
--    「この端末の通知をやめる」が恒久的に失敗する。C-4/C-5 がその実証じゃ。
--
-- ## information_schema を使わぬ理由（既存テストと同じ）
-- 走らせるロール次第で黙って 0 行になり偽緑になるため、catalog
-- （`pg_class.relacl` / `pg_attribute.attacl`）を `aclexplode` で直読みする。
--
-- ## 偽緑を潰す三段（既存テストの型を踏襲）
-- (P) positive control: `aclexplode(NULL)` は 0 行ゆえ、ACL が空でも negative
--     assert は緑になる。まず relacl が NULL でないことを固定する。
-- (S) seed の固定: 「他世帯のが見えぬ」は行が 0 件なら常に緑ゆえ、先に
--     **2 世帯ぶんの行が入ったこと**を assert する。
-- (C) 対照: 「見えぬ／書けぬ」だけでなく「見える／書ける」を同じ文脈で assert する。
BEGIN;
SELECT plan(44);

-- ══════════════════════════════════════════════════════════════
-- A. 権限カタログ・スキーマ（静的・ロール切替なし）
-- ══════════════════════════════════════════════════════════════

-- ── A-0. positive control ─────────────────────────────────────
SELECT isnt(
  (SELECT relacl FROM pg_class WHERE oid = 'notification_deliveries'::regclass),
  NULL,
  'A-0a: notification_deliveries の relacl は NULL でない（以降の negative assert の前提）'
);
SELECT isnt(
  (SELECT relacl FROM pg_class WHERE oid = 'notification_heartbeat'::regclass),
  NULL,
  'A-0b: notification_heartbeat の relacl は NULL でない'
);

-- ── A-1. authenticated のテーブル権限は「ちょうど」SELECT のみ ──
-- 書き手は service role の配信ジョブ 1 つ。INSERT/UPDATE/DELETE が生えたら赤。
SELECT set_eq(
  $$
  SELECT acl.privilege_type::text
  FROM pg_class c
  CROSS JOIN LATERAL aclexplode(c.relacl) acl
  WHERE c.oid = 'notification_deliveries'::regclass
    AND acl.grantee = 'authenticated'::regrole
  $$,
  ARRAY['SELECT'],
  'A-1: authenticated は notification_deliveries を読めるだけ（書込は service role のみ）'
);
SELECT set_eq(
  $$
  SELECT acl.privilege_type::text
  FROM pg_class c
  CROSS JOIN LATERAL aclexplode(c.relacl) acl
  WHERE c.oid = 'notification_heartbeat'::regclass
    AND acl.grantee = 'authenticated'::regrole
  $$,
  ARRAY['SELECT'],
  'A-2: authenticated は notification_heartbeat を読めるだけ'
);

-- ── A-3. anon は一切の権限を持たぬ（両表・テーブル権限と列権限とも）──
SELECT is_empty(
  $$
  SELECT c.relname::text || ':' || acl.privilege_type
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN LATERAL aclexplode(c.relacl) acl
  WHERE n.nspname = 'public'
    AND c.relname IN ('notification_deliveries', 'notification_heartbeat')
    AND acl.grantee = 'anon'::regrole
  UNION ALL
  SELECT c.relname::text || '.' || a.attname
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN LATERAL aclexplode(a.attacl) acl
  WHERE n.nspname = 'public'
    AND c.relname IN ('notification_deliveries', 'notification_heartbeat')
    AND acl.grantee = 'anon'::regrole
  $$,
  'A-3: anon は両表に一切の権限を持たぬ'
);

-- ── A-4. ポリシーは SELECT ただ 1 種（FOR ALL 禁止も同時に固定）──
-- polcmd: r=SELECT / a=INSERT / w=UPDATE / d=DELETE / *=ALL。
SELECT set_eq(
  $$ SELECT polcmd::text FROM pg_policy
     WHERE polrelid = 'notification_deliveries'::regclass $$,
  ARRAY['r'],
  'A-4: notification_deliveries のポリシーは SELECT のみ（IUD ポリシー無し / FOR ALL 無し）'
);
-- ⚠️ **心拍にポリシーが 0 本だと RLS 有効 = deny-all** になり、画面が常に空になる。
-- しかも「まだ走っておらぬ」と区別がつかぬ = 最悪の壊れ方ゆえ、在ることを固定する。
SELECT set_eq(
  $$ SELECT polcmd::text FROM pg_policy
     WHERE polrelid = 'notification_heartbeat'::regclass $$,
  ARRAY['r'],
  'A-5: notification_heartbeat に SELECT ポリシーが**在る**（0 本だと deny-all で常に空）'
);
SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'notification_deliveries'::regclass)
  AND (SELECT relrowsecurity FROM pg_class WHERE oid = 'notification_heartbeat'::regclass),
  'A-6: 両表とも RLS が有効'
);

-- ── A-7. 冪等キーは **NULLS NOT DISTINCT** ────────────────────
-- pg_index.indnullsnotdistinct が false なら、NULL を含む鍵が衝突せぬ既定に
-- 戻っておる（= B-5 のダイジェストが繰り返し鳴る）。定義文でも固定する。
SELECT ok(
  (SELECT i.indnullsnotdistinct
     FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
    WHERE c.relname = 'uq_notification_deliveries'),
  'A-7: uq_notification_deliveries は NULLS NOT DISTINCT'
);
SELECT is(
  (SELECT pg_get_constraintdef(oid) FROM pg_constraint
    WHERE conname = 'uq_notification_deliveries'),
  'UNIQUE NULLS NOT DISTINCT (kind, event_key, subscription_key, dedupe_day)',
  'A-8: 冪等キーは (kind, event_key, subscription_key, dedupe_day) — **scheduled_at も subscription_id も入らぬ**'
);

-- ── A-9. FK の向き ────────────────────────────────────────────
-- confdeltype: a=NO ACTION / r=RESTRICT / c=CASCADE / n=SET NULL / d=SET DEFAULT
SELECT is(
  (SELECT confdeltype FROM pg_constraint
    WHERE conrelid = 'notification_deliveries'::regclass
      AND contype = 'f' AND confrelid = 'push_subscriptions'::regclass),
  'n'::"char",
  'A-9: subscription_id は **SET NULL**（CASCADE だと端末失効で過去の sent_at が消える）'
);
SELECT is(
  (SELECT confdeltype FROM pg_constraint
    WHERE conrelid = 'notification_deliveries'::regclass
      AND contype = 'f' AND confrelid = 'households'::regclass),
  'c'::"char",
  'A-10: household_id は CASCADE（世帯が消えれば履歴も消えてよい）'
);
-- event_key に FK を張らぬこと（410 フル再同期で予定の id が入れ替わるため）。
SELECT is_empty(
  $$
  SELECT conname::text FROM pg_constraint
  WHERE conrelid = 'notification_deliveries'::regclass
    AND contype = 'f'
    AND confrelid IN ('calendar_events'::regclass, 'event_reminders'::regclass)
  $$,
  'A-11: 予定・通知設定への FK は**無い**（410 の DELETE→INSERT を跨ぐため）'
);

-- ── A-12. 秘密を持つ表を Realtime publication へ載せておらぬ ──
-- ここは能力を持たぬ表じゃが、「載せぬ」と宣言した以上は機械で固定する。
SELECT is_empty(
  $$
  SELECT tablename::text FROM pg_publication_tables
  WHERE pubname = 'supabase_realtime'
    AND tablename IN ('notification_deliveries', 'notification_heartbeat')
  $$,
  'A-12: 両表とも Realtime publication に載っておらぬ（明文宣言どおり）'
);

-- ── A-13. 心拍は 1 行しか持てぬ ───────────────────────────────
SELECT is(
  (SELECT pg_get_constraintdef(oid) FROM pg_constraint
    WHERE conname = 'chk_notification_heartbeat_singleton'),
  'CHECK ((id = 1))',
  'A-13: 心拍は id = 1 の 1 行に限られる'
);

-- ══════════════════════════════════════════════════════════════
-- B. seed（**2 世帯 × 夫婦 2 人**）
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
-- U2 は**同世帯の配偶者**。世帯単位であることの対照に使う。
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

-- 配信行: H1 に 2 件（夫の端末・妻の端末。**同じ予定・同じ日**）、H2 に 1 件。
INSERT INTO notification_deliveries
  (household_id, kind, event_key, subscription_id, subscription_key,
   dedupe_day, scheduled_at, sent_at)
VALUES
  ('11111111-1111-1111-1111-111111111111', 'event', 'ev-1',
   '55555555-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000001',
   '2026-08-15', '2026-08-15T00:50:00Z', '2026-08-15T00:50:01Z'),
  ('11111111-1111-1111-1111-111111111111', 'event', 'ev-1',
   '55555555-0000-0000-0000-000000000002', '55555555-0000-0000-0000-000000000002',
   '2026-08-15', '2026-08-15T00:50:00Z', '2026-08-15T00:50:02Z'),
  ('33333333-3333-3333-3333-333333333333', 'event', 'ev-2',
   '55555555-0000-0000-0000-000000000003', '55555555-0000-0000-0000-000000000003',
   '2026-08-15', '2026-08-15T00:50:00Z', NULL);

-- ⚠️ **`ON CONFLICT` を外すな。** 心拍は 1 行固定ゆえ、開発機で cron を一度でも
-- 叩いておれば（e2e が実際に叩く）行は既に在る。素の INSERT だと 23505 で
-- **トランザクションごと落ち、以降の assert が 1 本も走らぬまま「not ok が 0 件」に
-- 見える** — 実際にこれを踏んだ。件数だけ見る harness では気付けぬ形の偽緑じゃ。
INSERT INTO notification_heartbeat (id, ran_at, sent_count, skipped_count, failed_count)
  VALUES (1, '2026-08-15T00:50:03Z', 2, 0, 0)
  ON CONFLICT (id) DO UPDATE
    SET ran_at = EXCLUDED.ran_at, sent_count = EXCLUDED.sent_count,
        skipped_count = EXCLUDED.skipped_count, failed_count = EXCLUDED.failed_count;

-- ⚠️ 以降の件数 assert は**必ず seed した世帯へ限定する**。素の `count(*)` は
-- 開発機に残った他の行を数え、外部の状態でテストが割れる
-- （`approval_functions.sql` が #201 で同じ直しを受けておる）。
SELECT is(
  (SELECT count(*) FROM notification_deliveries
    WHERE household_id IN ('11111111-1111-1111-1111-111111111111',
                           '33333333-3333-3333-3333-333333333333')),
  3::bigint,
  'B-0: seed が 3 件（2 世帯ぶん。1 世帯 seed だと分離の縮退を見逃す）');

-- ══════════════════════════════════════════════════════════════
-- C. 冪等キーと FK の**実挙動**（owner 権限。RLS は関係せぬ）
-- ══════════════════════════════════════════════════════════════

-- ── C-1. 同じ鍵の 2 行目は弾かれる ───────────────────────────
SELECT throws_like(
  $$ INSERT INTO notification_deliveries
       (household_id, kind, event_key, subscription_id, subscription_key,
        dedupe_day, scheduled_at)
     VALUES ('11111111-1111-1111-1111-111111111111', 'event', 'ev-1',
             '55555555-0000-0000-0000-000000000001',
             '55555555-0000-0000-0000-000000000001',
             '2026-08-15', '2026-08-15T01:00:00Z') $$,
  '%uq_notification_deliveries%',
  'C-1: 同じ (kind, event_key, subscription_key, dedupe_day) の 2 行目は弾かれる'
);

-- ── C-2/C-3. **2 台の端末を順に失効させても DELETE が中断せぬ** ──
-- ⚠️ ここが本 migration の核 ③ の実証じゃ。冪等キーに `subscription_id` を
-- 入れると、2 台目の SET NULL が 1 台目の NULL 行と衝突して 23505 になり、
-- **DELETE そのものが中断する**（= 設定カードの「この端末の通知をやめる」が
-- 恒久的に失敗し、cron の 410 掃除も道連れになる）。
--
-- ⚠️ **順序と `lives_ok` が両方とも load-bearing じゃ。**
--   * 順序: 下の `ON CONFLICT (…subscription_key…)` を含む文より**先**に置く。
--     後ろに置くと、鍵を差し替える仕込みでは先に 42P10 が出て**トランザクション
--     ごと落ち、この assert に到達せぬ**（＝緑に見えるが実は走っておらぬ）。
--     実際に一度そう作って、仕込みで A-8 しか赤くならず露見した。
--   * `lives_ok`: 素の DELETE が raise するとファイル全体が死んで `not ok` すら
--     出ぬ。サブトランザクションで捕まえてこそ「どの assert が割れたか」が残る。
SELECT lives_ok(
  $$ DELETE FROM push_subscriptions
      WHERE id = '55555555-0000-0000-0000-000000000001' $$,
  'C-2: 1 台目の失効は通る'
);
SELECT lives_ok(
  $$ DELETE FROM push_subscriptions
      WHERE id = '55555555-0000-0000-0000-000000000002' $$,
  'C-3: **2 台目の失効も通る**（鍵に subscription_id を入れると 23505 でここが割れる）'
);
SELECT is(
  (SELECT count(*) FROM push_subscriptions
    WHERE user_id IN ('22222222-2222-2222-2222-222222222222',
                      '88888888-8888-8888-8888-888888888888')),
  0::bigint,
  'C-4: 2 台とも実際に消えておる（lives_ok が「何もせず生きておる」を緑にせぬ対照）'
);

-- ── C-5. 失効しても履歴は残り、sent_at は巻き戻らぬ ──────────
SELECT is(
  (SELECT count(*) FROM notification_deliveries
    WHERE household_id = '11111111-1111-1111-1111-111111111111'
      AND sent_at IS NOT NULL),
  2::bigint,
  'C-5: 端末を 2 台とも失効させても過去の sent_at 行は残る（CASCADE なら 0 件になる）'
);
SELECT is(
  (SELECT count(*) FROM notification_deliveries
    WHERE household_id = '11111111-1111-1111-1111-111111111111'
      AND subscription_id IS NULL AND subscription_key IS NOT NULL),
  2::bigint,
  'C-6: 指し先は NULL になるが **subscription_key は残る**（どの端末だったか追える）'
);

-- ── C-7. **scheduled_at は鍵に入っておらぬ** ─────────────────
-- 入っておれば C-1（時刻だけ違う行）が通ってしまう。ここでは「同じ鍵・別の時刻」が
-- DO NOTHING に吸われることを積極的に確かめる。**PostgREST が撃つ文そのもの**を
-- 書いてあるゆえ、鍵の列が揃わねば 42P10 でここが割れる（fake では取れぬ検査）。
-- 端末は上で 2 台とも失効させたゆえ、宛先は NULL・鍵は不変コピーだけで立てる。
INSERT INTO notification_deliveries
  (household_id, kind, event_key, subscription_id, subscription_key,
   dedupe_day, scheduled_at)
VALUES ('11111111-1111-1111-1111-111111111111', 'event', 'ev-1',
        NULL, '55555555-0000-0000-0000-000000000001',
        '2026-08-15', '2026-08-15T02:00:00Z')
ON CONFLICT (kind, event_key, subscription_key, dedupe_day) DO NOTHING;
SELECT is(
  (SELECT count(*) FROM notification_deliveries WHERE household_id IN ('11111111-1111-1111-1111-111111111111',
                     '33333333-3333-3333-3333-333333333333')),
  3::bigint,
  'C-7: 時刻だけ違う行は ON CONFLICT DO NOTHING に吸われる（予定の編集で二重にならぬ）');

-- ── C-8/C-9. **NULLS NOT DISTINCT が効く**（計画書が名指しした要件）──
-- event_key を NULL にした行（B-5 のダイジェスト）を同じ値で 2 回入れる。
INSERT INTO notification_deliveries
  (household_id, kind, event_key, subscription_id, subscription_key,
   dedupe_day, scheduled_at)
VALUES ('11111111-1111-1111-1111-111111111111', 'digest', NULL,
        NULL, '55555555-0000-0000-0000-000000000001',
        '2026-08-15', '2026-08-15T21:00:00Z');
INSERT INTO notification_deliveries
  (household_id, kind, event_key, subscription_id, subscription_key,
   dedupe_day, scheduled_at)
VALUES ('11111111-1111-1111-1111-111111111111', 'digest', NULL,
        NULL, '55555555-0000-0000-0000-000000000001',
        '2026-08-15', '2026-08-15T21:05:00Z')
ON CONFLICT (kind, event_key, subscription_key, dedupe_day) DO NOTHING;
SELECT is(
  (SELECT count(*) FROM notification_deliveries
    WHERE household_id = '11111111-1111-1111-1111-111111111111' AND kind = 'digest'),
  1::bigint,
  'C-8: **event_key が NULL でも 2 行目は入らぬ**（既定の NULLS DISTINCT なら 2 行になる）'
);
-- 素の INSERT なら例外になることも見る（DO NOTHING が隠しておらぬ証拠）。
SELECT throws_like(
  $$ INSERT INTO notification_deliveries
       (household_id, kind, event_key, subscription_id, subscription_key,
        dedupe_day, scheduled_at)
     VALUES ('11111111-1111-1111-1111-111111111111', 'digest', NULL,
             NULL, '55555555-0000-0000-0000-000000000001',
             '2026-08-15', '2026-08-15T21:10:00Z') $$,
  '%uq_notification_deliveries%',
  'C-9: NULL を含む鍵でも UNIQUE が発火する（DO NOTHING が黙らせておるのではない）'
);
DELETE FROM notification_deliveries
 WHERE household_id = '11111111-1111-1111-1111-111111111111' AND kind = 'digest';

-- ── C-10〜C-14. 状態の CHECK ─────────────────────────────────
SELECT throws_like(
  $$ UPDATE notification_deliveries
        SET skipped_at = now(), skip_reason = 'gone'
      WHERE household_id = '11111111-1111-1111-1111-111111111111' AND sent_at IS NOT NULL $$,
  '%chk_notification_deliveries_terminal%',
  'C-10: sent_at と skipped_at は排他（届いておらぬ通知が「最終配信」に数えられぬ）'
);
SELECT throws_like(
  $$ UPDATE notification_deliveries SET skipped_at = now()
      WHERE household_id = '33333333-3333-3333-3333-333333333333'
        AND sent_at IS NULL $$,
  '%chk_notification_deliveries_skip_pairing%',
  'C-11: 理由なき skip は書けぬ'
);
SELECT throws_like(
  $$ UPDATE notification_deliveries
        SET skipped_at = now(), skip_reason = 'なんとなく'
      WHERE household_id = '33333333-3333-3333-3333-333333333333'
        AND sent_at IS NULL $$,
  '%chk_notification_deliveries_skip_reason%',
  'C-12: 理由は allowlist の 4 種のみ'
);
SELECT throws_like(
  $$ INSERT INTO notification_deliveries
       (household_id, kind, event_key, subscription_key, dedupe_day, scheduled_at)
     VALUES ('11111111-1111-1111-1111-111111111111', 'event', NULL,
             'sk', '2026-08-15', now()) $$,
  '%chk_notification_deliveries_event_key%',
  'C-13: 予定通知は event_key を必ず持つ'
);
SELECT throws_like(
  $$ INSERT INTO notification_heartbeat
       (id, ran_at, sent_count, skipped_count, failed_count)
     VALUES (2, now(), 0, 0, 0) $$,
  '%chk_notification_heartbeat_singleton%',
  'C-14: 心拍の 2 行目は作れぬ'
);

-- 対照: 許された遷移は書ける（上の 5 本が「単に全部壊れておる」のではない証拠）。
UPDATE notification_deliveries
   SET skipped_at = now(), skip_reason = 'expired'
 WHERE household_id = '33333333-3333-3333-3333-333333333333'
   AND sent_at IS NULL;
SELECT is(
  (SELECT count(*) FROM notification_deliveries
    WHERE household_id IN ('11111111-1111-1111-1111-111111111111',
                     '33333333-3333-3333-3333-333333333333') AND skip_reason = 'expired'),
  1::bigint,
  'C-15: **対照** — 正しい skip は書ける（H2 の未送信行 1 件）'
);
-- 以降の件数 assert を崩さぬよう戻す。
UPDATE notification_deliveries SET skipped_at = NULL, skip_reason = NULL
 WHERE household_id IN ('11111111-1111-1111-1111-111111111111',
                     '33333333-3333-3333-3333-333333333333') AND skip_reason = 'expired';

-- ══════════════════════════════════════════════════════════════
-- D. RLS の実挙動（authenticated + JWT claims）
-- ══════════════════════════════════════════════════════════════
SET LOCAL role authenticated;
SELECT set_config('request.jwt.claims',
  json_build_object('sub', '22222222-2222-2222-2222-222222222222',
                    'role', 'authenticated')::text, true);

SELECT is((SELECT count(*) FROM notification_deliveries), 2::bigint,
  'D-1: 自世帯の配信行 2 件のみ可視（他世帯の 1 件は見えぬ）');
SELECT is(
  (SELECT count(*) FROM notification_deliveries WHERE event_key = 'ev-2'),
  0::bigint,
  'D-2: 他世帯の配信行は 1 件も見えぬ（対照: 上で 2 件は見えておる）'
);
-- ⚠️ **世帯単位であることの対照**。push_subscriptions 経由の EXISTS で世帯を
-- 書くと、あちらの RLS（user_id = auth.uid()）が効いてここが 1 件に縮退する。
SELECT is(
  (SELECT count(*) FROM notification_deliveries
    WHERE subscription_key = '55555555-0000-0000-0000-000000000002'),
  1::bigint,
  'D-3: **配偶者の端末宛の配信行も見える**（ユーザー単位への縮退を検知する）'
);
-- 「最終配信」が世帯で一致することを、実際に使う形（MAX）で見る。
SELECT is(
  (SELECT max(sent_at) FROM notification_deliveries),
  '2026-08-15T00:50:02Z'::timestamptz,
  'D-4: MAX(sent_at) は配偶者の配信を含む（端末失効で巻き戻っておらぬ）'
);

-- 書込は一切できぬ（ポリシーも GRANT も無い）。
SELECT throws_ok(
  $$ UPDATE notification_deliveries SET sent_at = now() $$,
  '42501', 'permission denied for table notification_deliveries',
  'D-5: authenticated は配信行を書き換えられぬ');
SELECT throws_ok(
  $$ DELETE FROM notification_deliveries $$,
  '42501', 'permission denied for table notification_deliveries',
  'D-6: authenticated は配信行を消せぬ（履歴の改竄を防ぐ）');
SELECT throws_ok(
  $$ INSERT INTO notification_deliveries
       (household_id, kind, event_key, subscription_key, dedupe_day, scheduled_at)
     VALUES ('11111111-1111-1111-1111-111111111111', 'event', 'x', 'y',
             '2026-08-15', now()) $$,
  '42501', 'permission denied for table notification_deliveries',
  'D-7: authenticated は配信行を作れぬ（偽の履歴を仕込めぬ）');

-- 心拍は読めるが書けぬ。
SELECT is((SELECT count(*) FROM notification_heartbeat), 1::bigint,
  'D-8: 認証済みなら心拍を読める（読めねば「故障」と「無風」を分けられぬ）');
SELECT throws_ok(
  $$ UPDATE notification_heartbeat SET ran_at = now() $$,
  '42501', 'permission denied for table notification_heartbeat',
  'D-9: authenticated は心拍を書き換えられぬ');

-- ── 配偶者から見ても同じ 2 件（世帯単位の対称性）──────────────
SELECT set_config('request.jwt.claims',
  json_build_object('sub', '88888888-8888-8888-8888-888888888888',
                    'role', 'authenticated')::text, true);
SELECT is((SELECT count(*) FROM notification_deliveries), 2::bigint,
  'D-10: **配偶者から見ても同じ 2 件**（片方だけが見える縮退を潰す）');

-- ── 他世帯からは自分の 1 件だけ ───────────────────────────────
SELECT set_config('request.jwt.claims',
  json_build_object('sub', '44444444-4444-4444-4444-444444444444',
                    'role', 'authenticated')::text, true);
SELECT is((SELECT count(*) FROM notification_deliveries), 1::bigint,
  'D-11: 他世帯からは自世帯の 1 件のみ（対照）');

-- ── 未認証（anon）は何も触れぬ ───────────────────────────────
SET LOCAL role anon;
SELECT set_config('request.jwt.claims', NULL, true);
SELECT throws_ok(
  $$ SELECT count(*) FROM notification_deliveries $$,
  '42501', 'permission denied for table notification_deliveries',
  'D-12: anon は配信行を読めぬ');
SELECT throws_ok(
  $$ SELECT count(*) FROM notification_heartbeat $$,
  '42501', 'permission denied for table notification_heartbeat',
  'D-13: anon は心拍を読めぬ');

SELECT * FROM finish();
ROLLBACK;
