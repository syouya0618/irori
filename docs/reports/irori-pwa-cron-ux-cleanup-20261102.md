# irori PWA・通知Cron・UX・ローカル整理 実行報告

観測日: 2026-11-02 JST。正本はこのMarkdownじゃ。画像・JSONはすべて合成データまたは秘密を除いたメタデータ。`PASS`は記載した検査範囲内、`FAIL`は再現した未達、`BLOCKED`は環境・権限で判定できず、`NOT_RUN`は未実施を表す。

## 1. 結論

**ローカルの小修正と安全な整理は完了。本番PWA・通知の全面受入は未完了じゃ。** 320px・文字200%での育児画面の横はみ出しと、ダークモードのログアウト文字のコントラスト不足を修正した。公開済みの掛川ニュースと任意AIの説明も更新履歴へ追加した。

- **PASS**: 2ブラウザ×4表示条件×6画面の48条件で、修正後の横はみ出し・axe指摘・画面例外は0。unit 3,658件、lint、型を含むproduction build、strict 4検査が通過した。
- **BLOCKED**: 個人Supabaseの読み取りSQLは権限拒否。本番Cron・HTTP応答・heartbeatの実態は正常とも異常とも断定できぬ。回避して別資格情報を使ってはおらぬ。
- **NOT_RUN**: 実iPhoneのstandalone、OS通知、実Push到達、ソフトキーボード、VoiceOver。macOS WebKitの成功で代用せぬ。
- **PASS**: ローカルブランチ2本、生成キャッシュ1ツリー・32ファイルを削除。削除対象の割当容量は436.09 MiB。worktree削除は0。保護対象を残し、他26作業木のstatus不変を確認した。
- **BLOCKED**: Previewの本番DB・秘密情報からの隔離を確認できていないためpush/Draft PRは未実施。変更はローカルcommitまでじゃ。

次は実iPhoneの読み取り受入とread-only SQLの結果回収、それから隔離を確認した配送へ進む。本番migration・cron変更・試験Push・merge・deployは実施しておらぬ。

## 2. 基準main・公開状態

|対象|判定|今回の証拠|
|---|---|---|
|GitHub main|PASS|公開Git fetchのFETCH_HEAD `521f2fc295cae077ad1ea54947b53455781e7a6a`。URL指定fetchのため、ローカルorigin/mainの更新と同一視しない|
|PR #251|PASS|merged 2026-11-01 14:15:50 UTC、head `cd2d44297252f4b110530383f850a0f4d5c968e3`、squash `54bee950ddb40de57d3e985cbbef2aa670c8729c`|
|PR #252|PASS|merged 2026-11-02 03:34:15 UTC、head `decc816bc9826bdf7b7018ca35a72de3565a5cdf`、squashが上記main|
|mainのCI / E2E / CodeQL|PASS|GitHub workflowのcompleted/successを取得。個々のジョブログ、CodeQL findingの審査完了までは意味しない|
|開いているPR|PASS|#249、#247、#246、#225、#204を確認し保護。close・remote branch削除なし|
|Vercel Production|PASS|専用connectorの直接読み取りでREADY、git SHAがmainと一致。GitHub statusだけでの代替判定ではない|
|本番公開物|PASS|manifest・sw.jsともHTTP 200。2026-11-02 07:21 UTC前後の読み取り。ホスト名・内部URLは掲載しない|
|本番ログイン後の版表示|NOT_RUN|未認証 `/api/version` は307。ログイン後に版を読んだ証拠ではない|
|本番migration 2件|NOT_RUN|ユーザー確認済みとの入力は受領。今回DB履歴を独立確認・再適用していない|
|今回の修正|PASS|専用worktree `/private/tmp/irori-pwa-cron-ux-20261102`、branch `codex/irori-pwa-cron-ux-hygiene-20261102`。実行コードSHA `7c0358352f3115a69c69fdaf37d7054da1b23687`|
|今回のhosted CI / deploy|NOT_RUN|ローカルcommitのみ。mainの成功を今回の変更のhosted実行証拠として流用しない|

