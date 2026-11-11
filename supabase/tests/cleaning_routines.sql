-- 掃除ルーティーン（cleaning_routines / cleaning_logs）の契約。
--   * 正規メンバーは読み書きでき、別世帯・viewer・子ども閲覧招待の受諾者・anon には非公開（X-06）
--   * 直接 DML は拒否、書込は RPC だけ（X-07 / X-08）
--   * 同じ操作 ID の再送は replayed、古い版は conflict（X-09 / X-10）
--   * 同じ回を 2 人が完了しても有効行は 1 行（B-06）。取り消せば再び完了できる（B-05）
--   * 未来日の実施は記録しない（B-07g）。過去日の追記は現在の回を閉じない（B-06）
--   * 周期を変えた後、変更前の格子で閉じた鍵は新しい格子の予定日を覆わない（B-02 / R16）
--   * 実施基準のスキップは対象回の予定日を履歴に残す（鍵が予定日から逃げた回でも次回は予定日から。B-07f）
-- 日付は実行日に依らぬよう、JST の今日からの相対（pg_temp.d(n)）で組む。
BEGIN;
SELECT plan(178);

CREATE FUNCTION pg_temp.d(integer) RETURNS date LANGUAGE sql STABLE AS
  $$ SELECT (now() AT TIME ZONE 'Asia/Tokyo')::date + $1 $$;

INSERT INTO households(id,name) VALUES
  ('f6000000-0000-4000-8000-000000000001','synthetic cleaning A'),
  ('f6000000-0000-4000-8000-000000000002','synthetic cleaning B');
INSERT INTO auth.users(id,email) VALUES
  ('f6000000-0000-4000-8000-000000000003','cleaning-a1@example.invalid'),
  ('f6000000-0000-4000-8000-000000000004','cleaning-a2@example.invalid'),
  ('f6000000-0000-4000-8000-000000000005','cleaning-b1@example.invalid'),
  ('f6000000-0000-4000-8000-000000000006','cleaning-guest@example.invalid');
UPDATE profiles SET household_id='f6000000-0000-4000-8000-000000000001',is_approved=true,role='owner' WHERE id='f6000000-0000-4000-8000-000000000003';
UPDATE profiles SET household_id='f6000000-0000-4000-8000-000000000001',is_approved=true,role='member' WHERE id='f6000000-0000-4000-8000-000000000004';
UPDATE profiles SET household_id='f6000000-0000-4000-8000-000000000002',is_approved=true,role='owner' WHERE id='f6000000-0000-4000-8000-000000000005';
CREATE TEMP TABLE fx(k text PRIMARY KEY, v jsonb); GRANT ALL ON fx TO authenticated;

-- ── 世帯 A の owner: 作成 → 読込 ──
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims','{"sub":"f6000000-0000-4000-8000-000000000003","role":"authenticated"}',true);

SELECT is((save_cleaning_routine('f6000000-0000-4000-8000-000000000010',NULL,'  synthetic bathroom drain  ','synthetic bath','week',1,'fixed',pg_temp.d(-14),false)->>'status'),'saved','member creates a fixed weekly routine');
SELECT is((SELECT name FROM cleaning_routines WHERE id='f6000000-0000-4000-8000-000000000010'),'synthetic bathroom drain','name is stored trimmed');
SELECT is((SELECT resume_floor FROM cleaning_routines WHERE id='f6000000-0000-4000-8000-000000000010'),pg_temp.d(0),'fixed routine does not count dates before its creation day');
SELECT is((SELECT household_id FROM cleaning_routines WHERE id='f6000000-0000-4000-8000-000000000010'),'f6000000-0000-4000-8000-000000000001'::uuid,'household comes from the caller, not from an argument');
SELECT is((save_cleaning_routine('f6000000-0000-4000-8000-000000000010',NULL,'synthetic bathroom drain','synthetic bath','week',1,'fixed',pg_temp.d(-14),false)->>'status'),'replayed','same id and content replays without a version');
SELECT is((save_cleaning_routine('f6000000-0000-4000-8000-000000000010','2020-01-01T00:00:00Z','synthetic renamed','synthetic bath','week',1,'fixed',pg_temp.d(-14),false)->>'status'),'conflict','stale version cannot overwrite the definition');
SELECT is((SELECT name FROM cleaning_routines WHERE id='f6000000-0000-4000-8000-000000000010'),'synthetic bathroom drain','conflict left the row untouched');
SELECT is((save_cleaning_routine('f6000000-0000-4000-8000-000000000011',NULL,'synthetic filter',NULL,'month',3,'after_done',pg_temp.d(0),false)->>'status'),'saved','after_done routine without a location');
SELECT is((SELECT resume_floor FROM cleaning_routines WHERE id='f6000000-0000-4000-8000-000000000011'),NULL::date,'after_done keeps the chosen first due date');
SELECT throws_ok($$SELECT save_cleaning_routine('f6000000-0000-4000-8000-000000000019',NULL,'synthetic x',NULL,'week',53,'fixed',pg_temp.d(0),false)$$,'22023',NULL,'interval above the unit limit is rejected');
SELECT throws_ok($$SELECT save_cleaning_routine('f6000000-0000-4000-8000-000000000019',NULL,'synthetic x',NULL,'day',1,'fixed',pg_temp.d(0),false)$$,'22023',NULL,'unknown cadence unit is rejected');
SELECT throws_ok($$SELECT save_cleaning_routine('f6000000-0000-4000-8000-000000000019',NULL,'   ',NULL,'week',1,'fixed',pg_temp.d(0),false)$$,'22023',NULL,'blank name is rejected');
SELECT throws_ok($$SELECT save_cleaning_routine('f6000000-0000-4000-8000-000000000019',NULL,'synthetic x',NULL,'week',1,'fixed',NULL,false)$$,'22023',NULL,'missing anchor date is rejected');
SELECT throws_ok($$SELECT save_cleaning_routine('f6000000-0000-4000-8000-000000000019',NULL,'synthetic x',NULL,'week',1,'fixed',pg_temp.d(0),true)$$,'22023',NULL,'a routine cannot be created archived');
SELECT throws_ok($$SELECT save_cleaning_routine('f6000000-0000-4000-8000-000000000019',now(),'synthetic x',NULL,'week',1,'fixed',pg_temp.d(0),false)$$,'42501',NULL,'a version for a missing row is refused');
SELECT is((SELECT count(*) FROM cleaning_routines),2::bigint,'creator reads both routines');

