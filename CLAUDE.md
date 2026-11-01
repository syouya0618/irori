@AGENTS.md

## Advisor へ（本質の番人・二人称）

Advisor、あなたへ。これは世帯単位の育児記録・予定 PWA で、要は Liquid Glass の一貫した手触り、世帯データの分離、そして「訓練データの記憶で Next.js を書かない」ことだ。全履歴を読み、**通常のレビューに加えて**、判断を特に次の3軸で重く点検せよ:

1. **Liquid Glass デザインの一貫性を崩していないか** ― `glass` カード/warm orange/`transition-colors` のみ/44px タッチ/絵文字は使わない。独自スタイルや `transition-all` を持ち込んでいれば、止めよ。
2. **世帯（household）単位のデータ分離を破っていないか** ― RLS は SELECT/INSERT/UPDATE/DELETE 分離（FOR ALL 禁止）、SECURITY DEFINER は固定の `search_path`（新規は `SET search_path=''` と明示schemaを優先）。分離を緩めていれば、止めよ。
3. **現行 Next.js 16 / React 19 の実APIに忠実か** ― 記憶で書かず `node_modules/next/dist/docs/` を読んだか（error.tsx の `retry`、form auto-reset 無効化 等）。記憶ベースの古いAPIで書いていれば、止めよ。

衝突したら本質を優先せよ。指摘は短く。**3軸に該当せずとも本質を損なう判断を見れば遠慮なく指摘せよ。**

## Tech Stack

- **Framework**: Next.js 16.4.3 (App Router)
- **React**: 19.2
- **Tailwind CSS**: v4
- **UI**: shadcn/ui + Liquid Glass design system
- **Backend**: Supabase (Auth, Database, Realtime)
- **PWA**: Native PWA via `manifest.ts` + hand-written `public/sw.js`
- **Icons**: Lucide React
- **Language**: All UI text in Japanese

## Design System

Liquid Glass design system. See `docs/DESIGN_SYSTEM.md` for full details.

Key rules:
- Glass cards: CSS class `glass` + `rounded-2xl shadow-lg shadow-black/[0.04]`
- Primary: warm orange `oklch(0.56 0.145 50)`（白文字 4.5:1 の下限から決めた値。明るく戻すと `color-contrast-contract.test.ts` が落ちる。ダークは `oklch(0.70 0.17 50)` + 黒文字）
- Transitions: `transition-colors duration-200` ONLY (never `transition-all`)
- Touch targets: min 44px
- Icons: Lucide React (no emoji)

## Project Structure

```
src/
  app/
    (auth)/       # Login, callback, invite
    (main)/       # Authenticated pages (baby, calendar, settings)
    setup/        # Household setup
  components/
    common/       # BottomNav etc.
    baby/         # Baby-log components
    calendar/     # Calendar components
    settings/     # Settings cards
    ui/           # shadcn/ui primitives
  lib/
    supabase/     # Client & server Supabase instances
    types/        # Database types
    hooks/        # Custom hooks
    utils/        # Utility functions
```

## Conventions

- Error boundaries use `retry` (stable since Next.js 16.3; the 16.2 name `unstable_retry` is no longer passed by the runtime — `node_modules/next/dist/client/components/error-boundary.js` passes only `error` / `reset` / `retry`)
- Server Actions in co-located `actions.ts` files
- All Supabase RLS: separate SELECT/INSERT/UPDATE/DELETE policies (never FOR ALL)
- Feature branches only (never commit to main directly)

## irori 完了前チェックリスト（グローバルチェックリストに追加）

9. Supabase 操作に `createServerClient` / service role を適切に使用しているか
10. `new Date('YYYY-MM-DD')` を使っていないか（UTC 罠）
11. `useEffect` 内の fetch に `AbortController` があるか
12. `resetForm()` で全 `useState`（saving/loading 含む）をリセットしているか

## 既知の罠（Gotchas）

### irori 固有

