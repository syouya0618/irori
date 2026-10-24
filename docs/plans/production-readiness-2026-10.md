# irori 本番適合性レポート（2026-10）

- 対象: `irori`（世帯単位の育児記録＋共有カレンダー PWA）
- HEAD: `b50c7ea`（main と同一）／作業ツリー: `.claude/worktrees/prod-hardening-2026-10`
- 作成日: 2026-10-01
- 性格: 修正**前**の読み取り専用監査の統合報告と、修正の台帳（§10.0）。監査の時点ではコード・migration・設定を変更していない。修正の進み具合は §10.0 の状態欄で追う。

---

## 1. 概要

### 1.1 範囲

認証・承認・オンボーディング、DB 分離（RLS / GRANT / SECURITY DEFINER / Realtime / Storage）、API・OAuth・cron・push・PDF、育児記録ドメイン、カレンダー・Google 同期・通知、migration と型の整合、PWA（SW・キャッシュ・更新・オフライン）、モバイル信頼性、UX / a11y（育児・カレンダー・設定・認証）、性能・構成、依存関係（PR #234）、テストの偽緑、CI・Vercel・env・可観測性・runbook・復旧、文書と指示のドリフト、GitHub Issue/PR の再評価。

### 1.2 方法

- 15 観点（A1 / A2 / A3 / B1 / B2 / B3 / C1 / C2 / D1 / D2 / E1 / E2 / F1 / F2 / G）で並列に監査し、その後に批評役が穴を指摘して 4 観点（X1〜X4）を追加した。
- 敵対的検証:
  - P0/P1 の主張は 3 レンズ（到達性・補償統制・影響）で独立に検証した。生き残りの条件は「反証しない票が 2 票以上」。
  - P2 は懐疑役 1 名が検証した。
  - P3 は未検証のまま収録した。
- 重大度は**検証後の final_severity** を採用した（発見者の主張は使わない）。
- **統合規則**: 同じ欠陥を複数の観点が報告した場合は 1 項目にまとめ、全ての出典 ID を残す。出典ごとに final_severity が異なるときは**最も高いもの**を採用し、低い判定は「異論」欄に記す。
- 確度の表記:
  - 「確認済み」= コード経路を端から端まで追跡し、補償統制が無いことも確認したもの。
  - 「仮説」= 本番状態（Dashboard 設定、適用済み migration、env、実機挙動）に依存するもの、または検証役が uncertain と判定したもの。仮説を確定事実としては扱わない。

### 1.3 環境上の制約

- エージェントの sandbox では、Docker・ローカル Supabase stack・`gh`（認証設定の読取りを拒否）が使えない。Supabase CLI は guard hook が拒否する。
- `pnpm build` は sandbox 内で compile 段から 30 分進まず、打ち切った。loopback の bind が EPERM になることは確かめたが、それが原因かは仮説である。
- 変更前の baseline（main context で実走、local の証拠）:

  | 検証 | 結果 |
  |---|---|
  | `pnpm install --frozen-lockfile` | 成功 |
  | `pnpm lint` | 0 errors / 3 warnings（テスト内の未使用 `_payload`） |
  | `pnpm exec tsc --noEmit` | 0 errors |
  | `pnpm test:run` | 112 files / 1797 tests passed |
  | `check-transition-reject-guard.py --strict` / `check-transition-all.py --strict` | 0 violations（19 blocks / 278） |
  | `check-supabase-error-destructure.py --strict` | 未実行（guard hook がファイル名で拒否） |
  | pgTAP（**PGlite 近似**） | migration 37 本を適用、14 files / 332 asserts ok |
  | `pnpm audit` | critical 1（`next` <16.3.6 の next/og RCE。src は next/og を import しない）。他は dev / build 専用の木と `shadcn` 配下 |

- **PGlite 近似**とは、`@electric-sql/pglite` と `@electric-sql/pglite-pgtap` に Supabase の役割（anon / authenticated / service_role）・`auth.uid()`・`auth.users`・storage の stub・`supabase_realtime` publication・platform の既定権限を shim として被せ、全 migration を適用して `supabase/tests/*.sql` を流したもの（scratchpad に置き、repo には入れていない）。本物の Supabase stack ではないため、DB の最終の証拠は CI の `supabase test db` とする。
- pgTAP と E2E の CI 上の証拠は、`b50c7ea` の push で走った GitHub Actions（CI / E2E / CodeQL がすべて success）に依る。公開 REST API で job step の結論まで確かめた。
- 本番の Supabase / Vercel の設定は一切観測していない。

### 1.4 重大度別件数（統合後）

| 重大度 | 件数（統合後の項目数） | 主な内容 |
|---|---|---|
| P0 | 0 | 世帯間でデータ行が漏洩する経路・認証バイパスは確認されなかった |
| P1 | 7 | 承認ゲート回避、承認待ち者の email 露出、push SSRF / 他世帯への通知停止、育児ログが再同期しない、授乳タイマーの無言破棄、日記の上書き消失、PDF の無音切り詰め |
| P2 | 42 | エラー画面の再試行ボタンが死んでいる、ログイン関連の UX、オフラインと鮮度、カレンダー、Google 同期、運用（バックアップ・SMTP・runbook）、テストの盲点 |
| P3 | 50 | 多層防御、残置物、a11y、依存の衛生、文書ドリフト |
| 反証済み | 4 | §6 |

**総評**: 世帯データの行が別世帯に渡る経路（P0）は見つからなかった。RLS・列 GRANT・DEFINER の `search_path` は堅牢である。一方、次の 3 点は家族データを任せる前に塞ぐべき欠陥である。

1. 「承認ゲート」が UI 層だけで成り立っており、DB 層では誰でも越えられる（P1-01/02）。
2. 共有記録の鮮度と保存の正しさが Realtime 頼みで、静かに嘘をつく（P1-04/05/06）。
3. 受診当日に使う PDF が、典型的な記録量で直近の数週間を黙って欠く（P1-07）。

加えて、Next 16.3 で API 名が変わったため、全エラー境界の「もう一度試す」が無反応になっている（P2-01）。

---

## 2. P0

該当なし。A2-create-household-approval-bypass は発見者が P0 を主張したが、3 レンズ検証の結果は P1（2 票）・P0（1 票）で、final_severity は P1 である（P1-01 に統合）。

---

## 3. P1

### P1-01 create_household が is_approved を検査せず、未承認ユーザーが RPC 直叩きで承認済み owner に自己昇格できる

- **重大度 / 検証状況**: P1／確認済み。3 経路（A1・A2・F1）の 3 レンズ合計 9 票すべてが成立と判定（P1: 7 票、P0: 1 票、P2: 1 票）。
- **統合元**: A1-create-household-approval-bypass, A2-create-household-approval-bypass, F1-create-household-approval-bypass
- **根拠**:
  - `supabase/migrations/20260603000001_security_hardening_rls.sql:31-45`: 検査は `caller IS NULL`・名前の空・`household_id IS NOT NULL` の 3 点だけ。
  - 同 `:51-55`: `SET household_id = new_household_id, role = 'owner', is_approved = true`
  - 同 `:62`: `GRANT EXECUTE ON FUNCTION create_household(TEXT) TO authenticated`
  - 再定義する migration は無い（rg 1 件のみ）。
  - 承認判定は `src/proxy.ts:186-198` の `if (!isApproved)` → /pending-approval だけで、Next の経路にしか効かない。
  - `src/app/setup/actions.ts:23` も承認を検査せずに `rpc("create_household")` を呼ぶ。
  - 対照: `20260808100001_push_subscriptions.sql:140-145` は `is_approved IS DISTINCT FROM TRUE` を DB 側で fail-closed に検査している。
  - `login-form.tsx:45-48` は `shouldCreateUser` を指定していない。`supabase/config.toml:165,202` は `enable_signup = true`（ローカル設定）。
- **対象ファイル**: 上記 migration、`src/app/setup/actions.ts`、`supabase/tests/approval_functions.sql`、`e2e/fixtures/test.ts`
- **利用者影響**:
  - magic link でサインアップした人なら誰でも、公開 anon key と自分の JWT で `POST /rest/v1/rpc/create_household` を 1 回呼べば承認済み owner になる。
  - 家族専用インスタンスの唯一の入場制御（`docs/runbooks/locked-out.md:60-62` が明記）が DB 層で無効になっている。
  - owner になった直後から P1-02 の経路で他人の email を取得でき、`approve_user` で誰でも承認できる。
  - 世帯データの RLS は保たれ、攻撃者が得るのは空の自世帯だけである。このため P0 ではない。
- **根本原因**: H1 修正で世帯作成を DEFINER 化した際、「承認済みだけが /setup に到達する」という UI 層の前提を関数内へ持ち込まなかった。pgTAP も create_household の呼び出し資格を一度も assert していない。`e2e/fixtures/test.ts:80-81` は proxy 層だけの不変条件を DB の不変条件として書いている。
- **再現・検出**: pgTAP で、handle_new_user が作る pending 行（household_id NULL・is_approved false）の sub を `request.jwt.claims` に注入し、`SELECT create_household('x')` を実行すると lives_ok になる。RESET ROLE 後に is_approved=true・role=owner へ変わっていることを観測できる。
- **修正案**:
  - (a) 新 migration で `CREATE OR REPLACE` し、冒頭に「`profiles` 行を `FOR UPDATE` で読み、`is_approved IS DISTINCT FROM TRUE` なら `RAISE ... USING ERRCODE='42501'`」を足す。`SET search_path = public` は維持する。FOR UPDATE は二重送信による孤児世帯も塞ぐ。
  - (b) 最初の利用者を承認する bootstrap 手順（service role による SQL）を runbook に追加する。これを (a) と同時に出さないと、新しいインスタンスでは誰も承認できなくなる。
  - (c) `e2e/fixtures/test.ts` のコメントを DB 契約に合わせて直す。
  - accept_invitation の招待経由の自動承認は変えない。
- **検証方法**:
  - pgTAP: pending の利用者で create_household を呼ぶと `throws_ok(42501)` になり、profiles と households の件数が変わらないこと。承認済みで世帯の無い利用者は lives_ok、既に所属している利用者は従来どおり拒否されること。修正前に赤になることを確認する（fail-red）。
  - E2E の smoke（承認済み → /setup → /baby）が緑のままであること。
- **なぜ今**: リポジトリは公開 OSS で経路は誰にでも見える。サインアップを開いている限り即日実行でき、既存の pending アカウントは Auth 設定に関係なく実行できる。
- **異論**: A2 の影響レンズ・到達性レンズは、世帯データ分離が破れないことを理由に P1 とした。統制レンズは「認証境界の迂回と PII の収穫」を理由に P0 とした。本報告は P1 を採る。本番の `Enable signups` は未観測である。

### P1-02 承認待ち一覧（get_pending_approvals / approve_user）がグローバルで、相互に信頼しない全世帯の owner に他人の email を見せ、誰でも承認できる

- **重大度 / 検証状況**: P1／確認済み。A2 系は 3 レンズすべて P1、D2-3 系は 3 レンズ中 1 票 P1・2 票 P2。
- **統合元**: A2-global-pending-approvals-email-leak, D2-3-global-approval-list-cross-tenant
- **根拠**:
  - `20260408000002_add_approval_system.sql:29-40`: owner 判定（`role = 'owner'`）だけを行い、`SELECT p.id, p.display_name, u.email::TEXT ... WHERE p.is_approved = false` を世帯条件なしで返す。
  - 同 `:54-63`: approve_user も同様に世帯条件が無い。
  - 意図は `20260603000001:112-123` に記載されている（「全 owner が全 pending を見るのは意図された挙動。マルチテナント分離が要件化した場合は再設計」）。
  - `supabase/tests/approval_functions.sql (11)` がこの挙動を固定している。
  - 表示: `settings/page.tsx:89-91` → `approval-card.tsx:77-84`（email 表示）、`:87-98`（確認なしの「承認」ボタンのみ）。
- **対象ファイル**: `20260408000002_add_approval_system.sql`、`src/app/(main)/settings/page.tsx`、`src/components/settings/approval-card.tsx`、`supabase/tests/approval_functions.sql`
- **利用者影響**:
  - 世帯同士は互いに信頼しない前提である。その前提の下で、新規サインアップした第三者の email・表示名・登録時刻が全 owner に見え続ける。P1-01 により、誰でも owner になれる。
  - ApprovalCard は自世帯の設定画面に「承認待ち」として出るため、owner は見知らぬ人を家族と誤認して承認しうる。
  - display_name には長さ制限が無く本人が書き換えられるため、なりすまし文言を全世帯へ出せる（React がエスケープするので XSS にはならない）。
- **根本原因**: 単一運営者を前提にしたグローバル allowlist の設計が、脅威モデル（公開サインアップ・世帯は相互に非信頼）と食い違っている。文書化された先送り条件（「マルチテナント分離が要件化した場合」）が既に成立している。
- **再現・検出**: pgTAP (11) と同じ形で、別世帯の owner の文脈から `SELECT email FROM get_pending_approvals()` を実行すると、無関係な pending の email が返る。
- **修正案**:
  - **製品の根幹に関わる選択であり、人間の判断事項である。** エージェントは決めない。選択肢は次のとおり。
    - (a) 承認権限を運営者 allowlist（service role が付与する専用表または claim）に限り、世帯 owner からは REVOKE する。
    - (b) 承認待ちを申請先の世帯に紐づける `pending_requests` を新設し、owner には自世帯宛ての申請だけを返す。
  - 単純に household フィルタを足すのは不可。承認導線が全損する回帰（H3 撤回の理由）になる。
  - 当面の緩和策: ApprovalCard の email をマスクし、「インスタンスへの新規登録であり、自世帯への参加ではない」と明記する。display_name に長さ CHECK（1..50）を足す。CHECK は締める方向のみ。
- **検証方法**: pgTAP (11) を新モデルに合わせて意図的に反転する（別世帯の owner は見えない・承認できない）。新しい承認導線が通る正例を 1 本置く。E2E で owner の設定画面に他人の email が出ないこと。
- **なぜ今**: P1-01 と組み合わさると、匿名サインアップだけで email を収穫できる。
- **異論**: D2-3 の統制・影響レンズは、漏れるのは世帯データではないとして P2 と判定した。

### P1-03 push endpoint の SSRF allowlist が Server Action 層にしか無く、RPC 直叩きで任意 URL を登録できる。cron が直列で送信するため他世帯の通知を止められる

- **重大度 / 検証状況**: P1／確認済み。A3 系は 3 レンズ中 2 票 P1・1 票 P2、A2 系は懐疑役が P2 と判定。
- **統合元**: A3-push-rpc-bypasses-ssrf-allowlist, A2-push-endpoint-ssrf-rpc-bypass
- **根拠**:
  - `20260808100001_push_subscriptions.sql:71-72`: CHECK は長さだけ。
  - 同 `:120-164`: RPC 本体は host・scheme・port を検査しない。
  - 同 `:167`: `GRANT EXECUTE ... TO authenticated`
  - `push-actions.ts:67`: 「SSRF / open relay 対策。ここが唯一の防御ゆえ」
  - `deliver.ts:1014-1022`: `endpoint: target.endpoint` を再検証せずに送る。
  - `send-push.ts:124-127`: timeout は socket の無通信 timeout にすぎないとコード自身が認めている。
  - `web-push-lib.js:372-374`: 応答本文を上限なく連結する。
  - `deliver.ts:203-214`: 世帯を直列に処理し、時間予算が無い。
  - `cron/notify/route.ts:43`: `maxDuration = 60`
  - `push-endpoint.ts:47-50`: isAllowedPushEndpoint は port を見ない。
- **対象ファイル**: 上記 migration、`deliver.ts`、`send-push.ts`、`push-endpoint.ts`、`push-actions.ts`、`cron/notify/route.ts`、`supabase/tests/push_subscriptions_grants_rls.sql`
- **利用者影響**:
  - P1-01 で承認済みになった誰かが、`https://attacker:port/` を購読として登録できる。自世帯に予定通知を作れば、cron が 5 分ごとにその宛先へ POST する（盲目 SSRF。failure_count が到達性の oracle になる）。
  - 応答を返さない宛先や tarpit を数本並べれば、1 回の実行で 60 秒を使い切れる。
  - 後に並んだ世帯の予定通知は grace 15 分を過ぎて expired になり、関数が kill されるため finally の心拍も書かれない。
- **根本原因**: 書き込みは RPC 1 本に封じたのに、入力検証をアプリ層の 2 か所の入口にしか置いていない。送信層に総時間の上限が無い。
- **再現・検出**: 承認済みの JWT で `rpc('upsert_push_subscription', { p_endpoint: 'https://attacker.example:8443/x', ... })` を実行すると成功する。pgTAP には非 allowlist の endpoint を RPC が拒むことを確かめるテストが無い。
- **修正案**:
  - (1) RPC 内で https・許可ホスト・port（空または 443）を検証し、不一致なら 22023 を返す。
  - (2) 既存行を先に検査してから同じ判定の CHECK を追加する。DB 側の正規表現と `isAllowedPushEndpoint` で port の扱いを一致させる。
  - (3) `deliver.ts` の送信直前に再検証し、不適合なら skip してログに残す。
  - (4) `isAllowedPushEndpoint` に port の検査を足す。
  - (5) `sendPushNotification` に AbortController で総時間の上限を付け、応答本文の長さにも上限を設ける。
  - (6) cron に時間予算を持たせ、閾値を切ったら心拍を書いて返す。
  - (7) 1 ユーザーあたりの購読数に上限を設ける。
  - 列 GRANT・404/410 だけ削除する方針・共用端末での付け替え（B-13）は維持する。
- **検証方法**: pgTAP で、許可外ホスト・http・非 443 port が拒否され、`https://fcm.googleapis.com/fcm/send/x` は lives_ok であること。vitest で deliver が不正な endpoint に送らないこと、総時間の上限で打ち切られること。
- **なぜ今**: コード自身が「唯一の防御」と宣言している箇所が迂回でき、相互に信頼しない世帯の主要機能（通知）を止められる。
- **異論**: A3 の影響レンズと A2 の懐疑役は P2 と判定した。理由は次のとおり。SSRF は盲目で、本文は暗号化されている。他世帯への影響は処理順に依存し、可用性の問題にとどまる。心拍の停止で異常に気付ける。内部到達性は TLS 検証により限定される。

### P1-04 育児ログ（baby_logs）は画面復帰・再接続のときに再取得されない。配偶者の記録や削除が反映されず、「最終授乳」「次の授乳の目安」が誤ったまま表示される

- **重大度 / 検証状況**: P1／確認済み。4 経路（B1・C2・D1・E1）の 3 レンズ合計 12 票すべて P1。
- **統合元**: B1-1-baby-logs-no-self-recovery, C2-baby-logs-no-resume-reconcile, D1-baby-logs-no-freshness-path, E1-baby-logs-no-resync-on-resume
- **根拠**:
  - `src/components/baby/baby-dashboard.tsx:97-101`: logs / weeklyLogs / growthLogs は `useState(initial*)` で一度だけ初期化される。`page.tsx:166` に key が無い。
  - 同 `:165-173`: `household_id=eq.` フィルタ付きの購読。
  - 同 `:239-244`: DELETE ハンドラ。フィルタ付き購読には DELETE が配信されないため、事実上死んでいる（リポジトリ自身が `20260723000001:9-14` と `verification-record.md` V2 で結論済み）。
  - 同 `:247-249`: subscribe コールバックはログを出すだけで、再接続しても再取得しない。
  - 同 `:305-330`: `useVisibilityRefetch` が取り直すのは `baby_diaries` だけ。
  - 同 `:334-401`: logs の再取得は selectedDate が変わったときだけ。
  - `next.config.ts:24-26`: 「visibilitychange / focus 復帰時 refetch が実データへ揃える」は baby_logs については事実に反する。
  - `baby-log-form-sheet.tsx:559-563`: 既に削除済みの行を削除しようとすると error で return し、onLogRemoved が呼ばれないため幽霊行が残る。
- **対象ファイル**: `baby-dashboard.tsx`、`baby-log-form-sheet.tsx`、`next.config.ts`
- **利用者影響**:
  - 夜間にバックグラウンドへ置いた端末を復帰させても、その間に配偶者が付けた授乳・おむつが出ない。postgres_changes は切断中のイベントを再送しない。
  - 配偶者が取り消した記録も残り続ける。
  - 最終授乳・目安・今日の回数・週間グラフが古い値のまま表示され、古いことを示す表示も無い。
  - 二重授乳の判断や重複記録に直結する。#92 が本番で続いていれば常態化する。
- **根本原因**: カレンダーと日記には入れた「復帰時の再取得で自己回復する」設計（V2 の代替策 2・計画 UX-08）を、最も重要な baby_logs にだけ配線していない。
- **再現・検出**: 2 端末で /baby を開き、B をバックグラウンドにする。A で記録と削除を行ってから B を復帰させても、B の表示は変わらない。vitest では visibilitychange を発火させても `from("baby_logs")` が呼ばれないことで検出できる。
- **修正案**:
  - `useVisibilityRefetch` と、2 回目以降の `SUBSCRIBED`（再接続）を契機に、選択日の logs・8 日窓の weekly・growth・lastFeeding / lastNursing の fallback を取り直す。AbortController と世代ガードを付ける。
  - 選択日のマージに `mergeDateNavLogs` を流用しない（prev を残すため削除が反映されない）。取得結果を真値として置き換え、取得開始後に楽観 append した id だけを残す。
  - deleteLog が「既に削除されています。」を返した場合も onLogRemoved を呼ぶ。
  - `next.config.ts` のコメントを実態に合わせて直す。
  - staleTimes.dynamic=10 は変更しない。
- **検証方法**: vitest で次を確認する。(a) visibility で再取得が走る、(b) 削除済みの行が消える、(c) 取得中に楽観追加した行が残る、(d) abort 後に setLogs しない。修正前に赤になることを確認する（fail-red）。E2E で 2 コンテキストを使い、A の削除・記録が B の復帰後に反映されることを確認する。
- **なぜ今**: #92（本番で Realtime が他端末に届かない）が未解決のまま、核心機能が Realtime 単独に懸かっている。
- **異論**: なし。DB の行は失われず、別タブとの往復（10 秒超）やリロードで回復する点が緩和要因である。

### P1-05 授乳タイマーの × ボタン・背景タップ・Esc が、計測中のタイマーを確認なしで無言のまま破棄する

- **重大度 / 検証状況**: P1／確認済み。B1 系は 3 票 P1、C2 系は 2 票 P1・1 票 P2、D1 系は 2 票 P1・1 票 P2。
- **統合元**: B1-3-timer-silent-discard, C2-feeding-timer-dismiss-destroys-running-timer, D1-timer-dismiss-discards-running-feeding
- **根拠**:
  - `src/components/baby/feeding-timer.tsx:618-625`: `if (!isOpen && startedAt && !isSavingRef.current) { // Sheet dismissed by swipe — treat as cancel; localStorage.removeItem(STORAGE_KEY); setStartedAt(null) }`
  - 同 `:630`: `<Sheet open={open} onOpenChange={handleOpenChange}>` に `disablePointerDismissal` が無い。
  - `sheet.tsx:43`: `showCloseButton = true`
  - `DialogRoot.d.ts:48-50`: `disablePointerDismissal @default false`
  - 同 `:815-821`: 明示キャンセルのボタンには min-h も確認も無い。
  - 通信失敗後（`:478-494`）は isSavingRef が false に戻るため、閉じた時点で破棄される。
  - 計画 B-10 / UX-04a で直すと決めていたが、未実装のまま残っている。
- **対象ファイル**: `feeding-timer.tsx`、`src/components/ui/sheet.tsx`、`baby-dashboard.tsx`
- **利用者影響**: 片手・夜間の操作で、上部の暗幕・× ボタン・保存失敗後の「閉じる」に触れるだけで、開始時刻・左右の回数・左右の秒数がすべて消える。次に開くと 00:00 から始まる。復元する手段は無い。
- **根本原因**: 初期実装の「スワイプで閉じる＝キャンセル」が、Base UI Dialog の既定の閉じ方（外側押下・閉じるボタン・Esc）にそのままつながっている。計測中のタイマーをシートの外で示す UI も無い。
- **再現・検出**: タイマーを開始してから暗幕をタップし、再度「左」を押すと 00:00 になる。vitest では Escape や Close の後に `localStorage['irori:feeding-timer']` が null になることで確かめられる（現状は fail-red の材料になる）。
- **修正案**:
  - 閉じる操作を非破壊にする。startedAt と localStorage を保持し、タイマーは走らせ続ける。
  - FeedingTimer 側で `disablePointerDismissal` を Root に渡し、`showCloseButton={false}` にするか、閉じるボタンを「最小化」の意味にする。共通の sheet.tsx の既定は変えず、prop を透過させるだけにする。
  - ダッシュボードに「授乳計測中 12:34・開く」のチップを置く。
  - 明示キャンセルは min-h-11 にし、2 段階で確認する。
  - 保存中の破棄ガード、logged_at を開始時刻とする契約、resolveBreastSideSeconds は維持する。
- **検証方法**: vitest で、Escape / 暗幕 / × の後も localStorage が残り、再度開いたときに同じ startedAt に復元されることを確認する。明示キャンセルのときだけ削除されることも確認する。実機で暗幕タップを試す。
- **なぜ今**: 最も頻繁に使う記録の主経路で、毎晩この経路を通る。
- **異論**: C2 と D1 の影響レンズは P2 と判定した。理由は、失われるのは未保存の進行中データで、利用者は 00:00 の表示で気付けるうえ、手動入力で概算を入れ直せること。

### P1-06 育児日記の upsert に同時実行制御が無く、配偶者の本文を無言で上書きする。取得失敗時に空欄から書いた場合も既存の日記を置き換える

- **重大度 / 検証状況**: P1／確認済み。B1 系は 3 票 P1、D1 系は 2 票 P1・1 票 P2。
- **統合元**: B1-6-diary-overwrite, D1-diary-blind-overwrite
- **根拠**:
  - `src/app/(main)/baby/actions.ts:791-801`: `.upsert({ household_id, diary_date, content: trimmed, updated_by }, { onConflict: "household_id,diary_date" })` を無条件に実行する。空保存の DELETE（`:772-788`）も無条件。
  - `baby-dashboard.tsx:382-393`: 日付ナビでの取得が error のとき `setDiary(null)` にし、トーストは出さない。
  - `page.tsx:141-145, :173`: `initialDiary={todayDiary ?? null}`
  - `baby-daily-diary.tsx:50-58`: diary が null なら「日記を書く」を出す。
  - `baby-diary-edit-sheet.tsx:45`: `useState(initialContent)` で開いた時点の本文に固定される。
  - `baby-diary-view.tsx:119-125`: Realtime も visibility の再取得も無い一覧から、空の初期値で書ける。
  - `migrations/20260722000002`: 履歴表も版の比較も無い。
- **対象ファイル**: `baby/actions.ts`、`baby-dashboard.tsx`、`baby-diary-edit-sheet.tsx`、`baby-daily-diary.tsx`、`baby-diary-view.tsx`、`baby/page.tsx`、`baby/diary/page.tsx`
- **利用者影響**: 2 人が同じ日の日記を前後して保存すると、先に保存した本文が消える。取得失敗を「日記なし」と表示し、空欄から書いた一言で既存の長文を置き換えることもある。履歴が無いため復元できない。
- **根本原因**: 読み込み状態が「有り / 無し」の 2 値しかない。W-1（前日の本文を流用しないための fail-to-empty）が、逆方向の「空からの上書き」という穴を残した。書き込み側にも期待版（updated_at）の前提条件が無い。
- **再現・検出**: A と B が同じ日を開き、A が保存した後に B が保存すると、A の本文が消える。dashboard の日付ナビで日記の取得を error にすると「日記を書く」が出る（`baby-dashboard-datenav.test.tsx:311-340` がこの挙動を仕様として固定している）。
- **修正案**:
  - (1) 日記の読み込み状態を 3 値（loaded / absent / unknown）にする。unknown のときは編集導線を無効にし、「読み込めませんでした・再読込」を出す。page / date-nav / 一覧の 3 か所の入口すべてに適用する。
  - (2) `upsertBabyDiary` に期待 updated_at（新規なら null = 不在を期待）を渡す。サーバは既存行なら `.eq('updated_at', expected)` 付きの UPDATE、新規なら INSERT を行い、衝突したら最新の本文と conflict を返す。空保存の DELETE にも同じ前提条件を課す。
  - W-1・UNIQUE・CHECK・RLS は変えない。migration は不要（updated_at 列とトリガは既にある）。
- **検証方法**: actions のテストで、期待 updated_at が不一致なら上書きせずに conflict を返すこと。dashboard のテストで、unknown のとき編集ボタンが無効になること。既存の datenav テスト `:311-340` は意図的に更新する。
- **なぜ今**: 日記は唯一の自由記述の共有データで、失うと再現できない。モバイル回線の不安定さと 2 台での利用という前提に直撃する。
- **異論**: D1 の影響レンズは P2 と判定した。理由は、logs の取得も同時に失敗すればトーストが出ること、同時編集の頻度が低いこと。

### P1-07 小児科用 PDF レポートが PostgREST の max_rows=1000 で無音に切り詰められ、直近の記録が欠ける。切り詰め検知も構造上発火しない

- **重大度 / 検証状況**: P1／コード上は確定（4 経路の 3 レンズ合計 12 票すべて P1）。本番で影響が出るかは本番の API Max Rows 設定次第で、そこは**仮説**（既定値もローカル設定も 1000、引き上げた記録は無い）。
- **統合元**: A3-baby-report-max-rows-silent-truncation, B3-pdf-report-silent-truncation-max-rows, E1-pdf-report-max-rows-silent-truncation, F2-baby-report-max-rows-silent-truncation
- **根拠**:
  - `src/app/api/baby-report/route.ts:32`: `const LOG_FETCH_LIMIT = 5000`
  - 同 `:80-81`: `.order("logged_at", { ascending: true }).limit(LOG_FETCH_LIMIT + 1)` の単発クエリ。ページングは無い。
  - 同 `:112`: `const truncated = fetched.length > LOG_FETCH_LIMIT`
  - `supabase/config.toml:18`: `max_rows = 1000`
  - `baby-log-aggregation.ts:130-133`: データのある日だけを行にする。
  - `route.test.ts:80,172`: mock が 5001 行を返すため、max_rows を再現できない。
  - 同じリポジトリの `baby-diary-view.tsx:31` は max_rows を前提に range でページングしている。