-- ── 完了: 再送・同じ回・未来日・過去日の追記・版 ──
SELECT is((record_cleaning_log('f6000000-0000-4000-8000-000000000020','f6000000-0000-4000-8000-000000000010',(SELECT updated_at FROM cleaning_routines WHERE id='f6000000-0000-4000-8000-000000000010'),'done',pg_temp.d(0),pg_temp.d(-7),NULL)->>'status'),'saved','completion closes the occurrence');
SELECT is((record_cleaning_log('f6000000-0000-4000-8000-000000000020','f6000000-0000-4000-8000-000000000010','2020-01-01T00:00:00Z','done',pg_temp.d(0),pg_temp.d(-7),NULL)->>'status'),'replayed','same operation id replays even with a stale routine version');
SELECT throws_ok($$SELECT record_cleaning_log('f6000000-0000-4000-8000-000000000020','f6000000-0000-4000-8000-000000000010',now(),'done',pg_temp.d(-1),pg_temp.d(-7),NULL)$$,'23505',NULL,'same operation id cannot carry different content');
SELECT throws_ok($$SELECT record_cleaning_log('f6000000-0000-4000-8000-000000000021','f6000000-0000-4000-8000-000000000010',(SELECT updated_at FROM cleaning_routines WHERE id='f6000000-0000-4000-8000-000000000010'),'done',pg_temp.d(1),pg_temp.d(0),NULL)$$,'22023','done_on in the future','a future day is never recorded as done');
SELECT is((SELECT count(*) FROM cleaning_logs WHERE id='f6000000-0000-4000-8000-000000000021'),0::bigint,'rejected future completion left no row');
SELECT is((record_cleaning_log('f6000000-0000-4000-8000-000000000022','f6000000-0000-4000-8000-000000000010',(SELECT updated_at FROM cleaning_routines WHERE id='f6000000-0000-4000-8000-000000000010'),'done',pg_temp.d(-3),NULL,' synthetic backfill ')->>'status'),'saved','a past day can be appended without an occurrence');
SELECT is((SELECT note FROM cleaning_logs WHERE id='f6000000-0000-4000-8000-000000000022'),'synthetic backfill','note is stored trimmed');
SELECT is((SELECT max_occurrence FROM cleaning_log_marks('f6000000-0000-4000-8000-000000000010')),pg_temp.d(-7),'appended past record does not close any occurrence');
SELECT is((SELECT last_done_on FROM cleaning_log_marks('f6000000-0000-4000-8000-000000000010')),pg_temp.d(0),'last done day is the newest valid done log');
SELECT is((record_cleaning_log('f6000000-0000-4000-8000-000000000023','f6000000-0000-4000-8000-000000000010','2020-01-01T00:00:00Z','done',pg_temp.d(0),pg_temp.d(0),NULL)->>'status'),'conflict','stale routine version is a conflict for a new log');
SELECT is((SELECT count(*) FROM cleaning_logs WHERE id='f6000000-0000-4000-8000-000000000023'),0::bigint,'conflict wrote nothing');
SELECT throws_ok($$SELECT record_cleaning_log('f6000000-0000-4000-8000-000000000023','f6000000-0000-4000-8000-000000000010',(SELECT updated_at FROM cleaning_routines WHERE id='f6000000-0000-4000-8000-000000000010'),'done',pg_temp.d(0),pg_temp.d(60),NULL)$$,'22023','occurrence out of range','a far-future occurrence cannot be closed');
SELECT throws_ok($$SELECT record_cleaning_log('f6000000-0000-4000-8000-000000000023','f6000000-0000-4000-8000-000000000010',(SELECT updated_at FROM cleaning_routines WHERE id='f6000000-0000-4000-8000-000000000010'),'done',pg_temp.d(0),pg_temp.d(-21),NULL)$$,'22023','occurrence out of range','a fixed routine has no occurrence before its anchor');
SELECT throws_ok($$SELECT record_cleaning_log('f6000000-0000-4000-8000-000000000023','f6000000-0000-4000-8000-000000000010',(SELECT updated_at FROM cleaning_routines WHERE id='f6000000-0000-4000-8000-000000000010'),'skip',pg_temp.d(0),pg_temp.d(0),NULL)$$,'22023',NULL,'a skip carries no done day');
SELECT throws_ok($$SELECT record_cleaning_log('f6000000-0000-4000-8000-000000000023','f6000000-0000-4000-8000-000000000010',(SELECT updated_at FROM cleaning_routines WHERE id='f6000000-0000-4000-8000-000000000010'),'skip',NULL,NULL,NULL)$$,'22023',NULL,'a skip must name the occurrence it closes');
SELECT throws_ok($$SELECT record_cleaning_log('f6000000-0000-4000-8000-000000000023','f6000000-0000-4000-8000-000000000010',(SELECT updated_at FROM cleaning_routines WHERE id='f6000000-0000-4000-8000-000000000010'),'undo',pg_temp.d(0),NULL,NULL)$$,'22023',NULL,'unknown kind is rejected');
SELECT is((record_cleaning_log('f6000000-0000-4000-8000-000000000024','f6000000-0000-4000-8000-000000000010',(SELECT updated_at FROM cleaning_routines WHERE id='f6000000-0000-4000-8000-000000000010'),'skip',NULL,pg_temp.d(7),NULL)->>'status'),'saved','upcoming occurrence can be skipped');
SELECT is((SELECT last_done_on FROM cleaning_log_marks('f6000000-0000-4000-8000-000000000010')),pg_temp.d(0),'skip does not move the last done day');
SELECT is((SELECT max_skip_occurrence FROM cleaning_log_marks('f6000000-0000-4000-8000-000000000010')),pg_temp.d(7),'skip is reported separately from done');

