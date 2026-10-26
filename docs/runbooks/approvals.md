# サインアップの承認と運用者（app_operators）

> **新しいインスタンスを立てる時と、`20261002100001`〜`20261002100003` を本番へ適用する時に読め。**

## 1. 何がどう変わったか（2026-10）

| | 以前 | 今 |
|---|---|---|
| 未承認の利用者が `create_household` を直接呼ぶ | 通った（承認ゲートは proxy だけ） | DB が 42501 で拒む（`20261002100001`） |
| 承認待ちの一覧（email つき）を見られる者 | **全世帯の owner**（世帯は互いに他人なのに） | **運用者だけ**（`app_operators` に載った者） |
| 承認できる者 | 全世帯の owner | 運用者だけ |
| push の宛先検証 | Server Action だけ（RPC を直に呼べば素通り） | RPC 内でも検証し、送信の直前にも再検査する（`20261002100003`） |

**承認は「世帯への参加」ではない。** 承認された人ができるのは、自分の世帯を作ることだけじゃ。家族を世帯へ入れるには、設定の招待リンクを使う（招待経由の参加は自動で承認される）。

## 2. 本番へ適用する手順（順序が肝）

エージェントは以下のどれも実行しておらぬ。人が Supabase の SQL Editor と手元の端末で行う。

**始める前に（どれか一つでも欠けたら進めぬ）:**

- 承認モデル（承認はインスタンスの運用者の権限。§4）を人が承認しておること。`db push` した時点で本番に効き、以後この 3 本は凍結される（直すなら新しい migration で出す）。
- 実行場所は、この 3 本を含む**検証済みの commit** の作業ツリーにする。この 3 本を含まぬ checkout（例: 別作業の残る main の checkout）からは流さぬ。未 link なら先に `supabase link --project-ref <ref>`。
- 2.2 の `supabase migration list --linked` で、未適用（Local にだけ在る版）が `20261002100001`〜`20261002100003` の 3 本**だけ**であること。`20260909100002` / `20260909100003` が出たら止める。100003 は本番の行を消す不可逆な DROP で、`db push` は未適用の分をまとめて流す。扱いを人が決めるまで `db push` も merge もせぬ。
- 2.2 の `supabase db push --dry-run` が流すと言う版も、同じ 3 本**だけ**であること（`migration list` と `--dry-run` の両方で同じ 3 本が出て初めて進む）。
- `select to_regclass('public.app_operators')` が NULL であること。NULL でなければ、誰かが SQL Editor で 100002 を手で流した痕跡じゃ。history が揃っておらぬまま `db push` すると `CREATE TABLE` で落ちる。手で流した版と history を人が照合するまで進めぬ。
- アプリの deploy（2.4）は 2.2 と 2.3 の**後**。Vercel が main への merge で本番を自動 deploy する設定なら merge = deploy ゆえ、merge も 2.3 の後に置く（設定は Vercel の dashboard で確かめる）。
- 修正を公開リポジトリへ push するのは、この 3 本が本番に効いた後にする（SECURITY.md の非公開報告の方針と同じく、未適用の間に攻略の経路を公開せぬ）。

### 2.1 適用前の読み取り監査

すべて `set transaction read only` の中で実行する。

```sql
-- (a) 全世帯と owner（承認を経ずに owner になった者がおらぬか、人の目で確かめる）
begin; set transaction read only;
select h.id as household_id, h.name as household_name, h.created_at as household_created_at,
       p.id as owner_id, u.email as owner_email, p.is_approved as owner_is_approved_now,
       p.created_at as owner_signed_up_at,
       (select count(*) from public.profiles m where m.household_id = h.id) as member_count
  from public.households h
  left join public.profiles p on p.household_id = h.id and p.role = 'owner'
  left join auth.users u on u.id = p.id
 order by h.created_at;
rollback;

-- (b) メンバーが 0 人の世帯（直接 INSERT された残骸の候補）。id と作成日だけ
begin; set transaction read only;
select h.id, h.created_at from public.households h
 where not exists (select 1 from public.profiles m where m.household_id = h.id)
 order by h.created_at;
rollback;

-- (c) 許可外の push 宛先の「件数だけ」（宛先の値は決して select しない）
begin; set transaction read only;
select count(*) as nonconforming_push_subscriptions
  from public.push_subscriptions
 where endpoint !~ '^https://(([a-z0-9-]+\.)+push\.apple\.com|fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com)/';
rollback;

-- (d) 承認済みで世帯に属さぬ利用者。修正の後も create_household で owner になれるゆえ、
--     見覚えがあるか確かめる（修正前は運用者でない owner も承認できた）。id と日付だけ
begin; set transaction read only;
select p.id, p.created_at from public.profiles p
 where p.is_approved = true and p.household_id is null
 order by p.created_at;
rollback;

-- (e) 受諾済みで role が member でない招待。20260801100001 より前は member が
--     role='owner' の招待を出せ、受諾した者は承認を経ずに owner になれた
begin; set transaction read only;
select i.id, i.household_id, i.role, i.accepted_by, i.created_at
  from public.invitations i
 where i.status = 'accepted' and i.role <> 'member'
 order by i.created_at;
rollback;
```

