-- ============================================================
-- 授乳: 既存の母乳行の logged_at を「終了時刻」→「開始時刻」セマンティクスへ補正
-- ============================================================

-- ① 目的
--   授乳行の logged_at の意味を「終了時刻」から「開始時刻」へ統一する。従来タイマーは
--   計測完了時（＝授乳終了時）に now() で記録していたため、logged_at は終了時刻だった。
--   以後タイマーは開始時刻を送るため、過去行を duration ぶん巻き戻して意味を揃える。
--   これを怠ると「最終授乳 N分前」とタイムラインの時刻が、移行日を境に別の基準で
--   混在する（同じ列に2つの意味が同居する = 後から判別不能な無音の不整合）。
--
-- ② WHERE を母乳系（breast_left / breast_right）に限定する理由
--   Flutter の recordFeeding は**種別に関わらず** duration_min を書く。ゆえに
--   bottle / pumped / solid 行にも duration_min が入っているが、それらの logged_at は
--   「タップ時刻」であって終了時刻ではない。一律に巻き戻すと、終了時刻ではない行まで
--   ずらして**新たな不整合を作る**。母乳の計測タイマーを通った行だけが対象。
--   duration が両方 NULL の行は巻き戻す幅が無いため対象外（そのまま = 開始時刻扱い）。
--
-- ②' さらに logged_at = created_at に限定する理由（この述語が選ぶものを正確に）
--   この述語が選ぶのは「INSERT 時に logged_at を明示送信しなかった行」である
--   （logged_at / created_at はとも DEFAULT now() = 同一トランザクション内で同値。
--   時刻を明示・編集した行は分単位入力 vs マイクロ秒精度で一致し得ず除外される）。
--   該当するのは:
--   (a) タイマー行 — logged_at = 保存時 now() = 終了時刻。duration ぶんの巻き戻しが
--       そのまま開始時刻になる（本補正の主目的）。
--   (b) 旧・手動入力モードの行 — logged_at = 保存時 now()。「保存時刻 − duration」への
--       変換は、新コードの手動入力（feeding-timer.tsx handleManualRecord）が同じ入力に
--       書く値と同一定義ゆえ、含めることで新旧の意味が揃う（含めるのが正しい）。
--   (c) 理論上の偽陽性 — クイック記録行を後から母乳種別+授乳時間へ編集し、時刻欄を
--       触らなかった行（duration 編集は #153 = 2026-07-22 以降のみ可能な狭いクラス）。
--       この行の logged_at はタップ時刻であり巻き戻しは近似になるが、変換は
--       created_at + duration から完全可逆（④の逆写像で戻せる）。
--   適用前に対象行を確認する場合は同じ WHERE の SELECT を実行すること（PR 本文参照）。
--   除外される行（時刻を明示・編集済み）は、ユーザーが決めた時刻をそのまま尊重する。
--
-- ③ 副作用: JST の日付境界を跨ぐ行がある
--   巻き戻し幅は最大 3 時間（chk_duration_sec ≤ 10800 秒 / chk_duration_min ≤ 180 分）。
--   例えば 00:20 JST に記録された 25 分の授乳は前日 23:55 JST へ移る。つまり
--   **過去日の「1日のまとめ」の回数が静かに変わる**（深夜授乳が前日側へ 1 件移る）。
--   これは意味の統一に伴う正しい移動だが、移行前の PDF レポート等と数字が合わなくなる
--   ため、差異を見たときに慌てないよう記録しておく。
--
-- ④ 逆写像（適用を戻したい場合）
--   このマイグレーションは冪等でない（再実行すると二重に巻き戻る）。Supabase の
--   migration 管理により 1 回しか走らないが、手で戻す場合は同じ WHERE に
--   「適用時刻より前に作られた行」の条件を足して符号を反転させる:
--
--     UPDATE baby_logs
--     SET logged_at = logged_at + make_interval(secs => COALESCE(duration_sec, duration_min * 60))
--     WHERE log_type = 'feeding'
--       AND feeding_type IN ('breast_left', 'breast_right')
--       AND (duration_sec IS NOT NULL OR duration_min IS NOT NULL)
--       AND logged_at + make_interval(secs => COALESCE(duration_sec, duration_min * 60)) = created_at
--       AND created_at < '<このマイグレーションの適用時刻>';
--
--   `logged_at + duration = created_at` は本 UPDATE の適用後にだけ成り立つ関係
--   （適用前は logged_at = created_at）ゆえ、補正済みの行を正確に選び戻せる。
--   created_at で切るのは、適用後に追加された行を巻き戻さないため（updated_at は
--   この UPDATE 自身がトリガで書き換えるので判別に使えない）。
--
-- NOTE: duration_min は SMALLINT だが `duration_min * 60` は integer に昇格するため
--   オーバーフローしない（180 * 60 = 10800）。logged_at に関わる CHECK 制約・
--   partial index は無く（20260410000001_baby_logs.sql を確認済み）、時刻を戻すことで
--   弾かれる制約は無い。

UPDATE baby_logs
SET logged_at = logged_at - make_interval(secs => COALESCE(duration_sec, duration_min * 60))
WHERE log_type = 'feeding'
  AND feeding_type IN ('breast_left', 'breast_right')
  AND (duration_sec IS NOT NULL OR duration_min IS NOT NULL)
  -- logged_at を明示送信しなかった行のみ（②' 参照）。時刻を明示・編集した行は巻き戻さない
  AND logged_at = created_at;