-- ── 世帯 A の 2 人目: 同じ回の完了は 1 行に確定 ──
SELECT set_config('request.jwt.claims','{"sub":"f6000000-0000-4000-8000-000000000004","role":"authenticated"}',true);
SELECT is((SELECT count(*) FROM cleaning_routines),2::bigint,'second member reads the same routines');
SELECT is((SELECT count(*) FROM cleaning_logs),3::bigint,'second member reads the same history');
INSERT INTO fx SELECT 'second', record_cleaning_log('f6000000-0000-4000-8000-000000000025','f6000000-0000-4000-8000-000000000010',(SELECT updated_at FROM cleaning_routines WHERE id='f6000000-0000-4000-8000-000000000010'),'done',pg_temp.d(0),pg_temp.d(-7),NULL);
SELECT is((SELECT v->>'status' FROM fx WHERE k='second'),'already_closed','second completion of the same occurrence is not a new row');
SELECT is((SELECT v->'log'->>'id' FROM fx WHERE k='second'),'f6000000-0000-4000-8000-000000000020','already_closed returns the row that closed it');
SELECT is((SELECT count(*) FROM cleaning_logs WHERE id='f6000000-0000-4000-8000-000000000025'),0::bigint,'no row was created for the second completion');
SELECT is((SELECT count(*) FROM cleaning_logs WHERE routine_id='f6000000-0000-4000-8000-000000000010' AND occurrence=pg_temp.d(-7) AND voided_at IS NULL),1::bigint,'exactly one valid row closes the occurrence');
SELECT is((record_cleaning_log('f6000000-0000-4000-8000-000000000025','f6000000-0000-4000-8000-000000000010',(SELECT updated_at FROM cleaning_routines WHERE id='f6000000-0000-4000-8000-000000000010'),'done',pg_temp.d(0),pg_temp.d(-7),NULL)->>'status'),'already_closed','retry of the second completion is still already_closed');
SELECT throws_ok($$SELECT record_cleaning_log('f6000000-0000-4000-8000-000000000020','f6000000-0000-4000-8000-000000000010',now(),'done',pg_temp.d(0),pg_temp.d(-7),NULL)$$,'23505',NULL,'another member cannot replay someone else''s operation id');

-- ── 取り消し → 同じ回を再び完了できる ──
SELECT is((void_cleaning_log('f6000000-0000-4000-8000-000000000020','2020-01-01T00:00:00Z')->>'status'),'conflict','stale version cannot void');
SELECT is((SELECT voided_at FROM cleaning_logs WHERE id='f6000000-0000-4000-8000-000000000020'),NULL::timestamptz,'conflict did not void');
SELECT is((void_cleaning_log('f6000000-0000-4000-8000-000000000020',(SELECT updated_at FROM cleaning_logs WHERE id='f6000000-0000-4000-8000-000000000020'))->>'status'),'saved','family member can void with the current version');
SELECT is((void_cleaning_log('f6000000-0000-4000-8000-000000000020','2020-01-01T00:00:00Z')->>'status'),'replayed','voiding again replays');
SELECT is((SELECT last_done_on FROM cleaning_log_marks('f6000000-0000-4000-8000-000000000010')),pg_temp.d(-3),'void recomputes the last done day from the remaining history');
SELECT is((SELECT max_occurrence FROM cleaning_log_marks('f6000000-0000-4000-8000-000000000010')),pg_temp.d(7),'void reopens the occurrence it had closed');
SELECT is((record_cleaning_log('f6000000-0000-4000-8000-000000000025','f6000000-0000-4000-8000-000000000010',(SELECT updated_at FROM cleaning_routines WHERE id='f6000000-0000-4000-8000-000000000010'),'done',pg_temp.d(0),pg_temp.d(-7),NULL)->>'status'),'saved','after a void the same occurrence can be completed again');
SELECT is((SELECT count(*) FROM cleaning_logs WHERE routine_id='f6000000-0000-4000-8000-000000000010' AND occurrence=pg_temp.d(-7)),2::bigint,'voided row is kept as history');
SELECT is((SELECT count(*) FROM cleaning_logs WHERE routine_id='f6000000-0000-4000-8000-000000000010' AND occurrence=pg_temp.d(-7) AND voided_at IS NULL),1::bigint,'still exactly one valid row');

-- ── 訂正 ──
SELECT set_config('request.jwt.claims','{"sub":"f6000000-0000-4000-8000-000000000003","role":"authenticated"}',true);
SELECT is((record_cleaning_log('f6000000-0000-4000-8000-000000000020','f6000000-0000-4000-8000-000000000010',now(),'done',pg_temp.d(0),pg_temp.d(-7),NULL)->>'status'),'conflict','replay of an operation that was voided meanwhile is not reported as success');
SELECT is((update_cleaning_log('f6000000-0000-4000-8000-000000000025',(SELECT updated_at FROM cleaning_logs WHERE id='f6000000-0000-4000-8000-000000000025'),pg_temp.d(-1),'synthetic corrected')->>'status'),'saved','past record can be corrected with its version');
SELECT is((SELECT done_on FROM cleaning_logs WHERE id='f6000000-0000-4000-8000-000000000025'),pg_temp.d(-1),'correction moved the done day');
SELECT is((SELECT occurrence FROM cleaning_logs WHERE id='f6000000-0000-4000-8000-000000000025'),pg_temp.d(-7),'correction keeps the closed occurrence');
SELECT is((update_cleaning_log('f6000000-0000-4000-8000-000000000025','2020-01-01T00:00:00Z',pg_temp.d(-1),'synthetic corrected')->>'status'),'replayed','same correction replays');
SELECT is((update_cleaning_log('f6000000-0000-4000-8000-000000000025','2020-01-01T00:00:00Z',pg_temp.d(-2),NULL)->>'status'),'conflict','stale correction cannot overwrite');
SELECT throws_ok($$SELECT update_cleaning_log('f6000000-0000-4000-8000-000000000025',(SELECT updated_at FROM cleaning_logs WHERE id='f6000000-0000-4000-8000-000000000025'),pg_temp.d(1),NULL)$$,'22023','done_on in the future','correction to a future day is rejected');
SELECT throws_ok($$SELECT update_cleaning_log('f6000000-0000-4000-8000-000000000024',(SELECT updated_at FROM cleaning_logs WHERE id='f6000000-0000-4000-8000-000000000024'),pg_temp.d(0),NULL)$$,'22023',NULL,'a skip cannot be turned into a done day');
SELECT is((update_cleaning_log('f6000000-0000-4000-8000-000000000020',(SELECT updated_at FROM cleaning_logs WHERE id='f6000000-0000-4000-8000-000000000020'),pg_temp.d(-2),NULL)->>'status'),'conflict','a voided record is not corrected');