PR #251/#252はsquashじゃ。旧headがmainの祖先でないことだけで未統合とは判定しておらぬ。今回はそのworktreeを削除せず、証跡・生成物・作業状況を保全した。

GitHub観測は2026-11-02 15:25 JST。[基準メタデータ](assets/pwa-cron-ux-20261102/github-baseline.json)にSHA・merge時刻・workflow状態を固定した。

## 3. PWA受入表

ローカルはmacOS、Node 24.13.0、Next 16.4.3のproduction webpack build。HTTP fixtureは `127.0.0.1:55438/55439` のみ。実Auth・DB・RSS・家族データへの接続なし。画面マトリクスではSWをblockし、別枠で実SWを検査した。

|項目|判定|実測・限界|
|---|---|---|
|manifest|PASS|本番200。name「うちのログ」、short_name「うちログ」、start_url `/`、display `standalone`。idは明示なし。アイコンSVG、PNG 192/512を宣言。ローカルPNGの実寸も一致|
|manifest identity|NOT_RUN|id省略を確認。既存インストールのOS上の同一性・更新は未確認。根拠なくidを変更していない|
|SW配信|PASS|本番sw.js 200、`no-cache, no-store, must-revalidate`。配信成功と端末での更新完了は別|
|画面・文字拡大|PASS|Chromium/WebKit各24条件。390 light、320 dark＋root font 200%、768 light、1280 dark。育児・睡眠・健診・閲覧共有・ニュース・設定。CSS文字拡大はOS文字サイズの近似|
|授乳・子ども切替|PASS / BLOCKED|搾乳入力を開いて閉じる操作、Chromium子ども切替を確認。WebKitはHTTP loopbackでproduction Secure cookieが保持されず切替4条件はBLOCKED。Secure属性を弱めていない|
|母乳の手動開始・タイマー・直近5量|PASS / NOT_RUN|既存unit suiteは通過。今回の端末上の計測・保存を通した受入はNOT_RUN|
|睡眠開始/停止・健診保存・共有期限/取消|NOT_RUN|画面と入口は表示確認。実Supabaseへの保存・期限到来・取消の通し確認はしていない|
|掛川ニュース|PASS|両ブラウザ・390/1280で地域選択→保存→再読込、年齢フィルタ、原文リンク表示、更新cooldown、通知ON→OFF保存と再読込、他地域へ記事が混ざらぬことを確認。fake HTTPの成功であり、本番RSS/DB/Pushの証拠ではない|
|更新案内・下書き保護|PASS / NOT_RUN|コードで版不一致時の表示、利用者が押す更新、下書き/計測/未確定保存がある時の確認、読めない時の確認を確認。既存unit通過。実端末で旧版→新版への更新はNOT_RUN|
|offline/online|PASS|実際のアプリSWをChromiumで登録・制御待ち→offlineページ再読込→online復帰。合成offline文書だけの検査で、全業務データ復旧ではない|
|保存再送・所有者隔離|PASS|既存の暗号化保存ブラウザ試験をChromium/WebKitで実行。ブラウザ再起動、owner変更、改ざん、旧版互換、欠損鍵で拒否、同時タブ、復帰ownerを検査。実DBでの二重登録防止・RLSの代用ではない|
|古いcache・認証境界|PASS / NOT_RUN|既存SW/ownerテスト通過。別キャッシュを無差別削除せず、認証データを報告へ出していない。本番ログイン移行はNOT_RUN|
|safe-area・キーボード・VoiceOver・片手操作|NOT_RUN|合成画面の幅・DOMラベル・axeは検査。ノッチ、OSキーボード、読み上げ順、実際の片手到達性は実iPhoneで確認が必要|
|実iPhone standalone / Push|NOT_RUN|端末に触れておらぬ。試験Pushも送っていない|

証拠: [修正前JSON](assets/pwa-cron-ux-20261102/before.json)、[修正後JSON](assets/pwa-cron-ux-20261102/after.json)。後者の53行は**48画面＋4件のWebKit切替BLOCKED＋1件のSW検査**であり、53画面成功ではない。JSONに実行SHAとUTC観測時刻を記録した。

