# irori Flutter ネイティブ「カレンダーホーム画面ウィジェット」ロードマップ

- 作成: 2026-07-18 / 対象 HEAD: main `e77a376`
- 改訂: 2026-07-18 敵対的レビュー（F4）の blocking 6 件を全て解消、suggestions 反映（レビュー原本: scratchpad/F4-review.md）
- 入力: `F1-flutter-state.md`（flutter/ 実査）/ `F2-widget-tech.md`（一次情報調査）/ 前回計画 `prior-audit/implementation-plan.md` §0（web↔Flutter 戦略設問）/ `docs/plans/2026-07-18-calendar-requests.md`（CAL 計画・§5 でユーザーが「Flutter 本格検討」を選択済み）
- 規模凡例: S(〜半日) / M(〜2日) / L(3日〜) / XL(1週間超)（前回計画 §2 と同一基準）
- 位置づけ: 調査成果物。コード変更・Issue/PR 作成は未実施。

---

## 0. 前提の要点（入力からの確定事実）

| 事実 | 出典 |
|---|---|
| flutter/ は **web ターゲット単独**。ios/ android/ 不在、widget/バックグラウンド系パッケージ皆無 | F1 §1, §5 |
| アプリ本体は堅牢: 8 feature・repository/AsyncNotifier 構造・RLS/承認ゲート parity・**950 テスト green（2026-07-18 実測）**・CI 配線済み | F1 §2-3 |
| calendar は丸ごと不在（AUDIT-013 現存）。ただし DB（RLS+Realtime）と jst_date は共有/移植済み。未移植は grid/validation/UI/CRUD の web 側 ~1,160 行 | F1 §4 |
| ウィジェット UI は **iOS=SwiftUI / Android=Kotlin(Glance) をどの路線でも各 1 枚書く**（home_widget は配線のみ）。データは App Group / SharedPreferences 中継が標準・推奨 | F2 §1, §3 |
| iOS の widget 更新はリロード予算制（1日 40〜70 回目安）で「任意時刻の確実更新」は原理的に不可。多日分 TimelineEntry 事前生成 + アプリ起動時 push + workmanager best-effort + 手動更新ボタンの多段構え | F2 §2 |
| **iOS ウィジェットの実配布には Apple Developer Program $99/年が必要**、TestFlight internal は**ビルド 90 日失効** → 定期再アップロード必須。Android は自己署名 APK 直配布 **0 円・失効なし**。※「App Group が無料 Apple ID で組めない」は home_widget docs（二次情報）依拠で Apple 一次明文は未確認 — §7-8 の 30 分検証で確定させる（F4 BLK-3） | F2 §4 |
| Magic Link は web origin 前提（`app_origin.dart:23-26` が非 http(s) で空文字）→ ネイティブ化には deep link 化が必須 | F1 §2, §6 |
| 前回計画 §0: 「web が主たる出荷物」は**仮置き**。web↔Flutter の関係 (a)実験/(b)置換/(c)並走 の確定は人間 | prior plan §0 |
| CAL 計画 §5: CAL-4（アプリ内カード）/CAL-5（shortcuts）は Flutter 検討の結論が出るまで**着手保留のつなぎ案として温存** | CAL 計画 §5 |

### 0.1 どの路線でも変わらない不変コスト（比較の土台）

路線 A/B の差を正しく測るため、先に「**選択に依らず必ず払うもの**」を固定する:

1. **P0 ネイティブブートストラップ**（`fvm flutter create --platforms=ios,android .`、Xcode 切替、CocoaPods、dart-define 注入経路）— 同一作業（F1 §6, F2 §5）
2. **認証の deep link 化**（app_links + カスタム scheme/Universal Links + Supabase Allowed Redirect URLs + `app_origin.dart` 分岐）— ウィジェット以前に「ネイティブでログインできる」ための必須工事。回避不能
3. **ネイティブ widget UI 両 OS 分**（SwiftUI TimelineProvider + Kotlin Glance）— home_widget を使っても消えない。**路線 B にしてもここは 1 行も減らない**
4. **配布・運用**（$99/年、TestFlight 90 日サイクル、Android keystore 管理）— アプリが「フルアプリ」でも「ウィジェット供給係」でも**配布の重さは同一**。iPhone への実配布は paid 一択 — 論拠は **TestFlight/ストア配布に $99 Program が必須という一次確定事実**（App Group の無料 ID 可否は §7-8 の検証待ちだが、それがどちらに転んでもこの結論は変わらない — advisor 指摘で論拠を張り替え）