-- ── 延期・休止・再開・周期の変更・アーカイブ ──
SELECT throws_ok($$SELECT set_cleaning_routine_state('f6000000-0000-4000-8000-000000000010',(SELECT updated_at FROM cleaning_routines WHERE id='f6000000-0000-4000-8000-000000000010'),'postpone',pg_temp.d(0),pg_temp.d(0))$$,'22023',NULL,'postpone must move the due date past today');
SELECT throws_ok($$SELECT set_cleaning_routine_state('f6000000-0000-4000-8000-000000000010',(SELECT updated_at FROM cleaning_routines WHERE id='f6000000-0000-4000-8000-000000000010'),'postpone',pg_temp.d(0),NULL)$$,'22023',NULL,'postpone needs both the occurrence and the new date');
SELECT throws_ok($$SELECT set_cleaning_routine_state('f6000000-0000-4000-8000-000000000010',(SELECT updated_at FROM cleaning_routines WHERE id='f6000000-0000-4000-8000-000000000010'),'pause',pg_temp.d(0),NULL)$$,'22023',NULL,'pause takes no dates');
SELECT is((set_cleaning_routine_state('f6000000-0000-4000-8000-000000000010',(SELECT updated_at FROM cleaning_routines WHERE id='f6000000-0000-4000-8000-000000000010'),'postpone',pg_temp.d(-7),pg_temp.d(2))->>'status'),'conflict','an occurrence that is already closed cannot be postponed');
SELECT is((SELECT postponed_until FROM cleaning_routines WHERE id='f6000000-0000-4000-8000-000000000010'),NULL::date,'refused postpone wrote nothing');
SELECT is((set_cleaning_routine_state('f6000000-0000-4000-8000-000000000010',(SELECT updated_at FROM cleaning_routines WHERE id='f6000000-0000-4000-8000-000000000010'),'postpone',pg_temp.d(0),pg_temp.d(2))->>'status'),'saved','open occurrence is postponed');
SELECT is((SELECT anchor_date FROM cleaning_routines WHERE id='f6000000-0000-4000-8000-000000000010'),pg_temp.d(-14),'postpone does not move the anchor');
SELECT is((set_cleaning_routine_state('f6000000-0000-4000-8000-000000000010','2020-01-01T00:00:00Z','postpone',pg_temp.d(0),pg_temp.d(2))->>'status'),'replayed','same postpone replays');
SELECT is((set_cleaning_routine_state('f6000000-0000-4000-8000-000000000010','2020-01-01T00:00:00Z','postpone',pg_temp.d(0),pg_temp.d(3))->>'status'),'conflict','stale version cannot change the postponement');
SELECT is((set_cleaning_routine_state('f6000000-0000-4000-8000-000000000010',(SELECT updated_at FROM cleaning_routines WHERE id='f6000000-0000-4000-8000-000000000010'),'pause',NULL,NULL)->>'status'),'saved','routine can be paused');
SELECT is((set_cleaning_routine_state('f6000000-0000-4000-8000-000000000010','2020-01-01T00:00:00Z','pause',NULL,NULL)->>'status'),'replayed','pausing again replays');
SELECT throws_ok($$SELECT record_cleaning_log('f6000000-0000-4000-8000-000000000026','f6000000-0000-4000-8000-000000000010',(SELECT updated_at FROM cleaning_routines WHERE id='f6000000-0000-4000-8000-000000000010'),'done',pg_temp.d(0),pg_temp.d(0),NULL)$$,'23514',NULL,'a paused routine does not accept a completion');
SELECT is((set_cleaning_routine_state('f6000000-0000-4000-8000-000000000010',(SELECT updated_at FROM cleaning_routines WHERE id='f6000000-0000-4000-8000-000000000010'),'resume',NULL,NULL)->>'status'),'saved','routine can be resumed');
SELECT is((SELECT (paused_at IS NULL) AND resume_floor=pg_temp.d(0) FROM cleaning_routines WHERE id='f6000000-0000-4000-8000-000000000010'),true,'resume clears the pause and restarts counting from today');
SELECT is((SELECT postponed_until FROM cleaning_routines WHERE id='f6000000-0000-4000-8000-000000000010'),pg_temp.d(2),'pause and resume keep the postponement of the current occurrence');
SELECT is((save_cleaning_routine('f6000000-0000-4000-8000-000000000010',(SELECT updated_at FROM cleaning_routines WHERE id='f6000000-0000-4000-8000-000000000010'),'synthetic bathroom drain','synthetic bath','week',2,'fixed',pg_temp.d(-14),false)->>'status'),'saved','cadence can be edited with the current version');
SELECT is((SELECT postponed_occurrence FROM cleaning_routines WHERE id='f6000000-0000-4000-8000-000000000010'),NULL::date,'changing the cadence drops the old postponement');
SELECT is((set_cleaning_routine_state('f6000000-0000-4000-8000-000000000010','2020-01-01T00:00:00Z','clear_postpone',NULL,NULL)->>'status'),'replayed','clearing an absent postponement replays');
SELECT is((save_cleaning_routine('f6000000-0000-4000-8000-000000000011',(SELECT updated_at FROM cleaning_routines WHERE id='f6000000-0000-4000-8000-000000000011'),'synthetic filter',NULL,'month',3,'after_done',pg_temp.d(0),true)->>'status'),'saved','routine can be archived');
SELECT throws_ok($$SELECT record_cleaning_log('f6000000-0000-4000-8000-000000000027','f6000000-0000-4000-8000-000000000011',(SELECT updated_at FROM cleaning_routines WHERE id='f6000000-0000-4000-8000-000000000011'),'done',pg_temp.d(0),pg_temp.d(0),NULL)$$,'23514',NULL,'an archived routine does not accept new logs');
SELECT is((SELECT count(*) FROM cleaning_routines WHERE id='f6000000-0000-4000-8000-000000000011' AND archived),1::bigint,'archive keeps the definition and its history');

-- ── 周期の 6 通り（週・月・年 × 固定 / 実施基準）を全て作れる（B-02） ──
SELECT is((save_cleaning_routine('f6000000-0000-4000-8000-000000000013',NULL,'synthetic weekly after',NULL,'week',2,'after_done',pg_temp.d(0),false)->>'status'),'saved','week x after_done');
SELECT is((save_cleaning_routine('f6000000-0000-4000-8000-000000000014',NULL,'synthetic monthly fixed',NULL,'month',1,'fixed',pg_temp.d(-40),false)->>'status'),'saved','month x fixed');
SELECT is((save_cleaning_routine('f6000000-0000-4000-8000-000000000015',NULL,'synthetic yearly after',NULL,'year',10,'after_done',pg_temp.d(3),false)->>'status'),'saved','year x after_done');
SELECT is((save_cleaning_routine('f6000000-0000-4000-8000-000000000016',NULL,'synthetic yearly fixed',NULL,'year',1,'fixed',pg_temp.d(-400),false)->>'status'),'saved','year x fixed');
SELECT is((SELECT count(DISTINCT cadence_unit || '/' || schedule_mode) FROM cleaning_routines),6::bigint,'all six unit x mode combinations exist for the household');