## 4. 通知Cronの読み取り診断

|層|判定|今回の根拠と不足|
|---|---|---|
|個人irori SQL読取|BLOCKED|最初の `cron.job` SELECTに `MCP error -32600: You do not have permission to perform this action`。代替資格情報・別プロジェクトへ進んでいない|
|job schedule / active|BLOCKED|実DB値なし。5分起動はソース/runbookの設計契約|
|job_run_details|BLOCKED|直近運用履歴なし。仮にsucceededでもHTTP要求のenqueue成功とPush到達は別|
|HTTP status / heartbeat|BLOCKED|net応答・ran_at/failed_count未取得。200・401・404・405・5xx、停止の判別はできぬ|
|ニュース収集・朝通知|BLOCKED|ソース上は7:45〜8:00収集、8:00〜8:15通知。実行履歴・明朝配信を観測していない|
|HTTP method|PASS|コード/テスト上GET `/api/cron/notify`。POSTは405。運用endpointを試し打ちしていない|
|VAPID・購読ON・Push受理|NOT_RUN|設定値・endpoint・secretを読んでいない。設定画面の合成状態では本番の購読を証明できぬ|
|iPhone受信・タップ遷移|NOT_RUN|本人の通常利用通知の結果待ち|
|Google同期cron|PASS|通知Cronの証拠として扱わず分離した|

原因はまだ断定できぬ。読取結果で401なら認証照合、404/405ならpath/method、5xxなら安全なログとhandler、heartbeat停止ならscheduler/HTTP経路の順に狭める。登録変更・再実行・secret更新はいずれも今回実施しない。

### 所有者用read-only SQL

**個人iroriのSQL Editorだけ**で以下を実行し、5分以上空けて同じ範囲を再観測する。ニュースは通常の朝の時刻帯も確認する。会社プロジェクトは対象外じゃ。`command`、Vault、認証値、Push endpointは選ばぬ。`net._http_response` は他jobも混在しうるため、時刻突合だけで同一要求と断定しない。履歴の保存期限による欠落も障害と即断せぬ。

```sql
BEGIN TRANSACTION READ ONLY;
SELECT jobid, jobname, schedule, active
FROM cron.job
WHERE jobname IN ('notify-deliveries','purge-cron-history')
ORDER BY jobname;

SELECT jobid, status, start_time, end_time
FROM cron.job_run_details
WHERE jobid IN (SELECT jobid FROM cron.job WHERE jobname = 'notify-deliveries')
ORDER BY start_time DESC LIMIT 12;

SELECT status_code, created
FROM net._http_response
ORDER BY created DESC LIMIT 20;

SELECT ran_at, failed_count
FROM public.notification_heartbeat
ORDER BY ran_at DESC LIMIT 2;

SELECT source_key, region_key, last_success_at, last_error_at
FROM public.news_source_runs
ORDER BY region_key, source_key;
COMMIT;
```

## 5. UXスコアカードと主要5課題

主観の点数は付けず、観測できる合格条件で評価した。axe 0だけでWCAG 2.2 AA準拠やVoiceOver受入完了とは言わぬ。

今回の検査範囲でP1は再現していない。未検証領域にP1が存在しないと保証するものではない。

|軸|判定|結果|
|---|---|---|
|狭幅・文字拡大|PASS|48条件でdocument/viewport幅一致。文中の数値列も画面内へ折り返す|
|コントラスト・ラベル|PASS|対象画面のaxe WCAG 2A/AA・2.1AA・2.2AA指摘0。機械検査範囲のみ|
|操作サイズ・誤タップ|NOT_RUN|小targetの候補はJSONに残す。13px checkbox、1px隠しinput、文中リンクを一律FAILとしない。label領域・spacing例外を含む手動評価と片手実測は残る|
|導線・操作数|PASS|今回の折返し修正で操作は増えない。ニュース地域保存は選択→保存の2操作、通知OFFは解除→保存の2操作。設定から各採用機能への入口を確認|
|保存の成功/不明・復旧|PASS / NOT_RUN|合成ニュース保存と暗号化再送試験はPASS。各業務の実DB受入はNOT_RUN|
|通知・更新の理解|PASS|通知OFFでも記事一覧を利用する動作、任意AIの限定された役割を更新履歴に明記|
|低速起動|FAIL|約5秒問題は未解決。固定条件での今回の測定は下記追記。改善を主張するperformanceコードは入れていない|
|本番/実機統合|BLOCKED / NOT_RUN|Cron読取と実端末証跡が必要|