→ **路線 B が節約できるのは実質「calendar フル移植（L 規模）」と「以後の web↔Flutter 二重保守の約束」の 2 点のみ**。この認識が比較の軸になる。

---

## 1. 路線 A: フルパリティ延長

> 既存 flutter/ に ios/android ターゲットを追加し、calendar を丸ごと移植（AUDIT-013 解消）した上で home_widget を統合。家族が Flutter アプリを常用アプリとして使う道が開ける。前回計画 §0 の答えを (b)置換 または (c)並走 に倒す選択と実質同義。

### フェーズ分解

| フェーズ | 内容 | 規模 | 検証手段（合否条件） |
|---|---|---|---|
| **A-P0** ターゲット追加/起動確認 | org（bundle id）決定 → `fvm flutter create --platforms=ios,android .`（README §3 の web 追加前例踏襲、git diff で上書き確認）。`xcode-select` 切替 + `xcodebuild -runFirstLaunch` + `-downloadPlatform iOS` + CocoaPods。dart-define のローカルビルド注入経路整備 | **M** | ① iOS シミュレータ + Android 実機（emulator 可）でアプリが起動し既存 5 タブが表示される ② `fvm flutter test` 全緑維持（ベースラインは着手時実測を PR 本文に記録 — 参考値 2026-07-18: 950 本。CAL 計画の規律に統一、F4 提案） ③ `flutter build web --release` 非破壊（CI green） ④ 主要依存（supabase_flutter/shared_preferences/wakelock_plus/printing）の native ビルド通過 — F1 §6 の「一度も native build されていない」を初めて実証する関門 |
| **A-P1a** 認証ネイティブ化 | Magic Link deep link 化: app_links 設定（**App Links / Universal Links を優先** — カスタム scheme は他アプリの横取り耐性がないため fallback 扱い、F4 提案）、`app_origin.dart`/`buildEmailRedirectTo`（router.dart:35-39）の native 分岐、Supabase Allowed Redirect URLs 追加（**本番 config 変更 = 人間/ops 操作**） | **M** | 実機で Magic Link ログイン → 承認ゲート（fail-closed 維持）→ 世帯データ表示まで通る。**Flutter web ターゲットの Magic Link 手動 smoke（ログイン成立 = 合格）+ buildEmailRedirectTo native 分岐の unit テスト**（旧記載「web 側 e2e green」は Next.js の e2e で flutter/ の変更を検証しない常時緑の無情報条件だったため差し替え — F4 BLK-4） |
| **A-P1b** calendar 移植（AUDIT-013 解消） | web ~1,160 行を meals feature と同型（repository + AsyncNotifier + Realtime + freezed）で移植: calendar-grid（42 セル）/ calendar-validation / month view + agenda + event form / CRUD。jst_date は移植済みを再利用 | **L** | `fvm flutter test` に calendar 分を追加して green（grid 純関数は web 側テストケースを写経移植 = fail-red 先行が可能）。実機/web ターゲット両方で: web PWA で作成した予定が Flutter calendar に出る・Flutter で作成した予定が web に出る（同一 DB・RLS 越しの相互往復） |
| **A-P2** widget 統合 | home_widget（v0.9.3 系）+ workmanager 導入。Dart 側: アプリ起動/復帰時 + calendar CRUD 後に「今日〜+N 日分の予定 JSON」を saveWidgetData → updateWidget。iOS: Widget Extension（SwiftUI・**日付境界で切替わる多日 TimelineEntry 事前生成**・App Group）。Android: GlanceAppWidget + manifest + workmanager 周期更新（15 分〜）。オプション: 手動更新ボタン（AppIntent → バックグラウンド Dart isolate で Supabase fetch） | **L〜XL**（Android 分 M + iOS 分 L） | 実機合否: ① web PWA で予定追加 → Android ウィジェットに 15〜60 分以内に反映（workmanager 経路） ② iOS はアプリを一度開けば即反映 + 日付が 0:00 で自動的に翌日分へ切替（多日 entry 検証） ③ ウィジェットタップでアプリの calendar 該当日が開く ④ 機内モードで最終取得分が表示され続ける（クラッシュ/空白にならない） |
| **A-P3** 配布・運用 | Apple Developer Program 加入 → App ID/App Group/証明書 → TestFlight internal（夫婦 2 人）。Android: keystore 生成 + **バックアップ**（紛失=上書き更新不能、F2 §4.2）+ 署名 APK 配布。CI に ios/android ビルドジョブ追加（現状 web のみ、flutter.yml:48-53）。fastlane 等の自動化は任意。**注**: TestFlight 初回アップロード時はレビュー待ちが挟まる可能性あり（internal-only は通説レビュー不要だが Apple 一次の書きぶりは限定的 — F4 提案の注記） | 初期 **M** + **定常運用が恒久に残る**（TestFlight 再アップロード ≥ 年 4 回 × 数十分 + Android APK 受け渡し） | 妻/夫それぞれの実機に TestFlight / APK 経由でインストールでき、ウィジェットがホーム画面に置ける。90 日失効カレンダーリマインダー（or 自動化）が設定されていること自体を受け入れ条件に含める |