- **対象ファイル**: `src/app/api/baby-report/route.ts`、`__tests__/route.test.ts`、`src/components/settings/export-card.tsx`
- **利用者影響**: 新生児期は 1 日 15〜25 行あり、「3ヶ月」レポートは 1000 行を超える。昇順で取得するため、欠けるのは受診直前の数週間で、直近の体重や体温も落ちる。見出しは全期間を名乗り、ログ・`X-Report-Truncated`・PDF 本文の三重の警告はどれも出ない。
- **根本原因**: 切り詰めを「要求件数を超えたか」で判定しているが、実際の上限はサーバ側の db-max-rows で、limit は黙って 1000 に丸められる。
- **再現・検出**: CI と同じローカル Supabase で、直近 90 日分の baby_logs を 1500 行 seed し、`GET /api/baby-report?period=3months` を呼ぶ。集計は 1000 行で止まり、ヘッダも付かない。本番では Dashboard → API Settings → Max Rows と、`count(*)`（90 日）を確認する。
- **修正案**:
  - `.order("logged_at").order("id").range(offset, offset+999)` を、受領件数をオフセットにしながら 0 件が返るまでループする。累計で 5001 行に達したら既存の truncated 経路へ流す。
  - 代替案として、SECURITY INVOKER の集計 RPC で日別集計を DB 側に寄せてもよい。
  - max_rows の引き上げを修正にしてはならない（全 API の防御を緩めることになる）。
  - ユーザー client（RLS 経由）と三重警告は維持する。
- **検証方法**: route の fake を「min(要求件数, 1000) 行しか返さない」ものに変え、1500 行で全件が集計され最終日の行があること、999 行と 5001 行の対照も確かめる。修正前に赤になることを確認する（fail-red）。CI の E2E で 1001 行以上を seed した実 DB テストも行う。
- **なぜ今**: 生後 2〜3 ヶ月で必ず閾値を超え、それはちょうど健診の時期に当たる。誤りは紙に残り、利用者は検知できない。
- **異論**: なし。本番の Max Rows が 5001 以上に引き上げられていれば顕在化しない（未観測）。

---

## 4. P2

各項目の欄は、重大度 / 検証状況・統合元・根拠・対象・影響・原因・再現・修正・検証・なぜ今・異論、の順に並べる。

### P2-01 Next 16.3.4 では error.tsx に unstable_retry が渡されず、全ての「もう一度試す」ボタンが反応しない（CLAUDE.md が旧 API を強制している）

- **重大度 / 検証状況**: P2／確認済み（3 レンズ中 P2 が 2 票、P1 が 1 票）。統合元: G1-error-boundary-unstable-retry-dead
- **根拠**:
  - アプリ側: `src/app/error.tsx:8,11,34` `onClick={() => unstable_retry()}`、`(main)/error.tsx:9,12,23` と `(main)/baby/error.tsx:9,12,23` `onRetry={unstable_retry}`
  - Next 側: `node_modules/next/dist/client/components/error-boundary.js:110-115` は `error, reset, retry` の3つしか渡さない。docs `error.md:331` `v16.3.0 | retry prop became stable.`
  - 規約側: CLAUDE.md:9,:58 が `unstable_retry` の使用を指示している。
  - error 境界を描画するテストは 0 件。
- **対象**: 上記 error.tsx 3 本、`error-view.tsx`、CLAUDE.md
- **影響**: lookup-failed（`(main)/layout.tsx:29-30` で throw）や描画時の例外で error 画面に落ちると、再試行を押しても何も起きない。ルートの error.tsx では TypeError が出る。BottomNav が出ない経路で iOS standalone の場合、アプリの強制終了以外に戻る手段が無い。
- **原因**: #230 で Next を 16.3.4 に上げた際に prop 名が改名された。props の型はアプリ自身が宣言しているため、tsc では検出できない。
- **再現**: Next の ErrorBoundary で throw する子を包み、`AppRouterContext.refresh` の mock を置く。button をクリックしても refresh が呼ばれない。
- **修正**: 3 ファイルの prop を `retry` に改名する。CLAUDE.md:9,:58 と advisor 軸3 の例示も直す。
- **検証**: 境界描画テスト（click → refresh が 1 回）を fail-red で追加する。`grep -rn unstable_retry src CLAUDE.md` が 0 件になることを確認する。
- **なぜ今**: 既に本番に入っている。PR #234 を入れても直らない。lookup-failed の設計はこのボタンでの自己回復を前提にしている。
- **異論**: 統制レンズは P1 と判定した（回復手段を偽る UI であり、主要経路が停止する）。

### P2-02 /auth/confirm が GET 1 回で token_hash を消費する。リンクプレビューの先読みで緊急ログインが失敗し、発行者・本人に結び付かないため login CSRF も成立しうる

- **重大度 / 検証状況**: P2／仮説（A1 系は懐疑役が確認、X1 系は 3 レンズ中 uncertain 2 票・confirmed 1 票、いずれも P2）。統合元: A1-confirm-link-burned-by-preview, X1-auth-confirm-login-csrf-cross-household
- **根拠**:
  - `src/app/auth/confirm/route.ts:55-96` は GET で `verifyOtp({ token_hash, type })` を呼び、そのまま redirect する。確認画面も、端末や本人への結び付けも無い。
  - `:24` の「リンクを作れるのはサービスロールキーを持つ者だけ」は誤り。GoTrue の TokenHash は、通常のマジックリンクメールの `token=` と同じ値である。
  - `proxy.ts:144` は完全一致で public にしている。`:216-223` のとおり、ログイン済みの端末はハンドラに届かない。
  - `locked-out.md:24-26` は「LINE 等で渡す」「どのブラウザで開いてもよい」と案内している。
  - Supabase 公式は、prefetch による消費への対策として確認ボタンのページを挙げている。
  - 連鎖: `push-reconcile.ts:170-187` と `upsert_push_subscription:147-160` で購読が自動で付け替わる。Google 連携は差し替え後の user_id に保存される。
- **対象**: `auth/confirm/route.ts`、`proxy.ts`、`push-reconcile.ts`、`locked-out.md`、`scripts/generate-login-link.mjs`
- **影響**:
  - (a) runbook どおり LINE で送ると、プレビュー取得が先に token を消費し、本人がタップしても link_invalid になる。
  - (b) 独自 SMTP を導入した後は、攻撃者が自分宛てのメールから得た token_hash を未ログイン端末で踏ませるだけで、被害者の端末が攻撃者のセッションに差し替わる。以後の記録・push 購読・Google 接続は攻撃者の世帯へ流れる。
- **原因**: 使い切りの資格情報を安全な GET で消費しており、人の操作を挟んでいない。
- **再現**: (a) 生成したリンクを curl で 1 回取得した後、ブラウザで開くと link_invalid になる。(b) CI の Mailpit からメール本文の token を取り出し、cookie の無い context で /auth/confirm を開くとセッションが立つ。
- **修正**:
  - GET では verifyOtp を呼ばず、`Cache-Control: no-store` と `Referrer-Policy: no-referrer` を付けた確認画面を返す。
  - 確定は Server Action の POST で行う。Next の Origin 照合が効く。Route Handler にする場合は Origin / Sec-Fetch-Site の明示検査が必須。
  - generate-login-link で `email` と `exp` を HMAC 署名し、POST 後に `data.user.email` と照合する。不一致なら `signOut({scope:'local'})` して失敗させる。署名の無い token は拒否する。
  - 利用者が交代した端末では reconciler の自動再登録を止める。
  - proxy の完全一致は維持し、ALLOWED_TYPES は magiclink のみとする。確認画面だけでは login CSRF は防げない。
- **検証**:
  - vitest: GET で verifyOtp が呼ばれないこと。POST で 1 回呼ばれること。email 不一致なら拒否されること。
  - E2E（Mailpit）: cookie の無い GET でセッションが立たないこと。Origin が異なる POST が拒否されること。
- **なぜ今**: 緊急経路は使う瞬間にしか試されない。**独自 SMTP（P2-39）やメールテンプレートの TokenHash 化より前に入れねばならない**。順序を誤ると (b) が実害になる。
- **異論**: X1 の到達性・統制レンズは「本番は組込み SMTP で、第三者は token を得られない」として uncertain と判定した。X1 は当初 P1 を主張していた。

### P2-03 ブラウザ側の refresh が失敗・破棄されると、PostgREST の読み取りが anon キーで送られる。RLS が空配列を「成功」として返し、復帰時の再取得が予定・今日明日カード・日記を無言で空にする

- **重大度 / 検証状況**: P2／確認済み（懐疑役。Realtime に関する副主張は未検証で除外）。統合元: X4-1-anon-fallback-silent-empty-on-refresh
- **根拠**:
  - auth-js `GoTrueClient.js:2528-2538`: 実失効中の refresh 失敗は session null になる。`:4126-4131` で失敗が 60 秒キャッシュされる。`:4155-4171` の commit guard でも破棄される。
  - supabase-js `index.cjs:957`: `const bearer = realToken ?? (allowKeyAsBearer ? supabaseKey : null)`
  - `calendar_events_select` には TO 句が無く、anon では `get_my_household_id()` が NULL になるため 0 行が返る（error ではない）。
  - アプリ側 `use-month-events.ts:103-109` と `upcoming-events-card.tsx:96` は error のときしか状態を保持しない。`baby-dashboard.tsx:315-327` は `setDiary(data ?? null)` で上書きする。
- **対象**: `use-month-events.ts`、`upcoming-events-card.tsx`、`baby-dashboard.tsx`、household 系 migration
- **影響**: 網の回復直後や Auth の部分障害時に、予定が「ありません」になり、カードと日記が消える。ログもトーストも出ない。消えた日記を見て書き直すと、P1-06 の経路で配偶者の本文を失う。
- **原因**: 次の3つが重なって、認証が一時的に無い状態がデータの空として描かれる。auth-js の null 返却、supabase-js が黙って anon へ退避すること、household 表が anon の SELECT を許していること（Supabase の既定 GRANT）。
- **再現**: mock で `getSession` を null、select を `{data:[],error:null}` にして visibilitychange を起こすと、events が [] になる。pgTAP では `SET LOCAL role anon` のまま 0 行が返る。
- **修正**:
  - (1) 新 migration で household 表（calendar_events / baby_logs / baby_diaries / profiles / households 等）を `REVOKE SELECT ... FROM anon` する（締める方向のみ）。anon の読み取りは 42501 になり、既存の error ガードで状態が保持される。
  - (2) ブラウザ側の読み取りの前に session の非 null を確認し、null なら状態を変えずに `router.refresh()` する。
- **検証**: pgTAP で anon の SELECT が throws_ok '42501' になること。vitest で session が null のとき setEvents / setDiary が呼ばれないこと（mutation で検知力を確かめる）。
- **なぜ今**: 復帰時の再取得は全画面で鮮度の唯一の担保であり、同じ経路が認証の不在をデータの消失として描いている。
- **異論**: なし。iOS のコールドスタートでは proxy が先に refresh するため発生しない。

### P2-04 /baby の SSR が 8 クエリのどれかで失敗しても握りつぶして空表示にし、「まだ記録がありません」「最終授乳 ---」と既定の授乳間隔を出す

- **重大度 / 検証状況**: P2／確認済み（懐疑役 2 名とも確認。B1-11 は P3 未検証）。統合元: D1-page-fetch-error-rendered-as-empty, E1-baby-page-silent-empty-on-query-error, B1-11-ssr-silent-empty
- **根拠**:
  - `src/app/(main)/baby/page.tsx:117-163` は error をログに出すだけ。`:165-184` は `initialLogs={logs ?? []}`、`babyBirthDate={household?.baby_birth_date ?? null}`、`feedingIntervalMin={... ?? FEEDING_INTERVAL_DEFAULT}`。
  - commit 07bcab8 の注記は「フォールバック (?? []) は維持し動作は不変」。
  - `docs/plans/phase-a-bugfix.md:81,633-641` の A-6c で修正対象とされているが、未完。
  - `(main)/baby/error.tsx` は存在するが到達しない。
- **対象**: `baby/page.tsx`、`baby-dashboard.tsx`、`baby-timeline.tsx`、`baby-age-header.tsx`、`baby-summary-bar.tsx`
- **影響**: Supabase 側の部分的な障害で今日が 0 件と表示され、二重記録を誘う。設定済みの誕生日の入力を促し、授乳の目安を既定の 180 分で黙って計算する。P1-04 のため、この状態が自己回復しない。
- **原因**: 「読めなかった」と「無い」を同じ値で表している。settings で採っている unknown の区別が、baby には適用されていない。
- **再現**: 今日の範囲の baby_logs クエリだけを error にする fake を使うと、initialLogs:[] が描画される。
- **修正**: 中核クエリ（今日の logs / weekly / fallback / household）が失敗したら throw して error.tsx へ倒す（P2-01 の修正が前提）。非中核（growth / upcoming / diary）はカードごとに「読み込めませんでした」を出す。
- **検証**: page の単体テストで、各クエリの error 時に throw するかエラー状態になること。全クエリが正常で 0 件のときは空描画になる対照も置く。
- **なぜ今**: 不安定なモバイル回線が前提であり、空表示は重複記録という形でデータを汚す。
- **異論**: 懐疑役によれば、引き金は端末の回線ではなく Vercel→Supabase 間の部分障害であり、頻度は低い。

### P2-05 /baby を開いたまま JST 0:00 を跨ぐと、selectedDate が前日に留まる。「次の授乳の目安」が消え、配偶者が 0 時以降に付けた記録も受け付けない

- **重大度 / 検証状況**: P2／確認済み（D1 は 3 レンズで P2 が 2 票・P1 が 1 票、B1・C2 は懐疑役が確認）。React Compiler が today を凍結する分岐は仮説。統合元: D1-midnight-rollover-dashboard-stuck, B1-9-midnight-rollover, C2-dashboard-day-rollover
- **根拠**:
  - `baby-dashboard.tsx:102` `useState(initialDate)` を日付の境界で進める処理が無い。
  - `baby-summary-bar.tsx:60` `isToday = date === todayJstString(now)` は毎分評価されるため、0 時を過ぎると false になり、`:74-77` で目安が null になる。
  - `:194` admission の判定 `!== selectedDateRef.current` によって、0 時以降の INSERT が弾かれる。
  - `feeding-timer.tsx:505-507` もこの状態を認めている。
  - 計画書 D-1 は未診断のまま。
- **対象**: `baby-dashboard.tsx`、`baby-summary-bar.tsx`、`baby-date-nav.tsx`
- **影響**: 夜間授乳の最中に目安カードが消え、最終授乳は経過時間ではなく絶対時刻の表示に変わる。配偶者の 0:10 の記録は timeline にも回数にも出ない。
- **原因**: 「今日」の導出が、反応するもの（summary bar）と反応しないもの（dashboard / date-nav）に分かれている。
- **再現**: fake timers で 23:59 に描画し、2 分進めると目安が消える。0:01 の INSERT を emit しても反映されない。
- **修正**: today を `todayJstString(now)` から導く。selectedDate が旧 today なら新しい today へ進め、P1-04 と同じ再取得関数で取り直す。過去日を見ている場合は動かさない。
- **検証**: vitest（fake timers）で 23:59 → 0:01 を跨いだ後も、目安・admission・クイック記録が維持されることを確認する。実機で D-1 の 3 回試行を行う。
- **なぜ今**: 授乳は夜間に集中し、毎晩この境界を通る。
- **異論**: D1 の統制レンズは P1 と判定した。D1 の到達性・影響レンズは、データが無傷でリロードで回復することを理由に P2 とした。

### P2-06 自端末の作成・削除の楽観反映が logs だけで、週間グラフ・成長曲線に残る。編集はどこにも即時反映されない

- **重大度 / 検証状況**: P2／確認済み（懐疑役 2 名。編集が反映されない件は #92 に依存するため仮説）。統合元: B1-2-own-reflection-partial, D1-own-write-partial-reflection
- **根拠**: `baby-dashboard.tsx:505-513` の appendLog / removeLog は `setLogs` だけを呼ぶ。weekly / growth を変えるのは Realtime だけで、DELETE は配信されない。`baby-log-form-sheet.tsx:541-547` は updateLog の後にローカルを更新しない。`revalidatePath` は useState に捨てられる。
- **対象**: `baby-dashboard.tsx`、`baby-log-form-sheet.tsx`、`baby/actions.ts`
- **影響**: 誤入力した体重を削除しても成長曲線に残る。取り消したおむつも週間の内訳に残り、同じ画面内で数字が食い違う。Realtime が届かない間、編集が表示に反映されない。
- **原因**: B-03 の楽観化が、logs と作成・削除にしか適用されていない。
- **再現**: initialGrowthLogs を持つ状態で削除すると、成長の最新値が残る（Realtime は emit しない）。
- **修正**: appendLog / removeLog を weekly（窓の判定付き）と growth にも適用する。updateLog は更新後の行を返し、3 系統を id で置き換える（Realtime の echo と冪等にする）。
- **検証**: 削除・Undo・作成・更新の後に 3 系統が一致することを、fail-red で確認する。
- **なぜ今**: #92 の下では、「保存したのに変わらない」が日常的に表に出る。
- **異論**: なし。

### P2-07 編集シートが変更していない項目まで常に送るため、古い画面からの編集が配偶者の修正を無言で巻き戻す（lost update）

- **重大度 / 検証状況**: P2／確認済み（懐疑役。本番で数時間古い状態が常態化する点は #92 に依存するため仮説）。統合元: B1-5-stale-full-field-overwrite（D1-own-write の巻き戻しの記述を含む）
- **根拠**: `baby-log-form-sheet.tsx:433-435, 455-478, 517-521, 528-539` は memo / feedingType / amountMl / counts / diaperType / poopAmount / 体温 / 体重を常に送る。dirty 判定は時刻と時間にしか無い。`actions.ts:630-695` は前提条件なしで UPDATE する。`BABY_LOG_COLUMNS` に updated_at が無い。
- **対象**: `baby-log-form-sheet.tsx`、`baby/actions.ts`、`baby-log-columns.ts`
- **影響**: 父が 80→120ml に直した後、母が古いシートでメモだけ足して保存すると、量が 80 に戻る。どちらの端末にもエラーは出ない。シートを開いている最中に相手が保存した場合は、Realtime と関係なく起きる。
- **原因**: サーバは「undefined の項目は触れない」という部分更新の契約を持つのに、クライアントが全項目を送っている。楽観的排他も無い。
- **再現**: メモだけを編集したときに、updateLog の引数に amountMl が含まれる。
- **修正**: seed との差分だけを送る。ただし CHECK 上、組で送る必要があるもの（feedingType と counts / sides / startSide、diaperType と poopAmount）は組単位で dirty を判定する。updated_at を select に足し、`.eq("updated_at", expected)` を付ける。0 行なら「他の端末で更新されました」を返す。
- **検証**: vitest で、メモだけの編集時に payload に amountMl が無いこと。actions のテストで、updated_at が不一致なら専用エラーを返すこと。
- **なぜ今**: P1-04 により、古い seed が常態化している。
- **異論**: なし。

### P2-08 記録系 Server Action に冪等キーが無く、応答だけが失われて再試行すると二重記録になる

- **重大度 / 検証状況**: P2／確認済み（懐疑役 2 名。実環境で応答が失われる頻度は仮説）。統合元: B1-7-no-idempotency-duplicates, C2-record-retry-duplicates
- **根拠**:
  - `baby/actions.ts:255-281`（recordFeeding）と `:317-332`（recordDiaper）は id を指定せずに INSERT する。
  - `feeding-timer.tsx:478-488` は失敗時に localStorage を保持して再停止へ誘導する。
  - `baby-quick-actions.tsx:151-153` は「もう一度お試しください」と出す。
  - `revalidatePath` は応答の中で再描画するため（server-actions.md:150）、commit から応答までの時間が長い。
- **対象**: `baby/actions.ts`、`feeding-timer.tsx`、`baby-quick-actions.tsx`、`baby-log-form-sheet.tsx`
- **影響**: 電波の弱い寝室で、保存済みなのに失敗トーストが出る。再試行すると同じ授乳やおむつが 2 行になり、回数・週間・PDF が水増しされる。
- **原因**: at-least-once の再送を UI が促しているのに、サーバ側に重複を吸収する鍵が無い。
- **再現**: Playwright でレスポンスを遮断し、サーバ処理を完了させてから再試行すると 2 行になる。
- **修正**:
  - クライアントで `crypto.randomUUID()` を**操作の意図ごとに 1 回だけ**生成し、成功するまで state か localStorage に保持する。タイマーは開始時に確定させ、`handleManualRecord` のように試行のたびに作り直さない。それを PK として INSERT する（**migration 不要**）。
  - 23505 の場合は RLS の下でその id を SELECT し、世帯と内容が一致したときだけ成功を返す。
- **検証**: タイマーのテストで、reject のあとに resolve した 2 回の呼び出しが同じ id を持つこと。actions のテストで、23505 かつ内容が一致すれば成功、不一致ならエラーになること。
- **なぜ今**: 夜間・不安定な回線という主環境で起きる。
- **異論**: なし（重複は目に見えて削除できる。消失ではない）。

### P2-09 タイマーで記録した母乳行（左右秒あり）を、ミルク・搾乳・離乳食へ種別変更できない

- **重大度 / 検証状況**: P2／確認済み（懐疑役）。統合元: B1-4-sides-row-type-change-blocked
- **根拠**: `baby-log-form-sheet.tsx:511-514` は種別を変えると `updates.durationSec = null` を送る。`actions.ts:605` `needsExistingRow = updates.durationSec !== undefined && !sidesPresent` → `:623-625` で `BREAST_SIDES_TOTAL_ONLY_ERROR` を返す。`:646-651` では同じ UPDATE で sides を null にしているため、CHECK 上は整合する更新である。
- **対象**: `baby/actions.ts`、`baby-log-form-sheet.tsx` と各テスト
- **影響**: 誤って「左」で記録したミルクを直せない。画面に出ていない左右時間を直せと言われ、削除して作り直すしかない。
- **原因**: 合計だけの編集を拒むガードが、種別変更の経路を除外していない。
- **再現**: タイマーで記録 → 編集 → ミルクに変えて更新すると、エラーのトーストが出る。
- **修正**: needsExistingRow を `feedingType === undefined || feedingType === "breast"` の場合に限る。CHECK は緩めない。
- **検証**: actions のテストで、sides 行に `{feedingType:'bottle', amountMl:80, durationSec:null}` を渡すと成功すること。既存の「breast のまま合計を編集すると拒否」のテストは維持する。
- **なぜ今**: 母乳の主経路がタイマーで、生成される行がほぼ全て sides 行である。
- **異論**: なし。

### P2-10 日付ナビの取得中・失敗時に、前の日の記録が新しい日付の見出しの下に表示され続ける（テストがこの挙動を固定している）

- **重大度 / 検証状況**: P2／確認済み（懐疑役）。統合元: D1-datenav-shows-other-day-rows
- **根拠**: `baby-dashboard.tsx:356-363` は失敗時に logs を保持する。`baby-timeline.tsx:19-22` は日付で絞らない。`:407-420` の lastNursing も日付で絞らない。`baby-dashboard-datenav.test.tsx:244-262` が `TODAYROW` の残存を assert している。
- **対象**: `baby-dashboard.tsx`、`baby-timeline.tsx`、当該テスト
- **影響**: 「昨日」の見出しの下に今日の行が時刻だけで並ぶ。今日へ戻る取得が失敗すると、昨日 23:30 を起点にした「目安 9 時間経過」のような誤った警告が出る。
- **原因**: B-08 の「logs を保持する」を、日付で絞らない描画に直結させている。
- **再現**: 既存テストの assert を反転させると、fail-red になる。
- **修正**: 描画時に `toJstDateString(l.logged_at) === selectedDate` で絞る（state は保持し、B-08 は維持する）。取得中は skeleton、失敗時は再試行を表示する。
- **検証**: 失敗時に別日の行が出ないこと。B-08 の先着行のテストは緑のままであること。
- **なぜ今**: 健診前に過去の日を確認する際に誤った事実を読ませる。
- **異論**: なし。

### P2-11 1 タップ記録の唯一の救済「取り消す」が、画面上端・高さ 24px・4 秒で消える。タイマー記録には Undo が無い

- **重大度 / 検証状況**: P2／確認済み（懐疑役）。統合元: D1-undo-toast-unreachable
- **根拠**: `baby-quick-actions.tsx:109-117` は duration を指定していない。`layout.tsx:56` は `<Toaster position="top-center">`。sonner `styles.css:181-186` は `height: 24px; font-size: 12px`、`TOAST_LIFETIME = 4000`。`feeding-timer.tsx:561-566` には action が無い。計画 UX-03a / 03c は未実装。
- **対象**: `layout.tsx`、`ui/sonner.tsx`、`baby-quick-actions.tsx`、`feeding-timer.tsx`
- **影響**: 片手で押し間違えると、親指が届かない上端の小さなボタンを 4 秒以内に押す必要がある。
- **原因**: sonner の既定（上配置・小ボタン・4 秒）をそのまま使っている。
- **再現**: Playwright（390x844）で action の boundingBox を測ると、高さ 24・上部にある。
- **修正**: `bottom-center` に配置し、`mobileOffset` で BottomNav を避ける。Undo 付きトーストは 6〜8 秒、action は min-h-11 にする。タイマー記録にも、返された id で取り消せる Undo を付ける。
- **検証**: Playwright で高さ 44 以上・下側にあることを確認する（座標そのものは不安定なので、`data-y-position` と高さを見る）。vitest で duration と action を確認する。
- **なぜ今**: DESIGN_SYSTEM.md が名指しする「誤タップ」に対する唯一の救済が、片手では使えない。
- **異論**: 懐疑役によれば「唯一の救済」は言い過ぎで、編集シートから削除できる。

### P2-12 予定の削除・繰り返し予定の一括削除が、確認も取り消しも無い 1 タップで確定する

- **重大度 / 検証状況**: P2／確認済み（D2-1 は 3 レンズで P2 が 2 票・P1 が 1 票、B2-5 は懐疑役が確認）。統合元: D2-1-calendar-delete-no-confirm, B2-5-calendar-delete-no-confirm
- **根拠**: `calendar-event-form-sheet.tsx:518-527` `onClick={() => onDeleteSeries(seriesId)}`、`:543-552` のゴミ箱ボタンは「更新」と gap-3 の間隔で並ぶ。`calendar-view.tsx:358-397` は即時に楽観削除する。`calendar/actions.ts:301-335` は物理 DELETE を行い、`cleanupRemindersFor` で通知設定も消す。対照として `baby-log-form-sheet.tsx:903-945` には 2 段階の確認がある。
- **対象**: `calendar-event-form-sheet.tsx`、`calendar-view.tsx`
- **影響**: 誤タップ 1 回で、繰り返し予定（最大 400 行）と各回の通知設定が不可逆に消える。成功時のトーストも無い。
- **原因**: baby で採っている確認の型が calendar に適用されていない。
- **再現**: 「すべて削除」を 1 回押すと即削除される（既存テスト `:149-157` がこの挙動を固定している）。
- **修正**: 単発・シリーズとも 2 段階の確認にする（件数を明示、44px、transition-colors のみ）。ゴミ箱の aria-label をシリーズ時は「この回のみ削除」にする。
- **検証**: 1 回目のタップでは呼ばれず、確認後に 1 回だけ呼ばれることを確認する。e2e の `calendar.spec.ts:138,178` も更新する。
- **なぜ今**: 片手・夜間の操作が主用途である。
- **異論**: 到達性レンズは P1 と判定した。

### P2-13 カレンダーの取得失敗・月送り中に「予定はありません」と表示し、今日・明日カードも失敗時に古い内容のまま残るか消える

- **重大度 / 検証状況**: P2／確認済み（懐疑役。C2 側は P3 未検証）。統合元: D2-8-calendar-silent-empty-on-failure, C2-calendar-month-fetch-failure-shows-empty
- **根拠**: `use-month-events.ts:117-122` で月を切り替えてから refetch し、`:103-106` で error 時は無言で return する。`calendar-agenda.tsx:71-74` が「予定はありません」を出す。`calendar/page.tsx:81-93` は `?? []`。`upcoming-events-card.tsx:69-78, :96`。
- **対象**: `use-month-events.ts`、`calendar-agenda.tsx`、`calendar/page.tsx`、`upcoming-events-card.tsx`
- **影響**: 前の月へ送る・今日へ戻る操作では、選択日が旧範囲の外になる。そのため回線が良くても往復の間は空表示になり、失敗時はそのまま残る。予防接種日などを見落とす。
- **原因**: loading / error の状態が無い。
- **再現**: REST を abort した状態で「前の月」を押すと、空の月が出てトーストも出ない。
- **修正**: `status`（loading / error / ready）を持たせる。取得中は skeleton、失敗時は「読み込めませんでした（再試行）」を出す。月送りなど利用者起点の失敗だけトーストを出す。
- **検証**: refetch が pending / error のとき空の文言を出さないこと（成功して 0 件のときだけ出す対照も置く）。
- **なぜ今**: 不安定な回線が前提で、予定の見落としにつながる嘘である。
- **異論**: 懐疑役によれば、次の月へ送った直後の 1 日目は旧データで正しく表示される（6 週グリッドが重なるため）。

### P2-14 予定フォームの下部シートに高さの上限もスクロールも無く、小型端末で見出し・タイトル・閉じるボタンが画面外に出る

- **重大度 / 検証状況**: P2／確認済み（懐疑役。高さはクラスからの算術）。統合元: D2-9-calendar-sheet-no-scroll
- **根拠**: `calendar-event-form-sheet.tsx:344` `className="rounded-t-2xl safe-bottom"`。`ui/sheet.tsx:56` は `h-auto` のみ。対照として `baby-log-form-sheet.tsx:589,596` は `max-h-[85dvh] overflow-hidden` と `overflow-y-auto` を持つ。
- **対象**: `calendar-event-form-sheet.tsx`
- **影響**: iPhone SE の standalone では既定状態でも上部が欠ける。時刻あり＋毎週にすると header とタイトルが画面外に出る。閉じる X も外に出て、取り消す手段が無くなる。
- **原因**: baby で使っているシートの型が適用されていない。
- **再現**: Playwright で 375x647、時刻あり＋毎週にすると、boundingBox の y が負になる。
- **修正**: baby と同じ型を適用する（max-h-[85dvh]、本文 overflow-y-auto、フッタ固定）。
- **検証**: 上記 Playwright で y>=0、タイトルが viewport 内、「追加」が可視であることを確認する。
- **なぜ今**: 通知と繰り返しを追加したことで、シートの前提を超えた。
- **異論**: 懐疑役によれば、フッタは固定されているので保存はできる。