|ID・優先度|再現/原因|最小修正・前後|判定|
|---|---|---|---|
|UX-01 P2|320px、dark、CSS文字200%、育児。日付/集計/ナビのflex縮小不足、体重身長の文字列が折り返せない|wrap・min-width・要約のbasis/anywhereを限定追加。document幅360→320px、40pxのはみ出し→0。両エンジンで確認|PASS 修正済み|
|UX-02 P2|1280px dark、設定のログアウト。赤文字の対比3.73:1で4.5:1未満|dark時の赤文字を明るくし、hover色も調整。両エンジンの該当axe指摘1→0|PASS 修正済み|
|UX-03 P2|公開済みPR #252とアプリ内履歴を照合。掛川/任意AIの個別案内がない|11月2日項目を追加。3公式配信元・手動更新・通知OFF・固定キーワード分類と抽出的要点・設定導線を説明。自由文生成と誤記しない|PASS 修正済み|
|UX-04 P2|低速初回表示が約5秒。操作前に待ちが長い|測定条件を固定して再計測。今回のレイアウト修正を高速化と呼ばない。取得/転送/初期操作準備を分けて次の改善対象を絞る|FAIL 未解決|
|ACCEPT-05 P2|本番Cronと実端末の受入証拠が不足|通知が動くと断定せず、SQLと5〜10分チェックリストを作成。コード欠陥の確定ではなく受入上の残件|BLOCKED / NOT_RUN|

[育児320px修正前](assets/pwa-cron-ux-20261102/baby-320-before.png) → [修正後](assets/pwa-cron-ux-20261102/baby-320-after.png)、[設定390pxと更新履歴](assets/pwa-cron-ux-20261102/settings-390-after.png)、[WebKitニュース390px](assets/pwa-cron-ux-20261102/news-webkit-390.png)。画像は長い全画面PNGゆえ、幅はJSONのgeometryでも確認できる。

初回診断では更新確認ボタンのopacity遷移中を測った一時的なcontrast指摘、WebKitのダイアログ閉鎖アニメーション待ち不足も見つかった。harnessで安定状態を待つよう直しただけの項目を、製品の欠陥修正数に含めていない。修正前buildはNode 26、最終buildは指定のNode 24。ここからbuild速度の前後改善は主張しない。

### 今回の低速条件の測定

**FAIL（速度目標未達）、測定実行自体はPASS。** Node 24・同一production build `7c035835`、Chromium 390px、新規browser context 5回、合成API各要求200ms、CDP latency 150ms・download 128 KiB/s・upload 64 KiB/s、30記録・1児・SW block。外部要求は遮断した。実iPhone時間ではない。

|操作|中央値|範囲（5回）|
|---|---:|---:|
|初回育児の内容準備|5,076ms|5,059〜5,205ms|
|搾乳フォームの記録ボタン準備|5,126ms|5,109〜5,256ms|
|育児→予定|1,651ms|1,623〜1,686ms|
|予定→設定|1,577ms|1,574〜1,623ms|
|設定→育児（同context）|70ms|56〜92ms|
|戻る|47ms|41〜59ms|
|新規contextで設定|4,386ms|4,371〜4,405ms|

初回TTFB中央値820ms、FCP/LCP 1,524ms。最初の描画から内容準備まで約3.55秒残り、初期画面配信だけで全待ち時間を説明できぬ。server fixture要求26件、browser API要求8件。server span中央値5,909msは描画後のprefetch等を含み、直列クリティカルパスでも5.076秒への加算項でもない。したがって「DBだけが遅い」とは断定せぬ。次の限定調査対象は初期JS転送/実行・hydration・ready待ちの時系列じゃ。既存データ取得を根拠なく書き換えていない。