**合計目安: XL**（M+M+L+L〜XL+M。CAL 計画 §4 の「Flutter + home_widget = XL」評価と整合）

### 路線 A 固有のリスク

| リスク | 実害 | 緩和 |
|---|---|---|
| **web との二重保守が恒久化** | 以後 web の全機能変更（CAL-1〜3、babycare 計画、P1/P2 バックログ…）に Flutter 移植が随伴。実質「§0 を (b)/(c) に確定」する戦略コミット。放置すれば「常用アプリのほうが機能が古い」逆転が起きる | 着手前に §0 を人間が明示確定（後述 G0）。(a) のままなら路線 A を選ばない |
| TestFlight 90 日失効の踏み外し | **失効ビルドは起動しなくなる** — 忘れると家族の常用アプリが突然死。常用アプリ化するほど被害が大きい | カレンダー定期タスク化 or fastlane + CI 定期ビルド。運用をやめたくなった時の撤退線も後述 G5 に定義 |
| iOS widget 更新の非保証 | 「朝必ず最新」は原理的に保証されない（F2 §2.1） | 常用アプリなら**毎日開く = 起動時 push が毎日発火**するため実用上ほぼ解消 — 路線 A の構造的な強み |
| native 初ビルドの未知（依存の実機挙動） | printing/pdf 等が iOS/Android で未検証（F1 §6-4） | A-P0 の合否条件④で最初に検証。落ちても web ターゲットは無傷 |

---

## 2. 路線 B: 最小コンパニオン

> ウィジェット表示に必要な最小限（auth + calendar 読み取り + widget 書き出し）に絞る。web PWA が常用のまま、Flutter は「ウィジェット供給係」。

### 2.0 土台の選定: **別軽量アプリは不採用、既存 flutter/ を土台にする**

| 選択肢 | 判定 | 根拠 |
|---|---|---|
| 別リポジトリ/別アプリを新規作成 | **不採用** | auth（Magic Link + 承認ゲート fail-closed = web `proxy.ts` の移植、router.dart:128-158）・supabase providers（timeout/構造化ログ付き、supabase_providers.dart:68-99）・jst_date・CI・テスト基盤の**再発明**になる。「最小」のつもりが security-critical な承認ゲートを二重実装する羽目になり、世帯分離の門番が 2 系統に割れる（CLAUDE.md 軸 2 に反する）。節約はゼロ、リスクだけ増える |
| **既存 flutter/ に ios/android ターゲットを足し、calendar は読み取り最小限のみ実装** | **採用** | P0/P1a/P2/P3 が路線 A と完全共通 = **B の全成果物がそのまま A への昇格資産**になる。アプリに meals/shopping 等の既存画面が同梱されるのは害でなく、「開けば widget が更新される」トリガーとして働く |

### フェーズ分解（A と共通のフェーズは差分のみ記す）