(a)・(d)・(e) に見覚えの無い世帯・利用者が出たら、適用の前に止めて扱いを決めよ（削除は不可逆ゆえ、この手順では行わぬ）。(c) が 0 でなくても、送信直前の再検査が送らぬ（`rejectedEndpoints` としてログに出る）。

### 2.2 migration の適用

```bash
supabase migration list --linked   # 履歴が repo と揃っておるか先に確かめる（Local だけの版 = 3 本）
supabase db push --dry-run         # 流れる版を印字するだけ。3 本以外が混じれば止める
supabase db push                   # 3 本を version 順に適用し、history も書く
```

`--include-all` は付けぬ。既定の `db push` は remote の最新版より**新しい**未適用の版だけを流す。古い版が未適用で残っておれば CLI はそれを告げて止まるが、それを `--include-all` で黙らせると `20260909100002/3` のような不可逆な版まで一緒に流れる。

**history（`supabase_migrations.schema_migrations`）の更新は `db push` に任せる。** `db push` は migration file を 1 本ずつ適用し、成功した版だけを history へ書く（version・name・statements）。途中の 1 本が落ちたら、その版と後続は history に残らぬ ＝ 原因を直して再度 `db push` すれば残りだけが流れる。**SQL Editor へ file を貼って流す経路は採らぬ**（history が更新されず、次の `db push` が同じ file をもう一度流して `CREATE TABLE app_operators` で落ちる）。やむを得ず手で流した時だけ `supabase migration repair --status applied <version>` で history を揃えるが、それは本手順の外じゃ。

history の確認（3 行が正）:

```sql
select version, name from supabase_migrations.schema_migrations
 where version in ('20261002100001', '20261002100002', '20261002100003')
 order by version;
```

**止める条件（どれか一つでも当たれば、次の文を流さず人が判断する）:**

| 観測 | 判断 |
|---|---|
| `migration list` の Local だけの版が 3 本以外 | 止める（`20260909100002/3` は不可逆な DROP） |
| `db push --dry-run` が 3 本以外を印字する | 止める（list と dry-run の食い違いは history の破れ） |
| `to_regclass('public.app_operators')` が NULL でない | 止める（手で流した痕跡。history を人が照合する） |
| 2.1 の (a) に見覚えの無い世帯・owner、(b)(d)(e) が 0 行でない | 止めて扱いを決める（削除は不可逆ゆえ本手順では行わぬ） |
| `db push` が途中で error を返す | **再送せぬ。** error 全文と上の history の確認を読み、どこまで入ったかを確かめてから直す |
| 下の a1〜a15 に true / 0 でない値が残る | deploy へ進まぬ。接続先と error を疑う |
| 2.5 の snapshot の差分に、期待する行以外が在る | deploy へ進まぬ。差分の行を読んで原因を特定する |

適用後の確認（a1〜a15 はすべて false / 0 が正）:

```sql
select has_table_privilege('anon','public.households','INSERT') a1,
       has_table_privilege('authenticated','public.households','INSERT') a2,
       has_function_privilege('anon','public.create_household(text)','EXECUTE') a3,
       has_function_privilege('anon','public.get_invitation_by_token(text)','EXECUTE') a4,
       has_function_privilege('anon','public.is_app_operator()','EXECUTE') a5,
       (select count(*) from pg_policies where schemaname='public' and tablename='households' and cmd='INSERT') a6,
       has_function_privilege('anon','public.accept_invitation(uuid)','EXECUTE') a7,
       has_function_privilege('anon','public.get_pending_approvals()','EXECUTE') a8,
       has_function_privilege('anon','public.approve_user(uuid)','EXECUTE') a9,
       has_function_privilege('anon','public.upsert_push_subscription(text,text,text,text)','EXECUTE') a10,
       has_table_privilege('anon','public.households','DELETE') a11,
       has_table_privilege('authenticated','public.households','DELETE') a12,
       has_table_privilege('authenticated','public.households','TRUNCATE') a13,
       has_table_privilege('anon','public.app_operators','SELECT') a14,
       has_table_privilege('authenticated','public.app_operators','SELECT') a15;
```