[実測JSON](assets/pwa-cron-ux-20261102/slow-network.json) に各trialと計測定義を保存した。過去の5.083秒と今回は測定環境・buildが完全同一ではないため、7ms改善とは扱わぬ。

## 6. 変更と検証

|対象|変更|
|---|---|
|baby-date-nav / baby-summary-bar / baby-timeline-item|狭幅・文字拡大で日付、集計、記録要約を折り返す|
|bottom-nav|各項目の縮小とアイコン背景の最大幅を制約|
|settings-content|dark時のログアウト文字contrastを改善|
|release-notes / release-history test|実際の公開内容に合わせた11月2日の履歴|
|test-pwa-ux-browser.mjs|隔離HTTP fixture・2ブラウザ画面診断・axe/geometry・限定SW復帰の検査を追加|
|test-news-browser.mjs|WebKit実行と通知OFF保存/再読込の確認を追加|

|検査|判定|結果・範囲|
|---|---|---|
|`pnpm lint`|PASS|最終runtimeでexit 0|
|`pnpm test:run`|PASS|258ファイル、3,658件、22.71秒。2026-11-02 16:40 JST実行。jsdomのnavigation未実装ログあり、テスト失敗なし|
|`pnpm exec next build --webpack`|PASS|合成URL/keyのみ、Node 24。TypeScript検査とproduction build完了|
|proxy / Supabase error / transition reject / transition CSS strict|PASS|最終build・コードで全4検査の違反0|
|PWA/UX browser|PASS / BLOCKED|前述48画面と限定SWはPASS、WebKit切替4件はBLOCKED。診断JSONを評価して判定。全条件を自動exit codeで強制するgateではない|
|news browser Chromium / WebKit|PASS|各390/1280。fake Auth/HTTP、実DB/RSSなし|
|record-request browser Chromium / WebKit|PASS|暗号化保存と所有者隔離・再起動・競合復旧の既存試験|
|実Supabase統合E2E / pgTAP|NOT_RUN|今回schema変更なし。main hosted E2Eの成功とは分ける|
|実iPhone / Push / 本番DB|NOT_RUN / BLOCKED|未実施・権限拒否。成功扱いにしない|

長い実行ログはローカル `/private/tmp/irori-hygiene-*.log` に保持し、[ログのSHA256・時刻](assets/pwa-cron-ux-20261102/local-log-hashes.json)を添付した。図・JSON全体の[artifact manifest](assets/pwa-cron-ux-20261102/manifest.json)も保存した。

再実行するなら環境ファイルのない専用worktreeで、合成Supabase URL `http://127.0.0.1:55439` と合成公開key、app URL `http://127.0.0.1:55438` を指定してbuildする。実credentialを渡さぬ。ブラウザ用2スクリプトと速度計測は同じportを使うため順番に実行する。

```sh
node scripts/test-pwa-ux-browser.mjs /private/tmp/irori-pwa-review
node scripts/test-news-browser.mjs /private/tmp/irori-news-review-chromium
node scripts/test-news-browser.mjs /private/tmp/irori-news-review-webkit --webkit
node scripts/test-record-request-browser.mjs
node scripts/measure-navigation.mjs /private/tmp/irori-speed-review.json --trials=5 --scenario=slow-network
```

## 7. 安全なローカル整理

削除前に全27 worktreeのHEAD・status・ignored・容量、branch一覧、PR状態、削除候補の使用プロセスを記録した。絶対pathを含む削除前manifestはローカル `/private/tmp/irori-hygiene-delete-manifest.json` に残した。公開用には個人homeを `$HOME` に置換し、ファイル名一覧・secret-like情報を省略した[整理証拠JSON](assets/pwa-cron-ux-20261102/cleanup.json)を添付する。

