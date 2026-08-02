-- ============================================================
-- 招待の role / invited_by を RLS で拘束する (2026-08-01, I-14)
-- ============================================================
-- ## 欠陥
-- `invitations_insert` (20260406000001:283-284) と `invitations_update`
-- (20260407000001 末尾) は **household_id しか拘束しておらぬ**。ゆえに
-- 一般 member が PostgREST 直叩きで `role='owner'` の招待を発行できた
-- （ローカル実機 probe で `INSERT 0 1` を確認・BEGIN…ROLLBACK 済み）。
--
-- その招待を受けた新規アカウントは `accept_invitation`（20260408000002）により
--   profiles.role = 'owner' かつ profiles.is_approved = true
-- を一度に得る。すなわち一枚の欠落で
--   (a) 権限昇格 — member が共犯アカウントを owner に仕立てられる
--   (b) 承認ゲートのバイパス — オーナー承認を経ずにアプリへ入れる
-- が同時に開く。owner になれば `approve_user` で任意ユーザーを承認できるため、
-- 以後は世帯の管理権限が丸ごと奪われる。
--
-- ## アプリ側の実態（この拘束が既存フローを壊さぬ根拠）
-- 招待を作る経路は `src/app/(main)/settings/actions.ts` の `generateInvite()` **ただ 1 つ**で、
--   .insert({ household_id: householdId, invited_by: userId, role: "member" })
-- と **role を 'member' にハードコード**しておる。`invite-card.tsx` に role の
-- 入力 UI は無い。owner は `create_household()`（20260603000001）が作る設計ゆえ、
-- **owner を招待で作る必要は無い**。よって `role = 'member'` の WITH CHECK で
-- 失われる正規機能は無い。
--
-- ## RLS の限界（なぜ「status 遷移のみ許可」を素直に書けぬか）
-- RLS の WITH CHECK は **新しい行しか見えぬ**（OLD を参照できぬ）ため、
-- 「status だけが変わったこと」は RLS では表現できぬ。BEFORE UPDATE トリガまで
-- 持ち出すのは本 PR の関心事を超えるゆえ、**「role と household_id が
-- 逸脱した行にはならぬ」** という形に落とす。これで
--   member 招待を作る → あとから role='owner' へ書き換える
-- という二手の昇格は塞がる。status の遷移（期限切れ化等）は従来どおり通る。
--
-- ## 既に植えられた招待の無害化（RLS だけでは閉じぬ）
-- `accept_invitation` は SECURITY DEFINER ゆえ **RLS をバイパスする**。
-- ポリシーを直しても、既存の `role<>'member'` な pending 行はそのまま
-- 受諾可能で昇格が成立してしまう。ゆえに下の (1) で無害化する。
-- ============================================================

-- ------------------------------------------------------------
-- 1. 既存の異常な招待を失効させる ★データを書き換える★
-- ------------------------------------------------------------
-- アプリは role='member' 以外の招待を一度も作っておらぬ（上記のとおり
-- generateInvite がハードコード）ゆえ、role<>'member' の pending 行は
-- 正規の導線では発生しえぬ = 異常値じゃ。status を 'expired' にすると
-- accept_invitation の `IF inv.status != 'pending'` で確実に弾かれる。
-- role 列は書き換えぬ（監査上、何が植えられていたかの記録を残すため）。
--
-- ⚠️ 本番への適用前に必ず**影響範囲を実測**すること。
--    ローカルは `db reset` 直後で invitations が空ゆえ、この UPDATE は
--    ローカルでは常に 0 行じゃ = **本番で 0 行である証拠には一切ならぬ**。
--    適用前に本番で次を実行し、返る行を確認せよ:
--
--      SELECT id, household_id, invited_by, role, status, created_at
--      FROM invitations
--      WHERE status = 'pending' AND role <> 'member';
--
--    1 行でも返れば、それは「migration の細部」ではなく**現に権限昇格の
--    招待が生きておる事案**じゃ。誰が（invited_by）いつ（created_at）
--    植えたかを記録してから適用せよ。
UPDATE public.invitations
SET status = 'expired'
WHERE status = 'pending'
  AND role <> 'member';

-- ------------------------------------------------------------
-- 2. INSERT: 自世帯 / role=member / 発行者は自分、の三点を拘束
-- ------------------------------------------------------------
-- invited_by = auth.uid() は他人名義での招待発行（責任者の詐称）を防ぐ。
-- アプリは userId をそのまま入れておるため影響なし。
DROP POLICY IF EXISTS "invitations_insert" ON public.invitations;
CREATE POLICY "invitations_insert" ON public.invitations
  FOR INSERT WITH CHECK (
    household_id = get_my_household_id()
    AND role = 'member'
    AND invited_by = auth.uid()
  );

-- ------------------------------------------------------------
-- 3. UPDATE: 自世帯のまま / role は member のまま、を拘束
-- ------------------------------------------------------------
-- USING  = どの行を触れるか（従来どおり自世帯のみ）
-- WITH CHECK = 更新後の行が満たすべき条件（世帯を跨がせぬ・role を昇格させぬ）
-- invited_by は WITH CHECK に**入れぬ**。入れると「member が作った招待を
-- owner が失効させる」等、他人の招待に対する正当な status 操作が
-- できなくなり、世帯運用を壊すためじゃ。
--
-- ## 副作用（承知の上で受け入れる）: role<>'member' の行は UPDATE 凍結される
-- WITH CHECK は更新後の行を見るゆえ、role='owner' の行はどう UPDATE しても
-- 更新後も role='owner' のままで WITH CHECK を満たせぬ。つまり (1) で失効させた
-- 異常行は**以後 RLS 経由で二度と UPDATE できぬ**（ローカル実測: owner が
-- status を戻そうとして `new row violates row-level security policy` で拒否）。
-- 異常行に対しては望ましい挙動じゃ。掃除が要る場合の逃げ道は DELETE で、
-- invitations_delete は WITH CHECK を持たぬため通る（同実測: `DELETE 1`）。
-- 正規の role='member' 行は従来どおり status を遷移できる。
DROP POLICY IF EXISTS "invitations_update" ON public.invitations;
CREATE POLICY "invitations_update" ON public.invitations
  FOR UPDATE
  USING (household_id = get_my_household_id())
  WITH CHECK (
    household_id = get_my_household_id()
    AND role = 'member'
  );