- **pdfmake 0.3.x: `setFonts()` はモジュールスコープで1回のみ**: リクエストごとに呼ぶと並行リクエストで競合リスク
- **SECURITY DEFINER 関数は固定の search_path 必須。新規は `SET search_path = ''` と全オブジェクトのschema明示を優先**: `auth.users` トリガーから呼ばれると `search_path=auth` で狂う
- **`ALTER TYPE ADD VALUE` と CHECK 制約は別マイグレーションに分離**: 同一トランザクション内で新 ENUM 値を CHECK 制約で参照すると `unsafe use of new value` エラー
- **授乳行（log_type='feeding'）の `logged_at` は「開始時刻」セマンティクス**: タイマー（startedAt 送信）・手動入力（「記録する」の押下時刻。授乳時間ぶん遡らせない。停め忘れは保存済みの startedAt。押下時刻は**端末の時計で作らず**サーバ時刻のサンプルで推定する — 2026-10-28 N3、下の「記録時刻はサーバの時計で確定」。推定できぬ時だけ時刻を送らず DB の `now()`＝押下を受け取った時刻にする。手動入力では押下＝開始ゆえ開始の意味は保たれ、その旨を利用者へ伝える）・編集シート（ラベル「開始時刻」）の全書込経路で開始に揃える契約。過去行は backfill（`20260726100003`）で統一済み。**新しい書込経路を足すときは必ず開始時刻を送ること** — 送らねば DB の `now()`（＝終了時刻）が入り、同じ列に2つの意味が無音で混在して事後判別できなくなる（かつて併走していた Flutter 版がこれに未追随のまま廃止された）
- **育児ログ・日記・予定の編集は「開いた時点の `updated_at`」を版に送る楽観的排他（P2-07 / P1-06）**: サーバは id・世帯・版を条件にした 1 本の UPDATE で書き、0 行は読み直して衝突・削除済み・冪等の成功を分ける。版は**表記の文字列のまま**運ぶ（`new Date()` を通すとマイクロ秒が落ちて以後の保存が全て衝突する）。**編集の経路を足すときは必ず版を送ること** — 送らねば Server Action（`updateLog` 等）が「画面が古い」で止める（無条件の上書きへは倒さぬ）。**この守りはアプリの層だけ**で、RLS は版を見ぬ — Server Action を通らぬ書込（PostgREST を直に叩く別のクライアント等）を足すなら、同じ条件を自前で持たせよ。楽観 append の行も作成の応答の版を持つ（`buildOptimisticLog` の `updatedAt` は省略不可）。育児ログの編集シートに、衝突の後の「上書きして保存」を置くな — 全項目を開いた時点の値から送るため、家族が直した項目まで巻き戻る（本文 1 欄の日記は上書きが意図どおりゆえ置いてある）
- **母乳サイクル行（feeding_type='breast'）の counts は双方向厳格 CHECK で守られている**: `breast_left_count`/`breast_right_count` は breast 行のみ非NULL・各0..20・合計≥1（`chk_breast_counts_only_breast`/`chk_breast_counts_required`）。ゆえに **`feeding_type` だけを部分 update する経路は breast 行を編集できない = 意図的な fail-loud**。緩めると「ミルクなのに左右回数を持つ」無音破損が DB に居座るため、CHECK を緩める方向の修正は禁止。サーバ Action（`validateBreastCounts`）と UI（0..20 clamp）は同じ契約のミラーで、上限と丸めは `src/lib/domain/feeding.ts` の `BREAST_COUNT_MAX` / `clampBreastCount` が唯一の正本（ステッパーは `breast-count-stepper.tsx` を共有）
- **左右別授乳時間（`breast_left_sec`/`breast_right_sec`）は「duration_sec = 左+右」の等式 CHECK 付き**（`chk_breast_side_sec_total`・`IS NOT DISTINCT FROM` で NULL 穴なし）: 合計は常にサーバが左右の和から導出する（クライアントの合計送信は拒否 = 二重真値源の禁止）。ゆえに **合計側を clamp する実装は禁止** — 走行中タイマーは 3h 超に到達しうるため、上限処理は `resolveBreastSideSeconds` が**側ごとに比例縮小**して和の等式を守る（合計 clamp に戻すと等式違反で記録が恒久失敗する）。sides NULL の行（#165 期の旧サイクル行・旧形式 localStorage から復元したタイマー）は「合計のみ持つ行」として合法・退化表示。左右配分の backfill は原理的に不可能ゆえ捏造しない
- **DB ENUM 由来 nullable フィールドは未知値で落とさず退化させる（enum drift 防御）**: DB の ENUM（`feeding_type`/`diaper_type` 等）は migration で増え、クライアントの型定義は遅れて追随する。未追随の間に未知値で throw する decode を書くと、その行を含む fetch が画面全体を倒す（かつて併走していた Flutter 版で #147/#158 として実際に起きた）。判別子（`log_type`）は required ゆえ厳格に扱ってよいが、**nullable enum は「未知 → null」で退化**させること。**さらに重要なのは判定の向き**: 未知値を含みうる列で振る舞いを分けるときは、除外したい値だけを名指しする denylist で書け（例: 授乳目安の起点判定は `feeding_type !== 'pumped'`）。allowlist で列挙すると、DB に新しい値が増えた瞬間にその行が**無音で機能から漏れる**
- **いつものミルク量（`households.bottle_default_ml`）は「見た量 = 記録する量」の契約**: クイック記録のミルクは**押した瞬間に釦へ出ていた量**を捕まえ、`recordFeeding` の `amountMl`・楽観行・トースト・帯の全部に同じ値を使う（記録の時にサーバで設定を読み直さぬ — 別端末の変更が入ると見た量と記録が食い違う）。冪等 key は量を含めず `feeding:bottle` のまま（応答を失った 120ml の後に 160ml へ変えて押し直すと、サーバの REPLAY_MISMATCH で止まり二重記録にならぬ。量を key に入れると二重記録に化ける）。「未設定（列が NULL）」と「取得失敗（error・行が見えぬ・session 切れの anon の 0 行）」は `decodeBottleDefault` だけが分ける — 取り違えると決めてある量を上書きさせる。量は赤子の名前・授乳間隔の households の select へ**混ぜず**別の問い合わせ（`selectBottleDefault`）で読む（migration 前の DB で巻き添えに落ちぬため）。Base UI Number Field を `<form>` に入れる時は `noValidate` 必須 — 隠し input の step の起点が min（1）ゆえ、ブラウザの制約検証が 160 を弾いて送信が無反応になる
- **楽観行の `logged_at` は DB が書いた値で組む（端末時計で補わぬ）**: loggedAt を送らぬクイック記録は DB の `now()` で書かれ、応答の届いた瞬間の端末時計とは数秒（時計がずれておればそれ以上）食い違う。端末時計で楽観行を組むと、分を跨いだ時に画面の HH:mm が DB と違い、編集シートがその時刻で seed され、量だけの保存でも表示が DB の時刻へ**飛ぶ**（Realtime の INSERT echo と `appendLog` は同じ id を捨てるゆえ自然には直らぬ。2026-10-25 のミルクの報告）。ゆえに `insertBabyLog` の成功は `loggedAt` を**必須**で返し、クイック記録の楽観行と取り消しの帯はその値を使う。新しい作成経路を足す時も、送った `loggedAt` か応答の `loggedAt` を `buildOptimisticLog` へ渡すこと。**2026-10-28 から成功・replayed は確定行 `log` も返す — 画面はまずそれを使う**
- **保存の再送契約（2026-10-27 大型更新 A2。正本 `src/lib/domain/save-attempt.ts`）**: 作成は最初の有効な押下で送信内容（id・**記録時刻（または「時刻を送らぬ」こと）**・量・左右秒・回数・開始側）を固定し、結果が分からぬ間は同じ id・同じ内容でしか送り直さぬ。**記録時刻はサーバの時計で確定する（2026-10-28 製品判断 N3）**: 端末の時計（`new Date()`）を新規の記録時刻として送るな — 進んだ時計は `validateLogTime` の 5 分で全て拒まれ、遅れた時計は黙って誤った時刻で残る（5 分の許容幅は緩めぬ）。クイック記録（ミルク・おむつ）は `loggedAt` を**送らず** DB の `now()`。母乳の手動記録は `/api/version` の `serverTime` と `performance.now` で押下時刻を推定して送る（`src/lib/domain/server-clock.ts`。サンプルは画面の寿命だけ持ち、往復 3 秒超・30 分超・壁時計と経過の時計の食い違い 2 秒超＝時計の変更かスリープなら使わぬ。押下をサンプルの取得で待たせぬ）。推定できぬ時は時刻を送らず受信時刻。**時刻を送らぬことも凍結する** — 再送で後から時刻を足すと、先の送信が届いておった時に同じ id・別の内容として照合に拒まれる。先の送信が届いておれば replay が初回の行（初回の時刻）を返す。届いておらねば送り直した時の受信時刻で記録され、成功の知らせで「届いた時刻（HH:mm）」と直し方を伝える（押した時刻と偽らぬ）。走っておるタイマーの開始は端末の時計で測り（経過・停め忘れの判定・端末保存の形は従来どおり）、**停めて送る開始時刻だけ**を停めた時のサンプルで端末の時計のずれ分サーバの時計へ写す（`deviceTimeToServerTimeMs`。± に同じく効き、誤差は往復の半分＋許す時計の食い違い 2 秒以内。写せぬ時＝サンプル無し・サンプルの後の時計の変更・スリープ・写す時刻が端末の今より後は端末の時刻のまま = 既知の限界: その時は進んだ端末で 5 分未満の計測を停めると未来の時刻で拒まれ、遅れた端末はその分早い時刻で黙って残る。再読込の前の時計の変更は拾えぬ。照合で見つからず内容を直した後の停止は、最初の停止で送った開始時刻を持ち越す）。停め忘れの記録（画面が端末の HH:mm で約束しておる）と記録シートの時刻入力は写さず端末の時計（v8 N3-01）。**停め忘れの開始時刻は推し量って書き換えるな**（2026-10-28 製品判断: 開始の時のサーバ時刻の手がかりが無い）— 今のサンプルが 1 分以上のずれを示す時だけ「端末の時計によるもので実際とずれうる・保存の後に記録を開いて直せる」と注記する（`significantDeviceSkewMs`。サンプルが無い時は確かめられぬゆえ何も言わぬ）。失敗はサーバが `failure: rejected / unknown / conflict` で分類し、**例外（fetch の reject）は常に unknown**（届かなかったのか応答だけ失われたのか区別できぬ）。**一度でも結果不明になった操作は、後の送信が rejected（ログイン切れ・一時的な失敗）でも控えと id を捨てぬ** — 捨てると次の押下が新しい id になり、先の送信が成立しておれば二重記録になる。Server Action は直列に送られる（`02-guides/server-actions.md`）ゆえ、照合の読みは `GET /api/baby-logs/lookup`（期限・取消しつき）。これは送信キューではない: 自動で行うのは照合の読みだけ。**控えの判定は 2 つに分ける**（`pending-saves-storage.ts`）: 安全の判定 `mayHaveLanded`（このページで今送っておる最中のもの以外は全て成立しておりうる — 控えと id を捨てるかはこちらで決める）と、表示の判定 `isAwaitingConfirmation`（別のタブの直近 60 秒の送信中を伏せるだけ。時刻は `{ nowMs }` で渡す — 位置引数だと `filter(isAwaitingConfirmation)` が添字を時刻に渡して伏せっぱなしになった）。表示の猶予を安全の判定へ持ち込むな（再読込の直後の拒否で控えを捨て、二重記録しうる。独立レビュー 3 周目）
- **育児記録の控えも作成ごと（v9 最終レビュー）**: `pending-saves-storage.ts` は `irori:pending-saves:v2:<userId>:<householdId>:<clientId>` の1鍵へ書く。配列の全件書き戻しへ戻すな — 別タブの作成・確定が他の結果不明の控えを消す。旧候補のv1配列は互換読みし、確定では該当IDだけを除く。上限で未確定の控えを押し出さず、新しい控えを書けぬと呼び出し側へ返す。
- **授乳タイマーの持ち主は計測の寿命で固定する（v9 最終レビュー）**: 利用者・世帯が替わればタイマーを作り直し、旧計測・固定した送信内容を名義変更しない。離脱後の送信・照合の応答は、新しい計測の端末保存・親への確定通知へ触れない。`BabyDashboard` のkeyも利用者・世帯・着地日を含める。
- **予定の作成の控えは作成ごと（2026-10-28 v9 / AC28。正本 `src/lib/domain/calendar-pending-creates.ts`）**: 「追加」を押した作成は、冪等 id と `createCalendarEvent` の入力そのもの（凍結）を**送る前に** `irori:calendar-create:v1:<userId>:<householdId>:<clientId>` の 1 鍵へ書く。**1 本の配列や 1 つの枠へ戻すな** — v8 は新規の下書きの 1 枠に送った作成も入れ、2 件目の作成・破棄・成功が先の作成の唯一の手がかりを消した（P-B）。状態は単調: 一度でも結果不明（例外・分類なし・送信中のまま画面が落ちた）になった作成は、後の送り直しがログイン切れ等で `rejected` でも `unknown` のまま（`mayHaveLanded` は戻らぬ。T2）。`rejected`（行は無い）と言えるのは 1 度きりの送信が拒まれた時だけ。端末の控えを消すのは確定（成功・replayed・conflict = 行は在る）・利用者の明示の取り下げ（「確認をやめる」・拒まれた控えの破棄／直して追加）・期限 7 日・持ち主の交代（CacheUserGuard）・壊れた控えだけ。新しい schemaVersion は消さずに読み飛ばす。**消えた控えを、遅れて届いた古い送信の結果で蘇らせるな**（`settleCalendarCreateAttempt` の superseded。v9rc1 PI-1: 遅れた rejected が「予定は作られていません」で蘇り、打ち直しで二重になった）。送信中の集合はページの寿命で持つ（画面を作り直しても送信中を「確認できていない」と出さぬ。v9rc1 PI-2）。**送った作成をフォームへ戻すな**（凍結した内容を書き換えて同じ id で送る道を作らぬ）— 新規の下書き（`calendar-event-new`）は送っておらぬ入力だけ、拒まれた作成を直す入力は scope = その id の枠。画面の「予定の追加の確認」から件ごとに送り直す（同じ id・同じ内容。確認中と保存できなかったものを分けて数える）。region の名前を「〜の予定」で終わらせるな（e2e が日の予定を `/の予定$/` で絞る）。端末に書けぬ時は送信は止めず、このページの間（再読込まで、画面を移っても残る）だけ持ち主で分離して握り「端末に残せていない」と言う。memory-only は CacheUserGuard の端末保存の掃除では消さず、読む時に持ち主で絞る。更新・ログアウト前の確認もこの控えを数え、再読込で消えることを伝える。別の画面で控えが終了した後に送信結果が不明になった時も、控えを蘇らせず、送った画面へ一覧で確かめるよう知らせる（RC2-2／RC2-3／RC2-4）。下書きの「7日間残ります」は、開いた時に書けると確かめられ・書いておるシートだけ（N1）。2 台の端末で人が同じ予定を打つ重複は端末ごとの控えでは防げぬ（outbox を持たぬ方針・既知の限界）
- **`cookies()` + `NextResponse.redirect()` で Cookie 未伝播**: `createServerClient` でレスポンスに直接書き込む
- **cron route は proxy の承認ゲートを迂回させねば 100% 不発になる（**2026-08-02 の Phase D で解消済み** — 以下は再発防止のための記録じゃ）**: Vercel Cron も pg_cron も **cookie を持たぬ GET** を送るゆえ、承認ゲートを通すと `/login` へ 307 され**ハンドラに到達せぬ**。現行は `src/proxy.ts` の `isPublicRoute` に `pathname.startsWith("/api/cron/")` が在り、`/api/cron/google-sync` と `/api/cron/notify` の両方が fail-closed な secret 検証（`safeEqual` + 未設定なら 401）を持つ。**matcher から外すのではなく isPublicRoute に**してあるのは `Server-Timing` を載せ続けるためじゃ。**ここに別の prefix を足す前に、そのハンドラが fail-closed な認可を持つことを必ず確かめよ**（片方だけ入れると cron が無認証で開く）。⚠️ **検証は Route Handler の直接 import では proxy を通らず「テスト緑・本番 100% 不発」になる** — cookie を持たぬ `request` フィクスチャで実 URL を叩き、307 ではなく 401 が返ることを assert せよ（`e2e/cron-routes-auth.spec.ts` が全 cron route を列挙して撃っておる）。⚠️ **`cron.job_run_details` は配達を監視せぬ** — pg_net は request_id を即返し HTTP は commit 後ゆえ、**HTTP が 500 でも 401 でも `succeeded` と記録する**（2026-08-09 に実際に起きた）。配達は `net._http_response` の `status_code` を見よ。詳細: `docs/runbooks/notify-cron.md` / `docs/plans/verification-record.md` の V8

### Next.js / Supabase 共通

Next.js/Supabase 汎用の罠は `~/.claude/rules/nextjs-supabase.md`（user-level rules）に一元化。該当ファイル編集時に自動適用される。