|実行した対象|HEAD / 容量|根拠・前後|判定|
|---|---|---|---|
|local branch `syouya0618/minnow`|`54bee950` / 容量算定外|どのworktreeにも未割当、mainの祖先。`git branch -d` 成功、存在→不存在|PASS 削除|
|local branch `worktree-prod-hardening-2026-10`|`b50c7eaa` / 容量算定外|どのworktreeにも未割当、mainの祖先。`git branch -d` 成功、存在→不存在|PASS 削除|
|`/private/tmp/irori-gap-baseline/.next/cache`|生成cache / 436.09 MiB|前タスク専用baseline、利用プロセス・symlinkなし。32ファイルのpath/sizeをmanifestと再照合して個別削除。存在→不存在|PASS 削除|
|linked worktree|0件|安全条件が揃わぬものを残した|PASS 保全|
|missing worktree metadata|0件|`git worktree prune --dry-run --verbose` は空。prune不要|PASS|

回収量は削除したcacheの`du`割当446,560 KiB（436.09 MiB）、論理457,198,862 bytes（457.20 MB）。システム全体の空き容量差分ではない。他プロセスやAPFSの影響を除いた空き容量増加量までは測っていない。

特にcleanな `$HOME/.codex/worktrees/ec9c/irori` と `irori-feeding-push-20261029/irori`（両HEAD `638f4690`、各16.7 MiB）は、`lsof +D` でcwd利用中のzshを確認したため**保留**した。プロセスを止めて削除条件を作ることはしていない。

### 残した作業木（削除前の容量・HEAD）

全行 **PASS（保全）/ BLOCKED（削除条件未成立）**。容量はMiB、親と子の集計は重複するため合算しない。変更数にはuntrackedを含む。ignoredの内容を安全に不要と断定できぬ作業木を残した。全行の完全HEAD・branch・保護pathのpostflight判定は整理証拠JSONにある。