-- ── 直接 DML は拒否（GRANT が無い） ──
SELECT throws_ok($$INSERT INTO cleaning_routines(id,household_id,name,cadence_unit,cadence_interval,schedule_mode,anchor_date) VALUES ('f6000000-0000-4000-8000-000000000018','f6000000-0000-4000-8000-000000000001','synthetic direct','week',1,'fixed',pg_temp.d(0))$$,'42501',NULL,'no direct insert into routines');
SELECT throws_ok($$UPDATE cleaning_routines SET name='synthetic direct'$$,'42501',NULL,'no direct update of routines');
SELECT throws_ok($$DELETE FROM cleaning_routines$$,'42501',NULL,'no direct delete of routines');
SELECT throws_ok($$INSERT INTO cleaning_logs(id,household_id,routine_id,kind,done_on) VALUES ('f6000000-0000-4000-8000-000000000028','f6000000-0000-4000-8000-000000000001','f6000000-0000-4000-8000-000000000010','done',pg_temp.d(5))$$,'42501',NULL,'no direct insert into history (future-day guard cannot be bypassed)');
SELECT throws_ok($$UPDATE cleaning_logs SET voided_at=NULL$$,'42501',NULL,'no direct update of history');
SELECT throws_ok($$DELETE FROM cleaning_logs$$,'42501',NULL,'no direct delete of history');

-- ── 別世帯 ──
RESET ROLE;
SELECT is((SELECT count(*) FROM cleaning_logs WHERE household_id='f6000000-0000-4000-8000-000000000001'),4::bigint,'seed check: household A has history before isolation is asserted');
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims','{"sub":"f6000000-0000-4000-8000-000000000005","role":"authenticated"}',true);
SELECT is((SELECT count(*) FROM cleaning_routines),0::bigint,'other household cannot read routines');
SELECT is((SELECT count(*) FROM cleaning_logs),0::bigint,'other household cannot read history');
SELECT is((SELECT count(*) FROM cleaning_log_marks()),0::bigint,'other household gets no marks');
SELECT throws_ok($$SELECT record_cleaning_log('f6000000-0000-4000-8000-000000000029','f6000000-0000-4000-8000-000000000010',now(),'done',pg_temp.d(0),pg_temp.d(0),NULL)$$,'42501',NULL,'other household cannot log against a foreign routine');
SELECT throws_ok($$SELECT save_cleaning_routine('f6000000-0000-4000-8000-000000000010',now(),'synthetic hijack',NULL,'week',1,'fixed',pg_temp.d(0),false)$$,'42501',NULL,'other household cannot edit a foreign routine');
SELECT throws_ok($$SELECT set_cleaning_routine_state('f6000000-0000-4000-8000-000000000010',now(),'pause',NULL,NULL)$$,'42501',NULL,'other household cannot pause a foreign routine');
SELECT throws_ok($$SELECT void_cleaning_log('f6000000-0000-4000-8000-000000000025',now())$$,'42501',NULL,'other household cannot void foreign history');
SELECT throws_ok($$SELECT update_cleaning_log('f6000000-0000-4000-8000-000000000025',now(),pg_temp.d(0),NULL)$$,'42501',NULL,'other household cannot correct foreign history');
SELECT is((save_cleaning_routine('f6000000-0000-4000-8000-000000000012',NULL,'synthetic B routine',NULL,'year',1,'fixed',pg_temp.d(0),false)->>'status'),'saved','control: the other household can use the feature for itself');
SELECT is((SELECT household_id FROM cleaning_routines),'f6000000-0000-4000-8000-000000000002'::uuid,'and sees only its own row');

-- ── 子ども閲覧招待の受諾者（別世帯のメンバー / 世帯を持たぬ閲覧者） ──
RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims','{"sub":"f6000000-0000-4000-8000-000000000003","role":"authenticated"}',true);
INSERT INTO fx SELECT 'share1', create_child_share((SELECT id FROM children WHERE is_legacy),true,true,true,true,NULL);
INSERT INTO fx SELECT 'share2', create_child_share((SELECT id FROM children WHERE is_legacy),true,true,true,true,NULL);
SELECT set_config('request.jwt.claims','{"sub":"f6000000-0000-4000-8000-000000000005","role":"authenticated"}',true);
SELECT accept_child_share((SELECT v->>'token' FROM fx WHERE k='share1'));
SELECT is((SELECT count(*) FROM cleaning_routines WHERE household_id='f6000000-0000-4000-8000-000000000001'),0::bigint,'accepting a child share from A does not open A''s chores');
SELECT set_config('request.jwt.claims','{"sub":"f6000000-0000-4000-8000-000000000006","role":"authenticated"}',true);
SELECT accept_child_share((SELECT v->>'token' FROM fx WHERE k='share2'));
SELECT is((SELECT count(*) FROM cleaning_routines),0::bigint,'share-only viewer reads no routines');
SELECT is((SELECT count(*) FROM cleaning_logs),0::bigint,'share-only viewer reads no history');
SELECT throws_ok($$SELECT save_cleaning_routine('f6000000-0000-4000-8000-000000000017',NULL,'synthetic viewer',NULL,'week',1,'fixed',pg_temp.d(0),false)$$,'42501',NULL,'share-only viewer cannot create routines');

-- ── 世帯に残ったまま viewer へ落ちた利用者 ──
RESET ROLE;
UPDATE profiles SET role='viewer' WHERE id='f6000000-0000-4000-8000-000000000004';
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims','{"sub":"f6000000-0000-4000-8000-000000000004","role":"authenticated"}',true);
SELECT is((SELECT count(*) FROM cleaning_routines),0::bigint,'viewer cannot read routines');
SELECT is((SELECT count(*) FROM cleaning_log_marks()),0::bigint,'viewer gets no marks');
SELECT throws_ok($$SELECT record_cleaning_log('f6000000-0000-4000-8000-000000000030','f6000000-0000-4000-8000-000000000010',now(),'done',pg_temp.d(0),NULL,NULL)$$,'42501',NULL,'viewer cannot write through RPC');