| フェーズ | 内容 | 規模 | 検証手段（合否条件） |
|---|---|---|---|
| **B-P0** | **A-P0 と同一**（不変コスト） | **M** | A-P0 と同一 |
| **B-P1** データ層（読み取りのみ） | calendar_events の read-only repository + freezed model（meals_repository.dart:64 と同パターン）+「今日〜+N 日」整形ロジック（jst_date 再利用）。**+ 最小 read-only アジェンダ 1 画面**（後述の「タップの着地」問題のため強く推奨。CRUD・月グリッド・validation・event form は作らない） | **S〜M**（アジェンダ画面込みで M） | `fvm flutter test` に repository/整形の unit 追加 green。実機: web PWA で作成済みの予定が Flutter の最小アジェンダに出る（RLS 越し読み取り実証） |
| **B-P1a**（= A-P1a） | 認証 deep link 化 — **省略不能**。ウィジェットが RLS 越しにデータを読むにはネイティブでのログイン成立が前提 | **M** | A-P1a と同一 |
| **B-P2** widget 統合 | **ネイティブ widget 実装は A-P2 と同一物**（不変コスト③)。差分: CRUD 後フックが無い代わりに、**workmanager 周期更新と手動更新ボタン（AppIntent → バックグラウンド Dart isolate で Supabase fetch）が「オプション」でなく必須**になる — 常用アプリでない = 起動時 push が滅多に発火しないため。手動更新ボタン（AppIntent）は **iOS 17+ 限定**（§5 #4 の OS フロア確認） | **XL 級の主要部**（A-P2 と同じ。必須項目が増える分むしろ僅かに重い） | A-P2 ①②④に加え、路線 B 固有の合否 2 条件（F4 BLK-1 で分離 — 旧「⑤手動込みで到達」は不合格を定義できず自壊していた）: **⑤a 自動経路のみ**（起動時 push・手動ボタン禁止）で、Flutter アプリを 3 日間未起動のまま web PWA から追加した予定が iOS ウィジェットへ到達する実測到達率を記録（24h 以内到達を基準に合否）。**⑤b 手動運用の受容**: ⑤a が不合格の場合、「朝ウィジェットの更新ボタンを押す」運用を**実際に使う家族（判定者 = 主需要側の端末所有者）**が 1 週間試して受容するか。⑤a/⑤b とも不合格なら路線 B は不成立（§3 の昇格一本化条件へ） |
| **B-P3** 配布・運用 | **A-P3 と同一**（不変コスト④）。「ウィジェット供給係」でも $99/年・90 日サイクル・keystore は 1 円も 1 分も減らない | 初期 **M** + 定常運用 | A-P3 と同一。ただし失効時の被害は「ウィジェットが古くなる/消える」に縮小（常用アプリ死よりは軽い） |

**合計目安: XL（A より calendar フル移植 L の 1 個分だけ軽い）** — 旧記載「L〜XL」は B-P2 単独で L〜XL + M×3 が積まれる自前の凡例と不整合で、絶対規模を過小表示していた（F4 BLK-6 で訂正）。**「最小コンパニオン」でも XL 級の投資である事実は変わらない。**

### 路線 B 固有のリスク

| リスク | 実害 | 緩和 |
|---|---|---|
| **鮮度エンジンの前提欠落（最大の構造的弱点）** | home_widget の標準は「アプリ起動時に書き出し」（F2 §2.3）。常用が PWA のままだと Flutter アプリは開かれず、**iOS の鮮度は保証なしの BGAppRefresh + 手動ボタン頼み**になる。「配偶者が web で足した予定がウィジェットに出ていない」が iOS で日常化しうる | ① 夫婦カレンダーはイベント追加頻度が低く、多日 TimelineEntry 事前生成で「日付切替」自体は確実 ② Android 側は workmanager で堅い ③ それでも駄目なら「朝ウィジェットの更新ボタンを押す」運用 — **自動経路の実測（⑤a）と手動運用の家族受容（⑤b）を分けて判定する（B-P2 合否条件参照）** |
| ウィジェットタップの着地が空洞 | iOS のウィジェットタップは**コンテナアプリを開く**のが原則（widgetURL。訓練知識ベースのため実装時に要確認）。calendar 画面ゼロだと「タップ → meals が開く」という肩透かし | B-P1 の最小アジェンダ 1 画面で着地を用意（S 規模）。Android はタップ intent の柔軟性が高く PWA URL に飛ばす案もあるが、二重 UX になるため非推奨 |
| バックグラウンド Dart isolate と本体の refresh token 競合 | 手動更新ボタン/workmanager の Dart isolate が supabase_flutter セッションを本体と別々に回転させる競合の可能性（F2 §3 の指摘の変形） | 実装時に supabase_flutter のセッション永続と isolate 挙動を要実機確認。競合が出るなら「アプリ起動時書き出しのみ」へ後退 |
| 「最小」の漂流 | アジェンダに「予定追加くらい欲しい」→ form → validation → …と路線 A へなし崩れ膨張 | スコープ明文化: **B での Flutter 側 write は作らない**。書きたくなったらそれは G4 での路線 A 昇格判断（なし崩しでなく明示ゲートで） |

