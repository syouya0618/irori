# irori 実装計画 — 週間平均 / 予定通知 / 朝夜の体温

- 作成: 2026-08-06 / 対象 HEAD: `main` `968fc73`
- ベースライン実測: `pnpm test:run` → **1412 passed / 116 files / 7.01s**（本計画で割らぬこと）
- 位置づけ: 実装計画会議の成果物。**コード変更・Issue/PR 作成は未実施**
- 調査: 下位モデル 4 体（コードベース 3 体 / 一次情報 2 体）＋ advisor 1 回。全ての「無い」は grep のコマンドと件数で裏づけ済み
- 会議での確定: 主の回答 6 件（§5.4 の意思決定記録に全て収録）

---

## 1. Executive Summary

### 何を作るか

主の訴え 3 件に応える。調査の結果、**3 件とも性質が違う**ことが分かった。

| 訴え | 調査で判明した真の性質 | 規模 |
|---|---|---|
| ① 週間サマリーに平均を | 平均が**一つも無い**。純粋な機能追加だが**分母の定義**が設計の核 | S |
| ② 予定を希望の時間で通知 | 通知基盤が**ゼロから要る**。Vercel Hobby では cron が原理的に足りぬ | **L** |
| ③ 朝夜の体温を記載できる場所 | 記録機能は**端から端まで実装済み**。欠けているのは**読み返す面** | S〜M |

### なぜ作るか

- ①③ は既にあるデータが**見えていない**。育児の判断（飲みが減った/熱がある）に使うべき数字が、合計値とタイムラインの流れの中に埋もれている
- ② は**能動的に届く経路が一本も無い**。カレンダーは「開いた人にしか届かぬ」道具に留まっている

### 誰のためか

夫婦 2 人（**妻: iPhone / 主: Android**）。妻の iPhone は irori を**ホーム画面に追加済み**（会議で確認）。

### 最も重要な設計判断

1. **② は Web Push 一本**。Google カレンダーを夫婦で共有していないため、Google 側へ書き戻してリマインダーに乗る案は**到達経路が無い**（§5.1 参照）
2. **② のスケジューラは Supabase pg_cron**。Vercel Hobby は cron が 1 日 1 回・±59 分で、分粒度の式は**デプロイ自体が失敗する**
3. **② は「撃ちっぱなし」を捨てキュー方式にする**。Vercel/pg_cron とも公式に「落ちる・重複する」と明言しており、送りっぱなしの設計は成立しない。さらに**送信は claim してから行う**（キューは INSERT の冪等しか担保せぬ）
4. **通知設定は `calendar_events` ではなく新テーブル `event_reminders` へ**。`calendar_events` の UPDATE は `source='native'` 限定ゆえ、列を足すと **Google 由来の予定に通知を付けられぬ**。主は Phase D で Google カレンダーを取り込んだばかりで、予定の多くが google 行である（DR-13）
5. **③ は DB に列を足さない**。朝/夜は `logged_at` の時刻から**表示側で振り分ける**。記録ボタンは `isToday` 限定（DR-14）
6. **① の平均は「昨日までの 7 日」で割り、取得窓と表示窓を別変数に分ける**。経過途中の今日を混ぜると朝に見た平均が必ず過小になる。窓を 1 変数で広げると既存の「合計」と「おむつ内訳」が無音で 8 日ぶんに化ける

### 推奨する実装方針

**3 つのトラックに分け、リリース単位を分ける。**①③ を ② の人質にしない。

- **トラック A（①③）**: DB 変更なし・数日規模。先に出す
- **トラック B（②）**: 5 PR + migration 3 本。**スパイクで到達性を実証してから**設計を確定する

---

## 2. Current State

### 2.1 現状（実測）

| 項目 | 実測 | 根拠 |
|---|---|---|
| ユニットテスト | 1412 passed / 116 files | `pnpm test:run` |
| Vercel プラン | **Hobby** | `src/app/api/cron/google-sync/route.ts:30` の記述 + 過去計画の実測記録 |
| 稼働中の cron | **1 本**（`/api/cron/google-sync`, `0 21 * * *` = JST 06:00） | `vercel.json` |
| Service Worker | 自前 418 行。`install`/`activate`/`fetch`/`message` の **4 listener のみ** | `public/sw.js` |
| Web Push の痕跡 | **リポジトリ全体で 0 件** | `grep -rn "PushManager\|pushManager\|web-push\|VAPID\|showNotification\|requestPermission" .` → 0 |
| 通知関連の migration | **0 件** | `grep -rn "remind\|reminder\|notify\|notification" supabase/migrations/` → 0 |
| 体温の記録経路 | **完全に実装済み**（ENUM/列/CHECK/Action/ボタン/フォーム/タイムライン） | §2.4 |
| 朝/夜の概念 | **コードベースに 0 件** | morning/evening/朝/夜 の grep で該当なし |
| 週間サマリーの平均 | **0 件** | `baby-weekly-summary.ts` は合計のみ |

### 2.2 問題と根本原因

| 症状 | 根本原因 |
|---|---|
| 「週の平均が分からぬ」 | 集計層に平均を出す関数が無い（`totalBabyWeeklySummary` は合計のみ） |
| 「予定の通知が来ぬ」 | 通知基盤が存在しない。さらに **Hobby の cron 制限**という構造的な壁がある |
| 「体温を書く場所が欲しい」 | 書く場所はある。**読み返す専用の面が無い**ため「無い」ように見えている |

### 2.3 制約

**技術的制約（一次情報・確認日 2026-08-06）**