対照（どちらも true が正。false なら確認の式か接続先を疑え）:

```sql
select has_function_privilege('authenticated','public.create_household(text)','EXECUTE') c1,
       has_function_privilege('authenticated','public.approve_user(uuid)','EXECUTE') c2;
```

**ここから 2.3 までの間、誰も承認できぬ。** fail-closed にしてあるのは意図どおりじゃ。これは `approve_user` の経路の話で、招待リンクから参加する家族は `accept_invitation` が自動で承認するため、この間も参加できる。

### 2.3 運用者の登録（2.2 の直後に）

運用者には既存の承認済みの owner を選ぶ。2.4 の deploy までは旧アプリが動いており、旧アプリは承認待ちの一覧を owner にしか出さぬ。

⚠️ **運用者を 2 人以上にする前に** `docs/runbooks/feedback.md` §5「既知の制約」を読め。要望の受信箱の既読（`operator_seen_at`）は運用者全員で 1 列を共有しており、ある運用者が開くと他の運用者の未読も消える。

```sql
-- 確かめる（読み取り）
select u.id, u.email, p.is_approved, p.household_id
  from auth.users u join public.profiles p on p.id = u.id
 where u.email = '<運用者のメールアドレス>';

-- 登録
insert into public.app_operators (user_id) values ('<運用者の uuid>')
  on conflict (user_id) do nothing returning user_id, created_at;

-- 新しいインスタンスで、運用者自身がまだ承認待ちの時だけ
update public.profiles set is_approved = true
 where id = '<運用者の uuid>' and is_approved = false returning id;

-- 確認
select user_id, created_at from public.app_operators;
```

戻す時:

```sql
delete from public.app_operators where user_id = '<運用者の uuid>' returning user_id;
-- 次の update は、登録時の「承認待ちだった時だけ」の update が行を返した場合に限って流す。
-- 登録前から承認済みだった運用者に流すと、元からの承認まで外れる。
-- （世帯に入っておる行は戻さぬ: 「承認待ちなら世帯なし」の不変条件を守る）
update public.profiles set is_approved = false
 where id = '<運用者の uuid>' and household_id is null returning id;
```

### 2.4 アプリの deploy（2.2 の後）

設定画面は `rpc("is_app_operator")` で承認カードを出し分ける。migration より先に deploy すると、その関数が無いため誰にもカードが出ず、設定画面を開くたびに `is_app_operator lookup failed` がログに出る（fail-closed）。

deploy の直後、開いたままの PWA は古いバンドルで動いておる。Server Action の id が変わるゆえ、古い画面からの保存・削除は「見つからぬ」か「画面が古い」で止まる（fail-closed・無言の破壊は無い）。家族には deploy の後にアプリを一度閉じて開き直してもらう。

### 2.5 member（世帯の家族）の日常利用が変わらぬことの証拠

3 本が触るのは `households`（INSERT ポリシーの削除と INSERT / DELETE / TRUNCATE の権限）、`app_operators`（新設・deny-all）、関数 7 本の本文または anon の EXECUTE だけじゃ。`baby_logs` / `baby_diaries` / `calendar_events` / `invitations` / `profiles` / `push_subscriptions` / `event_reminders` / `notification_*` / `google_*` のポリシー・表権限・列権限には一切触れぬ。これを「読んだ」ではなく「測った」にするため、**2.1 の前（before）と 2.2 の後（after）に同じ query を流し、出力を手元で diff する。**

```sql
-- before / after の両方で同じものを流す（読み取りのみ）。catalog を直に読む —
-- information_schema は「現在有効なロール」次第で黙って 0 行になる（profiles_column_grants.sql の注記）。
begin; set transaction read only;
select kind, object, grantee, priv
  from (
    select 'table' as kind, c.relname::text as object,
           acl.grantee::regrole::text as grantee, acl.privilege_type as priv
      from pg_class c cross join lateral aclexplode(c.relacl) acl
     where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p', 'v')
       and acl.grantee in ('anon'::regrole, 'authenticated'::regrole)
    union all
    select 'column', c.relname || '.' || a.attname,
           acl.grantee::regrole::text, acl.privilege_type
      from pg_class c
      join pg_attribute a on a.attrelid = c.oid and a.attacl is not null
      cross join lateral aclexplode(a.attacl) acl
     where c.relnamespace = 'public'::regnamespace
       and acl.grantee in ('anon'::regrole, 'authenticated'::regrole)
    union all
    select 'policy', tablename || '.' || policyname,
           coalesce(array_to_string(roles, ','), ''), cmd::text
      from pg_policies where schemaname = 'public'
    union all
    select 'function', p.oid::regprocedure::text, r.rolname, 'EXECUTE'
      from pg_proc p cross join (values ('anon'), ('authenticated')) r(rolname)
     where p.pronamespace = 'public'::regnamespace
       and has_function_privilege(r.rolname::name, p.oid, 'EXECUTE')
  ) s
 order by 1, 2, 3, 4;
rollback;
```