---

## 3. Go/No-Go ゲート（両路線共通のはしご + 撤退資産）

> 設計思想: **課金と戦略コミットを最後まで遅延させる**。特に「Android 先行」— iOS は App Group が paid 必須のため**ウィジェットの実機検証自体に $99 が先払いになる**が、Android は 0 円で最後まで検証できる（F2 §4）。夫婦が iPhone/Android 混在である本件は、この非対称を利用して「片方の実機で価値実証 → もう片方に課金判断」ができる稀有な好条件。

| ゲート | 時点 | 判断基準（no-go 条件） | 撤退時に残る資産 |
|---|---|---|---|
| **G0** | 着手前（今） | 人間判断 3 点（§5）が出ない/「Apple 加入 No」→ **iOS への実配布は不可能**（TestFlight/ストア配布に $99 Program 必須 — 一次確定事実）。その場合の縮退案: (i) Android 端末のみウィジェット（0 円で完走可能） (ii) 全面見送り → CAL-4/5 へ | 何も消費していない。本ロードマップ自体 |
| **G1** | P0 完了後 | native ビルドが通らない/主要依存が iOS or Android で破綻 → 撤退 | `flutter create` 生成物（無害に同居可、revert も一手）。「native ビルドの実態」という知見。web ターゲット・950 テストは無傷 |
| **G2** | P1(a) 完了後 | Magic Link deep link が実機で安定しない（メールアプリ経由の scheme 起動不全等）→ 撤退 or OTP 方式へ設計変更 | **路線 A なら calendar 移植（P1b）は Flutter web ターゲットでそのまま出荷可能 = AUDIT-013 解消は native 撤退でも生き残る**。B の read repository も将来資産 |
| **G3** | P2-Android 完了後（**課金前の本丸**） | Android 実機ウィジェットを家族が 1〜2 週間試用。「ホーム画面で見える」が「PWA を開く」に対して体感価値なし → **$99 を払わず撤退**。この時点で総支出 0 円。※**人間判断 #4 で iPhone 側が主需要と判明した場合、G3 の代理実証性は落ちる** → その場合は G3.5 を G3 と並行前倒しし、G3 単独の合格で課金へ進まない（F4 BLK-2） | Android ウィジェットは**そのまま恒久運用可**（0 円・失効なし）。「Android のみウィジェット」は正当な終着駅の一つ。撤退時は **irori-prod の Allowed Redirect URLs からカスタム scheme を削除**（本番 config 掃除 — F4 提案。G2 撤退時も同様） |
| **G3.5** | **$99 課金の直前（必須ゲート — F4 BLK-2 で新設）** | **iOS シミュレータで widget extension + App Group の動作検証を無課金でどこまで通せるか実証**（旧 §7-7 の「未検証」を課金前必須に格上げ）。SwiftUI TimelineProvider の骨格・多日 entry 切替・App Group 読み書きがシミュレータで動くことを確認してから支払う。シミュレータで原理不成立が見えたら **$99 を払わず撤退**（iOS 最大の未知を課金後の L 投資に先送りするサンクコストの罠を遮断） | Swift 実装の骨格・「シミュレータで何が検証できるか」の知見。Android 側は G3 の資産のまま |
| **G4** | P2-iOS + P3 完了後 | $99 支払い・TestFlight 配布まで実施後、iOS 側の鮮度/運用が不合格（B-P2 条件⑤a/⑤b）→ 翌年更新せず iOS 撤退。Android は継続 | Swift/Kotlin 実装・App Group 設計はリポジトリに残る（OSS 資産）。更新を止めても当年内は動作 |
| **G5** | 運用開始後（恒久） | 90 日アップロードが負担で続かない → iOS はウィジェット諦め PWA 回帰、Android のみ継続 | 全コード + 「運用コストの実測値」 |