|path|HEAD|MiB|status件数 / ignored件数|残した理由|
|---|---|---:|---:|---|
|`$HOME/dev/personal/irori`|`b50c7eaa`|24665.5|39611 / 21|親main・未追跡SQL・他Agent成果物|
|`/private/tmp/irori-pwa-cron-ux-20261102`|`521f2fc2`|17.7|0 / 1|今回の作業木（表のstatusは開始時）|
|`$HOME/.codex/worktrees/8236/irori`|`cd2d4429`|1021.2|0 / 7|PR #251 merged、検証/配送証跡を保護|
|`$HOME/.codex/worktrees/ec9c/irori`|`638f4690`|16.7|0 / 0|zshのcwd利用を検出|
|`$HOME/.codex/worktrees/irori-feeding-push-20261029/irori`|`638f4690`|16.7|0 / 0|zshのcwd利用を検出|
|`$HOME/.codex/worktrees/irori-feeding-push-sol-20261029/irori`|`e9687805`|899.9|0 / 5|固有生成物・証跡の要否/所有者判断未確定|
|`$HOME/dev/personal/irori/.claude/worktrees/agent-a-bottle`|`610f92c8`|753.4|0 / 5|固有生成物・証跡の要否/所有者判断未確定|
|`$HOME/dev/personal/irori/.claude/worktrees/agent-a-ui-ux`|`d6ea0471`|1487.5|1 / 8|未コミット/未追跡成果物あり|
|`$HOME/dev/personal/irori/.claude/worktrees/agent-b-baby-ux`|`a779c9cd`|1466.2|1 / 7|未コミット/未追跡成果物あり|
|`$HOME/dev/personal/irori/.claude/worktrees/agent-b-feeding-time`|`cb8bd207`|753.3|1 / 4|未コミット/未追跡成果物あり|
|`$HOME/dev/personal/irori/.claude/worktrees/agent-c-calendar-settings-ux`|`ce46f82c`|1466.4|1 / 7|未コミット/未追跡成果物あり|
|`$HOME/dev/personal/irori/.claude/worktrees/agent-c-feedback`|`a58f47d1`|753.6|0 / 3|固有生成物・証跡の要否/所有者判断未確定|
|`$HOME/dev/personal/irori/.claude/worktrees/fix-manual-breast-start-20261026`|`fa514ddf`|1029.2|100 / 5|未コミット/未追跡成果物あり|
|`$HOME/dev/personal/irori/.claude/worktrees/integration-irori-abc-20261025`|`c18eb2a9`|785.1|88 / 6|未コミット/未追跡成果物あり|
|`$HOME/dev/personal/irori/.claude/worktrees/integration-irori-abc-20261026`|`fa514ddf`|768.5|92 / 5|未コミット/未追跡成果物あり|
|`$HOME/dev/personal/irori/.claude/worktrees/integration-irori-abc-20261026-release`|`8b69c2bb`|15.2|6 / 0|未コミット/未追跡成果物あり|
|`$HOME/dev/personal/irori/.claude/worktrees/integration-irori-abc-20261026-release-v2`|`85936d52`|15.7|0 / 1|固有生成物・証跡の要否/所有者判断未確定|
|`$HOME/dev/personal/irori/.claude/worktrees/integration-irori-ui-ux-abc-20261025`|`1f79ab42`|1466.6|1 / 8|未コミット/未追跡成果物あり|
|`$HOME/dev/personal/irori/.claude/worktrees/manual-breast-start-delivery-20261027`|`f23a493b`|762.8|0 / 2|固有生成物・証跡の要否/所有者判断未確定|
|`$HOME/dev/personal/irori/.claude/worktrees/prod-hardening-2026-10`|`61ecad29`|1578.6|1 / 9|未コミット/未追跡成果物あり|
|`$HOME/dev/personal/irori/.claude/worktrees/product-quality-ux-20261027`|`c64ca328`|2968.8|0 / 8|固有生成物・証跡の要否/所有者判断未確定|
|`$HOME/dev/personal/irori/.claude/worktrees/security-next-20261026`|`e7e200af`|1499.8|4 / 7|未コミット/未追跡成果物あり|
|`$HOME/dev/personal/irori/.claude/worktrees/security-shadcn-20261026`|`e795858c`|1509.1|0 / 5|固有生成物・証跡の要否/所有者判断未確定|
|`$HOME/dev/personal/irori/.claude/worktrees/wf_e693de72-f69-1`|`324078f0`|1478.2|56 / 3|未コミット/未追跡成果物あり|
|`$HOME/dev/personal/irori/.claude/worktrees/wf_e693de72-f69-2`|`324078f0`|1478.2|67 / 3|未コミット/未追跡成果物あり|
|`$HOME/orca/workspaces/irori/fulmar`|`b50c7eaa`|751.8|0 / 5|固有生成物・証跡の要否/所有者判断未確定|
|`$HOME/orca/workspaces/irori/minnow`|`decc816b`|1262.2|0 / 4|前タスクのcommit・検証成果と共有依存を保護|

### 未追跡migrationの保護

親checkoutはbranch `main`、HEAD `b50c7eaa`、多数の未コミット/未追跡成果物あり。以下は以前の人間向け本番migration手順で配置された成果物として残した。同名mainとの内容一致だけでは所有者の不要判断にならぬ。

|`$HOME/dev/personal/irori/supabase/migrations/` 内のファイル|SHA256（mainと一致）|判定|
|---|---|---|
|`20261101090000_news_multiple_sources.sql`|`feef29771bb3a8c3f5d1c233bd2162d5cc73538b2883504616df799abad4e91e`|PASS 保全|
|`20261101100001_news_optional_ai.sql`|`0d89a3945bbc320f07dd90698aa914059ac8b0e98767d7ec2c53ce3ba1b83d9b`|PASS 保全|

削除後は全27 worktreeが存在し、他26作業木のstatusが削除前と同一、記録した保護pathも存在。`git fsck --connectivity-only --no-dangling` はexit 0。`rm -rf`、force削除、clean/reset、stash破棄、remote削除、PR closeは使っておらぬ。

## 8. 人間に残る操作（最大5件）