### P2-15 通知を送った後に同じ JST 日のうちで予定を後ろへ動かすと、新しい時刻の通知が冪等キーに吸われて鳴らない

- **重大度 / 検証状況**: P2／確認済み（懐疑役）。統合元: B2-2-sent-then-same-day-move
- **根拠**: `20260808100003:142-143` `UNIQUE NULLS NOT DISTINCT (kind, event_key, subscription_key, dedupe_day)`。`deliver.ts:529-549` は ignoreDuplicates で upsert する。`:747-753` は `.is("sent_at", null)` の行しか見ない。`delivery-rules.ts:153-159` の reaim は未送信の行しか救わない。
- **対象**: `deliver.ts`、`delivery-rules.ts`、migration 20260808100003
- **影響**: 10:00 の受診に「10分前」を付けて 9:50 に届いた後、同じ日の 15:00 に変更しても 14:50 には鳴らない。最初の本文が古い時刻のまま最後の情報として残る。10・30・60 分前の通知全般で起きる（前日 20 時の通知は該当しない）。
- **原因**: 冪等キーが送信済みかどうかと remind_at の変化を区別していない。
- **再現**: fake DB で 9:50 に送信し、15:00 / 14:50 へ動かして 14:50 に実行すると、送信が 0 件になる。
- **修正**: **案 B を採る**。expandDueReminders で「送信済みの行の scheduled_at が現在の remind_at と異なり、予定が未開始」の場合だけ、別のキーで 1 行を許す。発見者の推奨案 A（event_key に remind_at を混ぜる）は採用しない。loadReminders / loadEvents の event_uid キー参照が外れて全件 rescheduled で畳まれ、旧行の reaim による二重送信も起きるため。キーの形を変える場合は、google_sync_upsert_conflict.sql と同型の実 DB テストを置く。
- **検証**: 上の再現を fail-red→green にする。移動しなければ 2 回目は鳴らない既存の対照（`:369,:379`）を維持する。旧行と新行の二重送信が無いことも確認する。
- **なぜ今**: Google 同期は時刻変更を日常的に取り込む。リマインダーは欠落の方が痛い。
- **異論**: なし。

### P2-16 Google カレンダーを OFF にしてもミラー行が凍結したまま残る。カレンダー表示・毎朝のまとめ・通知に使われ続け、切断 UI も無い

- **重大度 / 検証状況**: P2／確認済み（B2-1 は 3 レンズで P2 が 2 票・P1 が 1 票、D2-2 は 3 レンズとも P2、A3 は懐疑役 P2）。統合元: B2-1-mirror-cleanup-unwired, D2-2-google-deselect-leaves-frozen-mirror, A3-google-deselect-no-mirror-cleanup-no-disconnect
- **根拠**: `src/lib/google/sync.ts:232` の `cleanupMirrorForUnsubscribedCalendar` は本番コードから呼ばれていない（呼び出しはテストだけ）。`settings/actions.ts:212-217` は「未実装として報告済み」とし、`:237-242` は is_selected を更新するだけ。`sync.ts:741` は `.eq("is_selected", true)` の購読しか同期しない。`calendar_events` の IUD RLS は native 限定。読み手（`deliver.ts:468-472, :570-575`、`calendar/page.tsx:63-69`）は購読状態を見ない。切断 Action も無い。
- **対象**: `settings/actions.ts`、`sync.ts`、`deliver.ts`、`google-calendar-card.tsx`
- **影響**: OFF にしたカレンダーの予定が、凍結したまま残る。Google 側の中止や移動が反映されず、古い時刻で通知が鳴り、まとめにも載る。利用者が消す手段は無い。refresh token も無期限に残る。
- **原因**: D-4 と D-5 の担当が互いに相手の担当とし合い、配線されないまま残った。
- **再現**: ON → 同期 → OFF にすると、予定が残る。Google 側で削除しても残る。
- **修正**: isSelected=false が成功したら、service role（認可後に after() 内で）で cleanupMirror を呼ぶ。二重購読中は消さない、`.eq("source","google")` は維持する。**同時にその購読の sync_token を NULL にする**（再び ON にしたとき、古いトークンからの増分同期で欠けたミラーが残るのを防ぐ）。本人の「連携を解除」Action を追加する（google_connections の DELETE → 掃除 → Google の revoke を timeout 付きで）。
- **検証**: vitest で、OFF 時に cleanup が呼ばれること・二重購読中は消さないこと・OFF→ON 後の最初の同期が full になることを確認する。
- **なぜ今**: **#205 で Google 同期を有効化する前に必須**。有効化した初日から凍結した予定と誤通知が出る。
- **異論**: B2-1 の統制レンズは P1 と判定した。

### P2-17 Google 同期の失敗（needs_reauth・恒久的な 403/404）が /calendar に出ず、「今すぐ同期」は結果に関係なく成功トーストを出す

- **重大度 / 検証状況**: P2／確認済み（懐疑役 3 名。403/404 の Google 側の挙動は仮説）。統合元: A3-manual-sync-toast-lies, B2-3-sync-failure-invisible, A3-permanent-403-404-treated-transient
- **根拠**: `api/google/sync/route.ts:37-38` は無条件に `{ ok: true, summary }` を返す。`google-calendar-card.tsx:243-254` は `response.ok` だけを見て「同期を開始しました」を出し、refresh もしない。`calendar/page.tsx:102-103` は接続状態を渡していない。`calendar-client.ts:185-191` は 403→quota、404→unknown に分類する。`sync.ts:765-777` は 1 件でも失敗すれば接続全体を前進させない（skipped_leased なら前進するため振動する）。
- **対象**: `api/google/sync/route.ts`、`google-calendar-card.tsx`、`calendar/page.tsx`、`calendar-view.tsx`、`sync.ts`、`calendar-client.ts`
- **影響**: refresh token が失効したり共有が解除されたりしても、利用者は同期できたと信じて古い予定を見続ける。
- **原因**: route が成否を ok:true に潰し、client が HTTP status だけで判定している。購読単位の失敗を接続単位に畳み込んでいる。
- **再現**: summary に失敗を含む 200 を mock して押すと、toastSuccess が呼ばれる。
- **修正**: route は failed / needsReauth / resync_required を集計して返す。カードは状態に応じた文言を出し、`router.refresh()` する。/calendar に再連携のバナーを出す。404 は恒久失敗として購読単位に記録し、403 は reason で分類する。CHECK の値は追加だけ（緩めない）。
- **検証**: カードのテストで、失敗時に成功トーストを出さず refresh を呼ぶこと。1 購読が 404 でも他の購読が前進すること。
- **なぜ今**: Phase D の有効化直後、最初のトラブルで利用者が唯一押すボタンが嘘をつく。
- **異論**: なし。

### P2-18 Google のフル同期に所要時間の上限が無い。maxDuration で殺されると sync_token が保存されず、エラーも表示されない

- **重大度 / 検証状況**: P2／確認済み（懐疑役。展開量は Google 次第で仮説）。統合元: A3-full-sync-unbounded-duration
- **根拠**: `sync.ts:470-479` は timeMin だけを指定する（timeMax なし）。`calendar-client.ts:52` `EVENTS_MAX_RESULTS = "250"`、`:58` `MAX_EVENT_PAGES = 200`、`:353-383` は直列のループ。書き込みは全ページを取得した後だけ（`sync.ts:525-561`）。`calendar/page.tsx:18` `maxDuration = 30`。殺された後の skipped_leased は、`sync.ts:765-777` で「成功」として idle と last_synced_at=now を書く。
- **対象**: `sync.ts`、`calendar-client.ts`
- **影響**: 終わりの無い繰り返し予定が多いカレンダーは、毎回時間切れになって入らない。そのうえ、リース中に再実行されると「同期済み」と誤表示される。
- **原因**: 時間予算が無く、途中経過も保存しない。
- **再現**: fake で各ページ 300ms・200 ページにすると、予算超過の扱いが無い。
- **修正**: maxResults を 2500 にする。ページごとに経過時間を見て、予算を超えたら中断し last_error_kind を記録する。skipped_leased を接続の成功として数えない。timeMax の導入は別途判断する。
- **検証**: リース保持中の再実行で last_synced_at が前進しないこと。予算を超えると error が記録されること。
- **なぜ今**: 本番で初めてのフル同期が最大の負荷になる。
- **異論**: なし。

### P2-19 cron が全世帯を 1 回の 60 秒実行で直列に処理する。世帯の列挙はページングなし（max_rows=1000）・.in() にも上限が無く、1 世帯の大量データで他世帯の通知が期限切れになりうる

- **重大度 / 検証状況**: P2／確認済み（懐疑役 2 名。本番の閾値は仮説）。統合元: A3-cron-enumeration-max-rows-and-serial-budget, B2-6-cron-cross-household-starvation
- **根拠**: `deliver.ts:253-271, 290-309` は range も order も無く世帯横断で select する。`:203-214, :785-880` は直列。`cron/notify/route.ts:43` `maxDuration = 60`。`sync.ts:873-904` も同じ構造。件数上限のトリガも無い。
- **対象**: `deliver.ts`、`cron/notify/route.ts`、`sync.ts`、`cron/google-sync/route.ts`
- **影響**: 悪意ある世帯が一括 INSERT で 1000 件を超える期限到来のリマインダを置くと、他の世帯が集合から漏れる。漏れた側の心拍は平常に見え、本当に無音で expired になる。
- **原因**: 家族 1 世帯の規模を前提にした単一実行の設計で、テナントごとの公平性が無い。
- **再現**: fake で 1000 件に切り詰める挙動を入れ、世帯 X に 1200 件・世帯 Y に 1 件を置くと、Y が展開されない。
- **修正**: SECURITY DEFINER の DISTINCT RPC（service role 限定）か range ページングで列挙する。.in() は 100 件ずつ分割する。世帯ごとの送信上限、ローテーション、経過時間による打ち切りを入れ、心拍に未処理件数を記録する。
- **検証**: 1000 件を超えても全世帯が列挙されること。予算を超えると failed>=1 になること。
- **なぜ今**: 公開サインアップでは世帯数・行数を運用側で制御できない。
- **異論**: 懐疑役によれば、現在の規模では自然発生しない。

### P2-20 配信の心拍 failed_count が全世帯で合算され、各世帯の設定画面に「直近の配信で N 件の失敗」と出る

- **重大度 / 検証状況**: P2／確認済み（B2-4 は懐疑役 P2。A3 と F2 の同一主張は P3 未検証）。統合元: B2-4-global-heartbeat-cross-household, A3-global-heartbeat-cross-household-signal, F2-global-heartbeat-cross-household
- **根拠**: `20260808100003:221-232`（`CHECK (id = 1)`）、`:258-259`。`deliver.ts:202-214, 1078-1080, 1133-1146`。`settings/page.tsx:117-121`。`notification-health.ts:135-136`。`notification-card.tsx:152-153`。
- **対象**: `deliver.ts`、`settings/page.tsx`、`notification-health.ts`、`notification-card.tsx`
- **影響**: 無関係な世帯の失効した端末が原因で、自世帯に「失敗あり」と出る。利用者は不要な解除・再登録を繰り返す。P1-03 の攻撃で、この数を意図的に膨らませることもできる。
- **原因**: 運用監視用の全体値を、世帯向けの診断に流用している。
- **再現**: 2 世帯の fake で B だけを 500 にすると、A が failing になる。
- **修正**: 画面の失敗表示は自世帯の deliveries / 購読（last_failure_at）から導く。心拍は ran_at（基盤が動いているか）だけに使う。failed_count は authenticated から列 GRANT で隠す（締める方向）。
- **検証**: B の失敗で A が failing にならないこと。
- **なぜ今**: 世帯が増えるほど誤報が増え、診断カードの存在意義が崩れる。
- **異論**: 懐疑役によれば、露出自体は設計意図として文書化されている。

### P2-21 セッション切れのとき PDF ダウンロードが proxy の 307→/login を追従し、ログイン画面の HTML を baby-log.pdf として保存する（Google 手動同期も同じ型）