> **路線 A への昇格の唯一条件（一本化 — F4 提案。他節の言及はすべて本項を指す）**: 「前回計画 §0 の人間回答が (b) または (c) に確定」**かつ**「G5 を 2 サイクル（半年）完走」の両方を満たした時のみ、明示ゲートとして昇格を判断する。なし崩し昇格（B-P2 ⑤ 落第を理由に暗黙で A へ流れる等）は禁止。

---

## 4. 比較表

| 軸 | 路線 A: フルパリティ延長 | 路線 B: 最小コンパニオン（既存 flutter/ 土台） |
|---|---|---|
| 総規模 | **XL**（M+M+L+L〜XL+M） | **XL**（A − calendar 移植 L 分。「最小」でも XL 級 — F4 BLK-6 訂正） |
| ウィジェット初回到達までの距離 | 遠い（P1b の L を経由） | **近い**（P1 が S〜M。ウィジェットだけなら最短） |
| ネイティブ widget 実装（SwiftUI/Kotlin） | 必要 | **同じだけ必要**（差ゼロ） |
| 配布・運用コスト（$99/年・90 日・keystore） | 必要 | **同じだけ必要**（差ゼロ） |
| iOS ウィジェット鮮度 | **強い**（常用化 = 毎日の起動時 push） | **弱い**（BGAppRefresh best-effort + 手動ボタン頼み。B 最大の弱点） |
| ウィジェットタップの着地 | フル calendar 画面 | 最小アジェンダ（read-only）。write 不可の肩透かし感は残る |
| AUDIT-013（calendar 不在） | **解消**（native 撤退でも web ターゲットで生存） | 未解消のまま（read-only repository のみ） |
| web との二重保守 | **恒久に随伴**（最大の負債。§0 を (b)/(c) に確定する戦略コミット） | 増えない（Flutter は widget 供給係で凍結。既存 950 テスト維持のみ） |
| §0 戦略との整合 | (a) のままなら不整合。(b)/(c) 確定が前提 | **(a) 仮置きのまま進められる**（戦略確定を後送りできる） |
| 撤退のしやすさ | P1b 投資が大きく心理的に引き返しにくい | **各ゲートで身軽**。B→A は無損失で昇格可（土台共通ゆえ） |
| 家族 UX の上限 | 高い（将来ネイティブ常用の道） | ウィジェット + 閲覧のみ。編集は引き続き PWA |

## 4.1 推奨（根拠付き）

**推奨: 路線 B（既存 flutter/ 土台 + 最小アジェンダ付き）で共通幹（P0 → P1a → P1 → P2-Android）を進め、G3（Android 実機・課金前）で価値実証してから $99 と iOS に進む。路線 A への昇格判断は §0 の人間回答が (b)/(c) に確定した時のみ、明示ゲートで行う。**

根拠:

1. **要望の本体は「ウィジェット」であって「常用アプリの乗り換え」ではない**。路線 A の追加投資（calendar フル移植 L + 恒久二重保守）は要望が要求していない対価であり、§0 で人間がまだ (a) 仮置きのまま（CAL 計画 §5 は「初シグナル」に留まる）の現在、先回りで戦略を確定させる路線 A は判断の越権になる。
2. **B は A の真部分集合**（土台を既存 flutter/ に取る限り）。B の全フェーズ成果物が A に昇格再利用できるため、「まず B」に機会損失がない。逆（A から B へ縮退）は calendar 移植分が widget には過剰投資だったことになる。
3. **コスト構造上、A/B の差は calendar 移植 1 個分しかない**（§0.1）。差が小さいからこそ、差額で買えるもの（= 常用アプリ化の選択肢）を人間の §0 回答なしに買うべきでない。
4. **Android 先行の G3 が 0 円で核心仮説を検証できる**。「ホーム画面で予定が見える」の実効価値が家族の生活で本当に立つかは、$99 もネイティブ iOS 実装も要らずに Android 端末で確かめられる。
5. ただし路線 B の弱点（iOS 鮮度）は本物。**B-P2 合否条件⑤a/⑤b を落第した場合の処方箋が「もっとアプリを開かせる」= 事実上の路線 A 誘導**であることは先に明記しておく。その時も §3 の昇格一本化条件（§0 確定 + G5 2 サイクル完走）を満たしてからのみ A へ昇格する（なし崩し禁止）。