1. **実iPhone受入（NOT_RUN）**: 下の5〜10分チェックを本人が実行。OS/ブラウザ/PWA版・日時・PASS/FAIL/NOT_RUNを返す。家族の実名・本文を撮影しない。
2. **Cron読取（BLOCKED）**: 個人irori SQL Editorで上のSQLを2回（5分以上間隔）、通常の朝の結果も収集。secret列を増やさぬ。異常が確認できてから最小是正の対象を決める。
3. **配送前の隔離確認（BLOCKED）**: PreviewのDB・secret・自動deploy設定を確認。今回ローカル変更を公開してよい状態になってから下の配送コマンドを実行する。未確認のままpushしない。
4. **新headの実DB統合検証（NOT_RUN）**: 隔離されたCI/E2Eで保存・睡眠・健診・共有取消・RLSを確認し、CodeQLの実行とfindingを確認。既存mainのgreenで代用しない。
5. **保留worktreeの所有判断（BLOCKED）**: 下表・JSONを確認し、所有Agent終了・未コミット成果物の保管・証跡の保存先が確定したものだけ次回整理。remote branchは別途1件ごとの明示承認が要る。

### 実iPhone 5〜10分チェック

|時間目安・操作（本人が実施）|合格条件|今回|
|---|---|---|
|1分: Safari→共有→ホーム画面へ追加、アイコンから起動。既存利用者は既存アイコンから確認|standalone、OS/PWA版と起動時間を記録。勝手な再インストール・データ消去はしない|NOT_RUN|
|1分: 設定の版・更新案内を確認|ログイン維持、表示版、案内が事実に合う。更新前は書きかけ/計測の有無を確認|NOT_RUN|
|2分: 育児・子ども切替・睡眠・健診・共有を閲覧|既存記録の件数/日時一致。横はみ出し・safe-area・文字拡大・読み上げ/フォーカスを確認。追加/削除/取消はしない|NOT_RUN|
|1分: ニュースと通知設定を閲覧|地域・記事・原文・通知ON/OFFの意味が分かる。購読を変えるなら本人の明示操作で行う|NOT_RUN|
|1分: 機内モード→戻す、バックグラウンド→復帰|保存不明を成功表示しない、画面復帰、ログインと子どもが混ざらない。実データを試し書きしない|NOT_RUN|
|通常利用時: 本人が受け取った通知を記録|受信時刻・種類・タップ先のみ。PWA内からのOS許可要求は本人操作。こちらから試験Pushしない|NOT_RUN|

各行の記録形式: `日時 / iOS・Safari版 / PWA版 / PASS・FAIL・NOT_RUN / 個人情報を除いた観測`。通知が来る時刻待ちは5〜10分の操作枠とは別じゃ。

### 配送用（未実行）

Preview隔離の確認と配送許可が揃った後、人間の許可されたGitHub経路でのみ実行する。credentialの取出しやbroker契約変更を求める手順ではない。

```sh
git push -u origin codex/irori-pwa-cron-ux-hygiene-20261102
gh pr create --draft --base main --head codex/irori-pwa-cron-ux-hygiene-20261102 \
  --title "fix: improve enlarged childcare layout and release guidance" \
  --body-file docs/reports/irori-pwa-cron-ux-cleanup-20261102-pr.md
```

## 9. 参照資料

確認日はいずれも2026-11-02。公式資料は試験方法・判定境界の根拠であり、irori本番の稼働証拠ではない。

- Next.js 16.4.3同梱 `node_modules/next/dist/docs/01-app/02-guides/progressive-web-apps.md` を実装前に確認。
- [WebKit: Web Push for Web Apps on iOS and iPadOS](https://webkit.org/blog/13878/) — Home ScreenとWeb Pushの実端末条件。
- [Playwright Emulation](https://playwright.dev/docs/emulation) — ブラウザエミュレーションの範囲。
- [WCAG 2.2](https://www.w3.org/TR/WCAG22/) — contrast、reflow、target-sizeの評価基準。
- [Supabase Cron](https://supabase.com/docs/guides/cron)、[pg_net](https://supabase.com/docs/guides/database/extensions/pg_net) — job履歴と非同期HTTPの分離。
- [Git worktree](https://git-scm.com/docs/git-worktree) — clean/locked/remove/pruneの扱い。
- リポジトリ `docs/runbooks/notify-cron.md`、`docs/runbooks/regional-news.md`、`docs/performance/product-expansion-20261031.md`、`CLAUDE.md`、個人credential境界規則を確認した。