-- ── 周期の変更と回の鍵（R16）: 変更前の格子で閉じた鍵が、新しい格子の予定日を覆わない ──
RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims','{"sub":"f6000000-0000-4000-8000-000000000003","role":"authenticated"}',true);
SELECT is((save_cleaning_routine('f6000000-0000-4000-8000-000000000040',NULL,'synthetic regrid',NULL,'week',1,'fixed',pg_temp.d(3),false)->'routine'->>'cadence_epoch'),'0','a new routine starts at cadence epoch 0');
SELECT is((record_cleaning_log('f6000000-0000-4000-8000-000000000050','f6000000-0000-4000-8000-000000000040',(SELECT updated_at FROM cleaning_routines WHERE id='f6000000-0000-4000-8000-000000000040'),'done',pg_temp.d(0),pg_temp.d(3),NULL)->>'status'),'saved','an upcoming occurrence is completed early');
SELECT is((SELECT max_occurrence FROM cleaning_log_marks('f6000000-0000-4000-8000-000000000040')),pg_temp.d(3),'control: before the cadence changes, the closed key is counted');
SELECT is((save_cleaning_routine('f6000000-0000-4000-8000-000000000040',(SELECT updated_at FROM cleaning_routines WHERE id='f6000000-0000-4000-8000-000000000040'),'synthetic regrid renamed',NULL,'week',1,'fixed',pg_temp.d(3),false)->'routine'->>'cadence_epoch'),'0','control: renaming does not start a new cadence epoch');
SELECT is((SELECT max_occurrence FROM cleaning_log_marks('f6000000-0000-4000-8000-000000000040')),pg_temp.d(3),'control: renaming keeps the closed occurrence closed');
SELECT is((save_cleaning_routine('f6000000-0000-4000-8000-000000000040',(SELECT updated_at FROM cleaning_routines WHERE id='f6000000-0000-4000-8000-000000000040'),'synthetic regrid renamed',NULL,'week',1,'fixed',pg_temp.d(1),false)->'routine'->>'cadence_epoch'),'1','changing the cadence starts a new epoch');
SELECT is((SELECT max_occurrence FROM cleaning_log_marks('f6000000-0000-4000-8000-000000000040')),NULL::date,'a key closed on the old grid does not cover the new grid');
SELECT is((SELECT last_done_on FROM cleaning_log_marks('f6000000-0000-4000-8000-000000000040')),pg_temp.d(0),'the last done day survives the cadence change');
SELECT is((SELECT resume_floor FROM cleaning_routines WHERE id='f6000000-0000-4000-8000-000000000040'),pg_temp.d(1),'cleaned today: the new grid starts counting from tomorrow');
SELECT is((record_cleaning_log('f6000000-0000-4000-8000-000000000051','f6000000-0000-4000-8000-000000000040',(SELECT updated_at FROM cleaning_routines WHERE id='f6000000-0000-4000-8000-000000000040'),'skip',NULL,pg_temp.d(1),NULL)->>'status'),'saved','the first occurrence of the new grid can be closed');
SELECT is((SELECT max_occurrence FROM cleaning_log_marks('f6000000-0000-4000-8000-000000000040')),pg_temp.d(1),'keys closed in the current epoch are counted');
SELECT is((save_cleaning_routine('f6000000-0000-4000-8000-000000000040',(SELECT updated_at FROM cleaning_routines WHERE id='f6000000-0000-4000-8000-000000000040'),'synthetic regrid renamed',NULL,'week',1,'fixed',pg_temp.d(3),false)->'routine'->>'cadence_epoch'),'2','changing the cadence back is yet another epoch');
SELECT is((set_cleaning_routine_state('f6000000-0000-4000-8000-000000000040',(SELECT updated_at FROM cleaning_routines WHERE id='f6000000-0000-4000-8000-000000000040'),'postpone',pg_temp.d(3),pg_temp.d(5))->>'status'),'saved','a date closed only in an older epoch is an open occurrence and can be postponed');
SELECT is((record_cleaning_log('f6000000-0000-4000-8000-000000000052','f6000000-0000-4000-8000-000000000040',(SELECT updated_at FROM cleaning_routines WHERE id='f6000000-0000-4000-8000-000000000040'),'done',pg_temp.d(0),pg_temp.d(3),NULL)->>'status'),'saved','the same date on the new grid is a different occurrence (not already_closed)');
SELECT is((SELECT count(*) FROM cleaning_logs WHERE routine_id='f6000000-0000-4000-8000-000000000040' AND occurrence=pg_temp.d(3) AND voided_at IS NULL),2::bigint,'two valid rows share the date, one per epoch');
SELECT is((record_cleaning_log('f6000000-0000-4000-8000-000000000053','f6000000-0000-4000-8000-000000000040',(SELECT updated_at FROM cleaning_routines WHERE id='f6000000-0000-4000-8000-000000000040'),'done',pg_temp.d(0),pg_temp.d(3),NULL)->>'status'),'already_closed','control: within one epoch an occurrence still closes only once');
SELECT is((SELECT cadence_epoch FROM cleaning_logs WHERE id='f6000000-0000-4000-8000-000000000052'),2,'a log carries the epoch it was recorded in');
SELECT is((save_cleaning_routine('f6000000-0000-4000-8000-000000000040',(SELECT updated_at FROM cleaning_routines WHERE id='f6000000-0000-4000-8000-000000000040'),'synthetic regrid renamed',NULL,'week',1,'fixed',pg_temp.d(3),true)->'routine'->>'cadence_epoch'),'2','archiving keeps the epoch');
SELECT is((save_cleaning_routine('f6000000-0000-4000-8000-000000000040',(SELECT updated_at FROM cleaning_routines WHERE id='f6000000-0000-4000-8000-000000000040'),'synthetic regrid renamed',NULL,'week',1,'fixed',pg_temp.d(3),false)->'routine'->>'cadence_epoch'),'2','restoring from the archive keeps the epoch (same grid)');
SELECT is((SELECT max_occurrence FROM cleaning_log_marks('f6000000-0000-4000-8000-000000000040')),pg_temp.d(3),'restoring keeps closed occurrences closed');
SELECT is((save_cleaning_routine('f6000000-0000-4000-8000-000000000041',NULL,'synthetic regrid skipped',NULL,'week',1,'fixed',pg_temp.d(3),false)->>'status'),'saved','a second routine with no cleaning today');
SELECT is((record_cleaning_log('f6000000-0000-4000-8000-000000000054','f6000000-0000-4000-8000-000000000041',(SELECT updated_at FROM cleaning_routines WHERE id='f6000000-0000-4000-8000-000000000041'),'skip',NULL,pg_temp.d(3),NULL)->>'status'),'saved','its upcoming occurrence is skipped');
SELECT is((save_cleaning_routine('f6000000-0000-4000-8000-000000000041',(SELECT updated_at FROM cleaning_routines WHERE id='f6000000-0000-4000-8000-000000000041'),'synthetic regrid skipped',NULL,'week',2,'fixed',pg_temp.d(0),false)->'routine'->>'resume_floor'),pg_temp.d(0)::text,'control: not cleaned today, so the new grid counts from today (a skip is not carried over)');
SELECT is((SELECT max_skip_occurrence FROM cleaning_log_marks('f6000000-0000-4000-8000-000000000041')),NULL::date,'a skip on the old grid is not the last closure of the new grid');