---

## 5. 人間判断が必要な項目（着手前に回答必須）

| # | 判断事項 | 影響 |
|---|---|---|
| 1 | **Apple Developer Program（$99/年 ≒ 13,000 円/年）に加入する意思があるか** | No なら iOS ウィジェットの**実機配布**は不可（TestFlight/App Group とも paid 前提の見込み。無料 ID での App Group 可否は §7-8 で 30 分検証してから確定 — F4 BLK-3）。「Android 端末のみウィジェット（0 円）」または全面見送り（→ CAL-4/5）に縮退。**G3.5 まで支払いは不要**なので「G3/G3.5 の結果を見てから決める」も正当な回答 |
| 2 | **常用アプリを web PWA から Flutter へ移す意思があるか**（前回計画 §0 の (a)/(b)/(c) の確定） | (a) 維持なら路線 B 固定。(b)/(c) なら路線 A（昇格）が視野。**本ロードマップの推奨は「回答を G3/G4 まで保留したまま進める」を許す設計**だが、路線 A へは回答なしに進まない |
| 3 | **bundle id / org 名**（例: `info.coprec.irori` 等） | P0 の `flutter create --org` に必要。後から変えると全ファイル書き換え（F1 §6） |
| 4 | 夫婦どちらの端末が iPhone / Android か、**ウィジェットを最も欲しているのはどちらの端末か**。あわせて両端末の **OS バージョン確認（1 分）**: 手動更新ボタン（AppIntent）は iOS 17+ 限定、Android は Glance の minSdk フロアあり（F4 提案） | G3（Android 先行実証）の有効性が変わる。**iPhone 側の人が主需要なら G3 の代理実証性は落ちる → G3.5 を G3 と並行前倒しし、G3 単独合格で課金へ進まない**（F4 BLK-2）。OS フロア未達なら該当機能を設計から落とす |
| 5 | Supabase 本番（irori-prod）の Allowed Redirect URLs へカスタム scheme を追加する操作の承認 | P1a で必要な本番 config 変更 |
| 6 | TestFlight 90 日ごとの再アップロード運用（年 4 回 × 数十分）を引き受けるか | G4/G5 の前提。fastlane 自動化に追加投資するかも含む |
| 7 | **babycare 計画 B-01（Critical・毎晩発生・実装号令待ち）との優先裁定** — XL 級の新規投資（本ロードマップ）より先に既知 Critical を片付けるか | G0 で併せて裁定（F4 提案）。ファイル交差はないため技術的には並行可能だが、リソース配分は人間の判断 |

---

## 6. CAL-4（アプリ内カード）を「つなぎ」として推すか — 判断材料

**結論: 推す。ただし「保留解除は今・実着手は CAL 計画の直列順どおり（CAL-1 → CAL-0 → CAL-2 → CAL-3 の後）」**（旧記載「今すぐ着手してよい」は CAL 計画 C5 レビューが確定した唯一の直列順と矛盾していたため訂正 — F4 BLK-5）。