| 制約 | 原文 | 出典 |
|---|---|---|
| Vercel Hobby の cron | "Hobby accounts are limited to cron jobs that run **once per day**. Cron expressions that would run more frequently **will fail during deployment**." / 精度 "Per-hour (±59 min)" | [usage-and-pricing](https://vercel.com/docs/cron-jobs/usage-and-pricing) |
| cron は best effort | "Cron job delivery is **best effort**... your function does not execute, and **no runtime log is created**" / "Vercel **will not retry**" / "can also occasionally **invoke the same scheduled run more than once**" | [manage-cron-jobs](https://vercel.com/docs/cron-jobs/manage-cron-jobs) |
| cron は redirect を追わぬ | "Cron jobs **do not follow redirects**... Redirect responses are treated as final" | 同上 |
| iOS の Web Push | "iOS 16.4 or later: **Home Screen web apps**"（Safari タブは対象外） | [Apple](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers) |
| **Safari は不可視 push を許さぬ** | "**Safari doesn't support invisible push notifications.** ... **If you don't [present immediately], Safari revokes the push notification permission for your site.**" | 同上 |
| Apple Developer Program | **不要** | 同上 |
| Google の reminders | "Information about the event's reminders **for the authenticated user**" | [Calendar API](https://developers.google.com/workspace/calendar/api/v3/reference/events) |
| pg_net | **beta** / 既定タイムアウト **2 秒** / **自動リトライ無し** / HTTP は **commit 後**に開始 | [pg_net](https://supabase.com/docs/guides/database/extensions/pg_net) |
| Supabase Free の pause | "Free projects are **paused after 1 week of inactivity**" / 復帰は "Click **Resume project** and confirm"（**自動復帰なし**） | [free-project-pausing](https://supabase.com/docs/guides/platform/free-project-pausing) |

**運用上の制約**

- **irori は public リポジトリ**。`CRON_SECRET` や URL を migration にベタ書きしてはならぬ → **Supabase Vault** 必須
- ローカル Supabase は現在アプリが動かぬ状態（CLI 2.108.0 の GRANT 差異）。**e2e はローカルで走らせられぬ前提で計画する**
- 本番へ任意 SQL を打つ経路は **Supabase Dashboard のみ**

### 2.4 既存資産（再利用するもの）

| 資産 | パス | ② での用途 |
|---|---|---|
| cron 認証の型 | `src/app/api/cron/google-sync/route.ts:38-67`（`safeEqual` + fail-closed `CRON_SECRET`） | 新 cron route にそのまま流用 |
| proxy の cron 迂回 | `src/proxy.ts:88` `pathname.startsWith("/api/cron/")` | **既に通る**（追加不要） |
| service role | `src/lib/supabase/admin.ts` `createAdminClient()` | 配信ジョブ |
| JST 時刻 | `src/lib/utils/date-jst.ts`（`jstWallClockToIso` / `formatTimeJst` / `shiftYmd` / `toJstDateString`） | 通知時刻の算出・体温スロット判定 |
| SW テスト基盤 | `src/lib/pwa/__tests__/sw-logic.test.ts`（node:vm で `self.__TEST_HOOKS__` を実行） | push ハンドラの単体テスト |
| 設定カードの型 | `src/components/settings/*-card.tsx`（関心事ごとに 1 枚） | 通知設定カード |
| 集計層 | `src/lib/domain/baby-weekly-summary.ts` | ① の平均 |
| 体温の抽出（**再利用不可・下記**） | `src/lib/domain/baby-log-aggregation.ts:211-224` `extractTemperatures` | ③ では使えぬ。`BabyLogData` から直接組む |

> ⚠️ `extractTemperatures` の返り値は `{ date, time, temperature }` で **`id` を持たず**、`time` は `formatTimeJst` の `"HH:MM"` 文字列ゆえ epoch 比較もできぬ。③ は編集のために `id` が要り、同枠の最新選択に epoch が要る。**PDF レポート専用の形と割り切り、③ は `BabyLogData` から組む**。

### 2.5 ②に関する前提の変化（記録）

`docs/plans/2026-07-18-calendar-requests.md:120` に「時間設定の真意 = (a) 時刻入力が見つけにくい（確認済み）… 通知（Push）解釈は**否定された**ためスコープ外のまま」とある。

**これは誰かの誤りではなく、必要が後から生まれたということ**として記録する。当時の判断は当時の情報では正しかった。ただし同じ計画書は「(c) なら Push 基盤の設計を別途起こす」と**出口を用意していた** — 本計画がその出口である。

---

## 3. Product and UX

### 3.1 利用者と利用状況

| 軸 | 実態 |
|---|---|
| 利用者 | 夫婦 2 人。育児中（細切れ時間・片手操作・夜間の暗所・疲労） |
| 端末 | 妻 iPhone（PWA ホーム画面追加済み）/ 主 Android |
| 頻度 | 育児ログは 1 日十数回。カレンダーは 1 日 1〜数回 |
| 熟練度 | 高い（自作アプリの当事者） |

### 3.2 主要ユースケース

| # | ユースケース | 訴え |
|---|---|---|
| U1 | 「うちの子は 1 日だいたい何回飲むのか」をひと目で知る | ① |
| U2 | 朝起きて体温を測り、その場で記録する | ③ |
| U3 | 「今日の夜の分はまだ測っていない」に気づく | ③ |
| U4 | 予定の 30 分前に通知を受けて動き出す | ② |
| U5 | 毎朝、今日の予定をまとめて受け取る | ② |

### 3.3 画面と UI 状態

#### ① 週間サマリーカード（既存を拡張）

```
┌─ 週間サマリー ──────────────────┐
│  授乳            おむつ           │
│  8.3 回/日       9.7 回/日        │  ← 新規（主表示を平均へ）
│  昨日まで7日の平均                │  ← 期間を明示（必須）
│                                   │
│  授乳                             │
│  ▁▃▅▇▅▃▂   ← グラフは今日含む7本（現状維持）
│  4/31 ... 8/6                     │
└───────────────────────────────────┘
```

- **空状態**: 7 日すべて 0 → `— 回/日` と表示し「まだ記録がありません」。`0.0 回/日` は「本当に 0 回だった」と読めてしまうため避ける
- **エラー状態**: 週間ログの取得失敗は既存の `error.tsx` が受ける（変更なし）

#### ③ 体温カード（新規）

```
┌─ 今日の体温 ────────────────────┐
│  朝              夜               │
│  36.7℃          ＋ 記録          │  ← 空きスロットは記録ボタン(44px)
│  07:12          （未測定）        │
└───────────────────────────────────┘
```

- **埋まっている**: `36.7℃` + `07:12`。タップで編集シートを開く
- **空**: `＋ 記録`（44px 以上）。タップで `logType="temperature"` のフォームシートを開く。**これが訴え③の「記載できる場所」に正面から答える部分**
- **同じ枠に複数**: 最新を主表示し `+2` バッジ。発熱時に何度も測る運用を殺さない
- **過去日**: `BabyDateNav` の選択日に追随して**閲覧はできる**。ただし **`＋ 記録` ボタンは今日（`isToday`）のみ**に出す。過去日では「記録なし」の表示に留める

> ⚠️ **訂正（当初の記述は事実誤認じゃった）**: `BabyLogFormSheet` に `logDate` **prop は無い**。実体は `baby-log-form-sheet.tsx:222` の `const logDate = log ? toJstDateString(log.logged_at) : todayJstString()` というローカル導出で、**新規作成は今日固定**。直上のコメントが「新規は当日（作成導線は isToday ゲート下ゆえ today = 選択日）」と前提を明記しておる。
>
> ゆえに記録ボタンを `isToday` の外へ出すと (a) 保存されるのは**今日の行**、(b) `baby-dashboard.tsx:457-459` の `appendLog` が日付を検査せず選択日の配列へ prepend するため**過去日のタイムラインに今日の行が混入**する。`baby-optimistic-log.ts:14-18` が「F-03（過去日クイック記録の解禁）採択時は本設計の再検討が必須」と名指しで警告しているのがまさにこれじゃ。
>
> **訴え③は「今日の朝夜」ゆえ `isToday` 限定で足りる**（DR-14）。過去日の記録が要るなら、それは F-03 として別 PR で `createLogDate` prop と `appendLog` の門番ごと入れよ。
- **色だけに依存しない**: 発熱域（37.5℃ 以上）は色ではなく**テキストと Lucide アイコン**で示す

#### ② 通知設定カード（新規・`/settings`）

- 未許可: 「通知を有効にする」ボタン（**ユーザー操作起点が必須** — Apple 公式要件）
- 許可済み: 購読中の端末一覧、既定のリード時間、毎朝ダイジェストの時刻、**最終配信時刻**
- 拒否済み: ブラウザ設定から戻す手順を文章で案内（JS からは復帰できぬ）
- 非対応ブラウザ: 機能を隠さず「この端末は非対応」と明示する

> **最終配信時刻を出すのは飾りではない。** Supabase Free の pause で通知が**静かに死ぬ**経路が実在するため、これが唯一の検知手段になる（§9）。

#### ② 予定フォーム（既存を拡張）

- `通知` Select を追加: `なし / 10分前 / 30分前 / 1時間前 / 前日20時`
- 既定値は通知設定の「既定のリード時間」から引く
- **終日予定でも選べる**（終日は `start_date` の 00:00 JST を基準に逆算）
- **Google 由来の予定（`source='google'`）にも付けられる** — 通知は `calendar_events` ではなく `event_reminders` に書くため、`source='native'` 限定の UPDATE ポリシーに当たらぬ。google 予定の詳細シートは本文が read-only のまま**通知 Select だけ操作可**にする

### 3.4 アクセシビリティ

- タッチターゲット 44px（体温カードの空きスロット、通知許可ボタン）
- `aria-label`: 体温スロットは「今日の朝の体温 36.7度 7時12分」のように読める形にする
- 平均値は色ではなく数値とラベルで表現する
- `transition-colors duration-200` のみ（`transition-all` 禁止）

### 3.5 採用しない UI トレンドと理由

| 案 | 却下理由 |
|---|---|
| 体温の推移グラフ | 主が今回は不要と判断（会議で確認）。将来拡張に温存 |
| 通知のリッチ表現（画像・アクションボタン） | iOS の Web Push は表現が限られ、実装コストに見合わぬ |
| 平均をスパークライン等で装飾 | 既に BarChart がある。二重表現は情報を薄める |

---

## 4. Technical Design

### 4.1 ① 週間平均

**⚠️ 窓を 2 つに分ける（ここを 1 変数で済ませると既存の数字が無音で壊れる）**

現在 `weeklyStartDate`（`baby-dashboard.tsx`）は **3 つの消費者**に食われている:

| 消費者 | パス | 8 日にすると何が起きるか |
|---|---|---|
| Realtime の週窓 in/out 判定 | `baby-dashboard.tsx:130-135` | 8 日目が届くようになる（**これは意図どおり**） |
| おむつ内訳 `weeklyDiaperBreakdown` | `baby-dashboard.tsx:413-419` | 「おしっこ4・うんち3」が**8 日合計に化ける** |
| `totalBabyWeeklySummary(days)` | `weekly-summary/baby-weekly-summary.tsx:59` | 「授乳◯回」が**8 日合計に化ける**（渡された配列の全要素を合計するため） |

さらに `baby-weekly-summary.tsx:102/118` の `aria-label="直近7日の…"` も嘘になる。**DR-2 で自ら「グラフの隣の数字がグラフと合わぬのは毒」と言うたその毒を、窓拡張が仕込む。**

**ゆえに変数を明示的に 2 本に割る:**

```
fetchStartDate   = shiftYmd(today, -7)   // 8 バケット。取得と Realtime 判定のみに使う
displayStartDate = shiftYmd(today, -6)   // 7 バケット。既存の表示系は全てこちら（意味を変えない）
```

- **グラフ / 合計 / おむつ内訳 = `displayStartDate` 起点の 7 バケット** ← **現状維持・意味を変えない**
- **平均のみ = `fetchStartDate` 起点の 8 バケットのうち index 0..6**（昨日までの 7 日）

**回帰テストの向き（重要）**: 既存の「おしっこ4・うんち3」assert は**旧値を守る側の回帰テスト**として残せ。壊れた新値へ書き換えてはならぬ — その瞬間に検出器が死ぬ。

**分母 `sampleDays` は 7 固定にしない**

記録を始めて 3 日目の世帯や、旅行・入院で数日空いた直後に「実データ 3 日ぶんを 7 で割る」と、**今日を除いた理由（過小評価を避ける）と同じ過小評価を分母側で作る**。しかも「飲みが減った」を判断する数字ゆえ向きが悪い。

```
sampleDays = min(7, 「最初の記録日」から昨日までの完了日数)
```

- ラベルは実測を出す: `昨日まで7日の平均` / データが浅ければ `昨日まで3日の平均`
- 記録が 1 日も無ければ `null` → UI は `— 回/日`
- **限界の明示**: 記録開始後に丸1日記録が無い日は「0 回の日」として分母に数える（「測らなかった」と「本当に 0 回」は原理的に区別できぬ）。この割り切りをコメントに残す

**なぜ今日を除くか**: 7 番目のバケットは経過途中で、朝に見れば必ず過小に出る。時刻によって意味が変わる平均は健康指標として信用できぬ。経過時間による按分は不透明ゆえ却下（§5.4 DR-1）。

**おむつの分子**: `diaperCount`（`both` を 1 回）を使う。`sumDiaperBreakdown`（`both` を pee/poop 双方に計上）は使わない。理由: 隣のバーグラフの高さと一致させるため。グラフの隣の数字がグラフと合わぬのは毒じゃ（§5.4 DR-2）。

**実装**

- `src/lib/domain/baby-weekly-summary.ts` に純関数を追加:
  ```
  export const AVERAGE_WINDOW_DAYS = 7
  export const AVERAGE_EXCLUDES_TODAY = true   // 1 箇所で切り替えられる形にする
  export function averageBabyWeeklySummary(days): { feedingPerDay, diaperPerDay, sampleDays } | null
  ```
- `sampleDays` を返すのは、後から「何日で割ったか」を UI と テストの両方で検証できるようにするため
- 全 0 のときは `null` を返し、UI が `— 回/日` を出す
- 小数第 1 位で四捨五入

**Realtime との整合（見落としやすい）**

`baby-dashboard.tsx` の Realtime ハンドラは「週窓に入る/出る」を判定して差分適用している（`:161, :187, :214`）。窓を 8 日にするなら `weeklyStart` の算出（`:111` 付近）も 8 日に合わせねばならぬ。**漏らすと 8 日目だけ Realtime が届かず、平均が静かにズレる**。

### 4.2 ③ 朝夜の体温

**DB 変更は無い。** 朝/夜は `logged_at` から導出する。

**なぜ列を足さないか**: 列にすると (a) 過去の全行が NULL になり (b) 境界時刻を後から変えられなくなる。導出なら定数 1 つで変えられる（§5.4 DR-3）。

**新ドメイン `src/lib/domain/baby-temperature-slots.ts`**

```
export const TEMPERATURE_SLOT_BOUNDARY_HOUR = 12   // 朝: 00:00-11:59 / 夜: 12:00-23:59
export const FEVER_THRESHOLD_C = 37.5

export type TemperatureSlot = "morning" | "night"
export function assignTemperatureSlot(loggedAtIso: string): TemperatureSlot
export function buildDailyTemperature(logs, ymd): {
  morning: { temperature, loggedAt, id } | null
  night:   { temperature, loggedAt, id } | null
  morningExtra: number   // 同枠の追加件数
  nightExtra: number
}
```

- 判定は JST。`toJstDateString` と同じ `Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" })` 系の既存ユーティリティを使う（`new Date('YYYY-MM-DD')` は禁止）
- 各枠の主表示は**その枠の最新**（`logged_at` の epoch 比較。文字列比較は楽観 append 行の `Z` とサーバ行の `+00:00` が混在するため使わない — `findLastNursing` と同じ理由）

**新コンポーネント `src/components/baby/baby-temperature-card.tsx`**

- `BabyDashboard` の `BabyQuickActions` 直後・`BabyWeeklySummary` の前に置く
- **読む配列は `logs`（選択日のログ）であって `weeklyLogs`（週窓）ではない**。`BabyDateNav` の選択日に追随する以上これが正。`weeklyLogs` で実装すると**窓の外の過去日を開いたとき静かに空になる**
- 入力は既存の `recordTemperature` / `updateLog` をそのまま使う（**新しい書き込み経路を作らない**）
- 楽観 append も既存経路に相乗り

### 4.3 ② Web Push 通知

#### アーキテクチャ

```
[ Supabase pg_cron ]  */5 * * * *
        │  net.http_post（URL と secret は Vault から）
        ▼
[ Vercel /api/cron/notify ]  ← CRON_SECRET fail-closed（既存 google-sync の型）
        │  service role
        ▼
[ notification_deliveries ]  ← 「時刻が来た & 未送信 & 期限内」を選出
        │
        ▼
[ web-push → APNs / FCM ]  → 妻の iPhone / 主の Android
        │
        └─ 410/404 → push_subscriptions から削除
```

#### なぜキュー方式か

Vercel も pg_cron も公式に「落ちる・重複する」と明言している。撃ちっぱなしでは成立しない。キューにすると 3 つの故障が同時に閉じる:

| 故障 | 閉じ方 |
|---|---|
| 取りこぼし（cron が 1 回落ちた） | 次の実行が拾う（catch-up） |
| 二重起動 | `UNIQUE(event_id, subscription_id)` と `sent_at` が殺す |
| 遅配の雪崩 | **grace window** が期限切れを skip する |

**grace window は Safari 対策でもある。** 「不可視 push 禁止 → 出さねば権限剥奪」ゆえ、遅れた通知をまとめて出すと大量の可視通知が雪崩れる。`GRACE_WINDOW_MIN = 15` を超えたものは送らず `skipped_at` を立てる。

#### スキーマ（migration 3 本）

**M1. `push_subscriptions`**

| 列 | 型 | 備考 |
|---|---|---|
| `id` | UUID PK | |
| `user_id` | UUID NOT NULL FK profiles ON DELETE CASCADE | **世帯は常にここから引く**（下記） |
| `endpoint` | TEXT NOT NULL **UNIQUE** | 冪等キー |
| `p256dh` / `auth` | TEXT NOT NULL | 暗号鍵 |
| `user_agent` | TEXT | 設定画面で端末を見分ける |
| `created_at` / `last_success_at` / `last_failure_at` | TIMESTAMPTZ | |
| `failure_count` | INT NOT NULL DEFAULT 0 | |

RLS（**FOR ALL 禁止 → 分離**）— 4 本すべて `user_id = auth.uid()`:
- SELECT / INSERT（WITH CHECK）/ **UPDATE（USING + WITH CHECK）** / DELETE

> ⚠️ **UPDATE ポリシーを置かぬのは「防御」ではなく「機能の破壊」じゃ。** `endpoint` は UNIQUE な冪等キーゆえ、再購読（`pushsubscriptionchange`・拒否→再許可・鍵ローテーション）で `INSERT ... ON CONFLICT DO UPDATE` が要る。UPDATE ポリシーが無ければ RLS 違反で落ち、ユーザーには「通知を有効にできぬ」としか見えぬ（しかも RLS が行を隠すゆえ原因調査もできぬ）。`profiles` が「**UPDATE ポリシーは残しつつ列 GRANT で 3 列に絞る**」形で同じ問題を解いておる（`20260603000001:74-78`）。

**⚠️ 列 GRANT で秘密を隠す（行 RLS × 列 GRANT の二段防御）**

`(endpoint, p256dh, auth)` の三つ組は、VAPID 秘密鍵と併せて**その端末へ任意の通知を送る能力そのもの**じゃ。設定カードは「購読中の端末一覧」を出すため、素直に作ると**端末 A のブラウザから端末 B の三つ組が読める** — 1 台の XSS が全端末のロック画面への任意表示権に化ける。UI が要るのは `id / user_agent / created_at / last_success_at / failure_count` だけで、**三つ組は一切要らぬ**。

```sql
-- 環境差を潰す型（20260802100001:23-31 が確立）: hosted は arwd 既定・
-- ローカルは Dxtm 既定ゆえ、REVOKE ALL してから必要な GRANT だけを与え、
-- どちらの環境でも同じ ACL へ収束させる。省くと local/CI/本番で ACL が割れ、
-- pgTAP が環境ごとに別のエラーを見る（local-supabase-cli-grant-divergence と同じ傷口）。
REVOKE ALL ON push_subscriptions FROM anon, authenticated;
GRANT SELECT (id, user_agent, created_at, last_success_at, last_failure_at, failure_count)
  ON push_subscriptions TO authenticated;
GRANT INSERT (user_id, endpoint, p256dh, auth, user_agent)  -- 書き込みは開示ではない
  ON push_subscriptions TO authenticated;
GRANT UPDATE (endpoint, p256dh, auth, user_agent) ON push_subscriptions TO authenticated;
GRANT DELETE ON push_subscriptions TO authenticated;
-- failure_count / last_success_at / last_failure_at は UPDATE 権を与えぬ = service role 専用
```

`google_calendar_subscriptions` が「`sync_token` は秘密ゆえ列 GRANT から外す」（`20260802100001:140-142`）、`profiles` が同型（`supabase/tests/profiles_column_grants.sql:5-14`「これを止めておるのは RLS ポリシーではなく**列レベル GRANT 1 枚**じゃ … 外れた瞬間に防御はゼロになる — しかも RLS ポリシーは残るため、ポリシー一覧を見ても異常に見えぬ」）を確立しておる。**pgTAP で列 GRANT の集合を `set_eq` で固定せよ。**

**⚠️ Realtime publication へ追加してはならぬ**（秘密列を持つため）。`20260802100001:16-21` が「本ファイルに `ALTER PUBLICATION` は**意図的に存在しない**」と明文宣言する型を確立しておる。新 3 テーブルとも同じ宣言を書け。

**⚠️ サインアウト時に購読を解除する**。購読は**ブラウザ単位**ゆえ、放置すると旧ユーザー宛の通知が新しい利用者の端末に届く。`sw.js:392-406` の `PURGE_HOUSEHOLD_CACHES` が「1 台を複数ユーザーが使う」脅威を既に認めておるのと同じ筋じゃ。`settings/actions.ts:225` の `signOut` に「行の DELETE + `subscription.unsubscribe()`」を足す。

> ⚠️ **`household_id` を非正規化して持たせてはならぬ。** `profiles.household_id` は nullable で `ON DELETE SET NULL`、かつ承認フローで後から入る。端末に世帯を焼き込むと、**世帯が変わった後も旧世帯の予定通知が届き続ける** — CLAUDE.md の軸2（世帯データ分離）に正面から当たる。配信時は必ず `push_subscriptions → profiles → household_id` と辿って引くこと。`profiles.household_id` が NULL（未承認・世帯離脱）の購読には**送らない**（fail-closed）。

**M2. `event_reminders`（新テーブル）+ `notification_preferences`**

> ### ⚠️ 設計変更: 通知列を `calendar_events` に足さず、**別テーブルへ出す**
>
> 当初は `calendar_events` へ `remind_*` 列を足す設計だったが、敵対レビューが致命的な穴を掘り当てた。
>
> **`calendar_events` の UPDATE ポリシーは `source = 'native'` 限定じゃ**（`20260709000002_calendar_events.sql:98-99`。UI も `calendar-event-form-sheet.tsx:172` の `isGoogle` で read-only にし、`calendar/actions.ts:247,272,302` が `.eq("source","native")` で二重防御している）。
> 主は Phase D で Google カレンダーを取り込んだばかりゆえ、**予定の多くが `source='google'` 行**である。そこに通知を付けられねば、訴え②は半分しか答えられぬ。
>
> `source='native'` 不変条件を緩めるのは**論外**（同期エンジンが google 行の唯一の書き手という契約が崩れる）。ゆえに通知を別テーブルへ出す。**これで 4 つの問題が同時に解ける:**
>
> 1. **google 行にも通知を付けられる**
> 2. `CALENDAR_EVENT_COLUMNS` を変えずに済む → **4 つの共有消費者**（`calendar/page.tsx:34` / `meals/page.tsx:45` / `use-month-events.ts:81` / `upcoming-events-card.tsx:60`）が無傷 → migration とデプロイの順序を誤って `/calendar` と `/meals` が**同時に**落ちる経路が消える
> 3. 同期エンジンの upsert 列集合と干渉しない
> 4. 新テーブルゆえ**最初から列 GRANT とトリガを自分で設計できる**（既存テーブルの ACL を触らずに済む）

> ### ⚠️⚠️ さらなる訂正: `event_id` を FK にしてはならぬ（410 フル再同期で通知が全滅する）
>
> `src/lib/google/sync.ts:388-393` を実読して判明した。**410 GONE のフル再同期は、その購読の `source='google'` 行を丸ごと DELETE してから入れ直す**:
> ```
> .from("calendar_events").delete()
>   .eq("household_id", …).eq("subscription_id", …).eq("source", "google")
> ```
> 再挿入では `gen_random_uuid()` で**新しい id** が振られる。ゆえに `event_id` を FK にすると:
> - `ON DELETE CASCADE` → **主が付けた Google 予定の通知が 410 のたびに黙って全滅する**
> - `ON DELETE SET NULL` → 行は残るが宛先を失い、**二度と紐づかぬ**
>
> 410 は sync_token の失効で**日常的に起きる**。「静かに消える」設計は出してはならぬ。
>
> → **`calendar_events` の volatile な行 id ではなく、Google 側の安定した同一性でキーを張る。**

`calendar_events` に**生成列**を 1 本足す（既存コードは SELECT せぬゆえ無害・`CALENDAR_EVENT_COLUMNS` も無変更）:

```sql
ALTER TABLE calendar_events ADD COLUMN event_uid TEXT
  GENERATED ALWAYS AS (
    CASE WHEN source = 'google'
         THEN google_calendar_id || '|' || google_event_id
         ELSE id::text END
  ) STORED;
CREATE UNIQUE INDEX uq_calendar_events_uid ON calendar_events(household_id, event_uid);
```

- google 行は **`(google_calendar_id, google_event_id)` が Google 側の同一性**ゆえ、削除→再挿入をまたいで不変
- native 行は `id` がそのまま不変
- 式は全て immutable ゆえ `STORED` 生成列にできる

| 列 | 型 | 備考 |
|---|---|---|
| `id` | UUID PK | |
| **`event_uid`** | **TEXT NOT NULL（FK を張らぬ）** | `calendar_events.event_uid` と対応。**410 を跨いで生き残る** |
| `household_id` | UUID NOT NULL FK households ON DELETE CASCADE | RLS の錨。`UNIQUE(household_id, event_uid)` |
| `remind_kind` | TEXT NOT NULL | `'minutes'` / `'prev_day_20'` |
| `remind_minutes_before` | SMALLINT NULL | `'minutes'` のときのみ非 NULL・`0..40320`（4 週間） |
| `remind_at` | TIMESTAMPTZ NOT NULL | **BEFORE トリガが常に導出して上書きする**（下記） |
| `created_by` | UUID NULL FK profiles ON DELETE SET NULL | |
| `created_at` / `updated_at` | TIMESTAMPTZ NOT NULL | |

- **世帯単位**（ユーザー単位ではない）。夫が付けた通知は妻にも届く。家庭のカレンダーとして自然な形 — **これで Q3 が決まる**
- CHECK: `(remind_kind = 'minutes') = (remind_minutes_before IS NOT NULL)`
- 索引: `CREATE INDEX ON event_reminders(remind_at)`（全行が `remind_at` を持つゆえ部分索引にせぬ）
- RLS: SELECT/INSERT/UPDATE/DELETE を分離、すべて `household_id = get_my_household_id()`
- **孤児の掃除**: 対応する予定が消えた通知行は発火せぬ（join が空になる）。放置しても害は無いが、**30 日以上マッチせぬ行を掃除するジョブ**を同じ cron に載せる（`job_run_details` の掃除と同じ扱い）

> ⚠️ **`remind_minutes_before` だけでは「前日20時」を往復できぬ**。前日20時は開始時刻に依存する（09:00 開始なら 780 分前、15:00 開始なら 1140 分前）ため、分数に潰すと**予定を開き直しただけで Select が 5 択に無い値になり既定へ落ちる**＝設定が黙って変わる。開始時刻を動かせば「前日20時」でもなくなる。ゆえに**種別を別列で持つ**。

**⚠️ `remind_at` の導出は Server Action ではなく BEFORE トリガで縛る**

「Server Action が導出する」だけでは、**認証済みユーザーが anon キーで PostgREST を直叩きして `remind_at` を任意に書ける** — `20260603000001_security_hardening_rls.sql` 冒頭が名指しした脅威モデルそのものじゃ。`duration_sec = 左+右` には**等式 CHECK** があるが、`remind_at` は `start_at` に依存する導出ゆえ CHECK では書けぬ（`AT TIME ZONE` は STABLE）。

→ **`BEFORE INSERT OR UPDATE` トリガ（`SECURITY DEFINER` + `SET search_path = public` 必須）がクライアントの `remind_at` を無条件に上書きする。** 副次的に、**Google 同期が `start_at` を更新したときの陳腐化も閉じられる**（同期後に該当 `event_reminders` を touch する経路を 1 本足す）。

**再スケジュール時のキュー畳み込み**（`remind_at` が動いたとき）は**同一トランザクション内**で:
`UPDATE notification_deliveries SET skipped_at = now(), skip_reason='rescheduled' WHERE event_key = <event_id> AND sent_at IS NULL AND skipped_at IS NULL`

`notification_preferences`（**`profiles` を汚さない** — profiles の列 GRANT は `display_name`/`avatar_url`/`default_page` に厳格に絞られており、これを緩めたくない）:

| 列 | 型 | 備考 |
|---|---|---|
| `user_id` | UUID PK FK profiles ON DELETE CASCADE | |
| `event_default_minutes` | SMALLINT NULL | 予定フォームの既定値 |
| `digest_time` | TIME NULL | NULL = 毎朝ダイジェスト無効。**JST 解釈**（下記） |
| `updated_at` | TIMESTAMPTZ | |

- ⚠️ **`digest_time` は TZ を持たぬ**。JST 解釈である契約を**列 COMMENT と cron 側の両方**に書け。書かねば `TZ=UTC` の Vercel と DB で 9 時間ズレる（`playwright.config.ts:19` が `TZ=UTC` を常時検証しているのは、まさにこの型の事故のためじゃ）
- ⚠️ **UPDATE ポリシーを必ず置く**（`user_id = auth.uid()` の USING + WITH CHECK）。設定カードから繰り返し編集するテーブルゆえ、UPDATE を塞ぐと**初回 INSERT 後に二度と変えられぬ**

**M3. `notification_deliveries`**

| 列 | 型 | 備考 |
|---|---|---|
| `id` | UUID PK | |
| **`household_id`** | **UUID NOT NULL FK households ON DELETE CASCADE** | **RLS の唯一の錨（下記）** |
| `kind` | TEXT NOT NULL | `'event'`（B-3）/ `'digest'`（B-5 で追加） |
| **`event_key`** | **TEXT NULL（FK を張らぬ）** | `event_reminders.event_uid` の不変コピー。**重複排除キー専用**（下記） |
| `subscription_id` | UUID NULL FK push_subscriptions **ON DELETE SET NULL** | **CASCADE 禁止（下記）** |
| `dedupe_day` | DATE NOT NULL | JST 暦日。digest の日次一意性に使う |
| `scheduled_at` | TIMESTAMPTZ NOT NULL | |
| `sent_at` / `skipped_at` | TIMESTAMPTZ NULL | |
| `skip_reason` | TEXT NULL | `'expired'` / `'event_started'` / `'gone'` / `'rescheduled'` |
| `created_at` | TIMESTAMPTZ NOT NULL | |

**一意性（⚠️ ここを素朴に書くと二重通知になる）**

```sql
-- digest 行は event_key IS NULL。既定の NULLS DISTINCT では NULL 同士が
-- 衝突せず「何行でも共存できる」ため、ON CONFLICT DO NOTHING が効かぬ。
-- cron は公式に「同じ実行を複数回起動しうる」ゆえ、ダイジェストが二通届く。
-- （20260709000002:60-66 が同じ罠を文書化しておる）
-- PG 17（supabase/config.toml:36）ゆえ NULLS NOT DISTINCT が使える。
CONSTRAINT uq_notification_deliveries
  UNIQUE NULLS NOT DISTINCT (kind, event_key, subscription_id, dedupe_day)
```

**⚠️ なぜ重複排除キーに FK を張らぬのか**

`calendar_events` の行 id は **410 フル再同期で入れ替わる**（`sync.ts:388-393`）。FK を張ると CASCADE なら履歴が消え、SET NULL なら「削除後に残った 2 行が `NULL` 同士で誤衝突する」（`NULLS NOT DISTINCT` は NULL を等しいと見なす）。

→ **`event_reminders.event_uid`（安定キー）を写した不変な TEXT 列 `event_key` を一意キーに使い、FK は張らぬ。** これで「予定が入れ替わっても履歴は残り、かつ誤衝突しない」が両立する。digest 行は `event_key IS NULL` 一本で日毎一意になる。予定の詳細が要るときは `(household_id, event_key)` で `calendar_events.event_uid` を引けばよい。

- `scheduled_at` は**一意キーに入れない**。入れると「予定の開始時刻を編集 → `remind_at` が動く → 別 `scheduled_at` で新行」となり、**旧行（未送信・grace 内）と新行の両方が発火して二重通知になる**
- `remind_at` を更新する経路は、**同 `event_key` の未送信行を `skipped_at` + `skip_reason='rescheduled'` で畳んでから**新しい行を入れること（同一トランザクション）
- ⚠️ **`.upsert({onConflict})` は列名しか出せぬ**ゆえ、キー形状を変えると `42P10` で**本番のみ**落ちる。`supabase/tests/google_sync_upsert_conflict.sql` が「ON CONFLICT が実 DB で解決できること」だけのために存在する前例じゃ — 新キーにも**同型の実 DB テストを必ず置く**
**⚠️ `household_id` を必ず持たせる — さもないと RLS が書けぬか、書くと黙って壊れる**

世帯スコープを他テーブル経由で書く手は 2 つとも罠じゃ:

- `calendar_events` 経由の EXISTS → **digest 行は `event_id IS NULL` ゆえアンカーが無い**。`event_id IS NULL OR ...` と逃がすと digest 行が全世帯に見える
- `push_subscriptions` 経由の EXISTS → M1 の SELECT ポリシーは `user_id = auth.uid()` ゆえ、**ポリシー式から参照した先にも RLS が効き、配偶者の配信行が黙って 0 件になる**。「世帯に開いたつもりが自分のみ」— **pgTAP を 1 人で seed すれば永久に緑**のまま、設定カードの「最終配信」が配偶者ぶんを取りこぼす

ゆえに `household_id` を非正規化して持ち、SELECT ポリシーは `household_id = get_my_household_id()` の 1 条件にする。`get_my_household_id()` は `SECURITY DEFINER STABLE`（`20260406000001_initial_schema.sql:254-257`）ゆえ入れ子 RLS の罠を踏まぬ。`google_calendar_subscriptions` が同じ流儀を採っている（`20260802100001:147`）。

- RLS: **SELECT のみ**世帯内に開き、書き込みは service role 専用（ポリシーを置かない）
- pgTAP は**必ず夫婦 2 人を seed**し、「配偶者の行が見える」「他世帯は見えぬ」を**対で**置く

**⚠️ `subscription_id` に CASCADE を張ってはならぬ（計画自身の検知手段が壊れる）**

CASCADE だと、端末を 1 台失効させた瞬間にその購読の**過去の `sent_at` 行が全て消え、`MAX(sent_at)` が過去へ巻き戻る**。設定カードの「最終配信」が古い時刻を指し、主は「通知基盤が死んだ」と誤読する。さらに `skip_reason='gone'` を立てた行がその DELETE で消えるため、**`'gone'` は原理的に一度も観測できぬ**。

→ `ON DELETE SET NULL`（`subscription_id` は NULL 可）。購読削除は「行は残る・宛先だけ失う」形にする。cron の送信対象は `subscription_id IS NOT NULL` で絞る。これは CLAUDE.md の「監査ログテーブルに `ON DELETE CASCADE` 禁止 → SET NULL または RESTRICT」に素直に従う形でもある（当初これを「配信キューゆえ例外」と書いたが、**例外にした結果が実害だったため撤回する**）。

#### 配信ジョブ `/api/cron/notify`

```
1. NOTIFY_CRON_SECRET を fail-closed 検証（google-sync:38-67 と同型）
2. now = new Date()
3. 対象世帯を集める（横断スキャンをせず 1 世帯ずつループする — 下記）
4. 期限切れの掃除: scheduled_at < now - GRACE → skipped_at, skip_reason='expired'
5. 対象イベントの展開（世帯ごと）:
     event_reminders r
       JOIN calendar_events e
         ON e.household_id = r.household_id AND e.event_uid = r.event_uid  ← 安定キーで結ぶ
       WHERE r.household_id = <この世帯>
         AND r.remind_at <= now AND r.remind_at > now - GRACE
         AND (e.start_at IS NULL OR e.start_at > now)   ← ★ 開始済みには撃たぬ
     × 同世帯の push_subscriptions（profiles 経由で household を辿る）
     → notification_deliveries へ INSERT ... ON CONFLICT DO NOTHING（冪等）
       event_key := r.event_uid を写す（不変コピー。TEXT へ）
6. ★ claim してから送る（下記 TOCTOU）:
     UPDATE notification_deliveries SET sent_at = now()
       WHERE id = ? AND sent_at IS NULL AND skipped_at IS NULL
             AND subscription_id IS NOT NULL
       RETURNING *          ← 取れた行だけを送る
7. 送信。410/404 → 購読削除（キュー行は SET NULL で残る）+ skip_reason='gone'
   その他失敗 → sent_at を NULL へ戻し failure_count++（次回の実行で再試行）
8. ★ 心拍を必ず書く: notification_heartbeat を upsert（下記）
9. 応答 JSON で { ranAt, scheduled, sent, skipped, failed } を返す
```

> ★ **キューにしただけでは二重送信は閉じておらぬ（TOCTOU）。** 行の**生成**は UNIQUE で冪等になるが、**送信**は排他されておらぬ。pg_cron の重複起動で 2 プロセスが同じ未送信行を SELECT し、両方が送る。
> **`UPDATE ... WHERE sent_at IS NULL RETURNING *` で先に claim する**ことで、行ロックが直列化を担う。DR-6 の「二重起動は UNIQUE と `sent_at` が殺す」は、この claim があって初めて真になる。
> なお **逐次実行の統合テストは claim の有無を弁別できぬ**（2 接続を並行させぬ限り「直列化される**はず**」しか書けぬ）。ゆえに**テストで固定できぬことを承知のうえで claim 方式を採る** — 機構を行ロックへ委ね、`FOR UPDATE SKIP LOCKED` の RPC は採らない（家庭規模で 5 分粒度ゆえ、単文 UPDATE の RETURNING で十分）。

**⚠️ 世帯ごとにループする（`admin.ts` の契約を守る）**

`src/lib/supabase/admin.ts:9-29` は「呼び出し側の義務 — **全クエリで `household_id` / `user_id` を明示 `.eq()`**」を定めておる。`event_reminders WHERE remind_at <= now` の**全世帯横断スキャン**はこれに正面から反する。

→ 既存 `syncAllHouseholds`（`src/lib/google/sync.ts:876-895`）と同型にせよ: **対象 `household_id` を先に集め、1 世帯ずつループして各クエリに `.eq("household_id", …)` を付ける**。

> ★ **`start_at > now` の 1 行が無いと、GRACE=15 分と「10 分前」の組で catch-up が開始 5 分後に通知を撃つ。** 予定が始まってから「10 分前です」と鳴るのは、リマインダーとして無価値どころか害じゃ。

**⚠️ 心拍テーブル `notification_heartbeat`（1 行）— 「最終配信」だけでは故障と無風を区別できぬ**

`MAX(sent_at)` は「送るものが無かった」日も進まぬ。通知付き予定は毎日あるとは限らぬゆえ、**パイプライン停止と平穏が同じ画面になる**。ゆえに cron が**毎回**「最終実行時刻」を書く:

| 列 | 型 |
|---|---|
| `id` | SMALLINT PK CHECK (id = 1) — 1 行に固定 |
| `ran_at` | TIMESTAMPTZ NOT NULL |
| `sent_count` / `skipped_count` / `failed_count` | INT NOT NULL |

- **RLS を必ず明記する**: 世帯を持たぬグローバル 1 行テーブルゆえ「**認証済みなら SELECT 可・書き込みは service role 専用（ポリシーを置かぬ）**」。書き忘れると **RLS 有効・ポリシー 0 本 = deny-all** になり（Supabase の既定）、設定カードが常に空になる
- publication へは追加せぬ（明文宣言する）

設定カードには **`最終実行`（心拍）と `最終配信`（`MAX(sent_at)`）を並べて出す**。この 2 つが揃って初めて、下表の故障が区別できる。

- `export const runtime = "nodejs"` / `export const maxDuration = 60`（google-sync と同じ）
- **GET ハンドラ必須**（Vercel cron は GET を送る。pg_cron 経由でも形を揃える）

#### pg_cron の登録 — **migration ではなく Dashboard の手順書にする**

> ⚠️ **これを migration に書いてはならぬ。** Vault の secret は**ローカルにも CI にも存在せぬ**ゆえ、`vault.decrypted_secrets` を参照する migration は pgTAP スイートで**検証不能**（緑でも赤でも意味を持たぬ）。加えて本番へ任意 SQL を打つ経路は Dashboard のみじゃ。
> → `docs/runbooks/notify-cron.md` として手順書に落とす。`job_run_details` の掃除ジョブ登録も同じ扱い。
>
> ⚠️ **順序依存**: Vault の秘密 2 件は、`cron.schedule` が**初めて発火する前に**入っておらねばならぬ。先に schedule すると 5 分ごとに失敗し続ける（しかも `job_run_details` は `succeeded` のまま）。
>
> ⚠️ **`NOTIFY_CRON_SECRET` は Vercel と Vault の 2 箇所に複製される。** 回転時に片方だけ変えると 5 分ごとに 401 を撃ち続け、心拍だけが進んで配信が止まる。回転手順を手順書に併記せよ。

```sql
-- 秘密は Vault へ（irori は public リポジトリゆえ migration にベタ書き禁止）
select cron.schedule(
  'irori-notify', '*/5 * * * *',
  $$ select net.http_post(
       url     := (select decrypted_secret from vault.decrypted_secrets where name='notify_url'),
       headers := jsonb_build_object('Authorization',
                    'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name='cron_secret')),
       timeout_milliseconds := 5000
     ) $$
);
```

- **5 分粒度**を採る。毎分だと `cron.job_run_details` が 1 日 1440 行たまり、Free の 500 MB を食う。10 分前通知に対し最大 5 分のズレは許容範囲
- `cron.job_run_details` の掃除ジョブを**同時に登録する**（公式が「自動削除されない」と明記）
- **タイムアウトは 5000ms**（既定 2 秒は Vercel のコールドスタートに短すぎる）

#### ⚠️ pg_cron の監視ギャップ（必ず塞ぐ）

`net.http_post` は request_id を即返し、HTTP は **commit 後**に始まる。ゆえに **HTTP が失敗しても `cron.job_run_details` は `succeeded` を記録する**。あれは「投函の監視」であって「配達の監視」ではない。

- 配達の可否は `net._http_response`（保持 **6 時間**・**unlogged**）を見る
- **アプリ側の真の監視は `notification_deliveries.sent_at` の最新値**。これを設定カードに「最終配信」として出す

#### Service Worker

`public/sw.js` に `push` / `notificationclick` / **`pushsubscriptionchange`** を追加する。

- **`CACHE_VERSION` は bump しない**（キャッシュスキーマの変更ではない。bump すると全キャッシュが消え、オフライン閲覧が一時的に壊れる）。`skipWaiting()` + `clients.claim()` は既に在る（`sw.js:233,252`）ゆえ新 SW は待たされずに有効化される
- `push` ハンドラは**必ず** `showNotification` を呼ぶ。ペイロードが壊れていても汎用文言で出す。**これが Safari 対策の主軸じゃ**（grace window は副次。夫婦 2 人・1 日数件では通知はそもそも雪崩れぬ）
- `notificationclick` は**日付を指して**開く（下記 §4.3 の「通知の着地先」）
- **`pushsubscriptionchange`**: Chrome/Android はブラウザ都合で購読を回す。拾わねば**購読が黙って死ぬ**
- 純粋関数は `self.__TEST_HOOKS__` に載せる。ただし**`addEventListener("push", …)` が実際に登録されたかは node:vm では検証できぬ**（`__TEST_HOOKS__` は純関数しか公開せぬ）。CLAUDE.md の「規約ファイルは在るだけでは効いておらぬ」と同 family ゆえ、**登録行の存在を別途 assert する**

**起動時の突き合わせ（自己修復）**

アプリ起動時に `registration.pushManager.getSubscription()` と DB の `endpoint` を照合し、乖離していれば張り直す。これが無いと **410 で消した購読を誰も再作成せぬ**（主が設定画面を自発的に開くまで）。VAPID 鍵を回した場合（R8）の復旧経路もこれが兼ねる。

#### ⚠️ 通知の着地先 — 現状は「常に今日」が開く

`src/app/(main)/calendar/page.tsx` は **`searchParams` を受け取らず**、`src/components/calendar/use-month-events.ts:51` が `useState<string>(todayJstString())` で**選択日をハードコード**している（上書きする prop も無い）。ゆえに:

- 「10 分前 / 30 分前 / 1 時間前」の通知 → 対象は今日 → **偶然通る**
- 「前日 20 時」の通知・毎朝ダイジェスト → **翌日の予定を指しながら今日が開く**＝行き止まり

`notificationclick` の「既存タブがあれば focus」は focus するだけで**日付を動かさぬ**ため、URL を足しただけでは既存タブ経路が直らぬ。3 点セットで直す（**B-6 として独立タスク化**）:

1. `CalendarPage` に `searchParams` を足す（Next 16 の作法は `settings/page.tsx:21-25` に既にある）
2. `useMonthEvents` に `initialSelectedDate` を渡す（**月跨ぎ**＝ 7/31 → 8/1 の表示月差し替えも込み）
3. `notificationclick` は既存タブへ `postMessage`（`sw.js:392` の message ハンドラが既にある）するか `client.navigate()` する

> これは PR #163（CAL-4）で「既知の制限」として意図的に残された宿題じゃ。通知が要求するゆえ、ここで解消する。

#### env

| 変数 | 場所 | 備考 |
|---|---|---|
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY` | Vercel | **公開鍵は 1 変数に統一する**（下記） |
| `VAPID_PRIVATE_KEY` | Vercel（server のみ） | **一度だけ生成し、以後変えない**（変えると全購読が無効化される） |
| `VAPID_SUBJECT` | Vercel | `mailto:` |
| **`NOTIFY_CRON_SECRET`** | Vercel + **Supabase Vault** | **`CRON_SECRET` と別値にする**（下記） |
| `CRON_SECRET` | Vercel（既存） | google-sync 用。**`env.example` に現在記載が無い** — 同時に直す |

全て `process.env.X?.trim()` で読む（既存の作法。ペースト時の末尾改行が過去 4 回再発している）。

> ⚠️ **公開鍵を `VAPID_PUBLIC_KEY` と `NEXT_PUBLIC_VAPID_PUBLIC_KEY` の 2 本に分けるな。** 二重真値源ゆえ、食い違うと**無音で全配信が落ちる**。1 変数に統一し、サーバ起動時に秘密鍵とのペア整合を assert せよ。
>
> ⚠️ **`NEXT_PUBLIC_VAPID_PUBLIC_KEY` が未設定のまま `pushManager.subscribe()` を呼ぶな。** 環境によっては購読が成立して設定カードが「有効」と表示するのに、送信は全て 403 になる（＝**カードが嘘をつく**）。未設定なら subscribe を呼ばず「未設定」状態を出す。
>
> ⚠️ **notify 用の secret を google-sync の `CRON_SECRET` と共有するな。** 2 つ理由がある: (a) 片方の漏洩が両方を開ける、(b) **pg_net は `Authorization` ヘッダを DB のキューテーブル（`net.http_request_queue` / `net._http_response`）に保存する** — Dashboard の SQL エディタから読める場所に秘密が滞留する。Vercel 自身の cron は `CRON_SECRET` を自動送出するゆえ、そちらとは分けるのが筋じゃ。

### 4.4 エラー処理・ログ

- Supabase の error は plain object ゆえ `logSupabaseError` を通す（`instanceof Error` は false）
- push の送信失敗は握り潰さず、status ごとに分岐して構造化ログ。**ただしペイロードは必ずログから除外する** — 入れると Vercel のログへ予定タイトルが落ちる
- **410/404 のみ購読を削除する allowlist**。401/403/5xx は削除せず再試行に回す
  > 「再試行は広く、破棄は狭く」— 4xx 一括で購読を消すと、一時的な認可エラーで**購読が消え通知が永久に止まる**

### 4.5 セキュリティ

| 項目 | 方針 |
|---|---|
| RLS | 全テーブル SELECT/INSERT/UPDATE/DELETE を分離（**FOR ALL 禁止**） |
| 購読の所有 | `user_id = auth.uid()` で本人のみ。他人の端末を消せない |
| service role | `/api/cron/notify` の**認可通過後にのみ**生成（google-sync と同型） |
| 秘密の格納 | migration にベタ書き禁止（public repo）→ **Vault** |
| 通知の中身 | 予定タイトルはロック画面に出る。**メモ本文は載せない**（機微が漏れる）。`tag` は **event id（UUID）固定**（タイトルを混ぜると置換挙動から内容が推測されうる）。`notificationclick` の URL に予定 id を載せぬ（ブラウザ履歴に残る）。**push ペイロード自体は aes128gcm で E2E 暗号化される**ゆえ APNs/FCM からは読めぬ |
| 列 GRANT | `push_subscriptions` の `(endpoint, p256dh, auth)` は**送信能力そのもの**ゆえ SELECT 権から外す。行 RLS だけでは既存の二段防御を下回る |
| 監査 | `notification_deliveries` は実際に送った行のみ記録（候補配列を書かない） |

---

## 5. Options and Decisions

### 5.1 ② の到達手段（比較）

| 案 | 到達性 | 費用 | 判定 |
|---|---|---|---|
| **Web Push** | 妻 iPhone（ホーム画面追加済み）✓ / 主 Android ✓ | 0 | **採用** |
| Google カレンダーへ書き戻し | **共有していないため経路なし**。かつ `reminders` は "for the authenticated user" | 0 | **却下** |
| Notification Triggers | Google が "development ... **has ended**" と明言。MDN に頁なし | 0 | **却下** |
| メール通知 | 届くが「予定の 30 分前」の即時性に向かぬ。`profiles` に email 列も無い | 0 | 却下 |
| LINE Notify | **2025-03-31 にサービス終了** | — | 却下 |
| ネイティブアプリ | iOS 配布に $99/年。既に見送り済み | $99/年 | 却下 |

### 5.2 ② のスケジューラ（比較）

| 案 | 粒度 | 費用 | 致命的な弱点 | 判定 |
|---|---|---|---|---|
| **Supabase pg_cron** | 毎分 | 0 | Free の pause で静かに死ぬ / pg_net は beta | **採用**（主の選択） |
| Vercel Pro | 毎分 | $20/月 | なし | 却下（費用） |
| Cloudflare Workers | 毎分 | 0 | インフラが 1 つ増える / CPU 10ms | 却下 |
| GitHub Actions | 5 分 | 0 | "some queued jobs may be **dropped**" / public repo は **60 日で自動無効化** | **却下**（信頼性） |
| Vercel Hobby cron | 1 日 1 回 | 0 | 分粒度の式は**デプロイが失敗する** | 不可 |

### 5.3 ③ の朝夜の切り方（比較）

| 案 | 判定 |
|---|---|
| **12 時で切る**（朝 00-11:59 / 夜 12-23:59） | **採用**（主の選択）。JST 暦日をそのまま使え、日跨ぎの補償が不要 |
| 生活リズム案（朝 4-12 / 夜 12-翌 4） | 却下。日跨ぎ行を前日へ付け替える実装が要る（授乳の `lastFeedingFallback` と同類の複雑さ） |
| 朝/昼/夜の 3 枠 | 却下。平時は「昼」が常に空になり、カードの横幅も食う |

### 5.4 意思決定記録

| ID | 判断対象 | 採用 | 却下 | 理由 | 見直し条件 |
|---|---|---|---|---|---|
| DR-1 | ① の分母 | **昨日までの 7 日**（8 日窓） | ÷7（今日込み）／経過時間で按分 | 今日込みは朝ほど過小に出て、時刻で意味が変わる。按分は不透明 | 主が実物を見て「今日も入れたい」と言えば `AVERAGE_EXCLUDES_TODAY` を false に（1 箇所） |
| DR-1b | ① 平均とグラフの窓のズレ | グラフは今日含む 7 本を**現状維持**、平均は昨日まで 7 日。ラベルで期間を明示 | グラフも昨日までにする／8 本表示 | グラフ変更の回帰リスクを避ける。代替案「今日を除く 6 日平均（グラフと完全一致）」は定数で切替可能にして温存 | 「数字が合わぬ」と感じられたら 6 日平均へ |
| DR-2 | ① おむつの分子 | `diaperCount`（`both`=1 回） | `sumDiaperBreakdown`（`both` を 2 計上） | 隣のバーグラフの高さと一致させる | — |
| DR-3 | ③ 朝夜の持ち方 | `logged_at` から**導出** | DB に `slot` 列を足す | 列にすると過去行が全 NULL、境界も変えられぬ | 「朝の分を夜に付け替えたい」等、人が上書きしたい要求が出たら列を検討 |
| DR-4 | ② の到達手段 | Web Push | Google 書き戻し | 夫婦で Google カレンダーを共有していない | 共有を始めたら再検討 |
| DR-5 | ② のスケジューラ | Supabase pg_cron（`*/5`） | Vercel Pro / Cloudflare / GH Actions | 費用 0 かつ既存の cron 認証パターンに乗る（主の選択） | 通知が繰り返し落ちるなら Vercel Pro へ |
| DR-6 | ② の配信方式 | キュー（`notification_deliveries`） | 撃ちっぱなし | cron は公式に落ちる・重複すると明言。Safari は遅配の雪崩で権限を剥奪する | — |
| DR-7 | ② の通知設定の置き場 | 新テーブル `notification_preferences` | `profiles` に列追加 | profiles の厳格な列 GRANT を緩めたくない | — |
| DR-8 | ② の粒度 | 5 分 | 毎分 | `job_run_details` が 1 日 1440 行たまり Free の 500MB を食う。10 分前通知に対し最大 5 分ズレは許容 | 精度不足の実感が出たら毎分＋掃除強化 |
| DR-9 | ② の failure 時の購読削除 | **410/404 のみ**（allowlist） | 4xx 一括（blocklist） | 一時的な認可エラーで購読が消え、通知が永久に止まる | — |
| DR-10 | ② の通知本文 | タイトルと時刻のみ | メモ本文も載せる | ロック画面に機微が出る | — |
| DR-11 | ③ のグラフ | 今回作らない | 体温の折れ線 | 主が不要と判断 | 発熱時の推移を追いたくなったら |
| DR-12 | ①③ と ② の同居 | **トラックを分けリリース単位も分ける** | 1 本の大きな PR 群 | ② は到達性が実証されるまで不確実。①③ を人質にしない | — |
| **DR-13** | 通知設定の置き場 | **新テーブル `event_reminders`（世帯単位）** | `calendar_events` へ列追加 | `calendar_events` の UPDATE は `source='native'` 限定ゆえ **google 行に通知を付けられぬ**。不変条件を緩めるのは論外。別テーブルなら `CALENDAR_EVENT_COLUMNS` も無傷で、4 つの共有消費者を巻き込む順序事故も消える | google 行への通知が不要と判明したら簡素化できる |
| **DR-14** | ③ の記録ボタンの範囲 | **`isToday` のみ**（過去日は閲覧のみ） | 過去日でも記録可 | `BabyLogFormSheet` は create 時に `todayJstString()` 固定で `logDate` prop が無く、`appendLog` も日付を検査せぬ。解禁は `baby-optimistic-log.ts:14-18` が名指しで禁じた F-03 そのもの。訴え③は「今日の朝夜」ゆえこれで足りる | 過去日記録が要れば F-03 として別 PR |
| **DR-15** | 毎朝ダイジェストの位置 | **B-5（最後の独立 PR）** | B-3 に織り込む | 敵対レビューが「トラック B の複雑さの主因」と判定。**主が明示的に選んだゆえ落とさぬ**が、訴え②の本体（予定通知）を人質にしない | — |
| **DR-16** | キューの重複排除キー | **`event_key`（FK なし・不変コピー）** | `event_id`（FK） | 履歴を守るため `event_id` を SET NULL にすると、`NULLS NOT DISTINCT` 下で「削除後の 2 行」が誤衝突する | — |
| **DR-17** | 送信の排他 | **`UPDATE ... WHERE sent_at IS NULL RETURNING *` で claim** | 素の SELECT → 送信／`FOR UPDATE SKIP LOCKED` の RPC | キューは INSERT の冪等しか担保せぬ。cron の重複起動で 2 プロセスが同じ行を送る。家庭規模・5 分粒度ゆえ単文 UPDATE の行ロックで十分。**逐次テストでは弁別できぬことを承知で採る**。⚠️ **`sent_at` を claim に兼用するため、claim 後・送信前にプロセスが落ちるとその 1 通は恒久喪失する（at-most-once）** — リマインダーは欠落の方が痛いが、夫婦 2 人・5 分粒度では稀ゆえ受け入れる | 「なぜか 1 回だけ来なかった」が続くなら claim 列を `sent_at` から分離する |
| **DR-18** | pg_cron の登録先 | **Dashboard の手順書（`docs/runbooks/`）** | migration | Vault の secret はローカルにも CI にも無く、`vault.decrypted_secrets` を参照する migration は pgTAP で**検証不能**（緑でも赤でも意味を持たぬ） | — |
| **DR-19** | 通知を予定へ結ぶキー | **安定キー `event_uid`（生成列・FK なし）** | `calendar_events.id` への FK | **410 フル再同期が google 行を全 DELETE → 新 UUID で再挿入する**（`sync.ts:388-393` を実読して確認）。行 id に結ぶと CASCADE なら通知が全滅、SET NULL なら二度と紐づかぬ。**どちらも「静かに消える」** | Google 同期をやめたら `id` FK へ単純化できる |

---

## 6. Implementation Phases

### トラック A（①③）— DB 変更なし・先に出す

| Phase | 目的 | 完了条件 | リリース条件 |
|---|---|---|---|
| A-1 | ① 週間平均 | 平均が表示され、分母が「昨日まで 7 日」であることがテストで固定 | 1412 + 新規テストが緑 |
| A-2 | ③ 朝夜の体温カード | 朝/夜スロットが表示され、空きから記録できる | 同上 |

A-1 と A-2 は**独立**（触るファイルが交差しない）。並行してよい。

### トラック B（②）— スパイクで門を開けてから

| Phase | 目的 | 完了条件 | リリース条件 |
|---|---|---|---|
| **B-0** | **到達性のスパイク** | **妻の iPhone に手動で 1 通届く** | コードはマージしない（使い捨ての検証枝）。ただし**VAPID 鍵は本番のものを生成して保管する**（下記） |
| B-1 | 購読基盤（M1 + SW push + 設定カード） | 両端末で購読でき、手動送信で通知が出る | B-0 が通っていること |
| B-2 | 予定への通知設定（M2 + フォーム） | 予定に通知時刻を付けられ、`remind_at` がサーバ導出される | B-1 マージ済み |
| B-3 | 配信キューとジョブ（M3 + `/api/cron/notify` + pg_cron） | 実際に時刻どおり通知が届く（**予定通知のみ**） | B-2 マージ済み。~~pg_cron / pg_net の実機確認~~ → **2026-08-06 に完了**（本番で両方 Success） |
| B-4 | 失効処理と診断（`pushsubscriptionchange`・起動時突き合わせ・心拍表示） | 410 で宛先が外れ、`最終実行`/`最終配信` が設定画面に出る | B-3 マージ済み |
| **B-5** | **毎朝ダイジェスト** | 指定時刻に今日の予定が 1 通届く | B-4 マージ済み |
| **B-6** | **通知の着地先（`?date=` 対応）** | 明日の予定の通知をタップして明日が開く（月跨ぎ込み） | B-1 以降ならいつでも。B-5 より**前**が望ましい |

> **ダイジェスト（B-5）を最後に回す理由**: 敵対レビューが「トラック B の複雑さの主因」と判定した。これ 1 つで (a) `event_id` の nullable、(b) 窓一致選出（catch-up 不能）、(c) `kind` 判別子 が生える。**主が明示的に選んだ機能ゆえ落とさぬ**が、**予定通知（訴え②の本体）を人質にしない**。B-4 まで出れば訴え②には答えている。
>
> **B-5 で必ず守ること**: 選出述語を `scheduled_at <= now()`（event と同型）にせよ。「`digest_time` が今の 5 分窓に一致」で書くと、**cron が 1 回落ちたその日の digest は永久に来ぬ** — DR-6 が謳う catch-up が digest だけ成立しなくなる。前夜または当日 0 時に翌日ぶんのキュー行を立て、時刻が来たら送る形にする。

> **B-0 を飛ばしてはならぬ。** これが通らねば B-1〜B-4 は全て無駄になる。ウィジェットの時と同じ過ちを繰り返さぬための門じゃ。

> **B-0 の VAPID 鍵は捨て駒にするな。** コードは使い捨てでよいが、**鍵は本番のものを生成して Vercel env と手元に保管する**。鍵を後で作り直すと**既存の購読が全て無効化され、妻にもう一度購読させることになる**（R8）。B-0 で妻の端末に購読させた実績を、そのまま B-1 以降で使えるようにしておく。

> **B-3 の前提**: Supabase Free で pg_cron が使えるかは**公式に明記が無い**（禁止の記述も無い）。Dashboard で `create extension pg_cron` を試すのが唯一の確証。**ここが通らねば DR-5 を見直す**（Cloudflare か Vercel Pro へ）。

---

## 7. Task Breakdown

| ID | タスク | 担当 | 依存 | 変更対象 | 完了条件 | 検証 |
|---|---|---|---|---|---|---|
| **A-1-1** | 平均の純関数 | 中位 | — | `domain/baby-weekly-summary.ts` | `averageBabyWeeklySummary` が `{feedingPerDay, diaperPerDay, sampleDays}` か `null`。**既定 `days` は 7 のまま**（呼び出し側で 8 を渡す） | 単体（全 0→null / 丸め / **記録 3 日なら sampleDays=3**） |
| **A-1-2** | 取得窓を 8 日へ・**表示窓は 7 日のまま分離** | **上位** | A-1-1 | `baby/page.tsx:14`, `baby-dashboard.tsx:112`, 窓定数は**中立モジュール**へ | `fetchStartDate(-7)` と `displayStartDate(-6)` を別変数に。**グラフ・合計・おむつ内訳は全て `displayStartDate`**（意味を変えぬ） | **「8 日前の Realtime INSERT で平均が動く」新規テスト**（既存 9 本は 8 日目に盲目ゆえ検知にならぬ）＋ 既存 7 本が緑 |
| **A-1-3** | 表示 | 中位 | A-1-2 | `weekly-summary/baby-weekly-summary.tsx` | `8.3 回/日` と実測期間ラベル。空は `— 回/日` | jsdom。「おしっこ4・うんち3 がちょうど2箇所」は**旧値を守る回帰テストとして残す**（新値へ書き換えるな） |
| **A-2-1** | スロット判定の純関数 | 中位 | — | 新規 `domain/baby-temperature-slots.ts` | 境界・同枠複数の最新選択（epoch 比較）・JST 判定。**`extractTemperatures` は使わず `BabyLogData` から組む** | 単体（11:59 と 12:00 を**対で**） |
| **A-2-2** | 体温カード | 中位 | A-2-1 | 新規 `baby-temperature-card.tsx`, `baby-dashboard.tsx` | 朝/夜が出る。**`＋ 記録` は `isToday` のみ**。過去日は閲覧のみ。**`logs`（選択日）から導出し自前 fetch をしない** | jsdom。**一意な `aria-label`**（既存「体温」ボタンと multiple-match しないこと）。タッチ領域は既存 e2e が自動で拾う |
| **B-0** | **到達性スパイク** | 主＋中位 | — | 使い捨て枝（**鍵は本番用**） | **妻の iPhone に 1 通届く** | **実機**。`pnpm build && pnpm start`（dev では SW が登録されぬ） |
| **B-1-1** | migration M1 | 中位 | B-0 | 新規 migration | `push_subscriptions` + RLS **4 本**（UPDATE を含む）+ **列 GRANT で三つ組を隠す** + publication 非追加の明文宣言 | pgTAP（**2 人 seed**・列 GRANT の `set_eq`・`throws_like`） |
| **B-1-2** | SW の push ハンドラ | 中位 | B-0 | `public/sw.js`, `pwa/__tests__/sw-logic.test.ts` | `push`/`notificationclick`/**`pushsubscriptionchange`**。壊れたペイロードでも必ず可視通知 | **vm スタブの `addEventListener` を記録関数へ変え、登録イベント名の集合を assert**（綴りを壊して赤になることを実証） |
| **B-1-3** | 購読 Action + 設定カード + **サインアウト解除** | 中位 | B-1-1,2 | 新規 `settings/notification-card.tsx`, `settings/actions.ts` | 許可要求がユーザー操作起点。**公開鍵未設定なら subscribe せず「未設定」表示**。`signOut` で行 DELETE + `unsubscribe()` | jsdom + **e2e**（jsdom に `PushManager` は無い）+ 実機 |
| **B-2-1** | migration M2 | **上位** | B-1 | 新規 migration | `calendar_events` に**生成列 `event_uid`** + **`event_reminders`**（`event_uid` で結ぶ・google 行にも付く）+ **BEFORE トリガで `remind_at` を強制導出** + `notification_preferences`（**UPDATE ポリシーあり**・`digest_time` は JST 契約を COMMENT に） | pgTAP（`throws_like` で CHECK・**PostgREST 直叩きで `remind_at` を偽装しても上書きされる**・**google 行を delete→再 insert しても通知が生き残る**） |
| **B-2-2** | 予定フォーム + 再スケジュール畳み込み | **上位** | B-2-1 | `calendar-event-form-sheet.tsx`, `calendar/actions.ts` | 5 択が出て既定値が引かれる。**`remind_at` が動いたら同 `event_key` の未送信キュー行を同一 tx で `rescheduled` に畳む** | **「時刻を編集したら旧キュー行が発火しない」回帰テスト** |
| ~~B-3-0~~ | ~~pg_cron / pg_net の実機確認~~ | — | — | — | **完了（2026-08-06・本番で両方 Success）** | — |
| **B-3-1** | migration M3 | 中位 | B-3-0 | 新規 migration | `notification_deliveries` + `household_id` + **`event_key`** + `UNIQUE NULLS NOT DISTINCT` + 両 FK が **SET NULL** + `notification_heartbeat` | pgTAP（**digest 行を 2 回 INSERT して弾かれる** / `.upsert(onConflict)` が実 DB で解決する / **2 人 seed で配偶者の行が見える**） |
| **B-3-2** | 配信ジョブ | **最上位／上位** | B-3-1 | 新規 `api/cron/notify/route.ts` | 選出述語（**`start_at > now` を含む**）・grace・**claim してから送る**・世帯ごとループ・410 分岐・**心拍 upsert** | 単体（fake timers で決定的に）+ **e2e は `request` フィクスチャ（cookie 無し）で cron route を列挙して 401** |
| **B-3-3** | pg_cron 登録 + Vault | 主 | B-3-2 | **新規 `docs/runbooks/notify-cron.md`（migration ではない）** | 5 分毎に発火。**Vault の秘密が schedule 発火前に入っている**。掃除ジョブも登録。回転手順を併記 | 実機（`sent_at` と `ran_at` が進む） |
| **B-4-1** | 失効処理 + 起動時突き合わせ | 中位 | B-3 | `api/cron/notify/route.ts`, クライアント | **410/404 のみ**削除。起動時に `getSubscription()` と DB を照合し張り直す | 単体（**削除 status の集合を `{410,404}` として assert し、401/403/429/500 を表駆動で**） |
| **B-4-2** | 診断表示 | 中位 | B-4-1 | `settings/notification-card.tsx` | **`最終実行`（心拍）と `最終配信` を並べて**出す。端末一覧・`failure_count` も | jsdom + 実機 |
| **B-5** | 毎朝ダイジェスト | 上位 | B-4 | migration + `api/cron/notify` | **選出は `scheduled_at <= now()`**（窓一致にするな）。前夜に翌日ぶんのキュー行を立てる | 単体（**cron を 1 回落としても届く**ことを固定） |
| **B-6** | 通知の着地先（`?date=`） | 中位 | B-1 | `calendar/page.tsx`, `use-month-events.ts`, `sw.js` | 明日の予定の通知をタップして**明日が開く**（**月跨ぎ 7/31→8/1 込み**）。既存タブは `postMessage`/`navigate` で日付を動かす | jsdom + e2e |
| **X-1** | CLAUDE.md の訂正 | 軽量 | — | `CLAUDE.md` | 「proxy の `/api/` 未除外の地雷は現存」→ Phase D で解消済みへ | grep |
| **X-2** | `env.example` の欠落 | 軽量 | B-1 | `env.example` | `CRON_SECRET` / `NOTIFY_CRON_SECRET` / VAPID を追記 | grep |
| **X-3** | `admin.ts` の契約更新 | 中位 | B-3-2 | `src/lib/supabase/admin.ts` | 「横断スキャン → 世帯ごとループ」の型を義務として明記 | grep + レビュー |
| **X-4** | 検証記録の伏字ルール | 軽量 | B-0 | `docs/` | **B-0 の記録に購読 endpoint / `p256dh` / `auth` を貼らぬ**（＝完全な送信権限の公開になる） | grep |

> **B-3-2 と A-1-2 と B-2-2 は上位モデルに渡す。** それぞれ「時刻境界・冪等・不可逆な削除判定」「窓の分離（既存の 3 つの数字を壊さぬこと）」「二重真値源の同一 tx 整合」が集中しており、誤ると無音で壊れる。

---

## 8. Test Strategy

### 単体（vitest）

| 対象 | 何を固定するか |
|---|---|
| `averageBabyWeeklySummary` | 全 0 → `null`（`0.0` ではない）／`sampleDays` が 7／丸め |
| 8 日窓 | **既存の Realtime 差分テスト 9 本が緑のまま**（窓拡張の見落としを検出する唯一の網） |
| `assignTemperatureSlot` | 11:59 と 12:00 を**対で**置く。片側だけでは境界がズレても通る |
| `remind_at` 導出 | 終日/時刻付き/前日20時。**クライアント送信の `remind_at` が無視されること** |
| 配信の選出述語 | `vi.useFakeTimers()` で決定的な 1 点まで進める。**`waitFor` に等値アサートを入れてはならぬ**（本数が変わる途中で通過した瞬間に緑になる） |
| grace window | 期限内は送る / 期限切れは `skipped_at` が立つ、を**対で**置く |
| 410/404 の削除 | **削除対象 status の集合そのものを `{410, 404}` として assert し、非削除 status（401/403/429/500）を表駆動で回す**。「401 で残る」1 本だけでは、403/429/500 で blocklist が復活しても緑になる |
| **SW のリスナ登録** | **`install/activate/fetch/message/push/notificationclick/pushsubscriptionchange` の登録済みイベント名集合**を `set_eq` 相当で固定（下記 ★） |

> ★ **これがこの計画で最も「テスト緑・本番不発」を作りやすい筋じゃ。** `src/lib/pwa/__tests__/sw-logic.test.ts:36` の vm スタブは **`addEventListener: () => {}` の完全な no-op**。ゆえに `push` を `"pushnotification"` と綴り間違えても、`__TEST_HOOKS__` に載せた純関数のテストは**全部緑のまま本番では 1 通も届かぬ**。CLAUDE.md の「規約ファイルは在るだけでは効いておらぬ（単体テストは default export を直接呼ぶためファイルが inert でも緑）」と同 family じゃ。
> **弁別子**: vm スタブの `addEventListener` を**記録関数に変え**、登録されたイベント名の集合を assert する。**綴りを 1 文字壊して赤になることを実証してから**完了と言え。

### pgTAP

- **必ず夫婦 2 人 + 他世帯 1 人を seed する**。1 人だけだと `notification_deliveries` の SELECT が「世帯内」ではなく「自分のみ」に縮退していても**永久に緑**になる（B-4 の縮退はこの形でしか捕まらぬ）。「配偶者の行が見える」「他世帯は見えぬ」を**対で**置く
- **列 GRANT を `set_eq` で固定**する（`push_subscriptions` の SELECT 権が `endpoint`/`p256dh`/`auth` を含まぬこと）。catalog の `set_eq` **と** 行動テスト `throws_ok` の**両方**を置く — `supabase/tests/google_calendar_sync_grants_rls.sql:104-205`（catalog）と `:327-382`（行動）が既にその型じゃ
- **`UNIQUE NULLS NOT DISTINCT` が効いていること**: `event_key IS NULL` の digest 行を**同じ値で 2 回 INSERT し、2 行目が弾かれる**ことを見る。既定の `NULLS DISTINCT` のままだと 2 行入る（＝ダイジェスト二重配信）。この 1 本が無ければ、二重通知は本番で妻の端末にしか現れぬ
- **`.upsert({onConflict})` が実 DB で解決できること**: `supabase/tests/google_sync_upsert_conflict.sql` と同型を新キーにも置く。列名しか出せぬゆえ、キー形状の誤りは **`42P10` で本番のみ**落ちる
- **seed が効いていることを先に assert する**（`google_calendar_sync_grants_rls.sql:289-299` の「B-0. seed が効いておること … ここが赤いなら以降の assert は行が無いだけの偽緑じゃ」の型）。グローバル count は外部の DB 状態で壊れるゆえ seed 限定に

> ⚠️ **訂正: 「`throws_ok` に制約名を必ず書く」は機構的に誤りじゃった。** pgTAP の `throws_ok(sql, errcode, errmsg, desc)` は **errmsg を完全一致で比較する**。`'chk_reminder_kind'` は実際の `'new row for relation "event_reminders" violates check constraint "chk_reminder_kind"'` と等しくならず、**テストが落ちる**。
> 正しい機構は **`throws_like(sql, '%chk_reminder_kind%', desc)`**（または `throws_matching`）。
> 意図（「errcode だけでは別の理由の throw で偽緑になる」）は正しい — 既存 `supabase/tests/baby_breast_counts.sql:24-28` は `'23514', NULL` で message を捨てており、まさにその偽緑を抱えておる。完全一致を正しく書けているのは `google_calendar_sync_grants_rls.sql:327-330` の `'42501', 'permission denied for table google_tokens'` の型のみじゃ。

### E2E（Playwright）

- **cron route の認可**: `src/app/api/cron/*/route.ts` を**列挙して**、各々が secret 無しで **401 を返す**（307 でも 200 でもない）ことを回す
  > - Route Handler の直接 import では proxy を通らず「テスト緑・本番 100% 不発」になる。公式も "Cron jobs **do not follow redirects**... they will **not be shown in the logs**" と明言している
  > - ⚠️ **cookie を持たぬ `request` フィクスチャを使え。** `proxy.ts:142-150` は**承認済みユーザーが `isPublicRoute` を踏むと `/` へ 307 する**ゆえ、ログイン済み context から叩くと proxy に食われておらぬのに 307 が返り**偽陽性の赤**になる。既存 `e2e/google-cron-proxy.spec.ts` が `request` フィクスチャを使っておるのはこのためじゃ
  > - ⚠️ **1 本を名指しせず列挙せよ。** 次に cron route が増えた瞬間に取りこぼす（CLAUDE.md「全呼び出しを走査し、包まれていないものが理由付き allowlist と完全一致することを assert せよ」）
- 設定カードの状態表示（jsdom には `serviceWorker` も `PushManager` も無いため、**e2e で本物の分岐を踏む**）
- **`@playwright/test` は 1.61.1 に留める**（1.62.1 は `setOffline` の忠実性が落ちオフライン e2e が落ちる）
- **タッチ領域は既存 `e2e/touch-targets.spec.ts` が自動で拾う**（`/baby` と `/settings` を含む 6 画面の全 `button`/`[role=button]`/`a[href]` を実ブラウザで実測、例外リスト無し）。新カードのボタンは**書くだけで網に掛かる** — 手動確認に回すな

> ⚠️ **Push は `next dev` では一度も確認できぬ。** `src/components/common/service-worker-manager.tsx:21` は SW を **`NODE_ENV === "production"` でしか登録せず**、dev では `:44-51` が既存登録を **unregister する**。ゆえに「通知を有効にする」ボタンは dev で必ず失敗する。**B-0 / B-1 の手順に `pnpm build && pnpm start` を明記せよ。**

### 実機（機械では代替できぬもの）

| # | 何を | なぜ機械で代替できぬか |
|---|---|---|
| 1 | **B-0: 妻の iPhone に 1 通届く** | iOS の Web Push はホーム画面 PWA 限定で、実端末以外に証人がおらぬ |
| 2 | B-3: 時刻どおりに届く | pg_cron → pg_net → Vercel の連鎖は本番でしか繋がらぬ |
| 3 | 主の Android にも届く | 片翼だけ届く状態が無音で成立しうる |
| **4** | **妻の iPhone へ「壊れたペイロードの push」を 1 通送り、汎用文言の通知が出ること** | node:vm は `self.registration.showNotification` も `event.waitUntil` の実挙動も持たぬゆえ、「**実際に通知が出た**」ことを原理的に証明できぬ。**これを外すと、権限剥奪（復旧にユーザー操作が要る事故）を緑のテストのまま踏む** |
| 5 | ①③ の目視 — **390px でカードが崩れぬか / 発熱域の表示が暗所で読めるか に絞る** | 平均値・スロット振り分け・空状態・タッチ領域は全て機械で決着する（上記のとおり touch-targets e2e が自動で拾う）。目視に回すのはレイアウトと視認性だけ |

> ⚠️ 「壊れたペイロードでも `showNotification` が呼ばれる」を node:vm の純関数テストだけに任せてはならぬ。**呼ばれたことは検証できても、通知が出たことは検証できぬ。** これは Safari の権限剥奪（R3）への唯一の防御ゆえ、実機で 1 回は見よ。

### ⚠️ 壊れる既存テスト（トラック A・実体を grep で特定済み）

**当初 2 本と見積もったが、実際は最低 6 本。条件次第で 9 本以上じゃ。**

| ファイル : テスト名 | 壊れる理由 |
|---|---|
| `domain/__tests__/baby-weekly-summary.test.ts` : `終了日を含む7日分をゼロ埋めで返す` | 引数 2 つで呼び **7 要素を `toEqual` で完全一致**（:17-27）。**既定 `days` を 8 に変えれば即赤／呼び出し側で `days=8` を渡すなら緑** — A-1 は**どちらを採るか明記せよ**（推奨: 既定は 7 のまま、呼び出し側で 8 を渡す） |
| 同 : `授乳・おむつを日別に集計する` | `result[5]`/`result[6]` と**添字**で assert（:40-49）。既定 8 日化で全添字が 1 ずれる |
| 同 : `範囲外のログを除外する` | `2026-04-04T23:59` を「範囲外」として合計 0 を期待（:52-64）。既定 8 日窓なら**この行が範囲内に入る**。窓拡張の意味論を突く最良の赤 |
| `weekly-summary/__tests__/baby-weekly-summary.test.ts` : `おむつ内訳は…ちょうど2箇所` | `toHaveLength(2)` で固定（:53-54）。上部 StatHeader を平均へ置き換えると 1 になる。**無条件で赤** |
| 同 : `週間合計と2種類のグラフを描画する` | `toContain("3回")` はグラフ見出しが残れば緑・平均へ置換すれば赤。`aria-label="直近7日の…"`（:30-31）は**グラフを 8 本にすれば嘘になる**（変えれば赤・変えねば嘘） |
| `__tests__/baby-dashboard.test.tsx` : `週外の feeding INSERT は週間サマリーに影響しない` | `expect(beforeTitles).toHaveLength(7)`（:284）。8 要素を渡せば赤・スライスすれば緑。**この 1 本だけが「グラフ 7 本維持」を守る網**（平均側は守らぬ） |
| 同 : `真夜中跨ぎ: … chart labels がシフトする` | 7 要素配列を `toEqual`（:383-410）。同上 |
| `baby-dashboard-datenav / -optimistic / -feeding-estimate.test.tsx` | **条件付き**。`buildInlineReducerSupabaseMock` は `supabase.from()` で throw する（`baby-dashboard.test.tsx:59-61`）ゆえ、**体温カードが自前で fetch すれば 3 ファイルまとめて赤**。`logs` props から導出するなら緑 |

**⚠️ 既存の Realtime 差分テスト 9 本は 8 日目に対して盲目じゃ。** 全て `chartTitles("直近7日の授乳回数")` 経由でしか state を観測しておらず（`baby-dashboard.test.tsx:174,243,282,324,358,380` 等）、バケット 0 はグラフに出ぬ。ゆえに **`baby-dashboard.tsx:112` の `-6` を `-7` に直し忘れても 9 本は全て緑**。当初これを「窓拡張の見落としを検出する唯一の網」と書いたが**誤りじゃった** — 検知手段は実質ゼロで、平均だけが静かにズレる。
→ **「8 日前の Realtime INSERT で平均が動く」を assert する新規テストを 1 本置く**（グラフを経由せぬ観測点）。

**⚠️ アクセシブル名の衝突**: `baby-quick-actions.tsx:203` に既存の「体温」ボタンがある。新カードのボタンに「体温」を単独で使うと `getByRole("button", { name: /体温/ })` 系が multiple-match で割れる。**「今日の朝の体温を記録」等の一意な `aria-label`** にせよ。

**⚠️ 窓の literal は 2 箇所のみ**（`baby/page.tsx:14` と `baby-dashboard.tsx:112`）。`api/baby-report/route.ts:41` の `shiftYmd(today,-7)` は PDF の「1week」用の**独立した literal** ゆえ ① の波及なし。**逆に、共有定数化する際にここを巻き込むな。**
窓定数は `src/lib/domain/baby-weekly-summary.ts`（**境界指令を持たぬ中立モジュール**）に置き、`page.tsx`（Server）と `baby-dashboard.tsx`（`"use client"`）の**両方**が import する形にせよ。集約先を client 側にすると「`"use client"` の値を Server Component が import」の罠（2026-07-26 の実績あり・tsc も build も vitest も緑のまま e2e で発覚）を踏む。

### 移行検証

- **migration が先、コードのデプロイが後**。新コードが `remind_at` を SELECT するのに列が無いと **PostgREST が 400 を返し `/calendar` がページごと落ちる**。
  - これは `drop_baby_sleep` の「コードが先、migration が後」の**逆**である。両者は矛盾しない — **削除は「読む側を先に消す」、追加は「読まれる側を先に作る」**。どちらも「存在しない列を SELECT する瞬間を作らない」という同じ原則の表裏じゃ
- `ALTER TYPE ADD VALUE` は本計画では発生しない（新 ENUM 値なし）
- ロールバック: 列追加は旧コードを壊さぬため、**コードだけ revert すれば復旧する**（列は残してよい）。migration の revert は不要

---

## 9. Risks

| # | リスク | 可能性 | 影響 | 予防 | 検知 | 復旧 |
|---|---|---|---|---|---|---|
| R1 | Supabase Free の pause で通知が止まる | **低** | 中 | pause 条件は「週 1 回の DB 活動が無い」＝夫婦が 1 週間 irori を開いていない状態。事前警告メールが 1 通来る | **アプリ自体が開かなくなる**ので「静かには」死なぬ | Dashboard から Resume（自動復帰しない） |
| **R1b** | **DB は生きたまま通知だけ止まる** | **中** | **高** | `cron.schedule` が消える／pg_net が 401 を返し続ける／Vercel が落ちる — **これらは全てアプリが正常に見えたまま起きる** | **設定カードの「最終配信」**（これが唯一の検知手段。R1 ではなくこちらが本命） | 原因ごと。まず `cron.job_run_details` と `net._http_response` を見る |
| ~~R2~~ | ~~pg_cron が Free で使えない~~ | **消滅** | — | **2026-08-06 に本番実機で確認済み**（`create extension` が両方 Success）。公式に明記が無かった論点を実機で潰した | — | — |
| R3 | **Safari が push 権限を剥奪** | 中 | 高 | push ハンドラは**必ず**可視通知を出す。grace window で遅配の雪崩を防ぐ | 妻の端末で通知が来なくなる | 設定カードから再許可（ユーザー操作が要る） |
| R4 | cron の取りこぼし・二重起動 | **高**（公式が明言） | 中 | キュー方式（catch-up + UNIQUE） | `notification_deliveries` の `sent_at` 欠落 | 次の実行が拾う |
| R5 | `job_run_details` がディスクを食う | 高 | 中 | 掃除ジョブを**同時に**登録（公式が「自動削除されない」と明記） | DB サイズ | 手動 DELETE |
| R6 | pg_net が beta で API が変わる | 低 | 中 | 呼び出しを migration 1 本に閉じ込める | 実行失敗 | 呼び出し形の修正 |
| R7 | **8 日窓の Realtime 判定を漏らす** | 中 | 中 | `weeklyStart` を 1 箇所に集約 | 既存 Realtime テスト 9 本 | — |
| R8 | VAPID 鍵を再生成して全購読が無効化 | 低 | 高 | 「一度だけ生成」を env のコメントと計画に明記 | 全端末で通知が止まる | 再購読（ユーザー操作） |
| R9 | 秘密が public repo へ漏れる | 低 | **高** | migration にベタ書き禁止・Vault 必須 | secret scan | ローテーション |
| R10 | 通知本文から機微が漏れる | 低 | 中 | メモ本文を載せない（DR-10） | — | — |
| R11 | ローカル Supabase が壊れており e2e が回らぬ | **既知** | 中 | CI（CLI 2.101.0 pin）で回す | — | ローカル CLI を 2.101.0 へ下げる |
| **R12** | **SW の `push` リスナが登録されず 1 通も届かぬ** | 中 | **高** | vm スタブを記録関数に変え登録イベント名を assert。**綴りを壊して赤になることを実証してから完了と言う** | 現状の no-op スタブでは**検知不能**（`sw-logic.test.ts:36` が `addEventListener: () => {}`） | 綴り修正 |
| **R13** | **claim を入れ忘れて二重送信** | 中 | 中 | `UPDATE ... WHERE sent_at IS NULL RETURNING *` | **逐次テストでは弁別できぬ**（2 接続並行が要る）。実機で重複を観測して初めて分かる | claim の追加 |
| **R14** | `event_reminders` に列 GRANT / トリガを入れ忘れ、PostgREST 直叩きで `remind_at` を偽装される | 低 | 中 | BEFORE トリガで無条件上書き | pgTAP で「直叩きしても上書きされる」を固定 | トリガ追加 |
| **R15** | **410 フル再同期で Google 予定の通知が全滅** | **中**（410 は日常的に起きる） | **高** | 安定キー `event_uid` で結ぶ（DR-19）。**行 id への FK を張らぬ** | **静かに消えるゆえ検知できぬ** — だから設計で閉じる | 設計を戻せぬ。pgTAP で「delete→再 insert しても生き残る」を固定して回帰を防ぐ |

---

## 10. Open Questions

| # | 未決 | 判断者 | 期限 | 必要な情報 |
|---|---|---|---|---|
| ~~Q1~~ | ~~Supabase Free で `pg_cron` と `pg_net` が有効化できるか~~ | — | **決着（2026-08-06 実機）** | 主が本番 Dashboard で `create extension if not exists pg_cron;` と `pg_net;` を実行 → **Success**。公式に明記の無かった「Free で使えるか」は**実機で肯定**された。DR-5 は据え置き、R2 は消滅 |
| Q2 | 毎朝ダイジェストの既定時刻 | 主 | **B-5**（B-2 ではない） | 生活リズム（07:00 を仮置き） |
| ~~Q3~~ | ~~世帯全員か作成者のみか~~ | — | **決着** | `event_reminders` を**世帯単位**にしたことで解決（夫が付けた通知は妻にも届く） |
| Q4 | ① の平均が「グラフと合わぬ」と感じるか | 主 | A-1 の実物を見てから | 代替案（今日を除く 6 日平均）は定数で切替可能にしてある |
| **Q5** | **通知のリード時間は固定 5 択で足りるか** | 主 | B-2 着手前 | 現設計は `なし/10分前/30分前/1時間前/前日20時`。「任意の分数」や「予定ごとに絶対時刻」が要るなら `remind_kind` に種別を足す形で拡張できる |
| Q6 | 授乳リマインド（「最後の授乳から 3 時間」）を後で足すか | 主 | ② 完了後 | `feeding_interval_min` は既に設定値として存在し、リマインドに繋がっていない。**今回はスコープ外**（スコープ膨張を避ける） |

---

## 11. Readiness Assessment

| 軸 | 5 段階 | 根拠 |
|---|---|---|
| 要件明確度 | **5** | 3 件とも主の回答で確定。真の性質も調査で判明。Q5（5 択で足りるか）のみ残 |
| UI/UX 成熟度 | **4** | 画面と状態は定義済み。①③ は実物を見ての微調整が残る |
| 技術設計成熟度 | **5** | ①③ は実装済み。② は **Q1（pg_cron / pg_net）が 2026-08-06 に本番実機で通り**、DR-5 の前提が裏づけられた |
| セキュリティ成熟度 | **5** | 行 RLS × **列 GRANT** の二段防御・`REVOKE ALL` → GRANT の環境差潰し・BEFORE トリガによる導出強制・publication 非追加の明文宣言・allowlist 削除・secret 分離まで設計済み |
| テスト成熟度 | **4** | 壊れる既存テスト 6+ 本を特定。SW リスナ登録の盲点と pgTAP の `throws_like` を是正済み。**claim の排他だけは逐次テストで弁別できぬ**と明示 |
| 移行準備度 | **5** | migration 3 本、いずれも新テーブルか新列のみ。`CALENDAR_EVENT_COLUMNS` に触れぬため順序事故の主経路が消えた |
| **実装着手可能度** | **トラック A: 5 / トラック B: 4** | A は今すぐ着手可。B は **B-0 スパイクと Q1** を先に通す必要がある |

### 着手前に解決すべき項目

1. **B-0（到達性スパイク）** — 妻の iPhone に 1 通届かせる。**`pnpm build && pnpm start` で行うこと**（dev では SW が登録されぬ）。VAPID 鍵は本番用を生成して保管。**残る唯一の門はこれ**
2. ~~Q1（pg_cron / pg_net の実機確認）~~ → **2026-08-06 に決着**（本番で両方 Success）
3. **Q5（リード時間の 5 択で足りるか）** — B-2 のスキーマを切る前に
4. ~~トラック A~~ → **実装済み**（PR #206 / #207）

---

## 12. レビュー履歴

| 段 | 実施 | 結果 |
|---|---|---|
| 設計 | 最上位（本エージェント） | 初版 |
| 本質レビュー | advisor（全履歴を見る） | 指摘 7 件 → **全件反映**（NULLS DISTINCT / `scheduled_at` を鍵から外す / `household_id` 非正規化の危険 / 移行順の矛盾 / VAPID 鍵の保管 / ③ が読む配列 / R1 の重み） |
| 敵対レビュー 1（Architecture Challenger） | 独立エージェント | Blocking 9 件 → **7 件反映**（`remind_kind` / `event_key` / M3 の `household_id` / CASCADE / 心拍 / 着地先 / `logDate` の事実誤認 / 8 日窓の波及 / `sampleDays`）。過剰判定 4 件のうち「digest を外せ」は**主の決定ゆえ落とさず B-5 へ後置**、「per-subscription 行は妥当」は据え置き |
| 敵対レビュー 2（Security / Test） | 独立エージェント | Blocking 9 件 → **8 件反映**（列 GRANT / UPDATE ポリシー / **google 行に通知が付かぬ** / claim の TOCTOU / `throws_like` の機構誤り / SW リスナ登録の盲点 / 壊れる既存テスト 6+ 本 / secret 分離）。1 件（`REVOKE ALL` の型）は列 GRANT と併せて反映 |
| 最終確認 | advisor（2 回目） | 4 件。うち **1 件が真の Blocking**: レビュー後に新設した `event_reminders` は**どのレビューも通っておらぬ**という指摘 → `sync.ts:388-393` を実読し、**410 フル再同期が google 行を全 DELETE → 新 UUID で再挿入する**ことを確認。行 id への FK では通知が全滅する経路を発見し、**安定キー `event_uid`（生成列）へ設計変更**（DR-19 / R15）。他 3 件（心拍の RLS 未指定 / claim の at-most-once / Q3 の独断決着）も反映 |

**二体の敵対レビューは独立に走らせ、4 つの穴を両者が掘り当てた**（NULLS DISTINCT / `household_id` 欠落 / `logDate` の事実誤認 / 移行順）。独立して同じ結論に達した指摘は確度が高いと判断し、いずれも無条件で反映した。

**わっち自身の誤りとして記録すべきもの 3 件**:
1. 「フォームは `logDate` prop を持つ」— **事実誤認**。実体はローカル導出で今日固定
2. 「既存 Realtime 9 本が窓拡張の見落としを検出する唯一の網」— **誤り**。9 本はグラフ経由でしか観測せず 8 日目に盲目
3. 「`throws_ok` に制約名を必ず書く」— **機構的に誤り**。完全一致比較ゆえテストが落ちる。正しくは `throws_like`