-- ── B-07f 実施基準のスキップは、対象回の「予定日」を履歴に残す（鍵は予定日から逃げうる）──
-- 最初の予定日 d(7)・週 1。今日 d(0) に早めに実施して鍵 d(7) を閉じる → 次の予定日 d(0)+7 = d(7) は閉じた鍵と
-- 重なるゆえ、鍵は d(8) へ逃げる。この回をスキップした履歴は予定日 d(7) を持ち、次回は d(14)（鍵からの d(15) ではない）
SELECT is((save_cleaning_routine('f6000000-0000-4000-8000-000000000060',NULL,'synthetic early skip',NULL,'week',1,'after_done',pg_temp.d(7),false)->>'status'),'saved','an after_done routine whose first due day is a week ahead');
SELECT is((record_cleaning_log('f6000000-0000-4000-8000-000000000070','f6000000-0000-4000-8000-000000000060',(SELECT updated_at FROM cleaning_routines WHERE id='f6000000-0000-4000-8000-000000000060'),'done',pg_temp.d(0),pg_temp.d(7),NULL)->>'status'),'saved','it is completed early, closing its first occurrence');
SELECT is((SELECT scheduled_on FROM cleaning_logs WHERE id='f6000000-0000-4000-8000-000000000070'),NULL::date,'a completion carries no scheduled date (its base is the done day)');
SELECT is((set_cleaning_routine_state('f6000000-0000-4000-8000-000000000060',(SELECT updated_at FROM cleaning_routines WHERE id='f6000000-0000-4000-8000-000000000060'),'postpone',pg_temp.d(8),pg_temp.d(10))->>'status'),'saved','the occurrence with the escaped key is postponed');
INSERT INTO fx SELECT 'b07f', record_cleaning_log('f6000000-0000-4000-8000-000000000071','f6000000-0000-4000-8000-000000000060',(SELECT updated_at FROM cleaning_routines WHERE id='f6000000-0000-4000-8000-000000000060'),'skip',NULL,pg_temp.d(8),NULL);
SELECT is((SELECT v->>'status' FROM fx WHERE k='b07f'),'saved','the postponed occurrence whose key escaped can be skipped');
SELECT is((SELECT scheduled_on FROM cleaning_logs WHERE id='f6000000-0000-4000-8000-000000000071'),pg_temp.d(7),'the skip keeps the scheduled date before postponement (not the key, not the postponed date)');
SELECT is((SELECT v->'log'->>'scheduled_on' FROM fx WHERE k='b07f'),pg_temp.d(7)::text,'the RPC returns the scheduled date it stored');
SELECT is((SELECT occurrence FROM cleaning_logs WHERE id='f6000000-0000-4000-8000-000000000071'),pg_temp.d(8),'control: the key itself is still the escaped date');
SELECT is((SELECT last_skip_scheduled_on FROM cleaning_log_marks('f6000000-0000-4000-8000-000000000060')),pg_temp.d(7),'marks report the scheduled date of the last skip');
SELECT is((SELECT max_skip_occurrence FROM cleaning_log_marks('f6000000-0000-4000-8000-000000000060')),pg_temp.d(8),'control: marks still report the key of the last skip');
SELECT is((SELECT last_done_on FROM cleaning_log_marks('f6000000-0000-4000-8000-000000000060')),pg_temp.d(0),'the skip does not move the last done day');
SELECT is((record_cleaning_log('f6000000-0000-4000-8000-000000000071','f6000000-0000-4000-8000-000000000060','2020-01-01T00:00:00Z','skip',NULL,pg_temp.d(8),NULL)->>'status'),'replayed','resending the same skip replays');
SELECT is((SELECT count(*) FROM cleaning_logs WHERE routine_id='f6000000-0000-4000-8000-000000000060' AND voided_at IS NULL),2::bigint,'the replay adds no row');
SELECT is((SELECT last_skip_scheduled_on FROM cleaning_log_marks('f6000000-0000-4000-8000-000000000060')),pg_temp.d(7),'the replay does not move the schedule any further');
SELECT is((SELECT scheduled_on FROM cleaning_logs WHERE id='f6000000-0000-4000-8000-000000000024'),pg_temp.d(7),'control: a fixed skip stores its key (a grid date) as the scheduled date');
-- 月末: 1/31 に 2/28 の回を早めに実施 → 予定 2/28・鍵 3/1。スキップは 2/28 を持つ（src の cleaning-schedule.test.ts と同じ入力）
SELECT is((save_cleaning_routine('f6000000-0000-4000-8000-000000000061',NULL,'synthetic month end',NULL,'month',1,'after_done','2026-01-01',false)->>'status'),'saved','a monthly after_done routine');
SELECT is((record_cleaning_log('f6000000-0000-4000-8000-000000000072','f6000000-0000-4000-8000-000000000061',(SELECT updated_at FROM cleaning_routines WHERE id='f6000000-0000-4000-8000-000000000061'),'done','2026-01-31','2026-02-28',NULL)->>'status'),'saved','completed on 1/31, closing the 2/28 occurrence early');
SELECT is((record_cleaning_log('f6000000-0000-4000-8000-000000000073','f6000000-0000-4000-8000-000000000061',(SELECT updated_at FROM cleaning_routines WHERE id='f6000000-0000-4000-8000-000000000061'),'skip',NULL,'2026-03-01',NULL)->>'status'),'saved','the next occurrence (key 3/1) is skipped');
SELECT is((SELECT scheduled_on FROM cleaning_logs WHERE id='f6000000-0000-4000-8000-000000000073'),DATE '2026-02-28','month end: 1/31 + 1 month is clamped to 2/28');
-- 閏日: 2024-02-29 に翌年の回を早めに実施 → 予定 2025-02-28・鍵 2025-03-01
SELECT is((save_cleaning_routine('f6000000-0000-4000-8000-000000000062',NULL,'synthetic leap day',NULL,'year',1,'after_done','2024-02-29',false)->>'status'),'saved','a yearly after_done routine anchored on a leap day');
SELECT is((record_cleaning_log('f6000000-0000-4000-8000-000000000074','f6000000-0000-4000-8000-000000000062',(SELECT updated_at FROM cleaning_routines WHERE id='f6000000-0000-4000-8000-000000000062'),'done','2024-02-29','2025-02-28',NULL)->>'status'),'saved','completed on the leap day, closing the next year''s occurrence early');
SELECT is((record_cleaning_log('f6000000-0000-4000-8000-000000000075','f6000000-0000-4000-8000-000000000062',(SELECT updated_at FROM cleaning_routines WHERE id='f6000000-0000-4000-8000-000000000062'),'skip',NULL,'2025-03-01',NULL)->>'status'),'saved','the next occurrence (key 2025-03-01) is skipped');
SELECT is((SELECT scheduled_on FROM cleaning_logs WHERE id='f6000000-0000-4000-8000-000000000075'),DATE '2025-02-28','leap day: 2024-02-29 + 1 year is clamped to 2025-02-28');
-- 守り: 今の回ではない鍵を直に閉じた時は、無関係な予定日を植えず鍵そのものを残す（今の回は 3/28）
SELECT is((record_cleaning_log('f6000000-0000-4000-8000-000000000076','f6000000-0000-4000-8000-000000000061',(SELECT updated_at FROM cleaning_routines WHERE id='f6000000-0000-4000-8000-000000000061'),'skip',NULL,'2026-04-15',NULL)->>'status'),'saved','a direct call may skip a key that is not the current occurrence');
SELECT is((SELECT scheduled_on FROM cleaning_logs WHERE id='f6000000-0000-4000-8000-000000000076'),DATE '2026-04-15','such a skip stores the key itself as its scheduled date');