期待する差分は次の行**だけ**（before に無い行は現れず、after に無い行は消える）。

| 種類 | 消える行 | 増える行 |
|---|---|---|
| table | `households` の anon / authenticated の INSERT・DELETE・TRUNCATE（最大 6 行。before に無ければその分は出ぬ） | なし（`app_operators` は anon / authenticated に 1 行も出ぬのが正） |
| column | なし | なし |
| policy | `households.households_insert` | なし |
| function | anon の EXECUTE: `create_household(text)` `get_invitation_by_token(text)` `accept_invitation(uuid)` `get_pending_approvals()` `approve_user(uuid)` `upsert_push_subscription(text,text,text,text)`（before に anon の行が在った分だけ） | authenticated の EXECUTE: `is_app_operator()` |

それ以外の行が 1 行でも増減しておれば、2.2 の停止条件に当たる。

**member の経路ごとの影響（読みで確かめた分）:**

| member が日常にすること | 通る経路 | 3 本の影響 |
|---|---|---|
| 育児記録の記録・編集・削除、日記 | `baby_logs` / `baby_diaries` の RLS と GRANT | 触れぬ |
| 予定の閲覧・作成・Google 同期 | `calendar_events` / `google_*` | 触れぬ |
| 設定で世帯の赤ちゃん情報を直す | `households_update`（UPDATE） | 触れぬ（締めたのは INSERT / DELETE / TRUNCATE だけ） |
| 家族を招待する・招待リンクを開く | `invitations_insert`（role=member）、`get_invitation_by_token` / `accept_invitation` を**ログイン後**に呼ぶ | 触れぬ。anon から剥がした 2 関数は `/invite` が未認証を `/login` へ送った後にしか呼ばれぬ |
| 通知の購読・再購読 | `upsert_push_subscription` | 本文の検査が RPC 内にも入るだけ。宛先の allowlist は 2026-08 の購読基盤（#208）から Server Action に在り、アプリ経由で登録された行は同じ 3 ホストに限られる。2.1 (c) が 0 なら既存の購読は全て適合 |
| 設定画面を開く | `is_app_operator()` → false | 承認カードは出ぬ（member には以前から出ておらぬ） |

**deploy の後に member の端末で確かめること（5 つ、各 1 分）:** 育児記録を 1 件記録して取り消す／予定を 1 件作って消す／設定を開き承認カードが出ぬこと／招待リンクを 1 本作れること（使わずに捨ててよい）／通知のテスト送信が届くこと。

## 3. 戻し方（migration）

前へ進める修正を推奨する。戻すとそれぞれの欠陥が再び開くゆえ、戻すなら**新しい migration として**出し、`schema_migrations` の行は消さぬこと。

下の「戻し方」で旧い migration に触れるときは、**該当する関数定義（と GRANT）だけ**を新しい migration へ写す。旧いファイルを丸ごと流してはならぬ。例えば `20260408000002_add_approval_system.sql` は :15 に `UPDATE profiles SET is_approved = true;` を含み、丸ごと流すと承認待ちの全員が承認される。

| migration | 戻すと | 戻し方 |
|---|---|---|
| `20261002100003` | RPC で push の宛先検証が消える（送信直前の再検査は残る） | `20260808100001_push_subscriptions.sql` から `upsert_push_subscription` の定義だけを写す |
| `20261002100002` | 承認待ちの email が全 owner に見える状態へ戻る | **先にアプリを戻す**。次に `20260408000002_add_approval_system.sql` から `get_pending_approvals` / `approve_user` の定義だけを写し、`drop function public.is_app_operator(); drop table public.app_operators;` |
| `20261002100001` | 未承認の利用者が世帯を作れる状態へ戻る | `20260603000001_security_hardening_rls.sql` から `create_household` の定義だけを写す（`households_insert` ポリシーと anon への権限は戻さぬことを推奨） |

## 4. 運用者の決め方の別案（製品判断）

今回は「承認はインスタンスの運用者の権限」とした。家族専用インスタンスでは運用者 = 最初の家族の owner になる。別案として、承認待ちの利用者を「申請先の世帯」に紐付け、その世帯の owner が自世帯宛ての申請だけを承認する形もある（申請表の新設が要る）。今の運用では招待リンクが家族を加える本道であり、承認は「別の家族にこのインスタンスを使わせるか」の判断にあたるため、運用者の権限とした。