| 観点 | 材料 |
|---|---|
| 到達時間 | CAL-4 は S-M・web のみ・設計/レビュー済み（CAL 計画、e2e 分離済みで他 PR と非干渉）。対して Flutter ウィジェット初回到達は最短でも P0+P1a+P1+P2-Android ≈ **数週間** + G0 の人間回答待ち |
| 価値の重なり | CAL-4 は「毎日開く画面（/meals = PWA start_url）を開いた瞬間に今日・明日の予定」。ウィジェットの価値の相当部分（受動的に目に入る）を、**ホーム画面 1 タップ手前**という差だけで先取りする |
| 無駄になるか | **ならない**。ウィジェット完成後もアプリ内カードは別文脈（アプリを開いた時）で生き続ける。さらに路線 B では「PWA が常用」のままなので CAL-4 の露出頻度は落ちない。Flutter 全面撤退（G1〜G3 no-go）時は唯一の恒久解になる |
| 競合リスク | Flutter 側と共有ファイルなし（web のみ）。CAL 計画の直列制約（CAL-2 → CAL-3 → CAL-4）にだけ従えばよい |
| 推さない場合の論拠（両論併記） | 「ウィジェットが出るなら二重実装では」— 上記のとおり文脈が異なり二重でない。「Flutter に集中すべき」— CAL-4 は S-M で並行可能な粒度、かつ G0 の人間回答待ち期間は Flutter 側が進めない空白になる |

CAL-5（manifest shortcuts, XS）も同様に無競合・無害だが、体感 Android のみ・価値が薄いため優先度は CAL-4 の後のままでよい。

## 6.1 CAL 計画とのすみ分け

- **CAL-1/2/3（validation 整合・終了時刻表示・フォーム発見性）は Flutter 判断と無関係に web で進めてよい**（CAL 計画 §5 で「最優先ペア」確定済み）。むしろ CAL-2 の表示語彙（「→」等）は将来のウィジェット表示仕様の原型になるため、先行が望ましい。
- CAL-4/5 は上記のとおり「保留解除して着手」を推奨（CAL 計画 §5 の温存判断の更新提案）。
- 路線 A を選んだ場合の calendar 移植（A-P1b)は、CAL-1〜3 の**マージ後の web 実装を移植元**にすること（移植中に原本が動く rebase 地獄の回避。実行順依存として明記）。

---

## 7. 未確定・要実機確認（F2 から引き継ぎ + 本設計で追加）

1. 無料 Apple ID の 7 日失効の Apple 一次明文（挙動は二次情報多数一致。本設計は paid 前提のため影響軽微）
2. スマホ新法による日本のサイドローディング実運用ルート（確立を確認できず。確立すれば iOS 配布の $99 前提が崩れるため**年 1 回の再点検を推奨**）
3. iOS workmanager（BGAppRefresh）の実機更新頻度 — B-P2 合否条件⑤で実測
4. iOS ウィジェットタップの遷移先制御（widgetURL がコンテナアプリを開く挙動）— 訓練知識ベースのため P2 実装時に Apple docs で確認
5. バックグラウンド Dart isolate と本体アプリの supabase_flutter セッション/refresh token 競合 — P2 実装時に実機確認
6. workmanager / home_widget の当時最新版と Flutter 3.44 の互換 — P2 着手時に pub.dev で再確認（F2 時点 home_widget v0.9.3）
7. iOS シミュレータで App Group / ウィジェットが paid なしにどこまで動くか — **G3.5（課金前必須ゲート）に格上げ済み**（F4 BLK-2）
8. **「App Group は無料 Apple ID で組めない」の Apple 一次明文**（現状 home_widget docs の二次情報のみ。Apple の Supported capabilities (iOS) は Personal team 可否を明記せず — 2026-07-18 fetch 確認）— **Xcode の無料アカウントで App Group capability を追加してみる 30 分検証で白黒つける**（F4 BLK-3）。組めるなら iOS の部分検証がさらに 0 円で広がる

---

## 付録: フェーズ依存グラフ（両路線共通幹）

```
G0(人間判断 #1-#3) ──→ P0(create+起動確認, M)
                          │ G1
                          ├─→ P1a(認証deep link, M) ── G2
                          │        │
   路線A: P1b(calendar フル移植, L) │   路線B: P1(read-only repo+最小アジェンダ, S-M)
                          │        │
                          └─→ P2-Android(Glance+workmanager, M) ── G3 ★課金前の価値実証★
                                   │ (iPhone 主需要なら G3.5 を並行前倒し)
                                   └─→ G3.5(iOS シミュレータ検証・課金前必須) ── (人間判断 #1 の最終確定)
                                            └─→ $99 → P2-iOS(SwiftUI+App Group, L) → P3(TestFlight+APK, M) ── G4 → 恒久運用(G5)
```