-- ── anon・権限・構造 ──
RESET ROLE;
SELECT ok(NOT has_table_privilege('anon','public.cleaning_routines','SELECT') AND NOT has_table_privilege('anon','public.cleaning_logs','SELECT'),'anon has no table grant');
SELECT ok(NOT has_table_privilege('authenticated','public.cleaning_routines','INSERT,UPDATE,DELETE,TRUNCATE') AND NOT has_table_privilege('authenticated','public.cleaning_logs','INSERT,UPDATE,DELETE,TRUNCATE'),'authenticated has no write grant');
SELECT ok(NOT has_function_privilege('anon','public.save_cleaning_routine(uuid,timestamptz,text,text,text,integer,text,date,boolean)','EXECUTE')
  AND NOT has_function_privilege('anon','public.set_cleaning_routine_state(uuid,timestamptz,text,date,date)','EXECUTE')
  AND NOT has_function_privilege('anon','public.record_cleaning_log(uuid,uuid,timestamptz,text,date,date,text)','EXECUTE')
  AND NOT has_function_privilege('anon','public.update_cleaning_log(uuid,timestamptz,date,text)','EXECUTE')
  AND NOT has_function_privilege('anon','public.void_cleaning_log(uuid,timestamptz)','EXECUTE')
  AND NOT has_function_privilege('anon','public.cleaning_log_marks(uuid)','EXECUTE'),'anon cannot execute any cleaning RPC');
SELECT ok(has_function_privilege('authenticated','public.record_cleaning_log(uuid,uuid,timestamptz,text,date,date,text)','EXECUTE'),'control: authenticated can execute the RPC');
SELECT ok(NOT has_function_privilege('authenticated','irori_private.cleaning_begin()','EXECUTE'),'internal helper is not callable by clients');
SELECT is((SELECT array_agg(cmd::text ORDER BY tablename) FROM pg_policies WHERE schemaname='public' AND tablename IN ('cleaning_routines','cleaning_logs')),ARRAY['SELECT','SELECT'],'only SELECT policies exist (no FOR ALL)');
SELECT is((SELECT count(*) FROM pg_publication_tables WHERE pubname='supabase_realtime' AND tablename IN ('cleaning_routines','cleaning_logs')),0::bigint,'tables are not added to the realtime publication');
SELECT throws_ok($$INSERT INTO cleaning_logs(id,household_id,routine_id,kind,done_on) VALUES ('f6000000-0000-4000-8000-000000000031','f6000000-0000-4000-8000-000000000002','f6000000-0000-4000-8000-000000000010','done',pg_temp.d(0))$$,'23503',NULL,'composite FK refuses a routine of another household');
SELECT throws_ok($$INSERT INTO cleaning_logs(id,household_id,routine_id,kind,done_on,occurrence) VALUES ('f6000000-0000-4000-8000-000000000032','f6000000-0000-4000-8000-000000000001','f6000000-0000-4000-8000-000000000010','done',pg_temp.d(0),pg_temp.d(-7))$$,'23505',NULL,'unique index keeps one valid row per occurrence even without the RPC');
SELECT throws_ok($$INSERT INTO cleaning_logs(id,household_id,routine_id,kind) VALUES ('f6000000-0000-4000-8000-000000000033','f6000000-0000-4000-8000-000000000001','f6000000-0000-4000-8000-000000000010','done')$$,'23514',NULL,'done without a done day violates the shape check');
SELECT throws_ok($$INSERT INTO cleaning_logs(id,household_id,routine_id,kind) VALUES ('f6000000-0000-4000-8000-000000000034','f6000000-0000-4000-8000-000000000001','f6000000-0000-4000-8000-000000000010','skip')$$,'23514',NULL,'skip without an occurrence violates the shape check');
SELECT throws_ok($$INSERT INTO cleaning_logs(id,household_id,routine_id,kind,occurrence) VALUES ('f6000000-0000-4000-8000-000000000035','f6000000-0000-4000-8000-000000000001','f6000000-0000-4000-8000-000000000010','skip',pg_temp.d(30))$$,'23514',NULL,'a skip must carry the scheduled date of its occurrence');
SELECT throws_ok($$INSERT INTO cleaning_logs(id,household_id,routine_id,kind,occurrence,scheduled_on) VALUES ('f6000000-0000-4000-8000-000000000036','f6000000-0000-4000-8000-000000000001','f6000000-0000-4000-8000-000000000010','skip',pg_temp.d(30),pg_temp.d(31))$$,'23514',NULL,'a scheduled date after its key violates the shape check');
SELECT throws_ok($$INSERT INTO cleaning_logs(id,household_id,routine_id,kind,done_on,scheduled_on) VALUES ('f6000000-0000-4000-8000-000000000037','f6000000-0000-4000-8000-000000000001','f6000000-0000-4000-8000-000000000010','done',pg_temp.d(0),pg_temp.d(0))$$,'23514',NULL,'a completion carries no scheduled date');
SELECT throws_ok($$UPDATE cleaning_routines SET postponed_occurrence=pg_temp.d(0) WHERE id='f6000000-0000-4000-8000-000000000010'$$,'23514',NULL,'half of a postponement violates the pair check');
SELECT throws_ok($$UPDATE cleaning_routines SET cadence_interval=25 WHERE cadence_unit='month'$$,'23514',NULL,'interval range is enforced by the table too');
SET LOCAL ROLE anon;
SELECT throws_ok($$SELECT count(*) FROM cleaning_routines$$,'42501',NULL,'anon cannot read routines');
SELECT throws_ok($$SELECT cleaning_log_marks()$$,'42501',NULL,'anon cannot call the read RPC');
RESET ROLE;
SELECT * FROM finish();
ROLLBACK;