- **重大度 / 検証状況**: P2／確認済み（懐疑役 2 名。Google 同期の POST 側は仮説）。統合元: A3-export-follows-login-redirect, C2-api-fetch-follows-proxy-307
- **根拠**: `proxy.ts:150-161` は /api/* にも 307 を返す。`export-card.tsx:28-46` は既定の follow で fetch し、`!res.ok` だけを見て、Content-Type を検査せずに `a.download = "baby-log.pdf"` で保存する。`route.ts:46-48` の 401 には到達しない。対照として `push-reconcile.ts:202-219` は `redirect: 'manual'` と JSON の検証で塞いでいる。
- **対象**: `export-card.tsx`、`google-calendar-card.tsx`
- **影響**: 受診当日に、エラー表示も無く開けないファイルが渡される。
- **原因**: fetch の既定の follow と、res.ok だけで成功を判定していること。repo 内で既知の罠が水平展開されていない。
- **再現**: 200・text/html・redirected の fake で、保存処理が走る。
- **修正**: `redirect: 'manual'` を付け、opaqueredirect と 3xx を「ログインし直してください」として扱う。保存は Content-Type が application/pdf のときだけ行う。sync は JSON の `{ok:true}` を検証する。
- **検証**: 307 / opaqueredirect / text/html 200 / 正常な PDF の 4 ケースを確認する。既存の pdfResponse の fixture にも Content-Type を足す。
- **なぜ今**: 一度きりの場面で、壊れたファイルに気付けない。
- **異論**: なし。

### P2-22 デプロイ後に古いクライアントで Server Action が UnrecognizedActionError になっても、「電波の良い場所で」と原因を取り違えて案内し、再読み込みの導線も無い

- **重大度 / 検証状況**: P2／確認済み（懐疑役 2 名）。ID が回転する頻度は本番の deploy 間隔と暗号鍵の固定に依存するため仮説。統合元: C1-server-action-skew-misreported-offline, C2-server-action-skew-misreported-as-offline
- **根拠**:
  - `server-action-reducer.js:102-104` が `UnrecognizedActionError` を投げる。
  - `action-handler.js:378-392` は 404 と `x-nextjs-action-not-found: 1` を返す。
  - `offline-error.ts:28-29, 42-45` は種類を問わず圏外として扱う。`feeding-timer.tsx:478-487` も同様。
  - server-actions.md:174-180 は「Surface the error as a retry path」と書いている。
  - `encryption-utils-server.js:28` は 14 日で鍵を回転させる。
  - 計画書の記載ではプランは Hobby で、Skew Protection（Pro 以上）は使えない。
  - `unstable_isUnrecognizedActionError` を src で使っている箇所は 0 件。
- **対象**: `offline-error.ts`、`feeding-timer.tsx`、`baby-quick-actions.tsx`、`calendar-view.tsx`、`service-worker-manager.tsx`
- **影響**: PWA を常駐させたままデプロイをまたぐと、おむつも授乳も保存できない。そのたびに「電波の良い場所で」と出るため、利用者は電波を疑って再試行を繰り返す。クイック記録はそのまま諦められがちになる。
- **原因**: reject の種類を区別していない。版ずれを検知していない。
- **再現**: build A のタブを開いたまま、鍵を変えて build B を start し、タップすると圏外トーストが出る。単体では、UnrecognizedActionError を注入すると文言が変わらない。
- **修正**:
  - `unstable_isUnrecognizedActionError` で判定し、「アプリが更新されました・再読み込み」を `location.reload()` 付きで出す。タイマー側の catch も同じ判定を通す（localStorage は保持済み）。
  - 任意で NEXT_SERVER_ACTIONS_ENCRYPTION_KEY を固定する。これは鍵を回転させないという trade-off なので、人間が判断する。
- **検証**: vitest で UnrecognizedActionError のとき reload 付きの文言になり、TypeError('Failed to fetch') のときは従来の文言のままであることを対で確認する。
- **なぜ今**: 手動デプロイで間隔が 14 日を超えやすく、デプロイのたびに再発する。
- **異論**: 懐疑役は、BottomNav の遷移で MPA にフォールバックして自己回復すると指摘した。

### P2-23 セッション失効後の Server Action が proxy の 307→/login に追従して reject され、「圏外」トーストに化ける。SIGNED_OUT を購読していないため、ログアウトしたことが伝わらない

- **重大度 / 検証状況**: P2／確認済み（懐疑役）。統合元: X4-3-server-action-after-session-loss-shown-as-offline
- **根拠**:
  - `proxy.ts:150-161` は POST の Next-Action 要求にも 307 を返す。
  - `server-action-reducer.js:74-78` は既定の follow で fetch する。`:140-149` は「An unexpected response」を投げ、`:331-334` で reject する。
  - `baby-quick-actions.tsx:151-153` は toastOfflineError に倒す。
  - src に onAuthStateChange の購読は 0 件。
- **対象**: `proxy.ts`、`offline-error.ts`、各記録 UI
- **影響**: global signOut（P2-28）や失効の後も開いたままの PWA で記録すると、電波が満タンでも圏外と出て保存されない。
- **原因**: document 要求用の 307 を Next-Action / RSC 要求にも返しており、認証喪失の情報が潰れる。
- **再現**: e2e で `clearCookies` してからクイック記録すると、圏外トーストが出る。
- **修正**: 未認証で `Next-Action` ヘッダ（または `RSC: 1`）がある要求には、本文なしの 401 を返す（fail-closed のまま）。client では reject の後に `getSession()` を確認し、未認証なら「ログインが切れました」と /login への導線を出す。(main) に `onAuthStateChange('SIGNED_OUT')` の常設バナーを置く。未送信の入力は保持する。
- **検証**: proxy の単体テストで Next-Action は 401、document は 307 であることを対で確認する。e2e で cookie を消すと分岐し、オフラインなら従来どおり圏外トーストになることを確認する。
- **なぜ今**: 失効のたびに必ず通る経路で、無言ログアウトの見え方そのものになっている。
- **異論**: なし。

### P2-24 サインアウト時のキャッシュ破棄が無言で失敗しても LAST_USER_ID を消すため、次の利用者の CacheUserGuard も効かない。前の世帯の HTML / RSC がオフラインで見える

- **重大度 / 検証状況**: P2／F1 の 3 レンズはすべて P2（confirmed 3）、C1 の懐疑役は P3。実際の到達経路は主にデスクトップのハードリロードと、未承認利用者のオンボーディング中に限られる。統合元: F1-signout-purge-key-ordering, C1-household-cache-purge-gaps
- **根拠**:
  - `sw-messages.ts:26-33` は controller が無いと何もせず resolve する。
  - `settings-content.tsx:111-113` は purge の成否を見ずに `removeItem(LAST_USER_ID)` する。
  - `cache-user-guard.tsx:29` は前の ID が消えていると purge しない。
  - CacheUserGuard は (main) 配下にしか無く、/pending-approval・/setup では走らない。
  - `sw.js:387-389` は URL キーだけで、利用者に束縛されない。
  - PURGE のテストは 0 本。
- **対象**: `sw-messages.ts`、`settings-content.tsx`、`cache-user-guard.tsx`、`pending-content.tsx`、`public/sw.js`
- **影響**: 共用端末で SW が未制御のまま（ハードリロード後など）サインアウトすると、前の世帯の育児記録や予定のスナップショットが残る。次の利用者（未承認なら /pending-approval → /offline → 「育児ページへ」の経路）がオフラインで開くと見えてしまう。
- **原因**: 唯一の後段検知キーを、破棄の成否を見ずに消している。
- **再現**: controller=null にしてサインアウトすると、`caches.keys()` に documents が残る。
- **修正**:
  - purgeHouseholdCaches はページ側から直接 `caches.delete`（documents / rsc）を呼ぶ。SW へのメッセージは補助にする。
  - 成功を確認できないときは LAST_USER_ID を残す。
  - /login・/setup・/pending-approval にも guard を置く。
  - SW の PURGE を vm でテストし、CacheUserGuard の単体テストも足す。
  - 破棄対象は documents / rsc に限り、サインアウトを止めない。
- **検証**: controller=null で window の caches.delete が呼ばれ、static は消えないこと。
- **なぜ今**: 世帯は相互に信頼しない前提で、破棄の仕組みは設計済みなのに穴が残っている。
- **異論**: C1 の懐疑役は P3 と判定した。理由は、スマホでは clients.claim 済みのため未制御にならず、物理的に端末を共有しない限り起きないこと。ack タイムアウトの経路は SW が waitUntil で完遂するので失敗しない。発見者の主張のうちこの部分は誤り。

### P2-25 SW がキャッシュ済みのスナップショットを返しても古さを示す表示が無い。onLine が true のまま通信できない状況（キャプティブポータル等）で、古い世帯データが現在の値に見える

- **重大度 / 検証状況**: P2／確認済み（懐疑役）。統合元: C1-stale-snapshot-no-indicator
- **根拠**: `public/sw.js:387-389, 413-416` は印を付けずにキャッシュを返す。`offline-banner.tsx:15-17, :31` は `navigator.onLine` だけを見る。`realtime-log.ts:42-61` はログを出すだけ。計画の UX-08（「同期が不安定です」の表示）は未実装。
- **対象**: `public/sw.js`、`offline-banner.tsx`、`src/app/layout.tsx`、`e2e/offline.spec.ts`
- **影響**: 夜間に Wi-Fi が外へ出られなくなると、配偶者の直近の記録が欠けたまま、最終授乳から何分かが表示される。
- **原因**: 鮮度を navigator.onLine だけで判定している。
- **再現**: onLine=true のまま SW の fetch だけを失敗させると、キャッシュが表示されバナーは出ない。
- **修正**: (main) layout で描画時刻を埋め込み、閾値を超えたら「HH:MM 時点の表示です」を出す。SW がキャッシュで応答したら postMessage で知らせる。Realtime の異常も表示する（UX-08）。
- **検証**: sw-logic のハーネスで SERVED_FROM_CACHE の postMessage を確認する。描画時刻が古い場合と新しい場合を対にしてバナーの有無を確かめる。
- **なぜ今**: オフライン対応の価値が最も問われる場面で、古いデータを現在の値として見せている。
- **異論**: 懐疑役によれば、start_url「/」は /offline を経由するため、コールドスタートでは警告が出る。

### P2-26 owner の「承認」は世帯への参加ではないのに、UI がそう見せる。承認された配偶者は別の世帯を作りやすく、退出も移籍もできない

- **重大度 / 検証状況**: P2／確認済み（懐疑役。利用者の誤解は推論）。統合元: A1-approval-does-not-join-household-split
- **根拠**:
  - `20260408000002:61-63` の approve_user は is_approved だけを更新する。
  - 承認された利用者は `(main)/layout.tsx:35` で /setup へ送られ、`setup/page.tsx:38-46` に「世帯をつくる」と表示される。
  - `approval-card.tsx:26-45` に説明は無い。
  - 一度世帯に属すと、accept_invitation と create_household は 'already belongs' で拒否する。退出の経路は無い。
  - `invite/[token]/page.tsx:57-63` は存在しない「退出してから」を案内している。
- **対象**: `approval-card.tsx`、`setup/page.tsx`、`invite/[token]/page.tsx`、`pending-content.tsx`
- **影響**: 夫婦で導入する初期に世帯が 2 つに分かれ、アプリ内では元に戻せない。
- **原因**: 承認はインスタンスへの入場許可なのに、文言と配置が「自世帯へのメンバー承認」に見える。
- **再現**: U2 が直接ログイン → U1 が承認 → U2 が /setup で世帯を作る → U1 の招待が「退出してから」で止まる。
- **修正**: ApprovalCard と /setup に「承認しても世帯には入りません。招待リンクを送ってください」と明記する。存在しない「退出」の文言を直す。根本的な対策は P1-02 の承認モデル再設計に含める。
- **検証**: vitest で文言を固定する（invite ページに「退出」が含まれないこと）。
- **なぜ今**: 初期導入で最も踏みやすい分岐で、踏むと戻せない。
- **異論**: 懐疑役は、隣に InviteCard があるので誤操作の確率は下がると指摘した。

### P2-27 招待の失効・一覧と、世帯メンバーの一覧・除名・退出・改名が存在しない。漏れた招待は自動承認でフルアクセスを与え、検知も排除もできない

- **重大度 / 検証状況**: P2／確認済み（懐疑役 2 名）。統合元: A1-no-invite-revocation-or-member-eviction, D2-10-membership-dead-ends
- **根拠**:
  - `settings/actions.ts:53-76` は insert するだけで、旧リンクは 7 日間有効なまま残る。
  - `20260408000002:114-118` は受諾時に is_approved=true を付ける。
  - `settings-content.tsx:137-156` には名前と自分の役割しか出ない。
  - `setup-form.tsx:69-71` は「あとから変更できます」と書くが、改名の経路は無い。
  - `verified-user.ts:30-32` は存在しない「承認取り消し」を前提にしている。
  - RLS は `get_my_household_id()` だけで評価し、is_approved を見ない。
- **対象**: `settings/actions.ts`、`invite-card.tsx`、`settings-content.tsx`、`verified-user.ts`、`setup-form.tsx`
- **影響**: LINE の誤送信などで漏れたリンクを最初に開いた第三者が、子の記録を恒久的に読み書きできる。owner には存在が見えず、除名もできない。
- **原因**: 招待の発行経路だけを作り、その後の管理を作っていない。
- **再現**: URL A を生成 → 新しいリンク B を生成 → 別アカウントで A を受諾すると参加できる。
- **修正**:
  - generateInvite で、同じ世帯の未使用の招待を expired にしてから insert する（既存の RLS の範囲内でできる）。
  - 有効な招待の一覧と失効ボタンを置く。
  - メンバー一覧を出す（既存の profiles_select で読める）。
  - 除名・退出は owner 専用の DEFINER 関数（同一世帯・最後の owner は不可・search_path 固定）で行う。
  - 列 GRANT は緩めない。
  - 文言を事実に合わせる。
- **検証**: vitest で、旧招待を失効させてから insert し、両方の error を検査していること。pgTAP で、除名後に世帯の行が読めないこと、owner 以外・他世帯・最後の owner はそれぞれ拒否されること。
- **なぜ今**: 招待は自動承認されるため、事実上の無期限の資格情報になっている。
- **異論**: なし。

### P2-28 signOut() が既定の scope 'global' で呼ばれ、1 台でログアウトすると全端末のセッションが失効する

- **重大度 / 検証状況**: P2／確認済み（懐疑役）。統合元: A1-signout-global-scope
- **根拠**: `settings/actions.ts:193-197` と `pending-approval/actions.ts:6-10` は引数なしで `signOut()` を呼ぶ。auth-js 2.110.8 の `GoTrueClient.js:3350,3360,3373` は既定値が `{ scope: 'global' }`。JSDoc は local を「recommended for most apps」としている。`verified-user.ts:17-21` もこの挙動を認識しているが放置している。
- **対象**: `settings/actions.ts`、`pending-approval/actions.ts`、`settings-content.tsx`
- **影響**: PC や共用タブレットでログアウトすると、スマホの PWA も最大 1 時間後に無言でログアウトする。メールの上限（2 通/時）と合わさって締め出しが連鎖する。X4-4 では、これを無言ログアウトの第一容疑としている。
- **原因**: auth-js の既定値をそのまま使っている。
- **再現**: 端末 A と B でログインし、A でログアウトすると、B は token の期限後に /login へ落ちる。
- **修正**: 通常のログアウトを `{ scope: 'local' }` にし、**同時に**説明付きの「全端末からログアウト」（global）を別のボタンとして用意する。local 化だけでは、端末紛失時の失効手段を狭めることになる（安全側を緩める変更になる）。
- **検証**: vitest で通常のログアウトが local、全端末ボタンが global で呼ばれることを対で確認する。
- **なぜ今**: #223 / #224 の再発防止の流れに残っている、同じ型の誘因である。
- **異論**: 懐疑役は、global は紛失端末の失効手段でもあると注記した（このため修正は 2 ボタンをセットにする）。

### P2-29 iOS のホーム画面 PWA では magic link でログインし直せない。画面と runbook の指示（「同じアプリで開いて」「どのブラウザでもよい」）は実行できない

- **重大度 / 検証状況**: P2／仮説（D2-4 は 3 レンズとも P2 で confirmed、G5 は懐疑役 P2。iOS の cookie 分離は実機未検証）。統合元: D2-4-ios-standalone-login-deadend, G5-ios-pwa-login-instructions-unactionable
- **根拠**:
  - `login-form.tsx:45-48` は PKCE の magic link だけを使う。コード入力の経路は無い。
  - 同 `:83-85` のコメントは「別領域で開かれ、必ず失敗する」と自ら書いている。`:88` は「同じアプリで開いてください」と案内する。
  - `auth-error-messages.ts:48-49`、`locked-out.md:13,25-26`。
  - commit 31b4c1f の本文は「iOS のホーム画面 PWA はマジックリンクでログインできぬ」。
  - iOS の Web Push はホーム画面アプリ限定（`notification-card.tsx:8-10`）。
- **対象**: `login-form.tsx`、`auth-error-messages.ts`、`locked-out.md`、`settings-content.tsx`
- **影響**: 通知を使っている iPhone の親ほど、ログアウトした後に PWA へ戻れない。実行できない指示に従って再送を繰り返し、上限に達する。
- **原因**: standalone の保存領域の中でセッションを確立する手段（OTP コード入力）が無い。
- **再現**: iOS 実機でホーム画面に追加 → ログアウト → メールのリンクを開くと、Safari 側でしかログインできない（未検証）。
- **修正**:
  - ログインフォームに「6 桁コードを入力」（`verifyOtp({ type: 'email' })`）を追加する。メールテンプレートに `{{ .Token }}` を入れる作業は Dashboard 上の人間の作業になる。
  - 文言を iOS 向けに分ける。
  - ログアウトに確認を入れる。
  - **メールテンプレートの変更は P2-02 の後に行う。**
- **検証**: iOS 実機で、コード入力によって PWA 内でセッションが確立することを確認する。vitest で verifyOtp の呼び出しを確かめる。
- **なぜ今**: 2026-08-10 に締め出しが実際に起きている。
- **異論**: 3 レンズとも P2 に下げた（Safari では使い続けられ、データの損失は無い）。

### P2-30 設定の 2 フォームが `<form action>` の自動 reset で入力を失う。授乳間隔の select は保存後に古い値の表示へ戻り、次の保存で黙って巻き戻る

- **重大度 / 検証状況**: P2／確認済み（D2-5 懐疑役。G13 は P3 未検証）。統合元: D2-5-react19-form-reset-profile-cards, G13-form-action-auto-reset-on-error
- **根拠**: `baby-profile-card.tsx:61` は `<form action={handleSave}>`、`:85-88` は select を `defaultValue` で持つ。`profile-card.tsx:58` も同様。react-dom の `:9284-9287` は `requestFormReset$1(formFiber)` を無条件に呼ぶ。select の defaultSelected は更新されない（`:22525-22529`）。`settings/actions.ts:163-169` は 3 列を全上書きする。onReset は 0 件。
- **対象**: `baby-profile-card.tsx`、`profile-card.tsx`、CLAUDE.md
- **影響**: 保存に失敗すると入力が旧値に戻る。授乳間隔を 2.5h に保存すると表示は 3h に戻り、続けて名前を保存すると間隔が 3h に戻る。
- **原因**: 同期関数を form action に渡すと必ず reset が予約される。CLAUDE.md は auto-reset の無効化を前提に語っているが、実装が伴っていない。
- **再現**: 180 で描画 → 150 に変更して保存 → initialProfile=150 で rerender すると、select の値が '180' になる。
- **修正**: onSubmit と FormData に切り替えるか、`onReset={e => e.preventDefault()}` を付ける。select は制御コンポーネントにするか、保存後に key を変えて再マウントする。
- **検証**: 上の vitest を fail-red で書き、修正後に green になることを確認する。
- **なぜ今**: 授乳間隔は夜間の判断材料である。
- **異論**: なし。

### P2-31 設定画面で households の取得に失敗すると赤ちゃん情報が空欄で描画され、保存で名前と生年月日を NULL に上書きする

- **重大度 / 検証状況**: P2／確認済み（懐疑役）。統合元: D2-6-settings-household-error-blank-overwrite
- **根拠**: `settings/page.tsx:231-235` は log を出すだけで描画を続ける。`:266-275` は `?? null` と `FEEDING_INTERVAL_DEFAULT`。`baby-profile-card.tsx:67,78,88` がそれを defaultValue にする。`settings/actions.ts:165-169` は全列を update する。profile の取得失敗は throw する（`:61-64`）のと非対称。同じファイルの `:295-298` には「読めなかったを無効として描かせぬ」という方針がある。
- **対象**: `settings/page.tsx`、`baby-profile-card.tsx`、`settings/actions.ts`
- **影響**: 一過性の障害の最中に間隔だけを直して保存すると、名前と誕生日が消える。
- **原因**: unknown の区別が households には適用されていない。
- **再現**: households を error にする mock で、`name=null` が渡る。
- **修正**: householdError のときは throw するか、カードを「取得できませんでした（変更不可）」にする。
- **検証**: error のときに保存できないこと。
- **なぜ今**: 再入力が要る家族データが消える。
- **異論**: 懐疑役によれば、引き金はサーバ間の部分障害で、頻度は低い。

### P2-32 ダークモードで、ログイン画面とセットアップ画面のカード外のテキストとエラー通知がほぼ読めない

- **重大度 / 検証状況**: P2／確認済み（懐疑役。コントラスト比は概算）。統合元: D2-7-auth-setup-dark-mode-illegible
- **根拠**: `(auth)/layout.tsx:7` と `setup/layout.tsx:7` は `from-orange-50 via-amber-50/50 to-rose-50/30` で、dark: 用の指定が無い。`login-notice.tsx:28-31` は `bg-destructive/5 text-foreground`。前景の比は約 2.4:1、muted は約 1.1〜1.3:1。
- **対象**: `(auth)/layout.tsx`、`setup/layout.tsx`、`login-notice.tsx`、`login/page.tsx`、`setup/page.tsx`
- **影響**: 夜間に締め出された人が、失敗の理由を読めない。
- **原因**: auth と setup のレイアウトだけが、ライト用のグラデーションに固定されている。
- **再現**: OS をダークにして `/login?error=verifier_missing` を開く。
- **修正**: dark: 用の指定を足す。または通知をカードの内側へ移す。
- **検証**: Playwright の colorScheme:'dark' で axe の color-contrast を実行し、違反 0 にする。
- **なぜ今**: 締め出し対策として足した表示が、夜間に機能しない。
- **異論**: なし。

### P2-33 夜間に一瞥する主要な値が 10〜12px（仕様の最小は 14px）で、目安超過の表示は約 3.2:1。しかもピンチズームを禁止している

- **重大度 / 検証状況**: P2／確認済み（懐疑役。比は手計算による概算）。統合元: D1-glance-text-too-small-zoom-disabled
- **根拠**: `baby-summary-bar.tsx:107-108`（10px のラベル・12px の値）、`:145-150`（11px の amber-600）、`:180-184`。`baby-temperature-card.tsx` の text-[10px] が 7 箇所。`DESIGN_SYSTEM.md:40,137`。`layout.tsx:34-35` は `maximumScale: 1, userScalable: false`。
- **対象**: `baby-summary-bar.tsx`、`baby-temperature-card.tsx`、`src/app/layout.tsx`
- **影響**: 寝ぼけ眼では読みにくく、拡大して補うこともできない（Android）。
- **原因**: 密度を優先して仕様の下限を割っている。ズーム解禁の作業（計画 d）が止まっている。
- **再現**: rg で `text-[10px]` を検索する。
- **修正**: 主要な値・ラベル・超過表示の文字を大きくし、色を濃くする。settings の 2 つの入力を 16px にしてから userScalable の制限を外す（iOS 実機で確認する）。
- **検証**: axe の color-contrast、vitest によるクラスの確認、viewport の契約テスト。
- **なぜ今**: 最重要タスク（授乳の確認）の読み取りに直結する。
- **異論**: 懐疑役によれば、目安の時刻そのものは 14px で、14px 規約との乖離は babycare-ux 計画 §9 #6 で人間の判断待ちになっている。

### P2-34 PDF エクスポートが blob URL + a.download + 即時 revoke で、iOS のホーム画面アプリでは反応しないか、閉じ込められる恐れがある

- **重大度 / 検証状況**: P2／確認済み（懐疑役。iOS の挙動は外部報告に依拠し、実機未検証）。統合元: D2-11-ios-pwa-pdf-export
- **根拠**: `export-card.tsx:40-46` の経路しか無い。navigator.share / canShare は 0 件。`manifest.ts:38` は standalone。WebKit 275288 / 167341、Apple Forums 95911。
- **対象**: `export-card.tsx`
- **影響**: 受診当日、iPhone のホーム画面アプリから PDF を出しても何も起きない。
- **原因**: デスクトップ前提のダウンロード方法である。
- **再現**: iOS 実機で確認する（未検証）。
- **修正**: `navigator.canShare({files})` なら Web Share API で共有し、そうでなければ従来の方法にする。AbortError はエラーとして扱わない。即時 revoke は現行の WebKit では問題にならないため、遅延させる必要はない。
- **検証**: vitest で canShare の分岐を確認する。iOS と Android の実機で手動確認する。
- **なぜ今**: 唯一の用途が受診当日である。
- **異論**: 懐疑役によれば、即時 revoke を原因とする主張は WebKit r262085 で解消済み。

### P2-35 PDF 用フォント『NotoSansJP-Regular.ttf』の実体は可変フォントで、既定のウェイトが Thin(100)。全ての PDF が極細で埋め込まれている

- **重大度 / 検証状況**: P2／確認済み（懐疑役。fvar の default が 100、fontkit の経路も確認済み）。統合元: X2-pdf-font-variable-default-thin
- **根拠**: `baby-report.ts:30,47-52` は family を指定していない。フォントに fvar がある。`xxd -s 0x580714` で wght の default が 0x0064。OS/2 の usWeightClass=100。`fc-query` の結果は `NotoSansJP-Thin`。pdfkit→fontkit は variation を適用せず、glyf の既定マスターをそのまま複写する。
- **対象**: `fonts/NotoSansJP-Regular.ttf`、`src/lib/pdf/baby-report.ts`
- **影響**: 小児科に渡す 8〜9pt の表がかすれて読みにくい。データ自体は正しい。
- **原因**: Google Fonts の可変フォントを -Regular という名前で同梱した。
- **再現**: `fc-query -i 0 fonts/NotoSansJP-Regular.ttf`。
- **修正**: 静的な Regular（wght=400）に差し替える。`path.join(process.cwd(), "fonts", <定数>)` の静的な形は維持する（Turbopack のトレースのため）。OFL の同梱も維持する。
- **検証**: TTF のバイトを検査する（fvar が無く、usWeightClass==400）。実際に生成した PDF の smoke（`%PDF-`、`-Thin` を含まない）。差し替え前に赤になることを確認する。
- **なぜ今**: 半年間、全ての出力が Thin のまま誰も気付いていない。
- **異論**: なし（懐疑役は、数値セルは黒であると補正した）。

### P2-36 PDF 出力は route のテストで generateBabyReport を丸ごとモックしており、pdfmake とフォント読み込みを実行するテストがどの層にも無い

- **重大度 / 検証状況**: P2／確認済み（懐疑役）。統合元: F1-pdf-export-never-executed
- **根拠**: `route.test.ts:28-30` で vi.mock、`:102` で `Buffer.from("%PDF-1.4 fake")`。e2e に PDF のテストは 0 件。pdfmake は 0.3.x の patch 内でも挙動が変わっており、Dependabot の ec629bc は未実行のままマージされている。
- **対象**: `route.test.ts`、`src/lib/pdf/baby-report.ts`
- **影響**: pdfmake の更新や生成時の例外が、受診当日まで発覚しない。P2-35 と P1-07 もこの空白を通り抜けた。
- **原因**: テストの関心を診断のしやすさに絞った。
- **再現**: e2e が PDF を叩いていない。
- **修正**: generateBabyReport を実際に実行する単体テスト（`%PDF-` で始まることを確認）と、e2e（200・application/pdf・`%PDF` 始まり）を足す。Vercel のトレース漏れは e2e では検出できないので、nft.json の検査か preview での確認を加える。
- **検証**: FONT_PATH を壊すと新しいテストが赤になることを確認する。
- **なぜ今**: 月 1 回程度しか使わない導線で、壊れても気付きにくい。
- **異論**: なし。

### P2-37 cron の「正しい secret」e2e が 500 も通す。secret が欠けると test.skip で抜ける（PR #204 未マージ）

- **重大度 / 検証状況**: P2／確認済み（懐疑役。skip と鍵分離の偽緑は CI では起きないと反証済み）。統合元: F1-cron-e2e-weak-asserts
- **根拠**: `google-cron-proxy.spec.ts:66-67` は `not.toBe(307/401)` だけ。`cron-routes-auth.spec.ts:83-88` は「500 が正常な姿」としている。notify は VAPID が無いと `deliver.ts:189-199` で throw する。service_role の権限を固定する pgTAP は無い。99d9c34 は未マージ。
- **対象**: e2e の 2 本、`scripts/e2e-env.sh`
- **影響**: service role の権限やスキーマの不整合で cron の本体が 500 になっても、CI は緑のまま。通知と同期が無言で止まる（99d9c34 に、CLI 2.108 で 42501 が出た記録がある）。
- **原因**: 到達と認可だけを検査対象にしている。
- **再現**: 99d9c34 の注入実測で、`Received: 500` でも緑になった。
- **修正**: #204 を rebase してマージする。e2e-env.sh にテスト専用の固定 VAPID 鍵を置き、notify は 200 と応答の形を assert する。pgTAP で service_role の読み書きを lives_ok で固定する。
- **検証**: 注入した変更で赤になり、元に戻すと緑になることを確認する。
- **なぜ今**: #205 で本番の cron を有効化する前に、本体が完走することを機械で保証する必要がある。
- **異論**: 懐疑役によれば、skip と鍵分離の偽緑は CI では到達しない。

### P2-38 世帯メンバーシップの門（households / profiles の RLS、accept_invitation、get_invitation_by_token、create_household）に pgTAP も e2e も無い

- **重大度 / 検証状況**: P2／確認済み（F1 懐疑役。A2 は P3 未検証）。統合元: F1-pgtap-membership-gaps, A2-pgtap-isolation-gaps
- **根拠**: `household_isolation_rls.sql:11-13` の対象は baby_logs / diaries だけ。households を authenticated で読み書きする assert は 0 件。accept_invitation のテストも 0 件。publication の set_eq も無い。招待受諾の e2e も無い。
- **対象**: `supabase/tests/*`
- **影響**: P1-01 と P3-01 は CI が緑のまま本番に入った。今後の回帰も検知できない。
- **原因**: 発見済みの欠陥の固定に偏っている。
- **再現**: 各欠陥の再現 SQL を入れると赤になる。
- **修正**: `isolation_matrix.sql` を作る（他世帯 / pending / anon × SELECT / INSERT / UPDATE（世帯の移動を含む） / DELETE）。accept_invitation の期限・使用済み・既に所属のケースを throws_ok で書き、メッセージまで照合する（authenticated と jwt claims の文脈で実行し、偽緑を避ける）。publication を set_eq で固定する。招待受諾の e2e を 1 本足す。
- **検証**: policy や IF 分岐を外す mutation で赤になることを確認する。
- **なぜ今**: P1-01 の修正と同時に入れなければ、同じ穴がまた開く。
- **異論**: なし。

### P2-39 組込み SMTP のままでは、Supabase 組織のメンバー以外にはマジックリンクが届かない。招待した家族や新しい世帯がログインできない

- **重大度 / 検証状況**: P2／**仮説**（3 レンズすべて uncertain で P2。本番の SMTP 設定は観測していない）。統合元: F2-builtin-smtp-team-only-and-rate-limit
- **根拠**: `locked-out.md:42` に「[設定・未対応]」、`:54`。Supabase 公式は「refuse to deliver messages to addresses that are not part of the project's team」としている。`auth-error-messages.ts:94-108` は `email_address_not_authorized` を個別に扱っていない（code 付きの総称文になる）。`generate-login-link.mjs:100-105` は既存ユーザー専用。
- **対象**: `locked-out.md`、`auth-error-messages.ts`、`login-form.tsx`
- **影響**: 新しく招待した祖父母などがログインできない。家族を Supabase チームに入れて回避すると、その人が Dashboard の権限を持ってしまう。2 通/時の上限による締め出しも残る。
- **原因**: SMTP の判断が保留のままで、制約がどこにも記録されていない。
- **再現**: チーム外のアドレスで送信する（本番で確認する）。
- **修正**: 独自 SMTP（Resend / SES 等）を導入し、上限を引き上げる（人間の作業）。**導入は P2-02 の後に行う。** それまでは専用の文言を足し、runbook に「家族をチームに入れてはならない」と明記する。
- **検証**: Dashboard の auth/smtp を確認する。チーム外への送信を smoke する。文言のテストを足す。
- **なぜ今**: 招待と承認は実装済みの機能として掲げられている。
- **異論**: 検証役によれば、既存の家族はかつて受信できていたので、影響は新規の招待に限られる見込み。

### P2-40 バックアップ・復元の手順と、生データの書き出しが存在しない（Free を想定すると、自動バックアップも PITR も無い）

- **重大度 / 検証状況**: P2／確認済み（統制・影響レンズ）と uncertain（到達性レンズ）。プランは観測していない。統合元: F2-no-backup-restore-or-raw-export
- **根拠**: `rg -i 'backup|PITR|pg_dump|restore'` で手順は 0 件。`notify-cron.md:116` に「Free tier の 500MB」。Supabase の自動バックアップは Pro 以上。削除は物理削除で、households には CASCADE が張られている。
- **対象**: `docs/runbooks/`、`README.md`、`api/baby-report`
- **影響**: 運用者の誤操作・破壊的 migration・事故が起きると、何年分もの記録を戻せない。PDF は集計なので復元には使えない。
- **原因**: データ保全の設計が無い。
- **再現**: Dashboard → Database → Backups を確認する。
- **修正**: `docs/runbooks/backup-restore.md` を作る。Pro の daily backup / PITR を使うか、定期的な `supabase db dump` を暗号化して外部に保管する。ローカルへの復元演習と件数の突き合わせを行う。破壊的 migration の前の dump を必須にする。dump は PII なので repo や CI には置かない。
- **検証**: 演習の記録を残す。
- **なぜ今**: 家族のデータを預かる最低条件であり、不可逆な DROP を既に適用した実績がある。
- **異論**: 到達性レンズは、記録の消失を直接起こすものではないとして uncertain と判定した。

### P2-41 NOTIFY_CRON_SECRET の回転手順が実装と矛盾しており、文字どおり実行すると最後の手順で現行の値を消して通知が全停止しうる

- **重大度 / 検証状況**: P2／確認済み（F2 懐疑役。G12 は P3 未検証）。統合元: F2-notify-secret-rotation-runbook-incoherent, G12-notify-secret-rotation-runbook-overlap
- **根拠**: `notify-cron.md:273` は「旧値は消さぬ」、`:277-279` は「旧値を削除」と書く。`cron/notify/route.ts:62,76` は単一の値でしか比較しない。Vercel では、1 つの名前・target には値を 1 つしか持てない。
- **対象**: `docs/runbooks/notify-cron.md`、`cron/notify/route.ts`
- **影響**: 手順 5 で唯一の値を消すと、毎 tick が 401 になる。手順 4 の確認より後なので検出されない。
- **原因**: 二重 secret を前提にした手順を、単一 secret の実装に対して書いている。
- **再現**: ステージングで手順どおりに実行する。
- **修正**: `vercel env update` → 再デプロイ → Vault の更新 → status 200 の確認、という手順に書き直す（手順 5 は削除）。401 の窓は grace 内に収まると明記する。無停止で回す必要があるなら、`NOTIFY_CRON_SECRET_PREVIOUS` の併受理を別途設計する。
- **検証**: runbook-contract 型のテストで、削除手順が無いことを確認する。
- **なぜ今**: 漏洩時に急いで行う作業だからである。
- **異論**: なし。

### P2-42 締め出し時の runbook と生成スクリプトが .env.local を前提にしており、手順どおりだと開発 env を潰すか、ローカル向けのリンクを無言で出す（PR #225 未マージ）

- **重大度 / 検証状況**: P2／確認済み（懐疑役。development env が空という部分は仮説）。統合元: G4-locked-out-runbook-destructive-env-pull
- **根拠**: `locked-out.md:32-33` は「`vercel env pull .env.local`」（既定は development）。`generate-login-link.mjs:42-48` は .env.local しか読まない。`:130-132` は appUrl をそのまま使い、host を表示しない。runbook はどこからも参照されていない。
- **対象**: `locked-out.md`、`generate-login-link.mjs`、README
- **影響**: 緊急時に、localhost のリンクが成功の表示付きで出るか、開発 env を消して失敗のループになる。
- **原因**: env の出所を区別していない。
- **再現**: ローカルの値を入れて実行すると、127.0.0.1 のリンクが出る。
- **修正**: #225 をマージする（衝突なし）。加えて、production / preview の sensitive な env は pull しても空で返りうるため、Dashboard から取得した service role key を環境変数で渡す経路も runbook に書く。README と CLAUDE.md の索引に runbook を 2 本とも載せる。
- **検証**: ローカルの値で stderr に警告が出ること。空の export ではファイルの値が使われること。
- **なぜ今**: 2 通/時の制限は解消されておらず、締め出しは再発しうる。
- **異論**: なし。

---

## 5. P3

P3 は簡潔な形式で記す。「検証済み P3」は検証役が P2 以上から引き下げたもの、「P3 未検証」は発見者の P3 判定をそのまま収録したもの。

### P3-01 households_insert `WITH CHECK (true)`（TO 句なし）が残っており、anon / authenticated が孤児の世帯行を INSERT できる
- 重大度・検証: P3。検証済み（A1 は懐疑役が確認、A2 は懐疑役が uncertain）。anon に GRANT があるかは**仮説**。統合元: A1-households-insert-open-to-anon, A2-households-insert-open-to-anon
- 根拠: `20260406000001_initial_schema.sql:263-264`。households に対する REVOKE は 0 件。正規の世帯作成は DEFINER の create_household だけ。
- 対象: 同 migration
- 影響: 誰にも属さない行が増える（読めず、所属させることもできない）。分離は破れない。
- 原因: DEFINER 化の後に撤去されていない。
- 再現: `pg_policies` の INSERT が 1 行ある。
- 修正: 新しい migration で `DROP POLICY households_insert` と `REVOKE INSERT, DELETE, TRUNCATE ... FROM anon, authenticated`。P1-01 と同じ migration に同梱する。
- 検証: pgTAP で INSERT ポリシーが 0 件であること、relacl の assert（relacl が NULL でないことを先に確かめる）、create_household が lives_ok であること。
- なぜ今: 数行の引き締めで済む。
- 異論: 発見者は P2 を主張した。cron の走査対象が膨らむという主張は誤り（反証済み）。

### P3-02 google_calendar_subscriptions の UPDATE が世帯スコープで、同じ世帯の別メンバーが他人の接続のカレンダー選択を切り替えられる
- 重大度・検証: P3。検証済み（懐疑役が P2 から引き下げ）。統合元: A2-google-subscription-toggle-cross-user
- 根拠: `20260802100001:197-198` は `USING (household_id = get_my_household_id())`。一方 DELETE は本人限定（`:98-99`）。`settings/actions.ts:237-241` は所有者を検査しない。
- 対象: 同 migration、`settings/actions.ts`、`google_calendar_sync_grants_rls.sql`
- 影響: 世帯内の誰かが、他人の非公開カレンダーを共有側へ流せる。OFF にして同期を止めることもできる（故意の内部者に限る）。
- 原因: 所有境界の不一致。
- 再現: pgTAP で同じ世帯の U3 が UPDATE すると 1 行更新される。
- 修正: ポリシーに `EXISTS (google_connections c WHERE c.user_id = auth.uid())` を足し（WITH CHECK も同じ式）、Action にも同条件を入れる。P3-45 とは PR を分け、同じリリースで出す。
- 検証: RLS で拒否された UPDATE は 0 行になるので、throws_ok ではなく lives_ok と値の不変で確かめる。
- なぜ今: 修正はポリシー 1 本で済む。
- 異論: なし。

### P3-03 旧い DEFINER 関数 5 本が `REVOKE FROM PUBLIC` だけで、anon の明示 EXECUTE が残る可能性
- 重大度・検証: P3 未検証・**仮説**（本番の proacl は観測していない）。統合元: A2-legacy-rpc-anon-execute
- 根拠: `20260407000001:35-36,92-93`、`20260408000002:44-45,71-72`、`20260603000001:61-62`。get_my_household_id には REVOKE 自体が無い。新しい関数は `FROM PUBLIC, anon` まで落としている。
- 影響: 今の実害は小さい（get_invitation_by_token は token を持つ者だけ）。将来、関数の uid 検査が外れた瞬間に未認証へ開く。
- 修正: P1-01 の migration に `REVOKE ... FROM PUBLIC, anon` を同梱する。get_my_household_id は anon だけ剥がす。
- 検証: pgTAP で `has_function_privilege('anon', ...)` が false であること。
- 再現 / 原因 / なぜ今 / 異論: 型の遡及適用漏れ。既存の型に揃えるだけで済む。異論なし。

### P3-04 RLS の錨 get_my_household_id() が is_approved を見ないため、コードが前提にしている「承認取り消し」をしても DB 直叩き・Realtime・push が続く
- 重大度・検証: P3 未検証・仮説。統合元: A2-membership-not-approval-anchor
- 根拠: `20260406000001:254-257`、`verified-user.ts:31-32`、`deliver.ts:357-362`
- 影響: 運用者が is_approved=false にしても、PostgREST での読み書きが続く。
- 修正: 除名の正規手順（P2-27 の DEFINER 関数で household_id=NULL にし、セッション失効と接続の掃除を行う）を作る。錨に is_approved を足す案は、全ポリシーへの影響を pgTAP で確かめてから判断する。
- 検証: 未承認にしたメンバーの全表 SELECT が 0 件であること。
- 原因 / 再現 / なぜ今 / 異論: 取り消しの経路そのものが無い（P2-27）。異論なし。

### P3-05 event_reminders の BEFORE トリガが、RLS の WITH CHECK より前に他世帯の予定の存在を照会する（23503 と 42501 の差で判別できる）
- 重大度・検証: P3 未検証。統合元: A2-reminder-existence-oracle
- 根拠: `20260808100002:357-359, 166-176, 293-300`。PG の docs では WITH CHECK は BEFORE トリガの後に評価される。
- 影響: UUID を推測できた場合に限り、存在の 1 ビットが漏れる。
- 修正: トリガの冒頭で `NEW.household_id IS DISTINCT FROM get_my_household_id() AND auth.uid() IS NOT NULL` なら 42501 にする。
- 検証: 存在する uid と存在しない uid が同じ SQLSTATE になること。
- 原因 / 再現 / なぜ今 / 異論: A-12 で閉じたはずの照会窓口が残っている。異論なし。

### P3-06 baby_logs.logged_by と invitations.accepted_by が ON DELETE 未指定で、ユーザーを削除できない
- 重大度・検証: P3 未検証。統合元: A2-profile-fk-restrict-blocks-deletion
- 根拠: `20260410000001:38`、`20260406000001:92`。他の表は SET NULL にしている。
- 影響: 削除依頼に Dashboard で応じると FK 違反になる。
- 修正: nullable 化して ON DELETE SET NULL にする（CASCADE にはしない）。UI の記録者表示は NULL のとき退化表示にする。
- 検証: pgTAP で削除が成功し、行が残ることを確かめる。
- 原因 / 再現 / なぜ今 / 異論: 指定漏れ。削除の運用時に初めて露見する。異論なし。

### P3-07 廃止済みの eating-out-photos バケットが public=true のまま残っている（「残っても実害は無い」は不正確）。文書は Storage を使用中と記載している
- 重大度・検証: P3 未検証・仮説（objects の件数は観測していない）。統合元: A2-public-photo-bucket-residue, B3-eating-out-photos-public-bucket-residue, G7-storage-claims-and-public-bucket-residue
- 根拠: `20260406000002:4-6`、`20260909100002:73-78`、`20260909100003:36-42`。CLAUDE.md:19、README:37、SECURITY.md:21。src の `.storage` は 0 件。
- 影響: object が残っていれば、URL を知る者が見続けられる。本人には消す手段が無い。
- 修正: Dashboard で private 化 → Empty → Delete し、記録を残す（人間の作業）。文書から Storage を外す。migration のコメントを訂正する。
- 検証: `select public from storage.buckets where id='eating-out-photos'` と、件数のクエリで確かめる。
- 原因 / 再現 / なぜ今 / 異論: 削除を人手に回したまま記録していない。異論なし。

### P3-08 授乳タイマーの localStorage が利用者に結び付かず、サインアウトでも消えない。再起動後にダッシュボードに出ず、2 時間を超えると無言で破棄される
- 重大度・検証: P3。B1-8 は懐疑役が P2 から引き下げ、C2-timer-stale も懐疑役が P2 から引き下げ、A1 は未検証。統合元: A1-feeding-timer-survives-signout, B1-8-timer-invisible-and-stale-discard, C2-timer-stale-silent-discard
- 根拠: `feeding-timer.tsx:32-33, 246-264, 331-355`。ダッシュボードは STORAGE_KEY を読まない。`settings-content.tsx:110-117`、`cache-user-guard.tsx:29-32`。
- 影響: 共用端末で別世帯へ復元されうる（経過時間が表示されるので気付ける）。寝落ちした場合に開始時刻を説明なく失う。
- 修正: TimerState に userId を持たせ、一致しなければ破棄する。サインアウトと利用者交代のときに removeItem する。stale の場合は「◯時に開始したタイマー：記録 / 破棄」と通知する。計測中のチップは P1-05 と共通にする。
- 検証: userId が異なれば復元しないこと。stale の場合に通知が出ること。
- 原因 / 再現 / なぜ今 / 異論: stale 破棄は 3a10b96 の意図した設計。懐疑役によれば、閉じる経路ではどれもキーが消えるので、到達は狭い。

### P3-09 テスト通知の送信に timeout が無く、グローバルな setVapidDetails を使っている
- 重大度・検証: P3 未検証。統合元: A3-push-test-send-no-timeout
- 根拠: `push-actions.ts:120-135`
- 修正: `sendPushNotification` を流用する。
- 検証: vitest で timeout 付きの呼び出しを確かめる。
- 影響 / 原因 / 再現 / なぜ今 / 異論: push サービスが応答しないと固まる。共通実装を使っていない。外部 I/O に timeout を置く規約に反する。異論なし。

### P3-10 OAuth の state が開始したユーザーに結び付かない
- 重大度・検証: P3 未検証・仮説。統合元: A3-oauth-state-not-bound-to-user
- 根拠: `oauth-connect.ts:114-137`、`callback/route.ts:112-121`
- 影響: 共用端末で同意画面を開いたまま利用者を切り替えると、別の世帯に保存される。
- 修正: state cookie に userId の HMAC を入れ、callback で照合する。
- 検証: 別 userId では csrf になることを route テストで確かめる。
- 原因 / 再現 / なぜ今 / 異論: CSRF の検査がブラウザ単位になっている。X1 の連鎖は広げない（X1 の verified_sound）。異論なし。

### P3-11 POST /api/google/sync に回数制限が無い
- 重大度・検証: P3 未検証・仮説。統合元: A3-manual-sync-no-throttle
- 根拠: `api/google/sync/route.ts:27-45`
- 影響: 連打で、全世帯が共有する Google の quota と関数時間を消費できる。
- 修正: last_synced_at が N 秒以内なら 429 を返す。
- 検証: route テストで確かめる。
- 原因 / 再現 / なぜ今 / 異論: staleness ゲートが page 経路にしか無い。異論なし。

### P3-12 サーバ側の検証が DB の CHECK の一部（左右秒の合計の上限、量の上限 999）を写していない
- 重大度・検証: P3 未検証。統合元: B1-10-validation-mirror-gaps
- 根拠: `actions.ts:89-106, 262, 285`、`baby-log-form-sheet.tsx:155-158`
- 影響: 原因の分からない失敗トーストが出る（fail-loud なのでデータは壊れない）。
- 修正: 合計 ≤ 10800、amountMl を整数かつ 0..999 で検証し、具体的な文言を返す。合計側の clamp は禁止。
- 検証: 境界値を fail-red で確かめる。
- 原因 / 再現 / なぜ今 / 異論: 写し漏れ。異論なし。

### P3-13 カレンダーを ON にしても同期が走らず、空同期が last_synced_at を進めるため最大 5 分何も出ない
- 重大度・検証: P3 未検証。統合元: B2-7-new-selection-not-synced
- 根拠: `sync.ts:765-777`、`sync-trigger.ts:121-131`
- 修正: ON の保存成功時に after() で同期を予約するか、購読の last_synced_at が NULL なら stale と判定する。
- 検証: sync-trigger のテストで確かめる。
- 影響 / 原因 / 再現 / なぜ今 / 異論: Phase D の初回体験に直結する。stale 判定が接続単位になっている。異論なし。

### P3-14 コア表と service_role への GRANT が migration に無く、Supabase の 2026-10-30 の既定変更以降に追加する新表と、migration からの再構築で 42501 になる
- 重大度・検証: P3。検証済み（懐疑役が P2 から引き下げ）。統合元: B3-missing-explicit-grants-supabase-2026-10-30
- 根拠: rg で `TO service_role` は 0 件。`20260802100001:30-31` は「service_role からは REVOKE しない」。Supabase changelog #45329（既存の表は現行の grant を保持する）。
- 影響: 現在の本番は影響を受けない。新しい表をテンプレどおりに作ると、service_role が 42501 になり cron が失敗する（CI は旧 CLI 2.101.0 なので緑のまま）。
- 修正: 新しい migration で、現在の relacl を宣言として明示する（緩めない）。新表のテンプレートに service_role への明示 GRANT を必須として書く。migration の lint を CI に置く。
- 検証: GRANT の lint。既定権限を REVOKE したスタックで pgTAP を回す。
- 原因 / 再現 / なぜ今 / 異論: 既定権限に暗黙に依存している。期限は 2026-10-30。異論なし。

### P3-15 本番で migration 履歴が未記録の場合、20260909100002 の REVOKE が DROP 済みの表に当たって db push を止める
- 重大度・検証: P3。**仮説**（懐疑役 uncertain。schema_migrations は観測していない）。統合元: B3-migration-history-drift-100002-not-reappliable
- 根拠: `20260909100002:62-65` には存在確認のガードが無い。`20260909100003:37-39` に SQL Editor で適用した痕跡がある。
- 影響: fail-loud で止まるが、データは無傷。repair で戻せる。
- 修正: 人間が `supabase migration list --linked` で確認し、必要なら `migration repair --status applied`。REVOKE を `to_regclass` で守る。本番への適用経路を db push に一本化する。
- 検証: CI で 100002 を再実行して exit 0 になること。
- 原因 / なぜ今 / 異論: 次の migration（P1-01 等）を出す前に確認が要る。G6 の反証（害は無い）とは観点が異なり、ここでは運用上の確認項目として残す。

### P3-16 開始時刻 backfill の後、Flutter を廃止するまでに書かれた片側の母乳行が終了時刻のまま残っている可能性
- 重大度・検証: P3 未検証・仮説。統合元: B3-backfill-residue-legacy-breast-end-time
- 根拠: `20260726100003:66-72`。Flutter の recordFeeding は loggedAt を送っていなかった。
- 修正: 人間が本番で検出の SELECT を実行し、同じ述語で UPDATE する（自己除外的なので二重には巻き戻らない）。migration コメントの「冪等でない」と CLAUDE.md の「統一済み」を訂正する。
- 検証: SELECT の件数が N から 0 になること。
- 影響 / 原因 / 再現 / なぜ今 / 異論: 数日分の行がずれる。編集されると手掛かりが失われる。異論なし。

### P3-17 recordFeeding は母乳でも loggedAt の省略を許し、DB の既定 now()（＝終了時刻）に落ちる罠が残っている
- 重大度・検証: P3 未検証。統合元: B3-logged-at-default-trap-recordfeeding
- 根拠: `actions.ts:161-162, 276-277`
- 修正: breast（または duration / sides を指定した場合）で loggedAt が null なら、fail-loud で拒否する。
- 検証: fail-red で確かめる。
- 影響 / 原因 / 再現 / なぜ今 / 異論: 今は実害が無い。契約を code に固定するなら今が最も安い。異論なし。

### P3-18 2026-08-09 以前にホーム画面へ追加した端末は start_url が /meals のままで、起動のたびに 404 になる
- 重大度・検証: P3。**仮説**（懐疑役 uncertain。該当する端末が残っているか不明）。統合元: C1-legacy-start-url-meals-404
- 根拠: 186de58、`manifest.ts`（id が無い）、`next.config.ts` に redirects が無い。
- 修正: `/meals`・`/shopping`・`/stock`（`:path*` を含む）を `/` へ permanent:false で redirect する。manifest に `id: "/"` を足す。
- 検証: launch-redirect の e2e。
- 影響 / 原因 / 再現 / なぜ今 / 異論: 互換 redirect を置いていない。b50c7ea で 404 化した。異論なし。

### P3-19 handleDocument が 200 の text/html なら何でも保存し、劣化した描画が良いスナップショットを上書きする
- 重大度・検証: P3 未検証・仮説。統合元: C1-degraded-render-overwrites-snapshot
- 根拠: `sw.js:380-385`、`loading.md:103-105`（streaming 中は 200 のまま）
- 修正: 劣化した描画に sentinel の meta を出し、SW は put しない。
- 検証: sw-logic で対照を確かめる。
- 影響 / 原因 / 再現 / なぜ今 / 異論: 一過性の失敗でオフライン用の最後の砦が壊れる。異論なし。

### P3-20 廃止した /meals 等の document / RSC エントリが Cache Storage に無期限で残っている
- 重大度・検証: P3 未検証。統合元: C1-removed-route-cache-residue
- 根拠: b50c7ea の sw.js の差分。`CACHE_VERSION = "v1"` は据え置き。
- 修正: activate で APP_PAGES 以外のキーを削除する（version は bump しない）。
- 検証: sw-logic で確かめる。
- 影響 / 原因 / 再現 / なぜ今 / 異論: DROP 済みのデータが端末に残る。異論なし。

### P3-21 network-first の document / RSC に timeout が無く、弱い電波では白画面のまま待たされる
- 重大度・検証: P3 未検証・仮説。統合元: C1-network-first-no-timeout
- 根拠: `sw.js:379, 405, 454`
- 修正: 4 秒程度で cache と競わせる。**P2-25 の鮮度表示と同時に**入れる。
- 検証: fake timers で確かめる。
- 影響 / 原因 / 再現 / なぜ今 / 異論: 起動の体験を損なう。異論なし。

### P3-22 ログアウト時にサーバ側の購読解除が reject すると、ブラウザ側の unsubscribe() も飛ばされる
- 重大度・検証: P3。検証済み（懐疑役が P2 から引き下げ）。統合元: C2-signout-push-browser-unsubscribe-skipped
- 根拠: `push-unsubscribe.ts:37-39`、テスト `:99-120` は unsubscribe の呼び出しを assert していない。
- 修正: サーバの呼び出しを内側の try で包み、ブラウザ側の解除を必ず試みる。
- 検証: `toHaveBeenCalledTimes(1)` を足して fail-red で確かめる。
- 影響 / 原因 / 再現 / なぜ今 / 異論: 旧世帯の予定名がロック画面に出うる。窓は狭い。異論なし。

### P3-23 VAPID 鍵を回転すると、既存の購読が古い鍵に縛られたままで、自動でも「受け取る」でも直らない
- 重大度・検証: P3。検証済み（懐疑役 2 名が P2 から引き下げ）。統合元: C2-vapid-key-mismatch-no-self-heal, F2-vapid-rotation-no-recovery
- 根拠: `notification-card.tsx:281-288`（`existing ?? subscribe(...)`）、`push-reconcile.ts:154-189`、`sw.js:668-679`。計画書の R8 は「再購読で復旧」と主張している。
- 修正: `options.applicationServerKey` を現行の鍵とバイト単位で比べ、不一致なら handleEnable の中だけで unsubscribe してから subscribe する。reconciler は登録を見送り、「再登録が必要」と表示する。runbook に「VAPID の回転」の節を足す。
- 検証: 一致と不一致を対にしたテスト。
- 影響 / 原因 / 再現 / なぜ今 / 異論: 漏洩対応という最悪の局面で通知が止まる。手動の復旧経路（一覧から外す → 受け取る）はある。

### P3-24 通知カードが serviceWorker.ready を待って固まる。設定画面の複数の取得失敗が「無い / 未接続 / 承認待ち」として描かれる
- 重大度・検証: P3 未検証。統合元: C2-notification-enable-ready-hang, D2-15-settings-read-failure-states
- 根拠: `notification-card.tsx:252,280`（同じファイルの `:117-120` が自ら危険を指摘している）、`settings/page.tsx:143-147, 174-181, 203-211, 244-249`、`proxy.ts:172-186`
- 修正: `getRegistration()` と timeout に置き換える。各取得の unknown フラグを渡し、誤った CTA を出さない。pending の文言を補う。
- 検証: error のときに unknown 表示になることを vitest で確かめる。
- 影響 / 原因 / 再現 / なぜ今 / 異論: 不要な再登録・再連携を誘う。異論なし。

### P3-25 touch-targets の e2e が空の世帯の初期表示しか測らず、シート・トースト・入力の 44px 未満を見逃す
- 重大度・検証: P3 未検証。統合元: D1-touch-target-e2e-blind-spots
- 根拠: `e2e/touch-targets.spec.ts:38-41, 53-55`
- 修正: 記録を 1 件作り、タイマー・各シートを開いた状態でも測る。locator に input / select / textarea を加える。
- 検証: 既存の違反（キャンセル、トーストの action）で赤になることを確かめる。
- 影響 / 原因 / 再現 / なぜ今 / 異論: P1-05 と P2-11 を回帰から守る。異論なし。

### P3-26 app/error.tsx と ErrorView がダークモードを無視する
- 重大度・検証: P3 未検証。統合元: D1-error-screens-ignore-dark-mode
- 根拠: `src/app/error.tsx:18-28`、`error-view.tsx:28-29`、`not-found.tsx:6`
- 修正: glass / bg-background のトークンで組み直す。P2-01 と同じ PR で行う。
- 検証: .dark のクラスの vitest。
- 影響 / 原因 / 再現 / なぜ今 / 異論: 夜間に全画面が光る。異論なし。

### P3-27 セグメントの選択状態・グループの見出し・日セルの読み上げ・閉じるボタンの英語ラベルなど、支援技術向けの意味付けが欠けている。今日チップと入力が 44px 未満
- 重大度・検証: P3 未検証。統合元: D1-toggle-state-not-exposed, D2-14-touch-a11y-semantics
- 根拠: `segment-cn.ts:10-16`（aria-pressed が無い）、`sheet.tsx:75`（`Close`）、`calendar-month-view.tsx:74`、`calendar-view.tsx:416-422`（今日チップの高さ約 24px）、`baby-profile-card.tsx:69,80,89`（h-10）、`calendar-event-form-sheet.tsx:380`（編集時も autoFocus）
- 修正: aria-pressed か radiogroup を付ける。「閉じる」に直す。日セルを「10月1日（予定2件）」のように読ませる。min-h-11 と text-base にする。編集時の autoFocus を外す。
- 検証: pressed で role クエリが通ること、axe。
- 影響 / 原因 / 再現 / なぜ今 / 異論: 選択中の項目が読み上げで分からない。異論なし。

### P3-28 作成中の予定を開いたまま作成が完了すると、シートが仮の id を握り続け、通知の変更が無言で保存されない
- 重大度・検証: P3 未検証。統合元: D2-12-stale-optimistic-editing-reminder
- 根拠: `calendar-view.tsx:135-143, 342, 175-176`
- 修正: replaceOptimisticId のときに editing の id を差し替え、reminder を取り直す。
- 検証: vitest で確定 id によって setEventReminder が呼ばれることを確かめる。
- 影響 / 原因 / 再現 / なぜ今 / 異論: 「設定したのに通知が来ない」。窓は狭い。異論なし。

### P3-29 warm orange 上の白文字、明るい背景上の text-primary が 4.5:1 に届かない
- 重大度・検証: P3 未検証。統合元: D2-13-contrast-primary-tokens
- 根拠: `globals.css:52-53`（約 3.2:1）、`google-calendar-card.tsx:281-290`（再連携の警告は約 2.4:1）
- 修正: テキスト用に暗めの primary トークンを用意する。警告は text-foreground とアイコンで伝える（babycare-ux 計画では人間の判断待ち）。
- 検証: axe。
- 影響 / 原因 / 再現 / なぜ今 / 異論: 重要な警告を見落とす。異論なし。

### P3-30 calendar_events の Realtime イベント 1 件ごとに月全体を再取得し、Google のフル同期でクエリが嵐になる
- 重大度・検証: P3 未検証・仮説。統合元: E1-calendar-realtime-refetch-storm
- 根拠: `use-month-events.ts:175-178`
- 修正: trailing debounce と、in-flight 1 本 + dirty フラグ。
- 検証: fake timers で 200 回の payload に対して 2 回以下になること。
- 影響 / 原因 / 再現 / なぜ今 / 異論: 電池と通信を消費する。異論なし。

### P3-31 /settings が profiles を 3 回目に読み、さらに購読の取得を直列に待つ
- 重大度・検証: P3 未検証。統合元: E1-settings-extra-profile-roundtrips
- 根拠: `settings/page.tsx:42-53, 196-201`
- 修正: getAuthContext を使い、Promise.all に合流させる（列を明示し、GRANT 外の列は含めない）。
- 検証: 直列の段数を記録するテスト。
- 影響 / 原因 / 再現 / なぜ今 / 異論: TTFB が延びる。異論なし。

### P3-32 next-themes を Provider 無しで使っており、トーストがアプリ設定ではなく OS のテーマに従う
- 重大度・検証: P3 未検証。統合元: E1-next-themes-orphan-toaster-theme
- 根拠: `ui/sonner.tsx:3,8`。ThemeProvider は 0 件。
- 修正: アプリの `use-theme` の resolvedTheme を渡し、next-themes を削除する。
- 検証: vitest。
- 影響 / 原因 / 再現 / なぜ今 / 異論: 深夜に明るいトーストが出る。異論なし。

### P3-33 CI で固定した pnpm と Node の版が、Vercel の本番ビルドでは効かない可能性
- 重大度・検証: P3 未検証・仮説。統合元: E2-1-vercel-toolchain-unpinned
- 根拠: `package.json:16` は packageManager だけで engines が無い。`.nvmrc`。Vercel の docs。
- 修正: `ENABLE_EXPERIMENTAL_COREPACK=1`（Dashboard で設定）と `engines.node: "24.x"` を設定し、build log で確かめる。
- 検証: Vercel の build log。
- 影響 / 原因 / 再現 / なぜ今 / 異論: pnpm 9 になると ignoredBuiltDependencies が効かない。異論なし。

### P3-34 CSS 1 枚のために shadcn CLI（MCP SDK / express 等）が production dependencies に入っている
- 重大度・検証: P3 未検証。統合元: E2-2-shadcn-runtime-dependency
- 根拠: `package.json:42`、`globals.css:3`
- 修正: tailwind.css を vendor して依存を外す（最低でも devDependencies に移す）。
- 検証: CSS の差分が 0、`pnpm audit --prod`。
- 影響 / 原因 / 再現 / なぜ今 / 異論: audit が雑音で鈍り、build 機の install 量が増える。異論なし。

### P3-35 Actions が可変タグを参照し、ci / e2e に permissions の宣言が無い。E2E は Desktop Chrome だけで、retries が flaky を隠す
- 重大度・検証: P3。F1-e2e は検証済み（懐疑役が P2 から引き下げ）、他は未検証。統合元: E2-3-actions-mutable-tags-no-permissions, F2-ci-permissions-and-e2e-coverage, F1-e2e-desktop-chrome-only
- 根拠: `ci.yml:16-22`、`e2e.yml:30,61,81`、`playwright.config.ts:30,45-50`
- 修正: `permissions: contents: read`、third-party の action を SHA で固定、主要な動線だけ WebKit iPhone project を追加、`failOnFlakyTests` を設定する。
- 検証: token の権限表示、config の契約テスト。
- 影響 / 原因 / 再現 / なぜ今 / 異論: WebKit project でも iOS の standalone や Push には届かない（実機確認が必要）。flaky は GitHub reporter で注記されるので、完全に無音ではない。

### P3-36 vitest は React 19.2.8 で走り、本番の App Router は同梱の 19.3.0-canary で走る
- 重大度・検証: P3 未検証。統合元: E2-4-react-test-prod-skew
- 修正: #234 を採用し、major.minor の一致を CI で assert する。
- 根拠 / 影響 / 原因 / 再現 / 検証 / なぜ今 / 異論: `node_modules/react` 19.2.8 と next 同梱の canary。transition の挙動に差が出うる。異論なし。

### P3-37 msw の build script が黙って無視されており、方針が明示されていない
- 重大度・検証: P3 未検証。統合元: E2-5-msw-build-implicitly-ignored
- 修正: ignoredBuiltDependencies に msw を足し、`strictDepBuilds: true` にする。
- 根拠 / 影響 / 原因 / 再現 / 検証 / なぜ今 / 異論: `.modules.yaml:1960-1962`。pnpm 11 で CI が赤になる。異論なし。

### P3-38 公開直後の版の取り込みを遅らせる防御（minimumReleaseAge / Dependabot cooldown）が無い
- 重大度・検証: P3 未検証。統合元: E2-6-no-release-age-cooldown
- 修正: `minimumReleaseAge: 4320`、`trustPolicy: no-downgrade`、Dependabot の cooldown を 3 日、groups を production / development で分割する。
- 根拠 / 影響 / 原因 / 再現 / 検証 / なぜ今 / 異論: `pnpm-workspace.yaml`、`dependabot.yml:4-24`。npm worm 型の攻撃への備え。異論なし。

### P3-39 @supabase/ssr の setAll が渡す no-store 系の headers を捨てている（現状は Vercel の CDN が補っている）
- 重大度・検証: P3 未検証。統合元: E2-7-ssr-setall-ignores-cache-headers
- 根拠: `proxy.ts:59`、`server.ts:16`、ssr の `types.d.ts:21-25`
- 修正: `setAll(cookiesToSet, headers)` にし、finalize でも載せ替える。
- 検証: proxy のテスト。
- 影響 / 原因 / 再現 / なぜ今 / 異論: 将来 CDN を前段に置くと、セッションを取り違える。異論なし。

### P3-40 check-transition-reject-guard / check-transition-all / check-proxy-effective に、検出力を示す fixture テストが無い。reject-guard は *.tsx しか走査しない
- 重大度・検証: P3 未検証。統合元: F1-checker-selftests-missing
- 根拠: `check-transition-reject-guard.py:30,128`
- 修正: supabase checker と同形の正負 fixture の vitest を 3 本作る。走査対象を *.ts に広げる。
- 根拠 / 影響 / 原因 / 再現 / 検証 / なぜ今 / 異論: 正規表現が壊れても CI は緑のまま。異論なし。

### P3-41 可観測性が Vercel の runtime log 頼みだが、Hobby の保持は 1 時間で、夜間の障害の証跡は朝には消えている
- 重大度・検証: P3。検証済み（懐疑役が P2 から引き下げ）。統合元: F2-vercel-hobby-log-retention-1h
- 根拠: `realtime-anomaly-action.ts:13-14,24`、`cron/notify/route.ts:94`。Vercel では Hobby の保持は 1 時間。
- 修正: 重要な失敗を append-only の ops_events 表（PII なし、service role のみ、TTL つき）に残す。コメントを訂正する。Log Drain は Pro が必要。
- 検証: 1 時間後も読めること。
- 影響 / 原因 / 再現 / なぜ今 / 異論: 懐疑役によれば、通知と同期には耐久的な失敗信号（skip_reason、last_error_kind）が既にある。

### P3-42 logSupabaseError が PG の details を無条件に出力し、CHECK 違反の行値（メモ・日記）や Gmail アドレスがログに載りうる
- 重大度・検証: P3 未検証・仮説。統合元: F2-pii-in-logs-details-and-calendar-id
- 根拠: `log-error.ts:25-32`、`sync.ts:568-575`
- 修正: 23514 / 23502 / 23505 のときは details の行値を除く。googleCalendarId は subscriptionId に置き換える。
- 検証: log-error のテスト（42501 は保持する対照も置く）。
- 影響 / 原因 / 再現 / なぜ今 / 異論: PII を出さないという方針と食い違っている。異論なし。

### P3-43 本番デプロイ・env・Auth URL の runbook が無く、APP_URL を設定し忘れると招待リンクが localhost を指したまま成功と表示される
- 重大度・検証: P3 未検証・仮説。統合元: F2-env-runbook-and-invite-origin
- 根拠: `app-origin.ts:1,15,61`、`settings/actions.ts:68-72`
- 修正: `docs/runbooks/deploy-env.md` を作る。本番で APP_URL が無ければ、generateInvite はエラーと構造化ログを返す。
- 検証: actions のテスト。
- 影響 / 原因 / 再現 / なぜ今 / 異論: #205 の手作業の拠り所が無い。異論なし。

### P3-44 ログイン済みの端末で /auth/confirm を開くと、proxy が未消費の token_hash を redirect 先の URL へ引き継ぐ
- 重大度・検証: P3 未検証（コードで確定）。統合元: X1-proxy-forwards-unconsumed-token-hash
- 根拠: `proxy.ts:216-223`（`url.pathname + url.search`）、`proxy.test.ts:325-332`、`sw.js:125-129`
- 修正: 認証の着地点からの redirect では token_hash / type / code を削除する（allowlist 化が望ましい）。
- 検証: location に token_hash が含まれないこと。
- 影響 / 原因 / 再現 / なぜ今 / 異論: 有効な token が履歴とキャッシュのキーに残る。P2-02 と同時に直す。異論なし。

### P3-45 Google で非公開（private / confidential）にした予定が、件名・説明・場所とも原文のまま世帯全員と毎朝のまとめにミラーされる
- 重大度・検証: P3。検証済み（懐疑役が P2 から引き下げ）。統合元: X3-google-private-events-mirrored-verbatim
- 根拠: `google-calendar-sync.ts:39-54, 266-279`（visibility を扱わない）、`calendar_events_select`（世帯スコープ）、`digest-rules.ts:125-135`。Google の公式 docs では、writer / owner には非公開の詳細も返る。
- 影響: 本人の非公開の意図を越えて、家族の範囲に開示される（世帯外には出ない）。
- 修正: visibility が default / public 以外なら title を「予定あり」にし、memo / location / html_link を null にする。既存行は強制的にフル再同期して浄化する。設定カードで告知する。
- 検証: 対照付きの normalizeEvent のテスト。
- なぜ今: **#205 で有効化する前に入れる**。有効化した後は、増分同期では浄化されない。
- 異論: 懐疑役によれば、カレンダー単位の opt-in があり、世帯共有が前提の製品である。

### P3-46 accessRole を捨てているため freeBusyReader のカレンダーも選択でき、二重購読では後勝ちで件名を「(無題)」に上書きし合う
- 重大度・検証: P3 未検証・仮説。統合元: X3-2-freebusy-calendar-selectable-last-writer-overwrite
- 根拠: `callback/route.ts:388-396`、`google-calendar-sync.ts:181-194`、`sync.ts:851`
- 修正: freeBusyReader では upsert しない。一覧でも選択できないようにする。
- 検証: sync のテストで対照を確かめる。
- 影響 / 原因 / 再現 / なぜ今 / 異論: 表示が揺れ、情報が欠ける。異論なし。

### P3-47 Auth の一時障害で proxy の refresh が失敗すると、セッションが生きたまま /login へ 307 する。refresh の fetch に timeout も無い
- 重大度・検証: P3。検証済み（懐疑役が P2 から引き下げ）。統合元: X4-2-transient-refresh-failure-shown-as-logout
- 根拠: auth-js の `fetch.js:32-42`、`GoTrueClient.js:2528-2538, 3945-3961`、`proxy.ts:150-161`
- 修正: retryable かつ cookie がある場合は 503（データなし、Retry-After 付き）を返す。createServerClient の fetch に 5 秒の上限を付ける。
- 検証: proxy のテストで 3 つの対照（retryable / non-retryable / cookie なし）を確かめる。
- 影響 / 原因 / 再現 / なぜ今 / 異論: 上流障害のときだけ起きる。fail-closed は維持する。

### P3-48 #223 が「無言ログアウトの真因」とした因果は GoTrue の parent-of-active 規則と矛盾しており、真因は未特定。主な失効経路ではサーバに痕跡も残らない
- 重大度・検証: P3。検証済み（懐疑役が P2 から引き下げ）。統合元: X4-4-silent-logout-root-cause-unverified-and-untraced
- 根拠: `proxy.ts:86-91`、`locked-out.md:37-43`。GoTrue の `service.go`（親トークンを提示すれば現行トークンを返す）。`verified-user.ts:75-77`。
- 修正: 注記と runbook §3 を「#223 は衛生修正で、真因は未確定」に改める。SIGNED_OUT の計測を足し、再ログイン後に認証済みの Action で 1 回だけ報告する。第一容疑の P2-28 と併せて検証する。
- 検証: 1 回取りこぼした後に旧トークンで refresh しても成功することを、統合テスト（CI）で確かめる。
- 影響 / 原因 / 再現 / なぜ今 / 異論: 誤った真因の記録が再調査を妨げている。Supabase の Auth ログには痕跡が残りうる。

### P3-49 design-system/irori/MASTER.md がピンク・Inter・`transition: all` を「strictly follow」と指示しており、Liquid Glass と矛盾する
- 重大度・検証: P3。検証済み（懐疑役が P2 から引き下げ）。統合元: G3-design-system-master-contradicts-liquid-glass
- 根拠: `MASTER.md:3-5,21,31,76`。リポ内からの参照は 0 件で、src に混入した実績も無い。
- 修正: 削除するか、正本の要約に置き換えて「正本は docs/DESIGN_SYSTEM.md」と明記する。
- 検証: grep で 0 件になること。
- 影響 / 原因 / 再現 / なぜ今 / 異論: 将来の作業者を惑わす。異論なし。

### P3-50 文書・指示のドリフト群（DESIGN_SYSTEM と実装、CLAUDE.md の Stack・構成・規約、README の機能と検証手順、補助文書と Flutter の残滓、AGENTS.md）
- 重大度・検証: P3 未検証。統合元: G8-design-system-doc-vs-code, G9-claude-md-stack-structure-convention-drift, G10-readme-feature-and-verification-drift, G11-tooling-docs-residue, G14-agents-md-invisible-invariants
- 根拠・修正: 詳細は §8 に一覧化した。glass の見本がリテラルの backdrop-filter（#169 を再発させうる）、成長曲線を未実装と誤記、検証手順に 4 つの検出器と pgTAP が無い、Stop hook が `scripts/*`・`supabase/*` を対象にしていない、AGENTS.md に不変条件が無い、など。
- 検証: §8 の計画どおりに文書を更新し、find / grep で差分が 0 になることを確かめる。
- 影響 / 原因 / なぜ今 / 異論: 誤作業や Codex 監査の見落としを誘う。異論なし。

---

## 6. 反証された指摘（再提起しないこと）

| ID | 主張 | 発見者の重大度 | 反証の理由（1 行） |
|---|---|---|---|
| A3-ios-standalone-pwa-oauth-cookie-jar | iOS PWA から Google に接続すると、別の cookie 領域へ戻って csrf 失敗になる | P2 | 経路はスコープ内の同一窓への遷移と server redirect だけで、iOS の in-app browser は opener PWA と storage を共有する。さらに cookie が分かれても proxy が先に /login へ送るため、csrf の画面には到達しない。 |
| F1-background-engines-fake-only | 同期と通知のエンジンは fake でしか動かず、PostgREST の実構文の差が本番の失敗を隠す | P2 | 挙げられた差分（`.or` の ISO 値、maybeSingle の複数行、select 無し update の data、ignoreDuplicates）は、PostgREST の parser・PK による引き当て・既存の pgTAP（42P10）によって、どれも本番の欠陥を隠せないことが示された。 |
| G2-cookie-redirect-gotcha-stale-finalize-missing | CLAUDE.md の cookies+redirect の罠の記述は誤りで、finalize の不変条件も欠けている | P2 | Route Handler については記述が不正確だが、従っても害は無い。finalize の不変条件は proxy.ts:79-104 と回帰テスト（proxy.test.ts:114-157）が固定している。§8 で軽微なドリフトとしてのみ扱う。 |
| G6-db-push-vs-sql-editor-migration-history | db push の案内と SQL Editor での適用が混在し、不可逆な DROP の地雷になっている | P2 | 履歴がずれても fail-loud で止まり、repair で戻せる。DROP は人が件数を見て決めたもので、具体的な害は無い（運用上の確認は P3-15 に残す）。 |

---

## 7. 検証済みで健全な領域

- **世帯分離の骨格**:
  - FOR ALL のポリシーは 0 本。UPDATE は WITH CHECK を省略すると USING が流用されるため、household_id を他世帯へ動かせない。
  - DEFINER 関数 13 本はすべて `SET search_path = public`。
  - 列 GRANT（profiles の権限列、push の秘密列、google_tokens の deny-all、event_reminders の remind_at）は pgTAP（aclexplode / set_eq）で固定されている。
- **招待**:
  - token は 256bit。accept_invitation は FOR UPDATE と状態検査で 1 回しか使えない。
  - invitations の INSERT/UPDATE は role='member' に拘束されている（I-14）。
- **cron**:
  - 未設定なら 401（fail-closed）。safeEqual は長さで短絡する。
  - NOTIFY_CRON_SECRET と CRON_SECRET は分離されており、互いにフォールバックしない。
  - e2e はディレクトリを走査して全 route を 401 で撃つ。
  - isPublicRoute は完全一致か明示した prefix だけ。
- **認証の基本**:
  - open redirect は防がれている（safe-return-to と origin の前置）。
  - getClaims は exp を見て、JWKS で署名を検証する。失敗はすべて null（fail-closed）。
  - proxy の finalize は redirect にも cookie を載せ替える（#223）。Route Handler の cookie は Next がマージする。
  - Server Action は Origin を照合する。cookie は SameSite=Lax。
  - /auth/callback は PKCE で結び付いており、implicit のフラグメントは拒否される。
- **Server Action と Route Handler**: 全関数が getAuthContext から householdId を導き、クライアントの値を信用しない。update / delete は `.select("id")` で 0 行を検出する。
- **Google**:
  - OAuth の state は二重送信 cookie と非空の照合で守られている。
  - トークンは deny-all の表にあり、3 点で所有を照合する。callback の書き込み順は needs_reauth → 保存 → active。
  - 410 で full resync に入る。リースは条件付き UPDATE で、失敗時は解放しない。
  - nextSyncToken は最終ページのものだけを保存する。
  - google 行への IUD は native 限定の RLS とアクションの二重の eq で塞がれている。
- **通知**:
  - 冪等キーは UNIQUE NULLS NOT DISTINCT。claim は sent_at IS NULL の UPDATE で行う。
  - dedupe_day は scheduled_at から決める。grace は 15 分。
  - 購読を消すのは 404/410 だけ。
  - まとめも予定通知も memo を構造的に除外している。
  - 心拍は完走しなければ failed>=1 になる。
- **育児記録ドメイン**:
  - 授乳の全書き込み経路が logged_at に開始時刻を送る。
  - 母乳の counts、左右の秒、duration=左+右 は、サーバ・UI・DB CHECK が写し合っている。
  - enum は未知の値なら null に退化させる。判定は denylist で行う（pumped を除外）。
  - UTC の罠（`new Date('YYYY-MM-DD')`）は無い。
  - 楽観追加は id で重複を除く。日付をまたぐタイマーの扱いは保守側に倒してある。
- **ALTER TYPE と CHECK** は別の migration に分けてある。破壊的な migration（sleep の撤去・RENAME）は前提を確かめてから行っている。
- **Realtime publication**: 残っているのは baby_logs / calendar_events / baby_diaries の 3 表だけ。meals 系は外されている。秘密列を持つ表は載っていない。
- **PWA**:
  - sw.js は no-store で配信され、updateViaCache:'none'。
  - precache は URL ごとに try/catch で入れる。
  - 別オリジン・非 GET・/api・/auth には関与しない。redirect は保存しない。
  - /offline は個人データを含まない。push は必ず showNotification する。
- **依存**:
  - next の critical（next/og）と 16.3.8 で直る 6 件の GHSA は、irori の経路からは到達できない。
  - lockfile は全件 sha512。CI に pull_request_target も secret も無い。
  - supabase-js 2.117 の PKCE は二重書きなので、deploy と rollback をまたいでも互換。
- **PDF**:
  - setFonts はモジュールスコープで 1 回だけ呼ぶ。期間は allowlist で受ける。
  - pdfmake が URL を解決する経路は無い。AFM と ICC は読まれない。
  - 本文の記号（⚠・℃・〜・全角括弧）のグリフはフォントにある。
- **フォントの同梱**: Turbopack のソースを追うと、`path.join(process.cwd(), ...)` そのものがトレースの起点になり、同梱される見込み（nft.json での確認は人間の作業）。
- **テストの土台**:
  - 時限爆弾（壁時計への依存）は除去済み。日付処理は date-jst に集約されている。
  - fake-notify-db は NULLS NOT DISTINCT と FK の SET NULL を再現する。
  - sw-logic は本物の sw.js を vm で実行する。
  - 授乳の開始時刻の e2e は DB の窓を assert している。

---

## 8. ドキュメント / 指示のドリフト

### 8.1 既知（前提として受領済み・再掲のみ）

- CLAUDE.md と README は Next 16.2.6 と記載しているが、実際は 16.3.4。README には「16.2.6 で Turbopack を再テスト」という記述もある。
- CLAUDE.md は pdfmake v0.3.7 と記載しているが、実際は 0.3.11。
- CHANGELOG に「Flutter 移行 Phase 1」と Dependabot の pub がある。`.claude/hooks/stop-quality-gate.sh` に flutter の分岐がある。
- CLAUDE.md の RLS 規約に INSERT が含まれていない。
- ci.yml のコメントは「全 35 箇所」だが、checker は 19。

### 8.2 新規

| # | ドリフト | 根拠 | 対応 |
|---|---|---|---|
| 1 | CLAUDE.md:9,:58 が `unstable_retry` の使用を強制している（16.3 で `retry` に改名） | P2-01 | `retry` に修正し、advisor 軸3 の例も直す |
| 2 | CLAUDE.md:9 の「form auto-reset 無効化」が実装されていない | P2-30 | 実装するか、文言を直す |
| 3 | CLAUDE.md:81「cookies()+NextResponse.redirect で Cookie 未伝播」は Route Handler には当てはまらない（proxy には当てはまる）。user-level rules の写しが irori 固有の欄に置かれている | G2（反証済み・軽微） | proxy 限定の記述にし、finalize の不変条件を書く |
| 4 | Tailwind を v4.2 と記載しているが、lock は 4.3.3。PWA の欄に SW の記載が無い。callback は (auth) の外にある。Server Action の例外が 2 件ある（push-actions.ts、realtime-anomaly-action.ts）。public 経路の完全な集合が書かれていない | G9 | §8.3 |
| 5 | DESIGN_SYSTEM.md の glass の見本がリテラルの backdrop-filter（#169 に反する）。カードの角丸（rounded-xl と 2xl）、ナビの寸法、最小文字 14px が実装と一致しない。globals.css が参照する行番号が存在しない | G8, P2-33 | 見本を var(--glass-filter) 版に直し、寸法を実装値に合わせる |
| 6 | design-system/irori/MASTER.md が正本と矛盾している | P3-49 | 削除するか置き換える |
| 7 | README が成長曲線を未実装としている（実装済みで、未実装なのはパーセンタイル帯）。検証手順に 4 つの検出器（--strict）と pgTAP / E2E が無い。関連ドキュメントに runbook が無い | G10 | 訂正・追記する |
| 8 | scripts/README.md が 9 本中 2 本しか説明していない。block-generated-edits と .vercelignore に Flutter の残滓がある。Stop hook が `scripts/*` と `supabase/*` を対象にしていない。plans に状態の表記が無い | G11 | 索引を作り、残滓を除き、hook を追加し、plans に「完了 / 廃止」を付ける |
| 9 | CLAUDE.md・README・SECURITY.md が Storage を使用中と記載している。100003 のコメントは「残っても実害は無い」 | P3-07 | Storage を外し、コメントを訂正する |
| 10 | next.config.ts:24-26 の staleTimes の論拠（「visibility refetch が揃える」）が baby_logs では偽 | P1-04 | 実装と同時に直す |
| 11 | proxy.ts:86-91 と locked-out.md §3 が #223 を「真因」としている | P3-48 | 「衛生修正・真因は未確定」に直す |
| 12 | auth/confirm/route.ts:24「リンクを作れるのはサービスロールキーを持つ者だけ」が誤り。:44-46 の magiclink と recovery の分離の根拠も不正確 | P2-02 | 訂正する |
| 13 | locked-out.md:13,25-26（「同じアプリで」「どのブラウザでもよい」）、:32-33（`env pull .env.local`）。notify-cron.md の回転手順 | P2-29, P2-42, P2-41 | 訂正する（#225 を含む） |
| 14 | invite/[token]/page.tsx「退出してから」、setup-form「あとから変更できます」、verified-user.ts:30-32「承認取り消し」は、どれも存在しない機能を案内している | P2-26, P2-27 | 事実に合わせる |
| 15 | settings/actions.ts:212-217「D-5 の担当」が D-5 完了後も残っている。sync.ts:226-230 は CHECK が禁止していることを「禁じておらぬ」と書いている | P2-16, A2 注記 | 修正と同時に直す |
| 16 | migration コメントの「ローカルは Dxtm 既定」が CI の実挙動と矛盾している。verification-record の V2 / V3 / V7 / V9 が陳腐化している（stock-form.ts の参照など）。Supabase docs の DELETE フィルタに関する文言も更新された | B3, E1 注記 | 歴史記録として注記する |
| 17 | 20260726100003 の「冪等でない」は誤り（述語が自分自身を除外する）。CLAUDE.md の「統一済み」は Flutter の残余がある可能性 | P3-16 | 本番で確認してから訂正する |
| 18 | app-origin.ts:15 が参照する「デプロイ runbook」が存在しない。supabase/config.toml が参照する seed.sql が無い | P3-43, B3 注記 | runbook を作るか、参照を消す |
| 19 | generate-login-link.mjs:25 の「PR #741」は他リポの番号。push-endpoint.ts:29 の Edge（FCM）の記載（デスクトップ Edge は WNS） | G 注記, B2 注記 | 訂正する |
| 20 | CLAUDE.md の完了前チェックリスト 9-12 は、参照先の 1-8 がリポに無い | G 注記 | 番号を外す |
| 21 | AGENTS.md には Next に関する 1 文しか無い。不変条件は CLAUDE.md と ~/.claude/rules（リポの外）にしか無く、Codex と OSS の貢献者からは見えない | G14 | §8.3 |

### 8.3 CLAUDE.md / AGENTS.md の計画

**方針**: コードから推論できない不変条件・危険地帯・作業手順・必須の検証だけを残す。版数と全ディレクトリのツリーは消す（真値は package.json と実ツリー）。共有すべき不変条件は AGENTS.md に移し、CLAUDE.md は `@AGENTS.md` と Claude 固有の事項（Advisor の 3 軸）に縮める。

**AGENTS.md に置くもの**:

1. **proxy**
   - 全ての return を finalize() で包む（#223）。
   - 未認証で通す経路の完全な集合: `/login`、`/auth/callback`（prefix）、`/auth/confirm`（完全一致）、`/api/cron/`（prefix）、`/invite/`（prefix）。`startsWith('/auth/')` は禁止。
   - 経路を足す前に、fail-closed な認可があることを確かめる。e2e は cookie を持たない request で 401 を assert する。
2. **DB 契約**
   - breast の counts CHECK と duration = 左+右（合計を clamp せず、側ごとに比例縮小）。
   - 授乳の logged_at は開始時刻。例外として、クイック記録の bottle / solid はタップした時刻を開始とみなす。
   - enum の判定は denylist で書く。ALTER TYPE と CHECK は別の migration に分ける。
   - DEFINER には `SET search_path = public` を付ける。RLS は SELECT / INSERT / UPDATE / DELETE を分ける。CHECK・RLS・GRANT を緩めることは禁止。
   - 新しい表には anon / authenticated / service_role への GRANT を明示する（2026-10-30 以降は必須）。
3. **承認ゲート**
   - DB 側でも fail-closed にする（P1-01 の修正後）。
   - 承認の正本は profiles.is_approved。承認モデルの決定事項（P1-02 の結論）を記す。
4. **危険地帯**
   - `--glass-filter` は var() 経由が必須（#169）。
   - staleTimes.dynamic=10 は変更禁止。
   - 判定は resolveDefaultPage と getVerifiedUserId だけを源にする。
   - `'use client'` のファイルから値を import しない。`'use server'` のファイルは async 関数しか export しない。
   - `.update()` / `.delete()` は `.select("id")` で 0 行を検出する。
   - error.tsx は `retry` を使う。
   - 外部 I/O には timeout を置く。
   - Google 行は同期エンジンだけが書く。
   - 利用者に見せる「読めなかった」と「無い」を区別する。
5. **必須の検証**
   - lint / tsc / vitest / build。
   - `check-proxy-effective`（build log を渡す）、`check-supabase-error-destructure`、`check-transition-reject-guard`、`check-transition-all` をすべて --strict で。
   - pgTAP と E2E は CI でしか走らない（Docker が必要）。
6. **運用の索引**
   - `cron.job_run_details` は配達を監視しない。`net._http_response` を見る。
   - runbook 2 本（とバックアップ・env の新しい runbook）へのリンク。

**CLAUDE.md に残すもの**: `@AGENTS.md`、Advisor の 3 軸（例示を `retry` と正しい form reset に直す）、irori 固有の完了前チェックリスト（番号を外す）。

**docs へ移すもの**: cron の罠の長い経緯（verification-record V8 へ）、Tech Stack の版数（削除）、Project Structure（非自明な配置だけ残す）。

---

## 9. GitHub Issue / PR の再評価

閉じた・マージしたという主張はしない。以下はいずれも判断の提案である。

| 項目 | 判定 | 理由・条件 |
|---|---|---|
| **PR #234**（Dependabot group） | **採用（要対応）** | next 16.3.6 で critical の GHSA-vcvr が閉じる（irori からは到達しないが、audit の警報を正常に保つ）。react 19.3 は vitest と本番の差を縮める（P3-36）。supabase-js 2.117.2 と ssr 0.12.7 は**必ず同じ PR で**入れる（PKCE の per-flow slot が組で設計されているため）。マージ後に人間が iOS Safari / Android Chrome で手動 smoke する（base-ui 1.7/1.8 で Dialog の outside-press・scroll lock が変わり、シート内に Select がある）。**#234 では P2-01（retry prop）は直らない。** 16.3.8 は次の cycle で取ってよい（6 件の GHSA はいずれも到達しない）。CI / E2E / CodeQL は head で success（E2E は Desktop Chrome のみ）。 |
| **PR #225**（login link の env-file） | **採用（要対応）** | main と衝突しない。main の runbook は破壊的なコマンドを案内したまま。sensitive な env が空で返る場合の経路を runbook に追記する（P2-42）。 |
| **PR #204**（cron e2e を厳格化） | **要対応（rebase してからマージ）** | HEAD の spec は今も 500 を通す（P2-37）。base が古いので、現在の main に rebase して E2E を回してからマージする。notify の 200 固定は、テスト用 VAPID を足してから続けて行う。 |
| **Issue #205**（Phase D: GCP + Vercel env） | **production manual** | 手順: ① GCP の OAuth を In production で公開（Testing のままだと refresh token が 7 日で失効）、scope と redirect URI を登録。② Vercel production に GOOGLE_* / CRON_SECRET / NOTIFY_CRON_SECRET（別の値）/ VAPID 3 種 / NEXT_PUBLIC_APP_URL を入れて再デプロイ（`env add` だけでは自動で再デプロイされない）。③ Supabase で pg_cron / pg_net を有効にし、Vault に値を入れ、2 つの schedule を登録し、`net._http_response` で 200 を確認。④ eating-out-photos を削除（P3-07）。⑤ `migration list` で履歴を確認（P3-15）。⑥ 独自 SMTP（P2-39。**P2-02 の後**）。**有効化の前に、コード側の P2-16（ミラーの掃除）・P3-45（非公開予定の伏せ字と強制再同期）・P2-17（失敗の可視化）・P3-02 を入れることを強く推奨する。** |
| **Issue #166**（Flutter の母乳サイクル追随） | **close 候補** | Flutter は 9ec63e9 で削除済み。web 側は CHECK と validate* で完結している。backfill の残余は P3-16 で別に扱う。 |
| **Issue #92**（本番で Realtime が他端末に届かない） | **要対応（範囲を見直して継続）** | 当初の対象（meals / reactions）は廃止済み。残る購読は baby_logs / baby_diaries / calendar_events。根本原因は未特定（#190 の `[realtime-anomaly]` ログ経路があるのみ）。修正の主眼を「Realtime に依存しない自己回復」（P1-04）に移したうえで、Vercel の runtime log（保持 1 時間）と 2 端末での手動 smoke で配信状態を確かめる。README の「Realtime」実装済みの表記は、その結果に合わせる。 |
| **Issue #91**（meal_reactions の DELETE が Realtime で届かない） | **close 候補** | 対象の表は削除済み。フィルタ付き購読で DELETE が届かないのは仕様で、残る表は visibility refetch で回収する設計（baby_logs への適用は P1-04）。 |

---

## 10. 修正計画

### 10.0 今回の branch での台帳（状態欄つき）

本 branch（`worktree-prod-hardening-2026-10`）で扱う項目と状態。状態は「未着手 / 実装中 / 実装済み（local 緑）/ CI 待ち / 見送り」。下の 10.1 以降は監査時点の推奨計画全体で、本 branch で扱わない項目も含む。

| ID | 方針（本 branch） | 先に書く回帰テスト | migration | 本番の手作業 | 状態 |
|---|---|---|---|---|---|
| P1-01 | `create_household` の冒頭で `is_approved` を `FOR UPDATE` で検査し、未承認なら 42501。`households_insert` ポリシーの撤去（P3-01）を同梱 | pgTAP: 未承認 → throws 42501・副作用なし / 承認済み・世帯なし → lives | 要 | 迂回済み owner の監査クエリ（読み取りのみ） | 実装済み（local 緑）・CI 待ち |
| P1-02 | **製品判断（エージェントの既定案）**: 承認を「運用者」に限る。DB の運用者表（RLS 有効・ポリシー無しの deny-all・初期値は空）と `is_app_operator()`。運用者でない owner には承認カードを出さない。`/pending-approval` の案内を招待リンク前提へ（P2-26 を同時に解消）。代替案（世帯ごとの申請表）と rollback は最終報告 | pgTAP: 別世帯 owner は一覧を得られず承認もできない / 運用者は得られ承認できる（`approval_functions.sql` (11) を反転） | 要 | 運用者 1 名の登録 SQL（rollback つき） | 実装済み（local 緑）・CI 待ち |
| P1-03 | RPC 内で endpoint を検証（https・許可ホスト・port 無し・userinfo 無し）。TS の検証に port / userinfo / 生文字列一致を足し、送信直前にも再検査して不適合行は送らない | pgTAP と vitest で同じ事例表 | 要 | 既存の不適合行の件数を数える監査クエリ（値は出さない） | **閉じた**: 任意ホスト・内部アドレスへの送信（SSRF / open relay）と、tarpit ホストによる直列 cron の停止。実装済み（local 緑）・CI 待ち。**残る（P2 と再判定）**: 許可ホスト（FCM 等）の偽 endpoint を件数で積み、直列の通知 cron を時間切れにする枯渇。P2 とする理由: 承認済みのアカウントが要る（P1-01/02 で承認は運用者に限られた）、影響は予定通知の遅延・欠落で中核の育児記録には及ばない、偽 endpoint は FCM の 404/410 で gone として消える。招待経由の参加は自動承認ゆえ、1 つの世帯がアカウントを増やせば利用者ごとの上限では閉じられぬ — 根本対策は cron の時間予算と送信の総時間上限（§10 の 6 / P2-19） |
| P1-04 | 可視化・focus 復帰と channel の再 SUBSCRIBED で logs / weekly / growth を取り直す。取得中に入った行は保持し、世代ガードと AbortController を付ける | vitest: 復帰で再取得、相手が消した行が消え、取得中に入った行は残る | 不要 | なし | 実装済み（local 緑）・CI 待ち |
| P1-05 | **2026-10-19 に改訂（§10.0.2 UX-04a）**: 閉じる操作は計測を捨てずに閉じ、ダッシュボードのチップから戻る。破棄は確認つきの「キャンセル（記録しない）」だけ。**例外**: 開いて 1 分未満かつ seed から未操作なら、閉じる操作で取り消す（誤タップ救済。経過が負＝時計の巻き戻りは猶予外）。当初の「閉じる操作を断る」設計は指示 §7.1（閉じて予定を見ても戻れる）に反するため採らぬ | vitest: 計測中の dismiss で localStorage と startedAt が残る / 明示キャンセルでのみ消える | 不要 | なし | 実装済み（local 緑）・CI 待ち |
| P1-06 | `updated_at` を版にした楽観的排他（新規は INSERT … ON CONFLICT DO NOTHING、更新・削除は版の一致が条件）。衝突時は下書きを捨てず、サーバの本文と並べて見せる | vitest: 版の不一致で上書きせず conflict / 空シードからの保存でも既存行を壊さない | 不要（trigger 既存） | なし | 実装済み（local 緑）・CI 待ち |
| P1-07 | `(logged_at, id)` で安定させたページ取得。累計が上限 +1 に届いたら既存の truncated 経路へ | vitest: 1 要求 1000 行に制限した fake で全件集計 / 上限超過で truncated | 不要 | Max Rows の確認（任意） | 実装済み（local 緑）・CI 待ち |
| P2-01 | `error.tsx` 3 本を `retry` へ。CLAUDE.md の規約は訂正済み | vitest: retry がボタンに配線される / Next runtime が `retry` を渡す契約 | 不要 | なし | 実装済み（local 緑）・CI 待ち |
| P2-31 | 世帯の取得失敗時は編集フォームを出さず、失敗を表示する | vitest | 不要 | なし | 実装済み（local 緑）・CI 待ち |
| P2-30 | 設定 2 フォームの自動 reset を止める | vitest | 不要 | なし | 実装済み（local 緑）・CI 待ち |
| P2-21 | PDF / 手動同期の fetch で redirect と content-type を検査し、失効なら再ログインを促す | vitest | 不要 | なし | 実装済み（local 緑）・CI 待ち |
| P2-24 | purge の成功と signOut の成功を確かめてから LAST_USER_ID を消す。`/pending-approval` の purge はサーバが承認待ちを確認した時だけ | vitest | 不要 | なし | 一部実装（local 緑）・CI 待ち。**`/setup`・`/login` の guard は未実装**（承認済み・世帯なしの利用者が共用端末でオフライン閲覧すると、前の世帯のスナップショットが見えうる） |
| P2-38 | households / profiles / create_household の pgTAP を P1-01 / P1-02 と同時に足す | pgTAP | 不要 | なし | 一部実装（households / profiles / create_household / 招待 RPC の anon 権限。accept_invitation の状態別・publication は未）・CI 待ち |
| P2-26 | P1-02 の文言の変更で同時に解消 | — | — | — | 実装済み（承認カード・/pending-approval・/setup・招待ページの文言）・CI 待ち |

本 branch では直さず残す P2 / P3 は、最終報告の「Remaining risks」に列挙する。

### 10.0.2 2026-10-19 の統合と追加実装（状態欄つき）

main 作業ツリーの未コミット成果（2026-10-01: 日跨ぎ P2-05・編集の即時反映 P2-06・ネイティブピッカー）を本 branch へ合流させ、指示書（§7 / §8）の残項目と追加機能 A〜D を実装した。状態は「実装済み（local 緑）」= vitest 146 files / 2200 tests・tsc・eslint・transition 検出器 2 本が同じ最終ソースで緑。CI・build・pgTAP・e2e・実機は未実行（§11.1）。

| ID | 内容 | 主な場所 | テスト | 状態 |
|---|---|---|---|---|
| 統合 | main の 27 + 5 files を 3-way で合流。日跨ぎの二段目は `resyncLogs`（P1-04）へ一本化、`todayJstString()` は `todayRef` へ | baby-dashboard / diary-edit-sheet / date-nav / ui | day-rollover 17・today-clock-contract | 実装済み（local 緑） |
| P2-05 / P2-06 | 日跨ぎ追従・編集の版比較つき即時反映 | baby-dashboard | 既存 + resync | 実装済み（local 緑） |
| P2-10 | 日付ナビの取得中・失敗時に前の日の行を出さぬ（骨組み・失敗表示・再読み込み）。resync が癒す | baby-dashboard / baby-timeline | datenav 4 | 実装済み（local 緑） |
| UX-10 | 成長グラフの x 軸を時間比例に。直近の測定を数値一覧で併記 | charts | line-chart 7・growth-chart-section 4 | 実装済み（local 緑） |
| P2-08 | 冪等 id（UUID）を主キーに INSERT、23505 は同じ世帯の行だけ記録済みとして返す。タイマー・フォーム・クイック記録の再試行で同じ id | actions.ts / client-id / timer / quick-actions / form-sheet | actions-idempotency 8・quick-actions 3・timer 5 | 実装済み（local 緑）。migration 不要 |
| P1-05 改 / UX-04a | 閉じても計測は残り、チップから戻る。1 分未満の未操作だけ取り消し。破棄は確認つきのみ | feeding-timer / running-timer-chip / baby-dashboard | feeding-timer 66・timer-chip 6 | 実装済み（local 緑）。P1-05 の「閉じさせない」は指示 §7.1 に従い改めた |
| P3-08 | タイマーの端末保存に userId。別の利用者は復元せず捨てる。サインアウト・利用者交代で消す。停め忘れは手動入力で記録か破棄 | feeding-timer-storage / settings-content / pending-content / cache-user-guard | timer 5 | 実装済み（local 緑） |
| 機能 A | 記録者の表示（二人以上の世帯のみ） | recorder-label / page.tsx / timeline | recorder-label 4・timeline 2・item 2 | 実装済み（local 緑） |
| 機能 B | 日付ジャンプ・`?date=` 着地・全履歴検索（DB 側・keyset・exact count・ILIKE escape） | baby-link / baby-search / search/page | baby-link 4・baby-search 9・results 4・wiring 5・date-nav 3 | 実装済み（local 緑）。実 DB での検索は e2e 未作成（人間の smoke 項目） |
| 機能 C | 過去日の追記（フォーム経由・日付を明示）・日付ごと修正・おむつの作成 | form-sheet / past-day-actions / temperature-card | form-sheet-date 7・past-day 2・dashboard-past-day 2 | 実装済み（local 緑）。F-03 の据え置き理由は 3 点で閉じた（§10.0.2 注） |
| 機能 D | JSON エクスポート（keyset ページ取得・完全性・no-store・世帯境界） | baby-export / api/baby-export / export-card | route 11・domain 5・card 6・e2e 1 | 実装済み（local 緑）。e2e は CI で実行 |
| 文書 | README（成長曲線・Storage・検証手順・runbook）、SECURITY / CLAUDE.md の Storage、MASTER.md の撤去、plans の状態表記、CHANGELOG | docs | — | 実装済み |
| eslint | `.playwright-mcp/**` を除外、`_` 始まりの未使用を許容 | eslint.config.mjs | — | 0 errors / 0 warnings |

**公開前の照合事項（人間の判断）**: P1-02 の承認モデル（`app_operators`）は本 branch に migration と UI が実在するが、採用はエージェントの既定案であり利用者の決定は未確認（指示 §7.4）。db push の前に `docs/runbooks/approvals.md` の判断を人間が行う。承認の正本は `profiles.is_approved` のまま。

### 10.0.3 2026-10-20 の独立レビュー（code-reviewer / advisor）と処置

実装の思考を渡さぬ 2 名（code-reviewer・advisor）に §10.0.2 の最終ソースを読み取り専用でレビューさせた。どちらも test・build・e2e は走らせておらぬ。処置後の gate: vitest 150 files / 2240 passed、tsc 0、eslint 0 / 0、transition 検出器 2 本 0 件、`git diff --check` 0。

| 重大度 | 指摘 | 処置 | テスト |
|---|---|---|---|
| **P1**（advisor は STOP） | `/baby/search` が記録 1 件以上で Server 描画時に throw: Server Component の `baby-search-results` が `"use client"` の `baby-timeline-item` から `getLogSummary` を**値 import**（CLAUDE.md の罠。tsc / build / vitest は緑のまま） | 要約を中立モジュール `src/lib/domain/baby-log-summary.ts` へ移し、両者がそこから import。再発防止に `src/app/__tests__/server-client-value-import.test.ts`（page / layout / route を起点に境界指令の無いモジュールを辿り、use client のファイルから Component 風でない名前を値 import しておれば赤） | wiring 1・summary 3・boundary 3 |
| P2 | クイック記録の冪等 id に期限が無く、数時間後の本物の同種タップが過去の保存に吸収され無音で消える（undo は前回の本物の行を消す） | 再利用の期限 `RETRY_WINDOW_MS`（2 分）。サーバは受理を `replayed: true` で返し、クライアントは「既に記録されています」と出して undo も楽観 append もせぬ | quick-actions 3・actions 1 |
| P2 | 再試行が既存行の id だけを返し、呼び出し側は今の入力で楽観行を組む（直して押し直すと画面と DB が食い違う） | 23505 の読み直しで列一式を読み、**世帯と内容が一致した時だけ**受理（§4 P2-08 の契約どおり）。違えば fail-loud（更新を促す）。フォームは通信断の後に入力が変わったら id を作り直す | actions 3・form-sheet 5 |
| P2 | 日付ナビの取得中、日記だけ前の日の本文が新しい日付の下に出て、編集 → 2 回保存で前日の本文を新しい日へ書ける（W-1 の取りこぼし） | `diaryDate` を持ち、選択日と一致する時だけ本文と編集を許す（logs の `logsDate` と同じ gate）。取得中は骨組み | datenav 1・daily-diary 1 |
| 条件付き（advisor） | JSON の全期間書き出しが Vercel の応答上限 4.5MB を超えうる | 記録 3.2MB・日記 0.8MB のバイト予算で取得を止め、`complete: false` と `X-Export-Truncated` で明示。本文を compact JSON に。`diaries_truncated_after` を分離（日記だけの切り詰めで記録の時刻を指さぬ。P3-12） | route 2・domain 4 |
| P3 | まとめ・体温カードが取得中・失敗中に「0回」「未測定」と偽る | `status` を渡し、ready 以外は「—」／読み込み中・読み込めなかった表示（記録ボタンも出さぬ） | summary-bar 3・temperature 3・datenav |
| P3 | 開いたまま 2 時間を超えた計測が膨らんだ時間で記録される（判定が開いた時だけ） | 停止時にも判定し、手動入力へ回す | timer 1 |
| P3 | 端末保存が失敗する環境で、閉じて開き直すと計測が上書きされ、チップも 1 分で消える | 保存失敗を知っておれば手元の計測を保つ。ダッシュボードはタイマーの報告を保存より優先 | timer 2 |
| P3 | 前日行が appendLog を通らず、昨日表示中に行が出ぬ。2 日前でも「前日」と出る | 常に `onLogRecorded`（appendLog が日付で振り分ける）。日付は「前日」/「M/D」 | timer 2 |
| P3 | pending-approval が本物の失敗でもタイマーを消す | settings と同じく signOut の成功時だけ消す | pending 3 |
| P3 | ILIKE の `*`（PostgREST は `%` の別名） | 検索語から落とす | search 1 |
| P3 | `Button render={<Link/>}` に `nativeButton` が無い | 素の `<Link>` へ（`nativeButton={false}` は role="button" が付いて link でなくなる） | form 2 |
| P3 | `?date=` 着地後に `/baby` へ戻っても選択日が残る | `<BabyDashboard key={selectedDate}>` | wiring 1 |
| P3 | 台帳 P1-05 の記述が旧設計のまま | §4 の行を UX-04a に合わせて改訂 | — |
| 据え置き | advisor: PR を migration / 堅牢化 / 機能 A〜D の 3 本に分けよ | 人間の判断。migration 3 本 + runbook + pgTAP は file 単位で分けられる（`rc-pathspec-migrations.txt`）。堅牢化と機能は同じ file（baby-dashboard 等）に同居するため hunk 単位の staging が要る | — |
| INFO | 主ポインタが fine の端末ではアイコンのタップでピッカーが開かぬ見込み（`(pointer: coarse) and (any-pointer: fine)` の条件は main の設計） | 実機確認の項目へ（§11.4）。input 自体は常に操作できる | — |

問題なしと確かめた領域（両名）: 世帯境界（record* / update / delete / search / export の全クエリが RLS と `household_id` の二重）、keyset の整合、export の認可と no-store、タイマーの名義、時計の契約、appendLog の窓判定、Liquid Glass の規約、`searchParams` の Promise、SECURITY DEFINER の `search_path`、FOR ALL の不在。

### 10.0.1 新しい文脈での敵対レビューと処置

実装の思考を渡さぬ subagent に、要件・本書・diff・テストだけを渡してレビューさせた。blocker 候補は観点の異なる 2 名に反証させた。

| 回 | 指摘 | blocker | 処置 |
|---|---|---|---|
| 1 | 戻る操作でキャッシュ済み RSC から再マウントされると、P1-04 の再取得が走らぬ | 2 名とも確認 | マウント時と初回を含む全 SUBSCRIBED で取り直す |
| 1 | token 失効・refresh 失敗中の再取得が anon の 0 行を真値として描く（P1-04 の回帰） | 1 名確認・1 名は P2 相当 | 取得前に session を確かめ、無ければ反映せずログを残す（日記の再取得にも同じ門） |
| 1 | 衝突後に空の下書きで「上書き」を押すと家族の日記が消える | 非 | 空なら「保存されている日記を削除する」（destructive）と明示 |
| 1 | 誤って開いたタイマーを閉じられない / 小型画面で出口が切れる | 非 | 1 分未満かつ未操作は閉じると取り消す / 本文をスクロール可能に |
| 1 | `/pending-approval` の purge が、proxy の一過性の取得失敗で承認済みの家族のキャッシュを消す | 非 | サーバが承認待ちを確認した時だけ purge |
| 1 | 招待ページが同じ世帯の家族にも「別の世帯」と出す | 非 | 招待先の世帯と比べて文言を分ける |
| 1 | route の 401 が一過性の DB 障害でも出る | 非 | 401 は未認証だけ、一過性は 503、未承認・世帯なしは 403 |
| 1 | サインアウトで signOut の成功前に LAST_USER_ID を消す | 非 | purge と signOut の両方の成功後に消す |
| 1 | 破棄確認ボタンが 28px | 非 | 反証: 共通 Button の基底 class に `min-h-11 min-w-11` がある（修正不要） |
| 1 | e2e のページ取得テストが同値の重複・取りこぼしを検出できぬ | 非 | 5,000 行（ヘッダ無し）/ 5,001 行（ヘッダ有り）の境界の対へ |
| 2 | 時計が戻ると 60 秒猶予が長い計測を 1 タップで捨てうる | 非 | 経過が負なら猶予外・seed から触った計測は猶予外。当初の test は操作済みの fixture で、経過が負の門を消しても緑じゃった（2026-10-05 に mutation で判明）。未操作の seed で開始だけを未来にした test と、開始 30 秒前の対照を足した（門を消すと赤） |
| 2 | 応答を失った同じ端末の再保存に「別の端末で」と出る | 非 | 読み直した本文が同じなら成功として返す（冪等。mutation で赤を確認） |
| 2 | proxy の一過性の取得失敗も「セッション切れ」と出る | 非 | redirect は原因を断定せず再読み込みを促す文言に分ける（401 だけが「セッション切れ」） |
| 2 | 日記の版ガードを本物の DB で確かめるテストが無い | 非 | `supabase/tests/baby_diaries_version_guard.sql`（12 asserts）を追加 |
| 2 | `/setup`・`/login` の guard が未実装で記録も無い | 非 | P2-24 の行と Remaining risks に明記（未実装のまま） |

**共通の前提**:

- 各修正は、回帰テストを先に書いて赤を確認してから実装する（red → green）。
- migration は新しいファイルとして追加し、**エージェントは本番に適用しない**。人間が次の順で行う。
  1. `supabase migration list --linked` で履歴を確認する（P3-15。必要なら `migration repair`）。
  2. レビュー後に `supabase db push` を実行する。
- RLS・CHECK・GRANT はいずれも締める方向にしか変えない。

### フェーズ 0（すぐ・migration 不要）

1. **P2-01 retry の prop 名を改名**。テスト: ErrorBoundary で包んで描画し、click で refresh が呼ばれること（赤）。CLAUDE.md:9,:58 も同時に直す。migration: なし。
2. **PR #234 を採用**（上記の条件付き）。本番の作業: マージ後の実機 smoke。
3. **PR #225 を採用**、**PR #204 を rebase してマージ**。

### フェーズ 1（P1・本番の前提条件）

4. **P1-01 create_household の承認チェック**
   - テスト: pgTAP で pending の利用者が throws_ok(42501) になり副作用が無いこと、承認済みは lives_ok（赤を確認）。
   - **migration: 必要**。CREATE OR REPLACE と FOR UPDATE。同じ migration に P3-01（households_insert の撤去）と P3-03（旧 RPC の anon REVOKE）を同梱する。
   - **bootstrap の runbook を必ず同時に出す**。本番の作業: migration の適用と bootstrap 手順の確認。
   - P2-38 の membership pgTAP を同じ PR で追加する。
5. **P1-02 承認モデルの再設計**
   - **人間の判断**: 運営者 allowlist か、世帯ごとの申請表か。
   - 判断までの暫定対応（migration 不要）: email のマスクと文言の修正（P2-26 と合わせる）。display_name の長さ CHECK は migration が必要。
   - テスト: pgTAP (11) を意図的に反転する。
6. **P1-03 push endpoint の検証**
   - テスト: pgTAP で許可外ホスト・http・非 443 が拒否され、FCM は lives_ok。vitest で deliver が送らないこと。
   - **migration: 必要**（RPC の検証と CHECK）。**本番の作業: CHECK を足す前に、既存の行を SQL で検査する。**
   - 同じ PR で port の検査、送信の総時間の上限、cron の時間予算（P2-19 と一部共有）を入れる。
7. **P1-04 baby_logs の再同期**
   - テスト: visibility で再取得され、削除済みの行が消え、取得中の楽観行が残ること。
   - migration: なし。P2-05（日付の境界）と P2-06（楽観反映）を同じ設計で連続して入れる。
8. **P1-05 タイマーを閉じても破棄しない**
   - テスト: Escape / 暗幕の後も localStorage が残り、明示キャンセルのときだけ消えること。
   - migration: なし。P3-08 と P3-25 を併せる。
9. **P1-06 日記の楽観的排他と 3 値の読み込み状態**
   - テスト: updated_at が不一致なら conflict。unknown のとき編集を無効にする。
   - migration: なし。datenav の既存テストは意図的に更新する。
10. **P1-07 PDF の range ページング**
    - テスト: max_rows を模した fake で 1500 行が全件集計されること。999 行と 5001 行の対照も置く。
    - migration: なし。
    - 同じ流れで **P2-35（フォントを静的 Regular に差し替え）** と **P2-36（PDF の実行テスト）** を入れる。
    - 本番の作業: Max Rows の確認、生成した PDF への `pdffonts`。

### フェーズ 2（選定した P2・順序に依存するもの）

11. **P2-02 /auth/confirm の確認画面・HMAC 照合・Origin 検査**
    - テスト: GET で verifyOtp を呼ばない、email が不一致なら拒否、Origin が異なる POST は拒否。
    - migration: なし。
    - **P2-39（独自 SMTP）と P2-29（メールテンプレートの OTP / TokenHash 化）より前に必ず入れる。** P3-44 も同時に直す。
12. **P2-03 household 表を anon から REVOKE し、クライアントで session を確認する**
    - テスト: pgTAP で anon が 42501、vitest で session が null のとき状態を更新しないこと。
    - **migration: 必要**。
13. **P2-28 local のログアウトと「全端末からログアウト」をセットで出す** → P2-24（ページ側から直接 caches.delete、成功を確認してから key を消す）→ P2-23（Next-Action には 401、SIGNED_OUT のバナー）→ P2-22（UnrecognizedActionError で再読み込みを促す）。いずれも migration は不要。
14. **P2-04 / P2-31 / P2-13 「読めなかった」の表示**
    - error のときに空の文言を出さないことを確かめる。migration: なし。
15. **P2-12 カレンダーの削除確認**、**P2-14 シートのスクロール**、**P2-11 Undo トースト**、**P2-21 export の redirect:'manual'**、**P2-30 form の reset**。いずれも migration は不要。
16. **#205 で Google 同期を有効化する前**: P2-16（cleanupMirror の配線と sync_token の NULL 化、切断 Action）、P3-45（伏せ字と**全購読の強制フル再同期を 1 回**）、P2-17、P2-18、P3-02（**migration: 必要**）。本番の作業: #205 の手順。
17. **P2-15 案 B**（送信済みで移動した予定）。テスト: fake DB での再現（赤）と、二重送信が無いことの対照。migration はキーの形次第（案 B なら不要）。
18. **P2-08 クライアント UUID を PK にした冪等化**。テスト: 再試行で同じ id、23505 で内容が一致することを確かめる。migration: なし。
19. **運用**: P2-40 バックアップの runbook と復元演習、P2-41 回転手順の訂正、P2-39 SMTP の判断（P2-02 の後）、P3-43 deploy-env の runbook、P3-14 GRANT の明示と migration の lint（**2026-10-30 より前**に方針を決める）。
20. **文書**: §8 の計画どおりに AGENTS.md と CLAUDE.md を再構成する。

### 人間の作業の一覧（エージェントは実行しない）

- 本番での migration の適用（`migration list --linked` → 必要なら repair → `db push`）。
- 承認モデルの決定（P1-02）。bootstrap 手順の実施。
- Supabase Dashboard の確認と設定変更: Max Rows、Auth の Enable signups、SMTP、レート制限、メールテンプレート、Backups / PITR、プラン。
- Vercel の確認と設定変更: プラン、env（APP_URL、VAPID、Corepack、engines）、NEXT_SERVER_ACTIONS_ENCRYPTION_KEY の扱い、Actions の Workflow permissions。
- #205 の手順全体。eating-out-photos の削除。backfill の残余を SQL で確認・補正（P3-16）。
- iOS / Android の実機確認（standalone のログイン、PDF の共有、シートとダイアログの smoke、通知）。
- PR のマージと push（#234 / #225 / #204）。

---

## 11. 未実行の検証と、人間が実行するコマンド

### 11.1 本監査で実行していないもの

build、本物の Supabase stack での pgTAP、Playwright E2E、`check-proxy-effective.py`（build 成果物が要る）と `check-supabase-error-destructure.py`（guard hook が拒否）、実機、本番の Supabase / Vercel の観測。Docker 不在と sandbox の制約による。vitest・eslint・tsc・transition 系検出器 2 種・PGlite 近似の pgTAP は §1.3 のとおり実走した。

**2026-10-20 の再実行（§10.0.3 のレビュー処置後の最終ソース）**: `vitest run` 150 files / 2240 passed、`tsc --noEmit` 0、`eslint` 0 errors / 0 warnings、`check-transition-reject-guard.py --strict` 0 件（19 箇所）、`check-transition-all.py --strict` 0 件（283 箇所）、`git diff --check` 0。未実行: `pnpm build`（sandbox 内の Turbopack が「Creating an optimized production build」から進まず 2 回とも 10 分超で停止。`.next/server` は空のまま）、`check-proxy-effective.py`（build log が要る）、`check-supabase-error-destructure.py`（guard hook が script 名で拒否）、pgTAP / E2E（Docker socket が sandbox で permission denied）、画面と実機（dev server の port 結合不可・Playwright MCP 未接続）。これらは §11.2 のコマンドで人間が実行する。

**2026-10-20 午後の再実行（§12 の再利用監査と独立レビュー処置の後の最終ソース）**: `vitest run` 155 files / 2303 passed、`tsc --noEmit` 0、`eslint` 0 / 0、transition 検出器 2 本 0 件（19 / 283 箇所）、`git diff --check` 0。**build の新しい知見**: sandbox の網が Google Fonts（`next/font` の Geist）を拒むため build が落ちる。2 ホスト（fonts.googleapis.com / fonts.gstatic.com）を許すと **`next build --webpack` は完走**した（compile・TypeScript・page data・静的生成 23/23、`ƒ Proxy (Middleware)` あり）。その build log で `check-proxy-effective.py --strict` は違反 0、`baby-report` の nft に NotoSansJP が載る。**Turbopack の `pnpm build` は font を許しても「Creating an optimized production build」から進まず未完**（原因は未特定。本番は Turbopack ゆえ CI / ローカルで要確認）。webpack の完走は Turbopack の合格証拠ではない。

### 11.2 ローカル / CI（作業ツリーの直下で実行）

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm exec tsc --noEmit
pnpm test
pnpm build 2>&1 | tee build.log
python3 scripts/check-proxy-effective.py build.log --strict
python3 scripts/check-supabase-error-destructure.py --strict
python3 scripts/check-transition-reject-guard.py --strict
python3 scripts/check-transition-all.py --strict
# Docker が必要（CI と同等）
supabase start
supabase test db
pnpm exec playwright test
# PDF フォントがトレースされているか（build の後）
grep -n "NotoSansJP" .next/server/app/api/baby-report/route.js.nft.json
fc-query -i 0 --format='%{postscriptname}\n' fonts/NotoSansJP-Regular.ttf
```

（検出器の正確な引数は ci.yml:48-78 に従うこと。）

### 11.3 本番（読み取り。Supabase SQL Editor 等で人間が実行）

```sql
-- migration 履歴（P3-15）
select version from supabase_migrations.schema_migrations order by version desc limit 20;
-- PDF 切り詰めの実害（P1-07）: 世帯ごとの直近 91 日の件数
select household_id, count(*) from baby_logs where logged_at >= now() - interval '91 days' group by 1 order by 2 desc;
-- anon の表権限と関数権限（P2-03 / P3-01 / P3-03）
select relname, relacl from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r';
select has_function_privilege('anon', 'public.get_invitation_by_token(text)', 'EXECUTE');
select has_table_privilege('anon', 'public.households', 'INSERT');
-- 既存の push endpoint の形（P1-03。CHECK は足さず、送信直前の再検査で送らぬ方式にした）
-- 式は docs/runbooks/approvals.md §2.1 (c) と同じにする（大文字・空ラベルを適合と数えぬ）
select count(*) filter (where endpoint !~ '^https://(([a-z0-9-]+\.)+push\.apple\.com|fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com)/') from push_subscriptions;
-- 残置バケット（P3-07）
select id, public from storage.buckets where id = 'eating-out-photos';
select count(*) from storage.objects where bucket_id = 'eating-out-photos';
-- backfill の残余（P3-16）
select count(*) from baby_logs where log_type='feeding' and feeding_type in ('breast_left','breast_right') and coalesce(duration_sec, duration_min*60) > 0 and logged_at = created_at;
-- 承認待ちの件数（P1-02 の影響規模）
select count(*) from profiles where is_approved = false;
-- cron の配達（#205 の後）
select status_code, count(*) from net._http_response group by 1;
```

### 11.4 本番（Dashboard / CLI。人間が実行）

- Supabase Dashboard:
  - API Settings → Max Rows（P1-07）
  - Authentication → Enable signups / SMTP / Rate limits / Email templates（P1-01, P2-39, P2-29）
  - Database → Backups / PITR とプラン（P2-40）
  - Logs Explorer の Auth（P3-48）
- `supabase migration list --linked`（**人間が実行**。エージェントは supabase CLI を呼ばない）
- Vercel:
  - 最新の production deployment の build log で pnpm と Node の版を確認（P3-33）
  - プラン（Hobby / Pro。Skew Protection とログ保持）
  - production env の一覧（値は表示しない）
  - Runtime Logs で `[realtime-anomaly]` と `/api/baby-report` の ENOENT を確認（保持 1 時間）
- GitHub:
  - Settings → Actions → Workflow permissions
  - Dependabot security updates の有効・無効
- 実機:
  - iOS の standalone で、ログアウト → 再ログイン（P2-29）
  - PDF の保存（P2-34）
  - シートの開閉と、シート内の Select（#234 の後）
  - 2 端末での記録・削除の反映（P1-04, #92）
  - 0 時をまたぐ観測（P2-05 / D-1）

## 12. 成熟 OSS 再利用監査（2026-10-20）

**方針**: Build less, reuse more。導入そのものを成果とせず、既存方式の維持（KEEP）も同じ重さの判断として記録する。各領域を「A: リポジトリ内の再利用 → B: 導入済み依存の再利用 → C: 成熟 OSS・標準機能との比較 → D: 判定」の順で見た。版・ライセンス・最終公開は npm registry（`npm view`、2026-10-20 取得）、挙動は公式 docs で確かめた。新しい依存は**一つも足しておらぬ**。

### 12.1 領域別の判定（指示 §4 A〜H と UI）

| 領域 | 解決対象（現状の実コード） | 現在方式 | 候補（一次資料） | 利用条件 | 成熟度 | 技術適合 | 実装負担 | 運用負担 | 効果 | 判定 |
|---|---|---|---|---|---|---|---|---|---|---|
| A. IndexedDB・永続化 | 授乳タイマーの端末保存（1 キーの JSON、利用者の名義つき。`feeding-timer-storage.ts`）。IndexedDB と送信待ち（outbox）は RC に**存在しない**（I-21 を不採用） | 自作の localStorage 読み書き（97 行） | [idb](https://github.com/jakearchibald/idb) 8.0.4 / [Dexie](https://dexie.org/docs/) 4.4.6 | idb: ISC、Dexie: Apache-2.0。いずれも商用可。Dexie Cloud（有料）は対象外 | どちらも 2026-10 に公開あり | 同期 1 キーの読み書きに非同期の IDB は過剰。描画前の復元が遅れる | 置換なら復元経路の非同期化 | 依存 +1 | なし | **KEEP**。outbox を作る時は自前の IDB ラッパを書かず idb を第一候補にする（**DEFER の条件**）。冪等・認証・順序・世帯の分離は irori 側に残す |
| B. 非同期データ | 復帰・再接続の取り直し（世代ガード・取得中に触った行の合流）、Realtime、楽観更新 | 自作（`baby-log-resync.ts` の純関数 69 行と dashboard の effect） | [TanStack Query](https://tanstack.com/query/latest/docs/framework/react/overview) 5.104.5 | MIT | 高い | App Router の RSC と並べるとキャッシュの正本が二重になる。永続化した mutation の再送は「既定の mutationFn を登録しないと再読み込み後に再開できない」（公式 guides/mutations）。冪等・二重送信は解決しない | dashboard と calendar の状態管理を全面的に書き換える | 依存 +2（persist 込み）、キャッシュの正本が二重 | 取り直しの重複排除は得るが、取得中の楽観行を守る合流規則は自前で残る | **DEFER**。条件: 同じ取り直し規則を 3 画面以上が複製し始めた時、または Server Actions から client fetch へ移す時 |
| C. 繰り返し予定 | 毎日・毎週・毎月の展開（1 年以内、存在しない日は飛ばす、物理行で保存）。Google の予定は `singleEvents=true` で Google 側が展開済み | 自作（`calendar-recurrence.ts` 125 行。YYYY-MM-DD の文字列演算で TZ に依らぬ） | [rrule](https://github.com/jkbrzt/rrule) 2.8.1 | BSD-3-Clause | **最終公開 2023-11-10**（約 3 年更新なし） | JS Date ベースで TZ の扱いに注意が要る。保存形式は RRULE ではなく展開済みの行 | 置換は可能だが利益が無い | 更新の止まった依存 +1 | なし | **KEEP**。条件: 「第 2 火曜」（BYDAY / BYSETPOS）・例外日・シリーズの部分変更を足す時に再評価。その時も保存は展開行のまま（既存データの意味を変えぬ） |
| D. 成長グラフ | 体重・身長の折れ線（時間比例の x 軸）、週間の棒、`role="img"` と `<title>`、直近値の一覧の併記 | 自作 SVG（line 146 行・bar 84 行） | [Recharts](https://recharts.github.io/) 3.10.1 / d3-scale 4.0.2 | MIT / ISC | Recharts は活発。d3-scale は 2022 以降更新なし（安定） | Recharts は client 描画で計測が要る（展開後 7.4MB）。線形写像は 3 行で、d3-scale の利益が無い | 置換で表示とテストを作り直す | 依存 +1（大） | なし | **KEEP**。条件: 目盛り・ズーム・成長曲線の標準パーセンタイル帯を描く時に d3-scale だけ再評価 |
| E. 検索 | メモ・日記の全履歴検索（`/baby/search`）。世帯の境界は RLS と `household_id` の二重 | **既存 API の再利用**: PostgREST の `ilike`（`%` `_` `\` を escape、`*` を除去）・`(logged_at, id)` keyset・exact count。索引 `idx_baby_logs_household_time (household_id, logged_at DESC)` で世帯内の範囲走査 | pg_trgm（GIN）/ Full Text Search | PostgreSQL 標準 | 高い | pg_trgm は 3 文字未満の語で索引を使えぬ（主用途の 1〜2 文字の日本語に効かぬ）。FTS の simple / english 構成は日本語を分かち書きしない | migration と索引 | 索引の維持 | **未実測**（Docker 不可で実行計画を取れず） | **REUSE**（現状）。pg_trgm は **DEFER**。条件: 世帯あたりの行数が 10 万を超える、または検索の p95 が 300ms を超える実測。1〜2 文字検索の実行計画は未実測 |
| F. 日付・TZ | JST の暦日・日境界・週の起点・時刻入力の値 | 自作 `date-jst.ts`（Intl.DateTimeFormat と Date.UTC。授乳の開始時刻・日跨ぎ・月末・閏日・2/29 の 1 年後を検証済み） | [date-fns](https://date-fns.org/) 4.4.0 / @date-fns/tz 1.5.0 | MIT | 高い。**lockfile には Base UI の optional peer として既に入っておる**（直接依存ではない） | JST は DST が無く、文字列演算で足りる | 大量置換で検証済みの意味を崩す危険 | 依存 +2 | なし | **KEEP**。同時に **REPLACE（削除）**: 呼び出し元 0 件でローカル TZ に依存する `src/lib/utils/date.ts` を削除。日境界の手組み（`${ymd}T00:00:00+09:00`）を `jstDayStartIso` に寄せた（触った file の分） |
| G. PWA・SW | network-first の document / RSC、cache-first の静的資産、利用者単位の purge、24h のオフライン表示、Push、通知のタップ、購読の自動更新 | 自作 `public/sw.js`（759 行） | [Serwist](https://serwist.pages.dev/docs/next/turbo) 9.5.13 / @serwist/turbopack | MIT | 活発。docs は「Serwist 10 以降は Next.js 15 以上のみ」と明記。peer は next >=14・esbuild | Push・購読更新・purge は Serwist でも自前のまま。precache の revision は利用者が決める（docs の例はコミットのハッシュ）。キャッシュ名が変わると既存端末の移行が要る | SW の全面置換 | 依存 +2、build 構成の追加 | 既存の不具合の解消は無い（実測の欠陥なし） | **DEFER**。条件: precache の版管理の欠陥が実測される、またはキャッシュ戦略を増やす時。移行する PR には旧キャッシュ名の掃除と Push の回帰 e2e、iOS 実機の更新確認を同梱 |
| H. アクセシビリティ | 44px の e2e（`touch-targets.spec.ts`）と vitest の aria 検査のみ。axe 系の自動検査は無い | 自作の測定 | [@axe-core/playwright](https://playwright.dev/docs/accessibility-testing) | MPL-2.0（devDependency のみ。配布物に含まれず、ファイル単位の copyleft は本体に及ばぬ） | 活発。**最新 4.14.0 は 2026-10-15 公開（5 日前）**。cooldown を満たすのは 4.13.0（2026-08-11） | peer の playwright-core（1.61.1）に適合 | spec 1 本 | 既知の違反（P3-27 / P3-29）の基準線の管理 | 回帰の自動検出 | **ADOPT を推奨、本 RC では DEFER**。理由: sandbox で e2e が走らず、基準線を取れぬ（走らせていない spec を導入済みと書かぬ）。手順は §12.5 |
| UI プリミティブ | Sheet・Select・Toast・アイコン | **REUSE**: Base UI の Dialog（`ui/sheet.tsx`）、Sonner、Lucide | — | — | — | 独自の dialog / confirm 実装は 0 件（`role="dialog"` / `window.confirm` を走査） | — | — | — | **REUSE**（変更なし） |
| 授乳回数のステッパー | 左右の吸わせ回数を ±1 で数える（片手・授乳中） | 自作 `breast-count-stepper.tsx`（本 RC で 2 部の複製を 1 つに） | Base UI の NumberField（**導入済み** `@base-ui/react` 1.6.0） | MIT | 導入済み | 入力欄（spinbutton）が要り、`readOnly` にするとボタンも止まる。ボタンを押し続けると 400ms 後から 60ms ごとに値が変わり続ける（`number-field/utils/constants`）— 片手で数える場面では押し過ぎになる | 置換なら入力欄の扱いと押し続けの抑止を足す | なし | 無し（むしろ誤操作の危険） | **KEEP**（独立レビューの INFO を受けて比較を記録） |

### 12.2 リポジトリ内の再利用（Step A）で実施した変更

重複の検出は [jscpd](https://github.com/kucherenko/jscpd) 5.3.3（MIT、公開から 3 週間以上）を**依存に足さず計測にだけ**使った（`--min-tokens 50`、テストと生成型を除く `src/`）。短すぎて jscpd が拾わぬ重複（keyset 条件・認可表）は grep で数えた。

| 判定 | 内容 | 以前 | 以後 | 守る不変条件 | テスト |
|---|---|---|---|---|---|
| REUSE | `/baby` の baby_logs クエリ | 初回描画（page）5 本・取り直し（dashboard）5 本・日付ナビ 1 本を別々に記述（「理由は page.tsx 参照」で結合） | `src/lib/supabase/baby-log-queries.ts` の 5 関数 | JST の半開区間、週窓・前日授乳は今日基準、搾乳は `pumped` の denylist + NULL を残す or（CLAUDE.md の enum drift）、signal は client だけ | `baby-log-queries.test.ts` 7 件（5 本とも順序つきの全列で照合。allowlist への書き換え・最終授乳の `log_type` の削除で赤）。既存の resync・日跨ぎ・datenav のテストが同じ呼び出し順で緑 |
| REUSE | baby_logs の keyset 条件 | PDF・JSON（昇順）・検索（降順）に 3 部 | `src/lib/domain/baby-log-keyset.ts`（向きを引数に） | 値を二重引用符で囲む、logged_at を Date に通さぬ、id で同時刻を全順序に | `baby-log-keyset.test.ts` 6 件（昇順・降順の対、演算子の入れ替え）。route の偽 PostgREST が条件を意味で解釈するページング試験が緑 |
| REUSE | 認可の拒否理由 → HTTP status | 3 本の route が同じ表を別々に保持 | `src/lib/auth/auth-denial-status.ts`。`getAuthContext` の理由の union も同じ正本 | 401 はログインし直せば直る時だけ（lookup-failed は 503） | `auth-denial-status.test.ts` 4 件（表と、3 route が自前の表を持たぬこと） |
| REUSE | 授乳回数のステッパー・上限 20・丸め | タイマーと編集シートに複製 2 部（「両方を揃えて直すこと」の注記で結合）、上限 20 は UI 2 部とサーバのリテラル | `src/components/baby/breast-count-stepper.tsx`、`feeding.ts` の `BREAST_COUNT_MAX` / `clampBreastCount` | DB CHECK `chk_breast_counts_required`（0..20）のミラー。タイマーの丸めは救済（削らぬ） | 既存のタイマー・編集シートのテスト（aria 名と境界の disabled）が緑、`feeding.test.ts` に 8 件 |
| REUSE | 既存定数の未使用 | サーバの左右秒の検証と編集シートがリテラル 10800 | 既存の `FEEDING_DURATION_SEC_MAX` | DB CHECK の上限 | 既存 |
| REUSE | timestamptz の表記検査 | 日記の版と検索 cursor に別々の正規表現 | `src/lib/domain/timestamptz-text.ts`（予定の版にも使う） | Date に通さぬ（マイクロ秒を保つ）、PostgREST の論理木を壊す文字を通さぬ | `timestamptz-text.test.ts` 13 件 |
| REPLACE（削除） | `src/lib/utils/date.ts` | 呼び出し元 0 件のローカル TZ 依存の `addDays` / `formatDateKey` | 削除 | CLAUDE.md の UTC / TZ の罠を再び使わせぬ | tsc・全テスト |
| REUSE | JST の日境界 | `${ymd}T00:00:00+09:00` の手組み（触った file の分） | `date-jst.ts` の `jstDayStartIso` | +09:00 を明示（UTC の 0:00 で日を切らぬ） | `date-jst.test.ts` 1 件 |

**計測（jscpd、本体コードのみ）**:

| 指標 | 変更前 | 変更後 |
|---|---|---|
| 重複箇所 | 26 | 20 |
| 重複行 | 314（1.08%） | 230（0.79%） |
| 新規依存 | — | 0 |

残る重複のうち、本 RC で触らなかったもの（いずれも DEFER）: cron 2 本の secret 検証（25 行。セキュリティ境界ゆえ e2e `cron-routes-auth.spec.ts` と同じ PR で寄せる）、記録 5 種の入口検証の型（`baby/actions.ts`）、招待と `/setup` の Action の前置き、日記と検索のページ見出し（2 か所。3 か所目が出たら共通化）。

### 12.3 Priority 0 の監査と処置

| 項目 | 監査の結果 | 処置 |
|---|---|---|
| 予定の競合上書き | 予定の更新は版を照合せず後勝ち（`updateCalendarEvent`）。家族が先に直した時刻を古い画面から無言で巻き戻す | **実装**: 日記（P1-06）と同じ楽観的排他を REUSE。`calendar_events.updated_at` と既存 trigger を版にする（migration 不要）。0 行なら読み直し、中身が同じなら成功（応答を失った再試行）、違えば衝突、無ければ削除済み、同期予定は編集不可。版を送らぬ古いバンドルは上書きへ倒さぬ。作成の応答でも版を返す（作成直後の打ち直しを古い画面扱いにせぬ）。画面は**自分の保存で進めた版だけ**を辿って送る（応答待ちに開き直したシート・作成の応答前に開いた行が偽の衝突を起こさぬ。手元の最新行の版を読むと家族の変更を上書きできてしまうゆえ読まぬ）。テスト: actions 9 件（更新 8・作成 1）・画面 7 件・純関数 10 件、mutation 8 種（版の条件・中身の比較・衝突時の取り直し・版の前進・読み直しの世帯条件・自分の保存の辿り・最新版を読む素朴な実装・旧月の取り直し）をそれぞれ入れると赤 |
| 日記の競合上書き | P1-06 で処置済み（版の正規表現だけ共通化） | 変更なし |
| 育児ログの編集の lost update（P2-07） | 編集シートが未変更の項目も送り、`updateLog` に版の条件が無い | 当初 **DEFER** → 同日の final release hardening で**実装済み**（§13。既存の `updated_at` と trigger を版にした 1 本の条件付き UPDATE。差分送信へは変えず、衝突の後は上書きを置かず最新で編集し直させる） |
| 保存結果不明時の二重記録 | 記録 5 種は冪等 id を主キーに INSERT（P2-08）。中身が同じ時だけ再試行を受理 | 変更なし |
| 2 分の冪等期限を過ぎた再試行 | 期限を過ぎた再タップは新しい記録になる。重複は目に見え、取り消し・削除できる（消失ではない）。期限の起点は最初のタップで、応答が 2 分近く宙吊りになった後の再タップは別 id になりうる | **KEEP**（期限の設計は維持）。起点を失敗時刻へ移すかは **DEFER**。条件: Server Action の reject までの時間が 2 分に近い実測 |
| 予定作成の再試行 | 応答を失った作成を押し直すと 2 件になりうる（目に見え、削除できる） | **DEFER**（記録の P2-08 と同じ形で冪等 id を足せる。予定は頻度が低い） |
| 世帯の混在・RLS・app_operators | 本監査の変更は全クエリで `household_id` の明示と RLS の二重を保つ（読み直しも世帯で絞る）。FOR ALL の追加・SECURITY DEFINER の変更なし | app_operators は人間の判断のまま（§10.0.2） |
| PDF・JSON の欠落 | keyset と切り詰めの明示は維持（条件文字列は共通部品へ移しただけ） | 変更なし |
| JST の日境界 | 手組みを `jstDayStartIso` に寄せた | 上表 |
| PWA 更新・キャッシュ・Push | 実測の欠陥なし（G を参照） | 変更なし |

### 12.4 独自実装を残した理由（要約）

- **授乳の開始時刻・左右秒の等式・回数の CHECK** は irori 固有の契約で、汎用ライブラリに移しても正しくならぬ（CLAUDE.md の既知の罠）。
- **取り直しの合流規則**（取得中に手元で触った行は手元が真値）は画面固有で、TanStack Query を入れても自前で残る。
- **繰り返し予定**は展開済みの行で保存しており、3 種の展開に rrule の利益が無い（更新も 2023 年で止まっておる）。
- **SW** は Push・購読更新・利用者単位の purge という Serwist の外の責務が大半で、既存端末の更新互換を証明できぬ。
- **グラフ**は小さく、時間比例の写像は 3 行。依存を足すと bundle と保守が増える。

### 12.5 未実行と人間の手順（本節の分）

- e2e・pgTAP・Turbopack の build・実機・1〜2 文字検索の実行計画は未実行（§11.1 と同じ制約）。
- 確認済み（本 session、読み取りのみ）: 新規依存 0 は `git diff --stat HEAD -- package.json pnpm-lock.yaml` が空であることで確認。予定の版ガードと既存 e2e の互換は grep で確認: `calendar.spec.ts` の編集は「作成 → reload（SSR が `CALENDAR_EVENT_COLUMNS` で版つきの行を渡す）→ 1 回だけ更新」で、(a) DB を直接書き換えてから UI で保存する・(b) 同じ予定を続けて 2 回保存する・(c) 作成直後に reload せず編集する、の型は該当なし。UI の予定の読み出しは全て `CALENDAR_EVENT_COLUMNS` を使う。
- axe の導入（推奨。cooldown を満たす版）:

```bash
pnpm add -D @axe-core/playwright@4.13.0
# e2e/a11y.spec.ts を足し、/baby・/calendar・/settings・/baby/search を WCAG 2.x A/AA で走査
# 初回は基準線を取り、既知の違反（P3-27 / P3-29）は ID を名指しで台帳に紐づける（無言で rule を外さぬ）
pnpm exec playwright test e2e/a11y.spec.ts
```

- 予定の版ガードの実ブラウザ確認: 2 端末で同じ予定を開き、片方で時刻を変えて保存した後、もう片方で件名を変えて保存すると「先に更新されていました」が出て、家族の時刻が残ること。1 端末で同じ予定を続けて 2 回直しても衝突が出ぬこと。

### 12.6 独立レビュー（code-reviewer、読み取り専用・2026-10-20）と処置

指示書 §7 の 8 問と §1 の原則を渡し、本節の変更だけをレビューさせた（test・build は走らせておらぬ）。P1 は無し。

| 重大度 | 指摘 | 処置 | テスト |
|---|---|---|---|
| P2 | 保存の応答待ちに同じ予定を開き直すと、シートが保存前の版を握り、次の保存が自分の保存と衝突して 2 回目の編集が捨てられる（版ガードが生んだ退行）。作成の応答前に開いた行は一時 id のまま送られ、失敗時に幽霊行が残る | 自分の保存で進めた `${id}@${版}` → 進んだ先の対応を持ち、送る直前に辿る（家族の更新は辿らぬ）。作成も一時 id → 確定 id と版を記録。復元も辿った後の行で行う | 画面 4 件（開き直し・家族の V2 を取り直しても V1 を送る・作成直後・月）。辿りの無効化と「最新版を読む」素朴な実装の両 mutation で赤 |
| P3 | 「読み直しも世帯で絞る」のテストが UPDATE と共有の記録で素通りする | 順序つきの全列で照合 | 読み直しの世帯条件を消す mutation で赤 |
| P3 | クエリ部品のテストが `household_id` と授乳の `log_type` を縛らぬ | 5 本とも順序つきの全列で照合 | 最終授乳の `log_type` を消す mutation で赤 |
| P3 | 衝突・作成・同期の後の取り直しが、保存した時点の月を読む（待つ間に月を送ると新しい月を旧月で上書き） | `refetchCurrent`（ref の最新の月）へ 3 か所とも置換 | 旧月へ戻す mutation で赤 |
| INFO | Base UI NumberField との比較が未記録 | §12.1 に KEEP の行を追加（押し続けの自動増減と入力欄の要否） | — |
| INFO | 編集の楽観行が `series_id` を落とし、取り直すまで「すべて削除」が消える（以前から） | 編集は元の行の `series_id` を引き継ぐ | 既存 |
| INFO | ステッパーの説明は関数型の更新を勧めるが、タイマーは描画時の値で足す | 1 クリックずつ確定するため実害なし。変更せず | — |

レビュー役が「要確認」とした §12.1 の版・ライセンス・公開日は、本 session の `npm view`（2026-10-20）で取得した値じゃ。

## 13. P2-07 育児ログの編集の競合上書き（2026-10-20・final release hardening）

### 13.1 既存の仕組みの確認（REUSE。新規依存 0・新しい競合制御の枠組み 0）

- 版: `baby_logs.updated_at`（`NOT NULL DEFAULT now()`）と `trg_baby_logs_updated_at`（BEFORE UPDATE で `now()`）は初版の migration（20260410000001）から在る。**migration 不要**。
- 読み出し: `BABY_LOG_COLUMNS` は既に `updated_at` を含む（SSR・取り直し・Realtime・更新の応答の全経路）。
- 書き込み: `baby_logs` への `.update(` は `updateLog` の 1 本だけ（`from("baby_logs")` の grep）。
- 共有した部品: 版の形の検査 `isTimestamptzText`、「DB の行が今回送った内容か」の比較 `sameRecordedContent`（作成の冪等 id で使っていたものの型を広げて共有）、文言 `STALE_SCREEN_SAVE_ERROR`（日記・予定・ログの 3 箇所の同文を中立 module の 1 定数へ）、衝突の通知の枠（日記の衝突と同じ部品・配色）、要約 `getLogSummary`。

### 13.2 修正前後の挙動

| | 修正前 | 修正後 |
|---|---|---|
| 送る版 | 送らぬ | 編集を開いた時点の `updated_at` を `updateLog` の第 3 引数で送る（表記のまま。開いた時点で固定） |
| UPDATE の条件 | id・世帯 | id・世帯・版を条件にした 1 本の UPDATE（先に版を読んでから無条件に書く形ではない） |
| 0 行 | 「ログの更新に失敗しました」 | 読み直す。読めぬ → 「確かめられませんでした」（衝突と断定せぬ）／無い → 「削除されていました」（別世帯と削除を区別せず存在を漏らさぬ）／送った内容そのもの → 冪等の成功（応答だけ失われた再試行）／違う → 衝突と最新の行 |
| 古い画面（B）の保存 | A の変更を無言で上書き | 入力を残し、保存と削除を止め、先に保存された内容を見せ、背後のタイムラインを最新へ揃える。「最新の内容で編集し直す」で最新の行と版から開き直す |
| 他端末で削除済み | 失敗のトースト | 行を画面から外し、入力を残し、保存を止める |
| 作成直後の行 | 楽観行は版を持たぬ（版ガードを入れると保存できなくなるところ） | 作成の応答が版（`updatedAt`）を返し、楽観行が持つ（記録 5 種・クイック 2 種・タイマー） |
| 版の欠けた行 | — | 「画面が古い」で止める（無条件の上書きにせぬ。行の表示は止めぬ — 出さねば再タップの二重記録を招く） |
| 版を送らぬ古いバンドル | — | 「画面が古い」で止める（日記・予定と同じ） |

「上書きして保存」は置かぬ。このシートは全項目を開いた時点の値から送るため、上書きすると家族が直した項目（例: 量）まで無言で巻き戻る。授乳の開始時刻・回数と左右秒の CHECK・うんちの量の対の送信は従来のまま（書く列は 1 回だけ組み、UPDATE と内容一致の比較で同じものを使う）。

### 13.3 テスト（修正前 RED → 修正後 GREEN）

- actions: 新しい 11 件が修正前のコードで赤（`vitest run …/baby/__tests__/actions.test.ts` → 11 failed / 106 passed）、修正後は 117 / 117。既存の 106 件は fake を「経路ごとに `.eq()` を記録する型」へ作り直した後も修正前のコードで緑 = assert を弱めておらぬ。
- 画面: dashboard 6 件（対照の単独編集・衝突・最新で編集し直す・削除の確認を開いたままの衝突・削除済み・確かめられぬ失敗）、シート 1 件（版の欠けた行）、楽観行 2 件。既存の編集 test 16 件の assert に「開いた時点の版を第 3 引数で送る」を足した（強化）。
- mutation 14 種をそれぞれ入れると赤: 版の条件を外す（`updateLog` の 1 箇所だけ）・0 行を成功・内容一致を常に真・常に偽・版の形の検査を外す・insert で版を取らぬ・衝突の後も保存できる・背後を揃えぬ・衝突で閉じる・開き直しの結線を外す・版の欠けた行を止めぬ・衝突のトーストを出さぬ・削除の確認を閉じぬ（+ 日記と共有の行を巻き込む広い版）。いずれも元の bytes へ戻し `cmp` で一致を確認。
- pgTAP `supabase/tests/baby_logs_version_guard.sql`（15 件・**本 session では未実行**）: A の保存 1 行・trigger の前進・B の古い版 0 行・A の内容が残る・JSON の版の往復・B の再編集 1 行と A の変更の維持・他世帯と未承認は正しい版でも 0 行・削除 1 行・削除済みは 0 行。
- e2e `e2e/baby-edit-conflict.spec.ts`（**本 session では未実行**）: A と同じ世帯の家族 B の 2 context。B の古い保存が衝突し、入力が残り、DB は A のまま、編集し直しで A の変更を残してメモを足せる。

### 13.4 残すもの（DEFER と理由）

- `deleteLog`・Undo は版を見ぬ。古い画面からの削除は家族の新しい編集ごと消す。衝突の後は画面の削除を止めた。Undo は作成直後の数秒の取り消しで、id しか持たぬ。削除にも版を求めるなら、楽観行が作成の版を持つ本節の変更を土台に別 PR。
- 同じ瞬間の 2 つの保存の原子性は PostgreSQL の READ COMMITTED（行ロックの後に WHERE を最新の行で評価し直す）に拠る。1 本のトランザクションの pgTAP では再現できぬ。
- 編集は差分送信にしておらぬ（衝突の後に最新で編集し直させることで、全項目送信のまま lost update を塞いだ）。
- 版ガードはアプリの層（`updateLog`）だけにある。RLS は版を見ぬゆえ、Server Action を通らぬ書込（PostgREST を直に叩く別のクライアント — 例えば廃止済みの Flutter 版を戻す場合）は守られぬ。本 RC の書込は `updateLog` の 1 本だけ（grep で確認）。
- タイマーの保存が冪等の再試行（`replayed`）だった時も楽観行を出すが、その行は版を持たぬ（`updated_at: null`）。その行の編集は「画面が古い」で止まり、取り直しで DB の行に置き換わると直る（失うものは無い）。既存行の版だけを返して付けるのは誤り — 楽観行に無い列（家族が足したメモ等）を巻き戻す編集を許すゆえ、直すなら既存行そのものを返して出すこと。
- 保存の応答待ちにシートを手で閉じ、応答が着く前に同じ記録を開き直すと、自分の 1 回目の保存と衝突して見える（入力は残り、最新で編集し直せる。失うものは無い）。予定の画面が持つ「自分の保存で進めた版を辿る」仕組みは、シートが成功まで開いたままのこの画面では頻度が低いゆえ入れておらぬ。

### 13.5 人間の手順（本節の分）

```bash
W=/Users/suzukishouya/dev/personal/irori/.claude/worktrees/prod-hardening-2026-10
cd "$W" && supabase start && supabase test db supabase/tests/baby_logs_version_guard.sql
cd "$W" && pnpm e2e:env && pnpm e2e:build && pnpm exec playwright test e2e/baby-edit-conflict.spec.ts
```

実機の smoke: 2 台で同じ記録の編集を開き、片方で量を変えて保存した後、もう片方でメモを変えて保存すると「別の端末で先に更新されていました」が出て入力が残ること。「最新の内容で編集し直す」で量が家族の値になり、メモを足して保存できること。1 台で同じ記録を続けて 2 回直しても衝突が出ぬこと。

### 13.6 独立レビュー（code-reviewer・読み取り専用・別の文脈・2026-10-20）と処置

本節の差分だけを渡し、指示書 §8 の 6 点と、未実行の pgTAP・e2e の正しさを読ませた。製品の lost update は塞がれておる、という判定。

| 重大度 | 指摘 | 処置 | 確認 |
|---|---|---|---|
| P1（テストの欠陥） | e2e の B の context は手で作ったゆえ初回ツアーの既読フラグが入らず、ツアーの backdrop が B の操作を毎回遮る | B の context にも同じ init script を入れた。A 側にも準備完了の待ちを足した | 読みで確認（e2e は未実行） |
| P2（UX） | 衝突の通知はスクロール領域の先頭にあり、下の欄まで送って押すと理由が見えぬ | 衝突でも `toast.error` を出す | dashboard test に assert、外すと赤 |
| P3 | 削除の確認を開いたまま保存して衝突すると、確認の「削除する」が押せたまま（版を見ぬ削除で家族の編集を消す） | 衝突で確認を閉じ、確認の「削除する」も衝突の後は無効 | dashboard test 1 件、閉じる処理を外すと赤 |
| P3 | pgTAP の DELETE が assert されず、0 行なら後の 2 件が名前違いの赤になる | DELETE を CTE で 1 行と固定し plan を 15 へ | 読みで確認（pgTAP は未実行） |
| INFO | タイマーの冪等の再試行でも版の無い楽観行が出る | 安全側（「画面が古い」で止まる）。§13.4 に記録し、直し方の誤りも明記 | — |
| INFO | 版ガードはアプリの層だけ | §13.4 と CLAUDE.md に明記 | — |
| INFO | 古いバンドルは Server Action の id が変わり「見つからぬ」で落ちうる | いずれも fail-loud で、以前より悪くはならぬ。変更なし | — |

### 13.7 Turbopack の build が sandbox で止まる理由の切り分け（環境の問題と分類）

- 観測 1: `pnpm build`（Turbopack）は「Creating an optimized production build」で止まる（font の 2 ホストを許しても同じ。2026-10-20 に 2 回目）。止まる直前に `.next/build/chunks/pool_entry-[turbopack-node]_transforms_postcss_ts_*.js` が出来ておる（PostCSS = Tailwind v4 を走らせる Node の worker pool の入口）。
- 観測 2: その入口の `createIpc(port)` は `net.createConnection({ port, host: "127.0.0.1" })` で親へ繋ぐ（port は `process.argv[2]`）。親が 127.0.0.1 で待ち受ける形じゃ。
- 観測 3: 同じ形の最小 script（127.0.0.1 の空きポートで listen → 接続）は、この sandbox で `listen EPERM: operation not permitted 127.0.0.1`。
- 対照: `next build --webpack`（PostCSS を同じ process で走らせ、静的生成は worker thread）は同じ最終ソースで完走し（exit 0・静的生成 23/23）、その log で `check-proxy-effective.py --strict` 違反 0。
- 分類: **環境の問題**（sandbox の `allowLocalBinding` が無効）。アプリの問題を示す観測は無い。ただし Turbopack の build が通ることは**未証明**のまま — webpack の完走で代えぬ。通常のターミナル（または `sandbox.network.allowLocalBinding: true`）で `pnpm -C "$W" build` を走らせて確かめること。同じ制約で dev server と `next start` も起動できぬゆえ、irori 本体の画面確認も未実施。

## 14. PR #235 敵対レビューの処置と再開監査（2026-10-21 実装・2026-10-24 監査）

PR #235（HEAD `2e24c41`）に対する敵対レビューが挙げた 3 件 — **P1** 削除と「取り消す」が版を見ずに消す（家族が直した記録を古い画面から編集ごと消す）、**P2** `signOut()` の `{ error }` を読まず redirect し、失敗したログアウトで鍵と計測を消す、**P2** 共用端末の SW キャッシュ分離がクライアント側の持ち主タグに依っており、破棄を経ずにセッションが終わった後に次の利用者の着地 HTML が前の利用者の名で保存される — を 2026-10-21 に直し、独立レビュー r1〜r3 の指摘を畳んだ。本節は 2026-10-24 の再開監査（所在の確認・再検証・独立レビュー r4・本番適用計画）の記録じゃ。

### 14.1 現在地（2026-10-24・確認済み）

- worktree `.claude/worktrees/prod-hardening-2026-10`、branch `feature/prod-hardening-2026-10`、HEAD `2e24c41` = origin の PR head。main `b50c7ea`。未 commit の差分は tracked 29 file + untracked 2 file（`+1975 / −185`）。2026-10-21 の 29 file は欠けも取りこぼしも無い（前 session の marker `git_head` も一致）。
- 本節と `docs/runbooks/approvals.md` §2.2 / §2.5 の追記、r4 処置の 3 file（`sw-messages.ts`・`settings-content.tsx`・`pending-content.tsx`）と test 5 file が 2026-10-24 の追加分。

### 14.2 修正の要約

| 件 | 直し | 守る test |
|---|---|---|
| P1 削除競合・Undo | `deleteLog(logId, expectedUpdatedAt)` が `(id, household_id, updated_at)` の 1 本の条件付き DELETE。0 行は読み直して `alreadyDeleted`（行が無い）/ `conflict.current`（版が進んだ・行は画面から外さず最新へ揃える）/ どちらでもない（読み直し失敗）に分ける。版を送らぬ呼び出しは `STALE_SCREEN_SAVE_ERROR` で止める（無条件の削除へ倒さぬ）。「取り消す」は作成の応答が返した `updatedAt` でだけ出す（ローカル時計から版を作らぬ） | `actions.test.ts`、`baby-quick-actions.test.tsx`、`baby-log-form-sheet-optimistic.test.tsx`、pgTAP `baby_logs_version_guard.sql`（plan 15 → 27。(6)〜(9) が削除・取り消しの版ガードと対照）、e2e `baby-edit-conflict.spec.ts`（削除競合・取り消し競合の 2 本。DB 断面を service role で assert） |
| P2 ログアウト失敗 | `signOut()`（settings / pending-approval）は成功でだけ `redirect("/login")`、失敗は `{ error }` を返す（通信の例外も同じ結果へ。`unstable_rethrow` は catch の先頭・redirect は try の外）。クライアントは解決して返った値を失敗として扱い、鍵（LAST_USER_ID）・端末の計測・持ち主の記録に触れずボタンを戻す。通信断の reject だけ持ち主を今の利用者へ戻す（`{ error }` では戻さぬ: auth-js 2.110.8 の `_signOut` は 401/403/404 以外の失敗でも `removeCurrentSession()` を**先に**呼んでから `{ error }` を返す — 実物で確認） | `settings/actions.test.ts`、`pending-approval/actions.test.ts`、`settings-content-sign-out.test.tsx`、`pending-content.test.tsx` |
| P2 共用端末 SW 分離 | 応答の主はサーバが決める: `src/proxy.ts` が承認ゲートを通った素通し応答にだけ `x-irori-cache-owner: <検証済み user id>` を載せる。SW は `irori-meta` の持ち主の記録と主が一致する HTML / RSC だけを保存（`putOwned`）し、一致する項目だけを配る（`matchOwned`。違えば消す）。/login に着いた応答・記録と違う主の応答で記録を消す。破棄は記録を先に消してから行い、両経路の決着を待つ。`CacheUserGuard` は破棄の成否に従属させず持ち主を書く | `proxy.test.ts`、`sw-logic.test.ts`、`sw-messages.test.ts`、`cache-user-guard.test.tsx`、`sw-shared-device.test.tsx`（実物の `sw.js` を vm で動かし、Cache API の 2 つの意味論で 15 場面を撃つ） |

### 14.3 独立レビュー r4（code-reviewer・読み取り専用・別の文脈・2026-10-24）と処置

依頼した 3 件とも P1 / P2 の指摘は無し。P3 が 2 件。どちらも直し、mutation で検知力を確かめた。

| 重大度 | 指摘 | 処置 | mutation（外すと赤） |
|---|---|---|---|
| P3 | `putOwned` の保存側ガード（主 ≠ 記録・主の無い応答）を固定する test が無い。既存の assert はオフライン照会の**後**に見ており、照会の `matchOwned` が主の違う項目を消すゆえ「保存されなんだ」と「配られずに消えた」の区別がつかぬ。`matchOwned` の `!owner` 早期 return（記録の無い端末で、主の無い旧版の項目を `null !== null` で配らぬ）も未固定 | 遅延応答の test は保存の有無を照会の**前**に見る。別の利用者の応答の test に「B の着地は保存されておらぬ」を足す。主の無い応答の test を「記録なし → 保存せぬ」「記録あり → 保存せず・A の記録も消さぬ」の対にする。主を持たぬ旧版の項目を seed し、記録の有無にかかわらず配られぬ test を足す | M1 `recorded !== owner` を外す → 遅延応答 ×2・別の利用者の応答 ×2 が赤。M2 `putOwned` の `!owner` を外す → 主の無い応答 ×2 が赤（後段の判定が保存は止めるが A の記録を誤って消す — その副作用で赤）。M3 `matchOwned` の `!owner` を外す → 旧版の項目 ×2 が赤 |
| P3 | signOut の往復の間に別タブが (main) を開き直すと、その guard は鍵がまだ A ゆえ破棄せず `setCacheOwner(A)` を**書き戻す**。成功の redirect は Server Action の応答に乗る SPA 遷移で SW の nav-passthrough（/login で記録を消す経路）を通らぬゆえ、記録 A が残る。破棄が部分失敗した端末では A の項目も残り、未ログインの者がオフラインで開くと配られる（ログイン中の B には出ぬ — B の最初の応答で記録が消える） | `clearCacheOwner()` を `sw-messages.ts` に足し、settings-content / pending-content の成功分岐（`unstable_rethrow` が投げ返した直後）で待たずに呼ぶ。cookie はもう消えておるゆえ新しい利用者の記録は消さぬ | M0 呼び出しを外す → `sw-shared-device` の新 test ×2 と `settings-content-sign-out` の成功 test が赤 |

r4 の未検証・低確度（記録のみ・変更なし）: `putOwned` の記録削除と guard の `setCacheOwner(B)` の TOCTOU は B の記録を消しうるが fail-closed（次のハードロードまで B の保存が止まるだけ）。`deleteLog` の読み直しの版比較は文字列で、Realtime 形式の版だと取り違えうるが、現 RLS（SELECT と DELETE が同じ述語）では到達不能。ログアウト前に push の購読を解除するゆえ、`{ error }` が返ってセッションがまだ生きておる場合はその端末の通知が止まる（既存の挙動・差分の外）。

### 14.4 検証（2026-10-24・本 session で実走）

| 層 | 結果 |
|---|---|
| vitest（worktree 全体） | r4 処置前 157 files / **2398 passed**（基準と同数）→ 処置後 157 files / **2402 passed**（+4 = 新 test 2 本 × 2 意味論） |
| `tsc --noEmit` | 0（e2e も `**/*.ts` で対象） |
| eslint | 0 errors / 0 warnings |
| `check-transition-reject-guard.py --strict` / `check-transition-all.py --strict` | 0 / 0（19 / 345 箇所） |
| `git diff --check` | 0 |
| pgTAP `baby_logs_version_guard.sql` | **未実行**（Docker 無し）。`plan(27)` と assert 数 27 の一致は読みで確認。CI `e2e.yml` の `supabase test db` で実走 |
| Playwright `baby-edit-conflict.spec.ts` | **未実行**。CI `e2e.yml` で実走 |
| `pnpm build`（Turbopack） | **未実行**（§13.7 の環境の制約）。CI `ci.yml` で実走 |
| `check-supabase-error-destructure.py` / `check-proxy-effective.py` | **未実行**（guard の script 名拒否・build log が要る）。CI で実走 |

### 14.5 セキュリティ migration 3 本の最終監査（本番は 37 本適用済み・この 3 本だけ未適用 — ユーザー提供）

| migration | 依存（全て適用済み 37 本の内） | 変えるもの | member（妻）への影響 |
|---|---|---|---|
| `20261002100001` | `profiles.is_approved`（20260408000002）、`households`、`get_invitation_by_token` / `accept_invitation`（20260407000001） | `create_household` の頭に承認検査（`FOR UPDATE`）。`households_insert` ポリシー削除 + anon / authenticated から INSERT / DELETE / TRUNCATE を剥がす。3 関数から anon の EXECUTE を剥がす | **無し**。既に世帯に属するゆえ `create_household` は呼ばぬ。アプリは `households` を SELECT / UPDATE しかせぬ（`baby-report` / `baby-export` / settings / baby page / settings actions の UPDATE を grep で確認。e2e の INSERT / DELETE は service role）。招待 2 関数は `/invite` が未認証を `/login` へ送った後にしか呼ばれぬ（`invite/[token]/page.tsx:50-53`） |
| `20261002100002` | `profiles`、`auth.users` | `app_operators` 新設（RLS 有効・ポリシー 0・anon / authenticated 権限 0）。`is_app_operator()` 新設。`get_pending_approvals` / `approve_user` の門を owner → 運用者へ（戻り型・引数は同じゆえ `CREATE OR REPLACE` が通る） | **無し**。member は以前から承認カードを見ず承認もできぬ。`is_app_operator()` は false を返すだけ。**owner（本人）は 2.3 の登録まで承認できぬ**（意図した fail-closed） |
| `20261002100003` | `push_subscriptions`（20260808100001）。関数の引数名・型・戻りは同じ | `upsert_push_subscription` の頭に endpoint の正規表現検査（22023） | **実質無し**。同じ 3 ホストの allowlist は 2026-08 の購読基盤（#208）から Server Action に在り、アプリ経由で登録された行は全て適合する。PR 側の TS 検査は小文字・port 無し・パス必須まで DB と揃えた（厳しくなる向きのみ）。既存行は runbook 2.1 (c) の件数で確かめる（0 が期待値。0 でなければ送信直前の再検査が据え置くだけで、CHECK は足さぬゆえ落ちぬ） |

RLS・CHECK・GRANT はいずれも締める向きのみ。`baby_logs` / `baby_diaries` / `calendar_events` / `invitations` / `profiles` / `push_subscriptions` / `event_reminders` / `notification_*` / `google_*` のポリシー・表権限・列権限には 1 文も触れぬ（3 file の DDL / GRANT 文を全列挙して確認）。これを**測る**手順（before / after の catalog snapshot の diff）と期待する差分の表を runbook §2.5 に置いた。pgTAP は `create_household_approval.sql`（15）、`approval_functions.sql`（30）、`push_endpoint_allowlist.sql`（36）が 3 本の契約を固定する（CI で実走）。

### 14.6 本番適用の計画（人間が実行。順序と停止条件は `docs/runbooks/approvals.md` §2 が正本）

1. **before snapshot**（runbook §2.5 の query）と §2.1 (a)〜(e) の読み取り監査。今回のインスタンスの期待値（ユーザー提供の事実から）: (a) 世帯 1 件・owner は本人・`member_count` 2・`owner_is_approved_now` true、(b)(d)(e) 0 行、(c) 0。
2. `supabase migration list --linked` → Local だけの版が 3 本。`supabase db push --dry-run` → 同じ 3 本。`select to_regclass('public.app_operators')` → NULL。どれか一つでも外れたら止める。`--include-all` は付けぬ。
3. `supabase db push`（history は CLI が書く。SQL Editor へ貼らぬ）。error が出たら再送せず、history の確認 query でどこまで入ったかを見る。
4. a1〜a15（全て false / 0）、c1〜c2（true）、history 3 行、**after snapshot** → before との diff が §2.5 の期待する行だけ。
5. §2.3 運用者の登録（本人 1 名）。`select user_id from app_operators` → 1 行。
6. **ここで初めて** push / merge / deploy（merge = deploy の設定なら merge も 2.3 の後）。deploy 後に妻の端末で §2.5 の 5 点 smoke。アプリは一度閉じて開き直す（古いバンドルは fail-closed で止まる）。
7. 戻し: migration は §3（新しい migration で、関数定義だけを写す）。運用者は §2.3 の「戻す時」。

### 14.7 残存リスク

- CI 未実行（build・pgTAP・e2e）。ローカルの緑は CI の緑ではない。
- `/setup`・`/login` の CacheUserGuard は未実装のまま（P2-24。承認済み・世帯なしの利用者が共用端末でオフライン閲覧すると前の世帯のスナップショットが見えうる。今回の運用では該当者 0）。
- deploy 直後の古い PWA バンドル: Server Action の id 変更と版の必須化で、保存・削除が「見つからぬ」/「画面が古い」で止まる（無言の破壊は無い）。開き直せば直る。
- 14.3 の未検証 3 件（いずれも fail-closed または到達不能）。
