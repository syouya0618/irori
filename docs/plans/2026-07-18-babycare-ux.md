# irori 育児UX 磨き込み実装計画

- 作成: 2026-07-18 / 対象 HEAD: main `e77a376`（PR #114 feat/baby-ux マージ後）
- 改訂: 2026-07-18 敵対的レビュー 3 本（R1 実現可能性 / R2 検証十分性 / R3 本質・規約）の blocking 8 件を全て解消し、suggestions 17 件中の採用分を反映（差分は各節に付記。レビュー原本: `ws/R1-feasibility.md` / `ws/R2-verification.md` / `ws/R3-essence.md`）
- 位置づけ: **これを承認したら次セッションでそのまま実装に入る**ための計画書。調査成果物であり、コード変更・Issue/PR 作成は未実施。
- 根拠成果物（全て本計画作成時に Read 済み）:
  - トリアージ: `ws/T1-triage-114.md` / `T2-triage.md`
  - UX 実測: `U1-flows.md`（タップ数）/ `U2-a11y.md`（機械検査）/ `ws/U3-night.md`（夜間・中断耐性）/ `ws/U4-glance.md`（ひと目性）
  - バグハント（反証済み verdict 付き）: `ws/H1-report.md` / `H2-report.md` / `ws/H3-report.md` / `ws/H3-03-verdict.md`
  - 設計案 30 件: `ws/D1-night.md` / `D2-quick.md` / `D3-review.md` / `D4-handoff.md`
  - 審査: `ws/J1-value.md`（価値）/ `J2-cost.md`（コスト）/ `J3-fit.md`(規約・整合)
  - 前回監査・計画: `prior-audit/integrated.md` / `prior-audit/round2/round2-synthesis.md` / `prior-audit/implementation-plan.md`
- 注: 本文中の file:line は全て HEAD `e77a376` 時点の実体（各レポートで Read/grep 検証済み、本計画でも要所を再スポットチェック済み）。実装時に先行 PR がマージされていれば行番号はズレる。

---

## 1. 前提とスコープ

### 1.1 担当範囲

本計画の担当は **育児（baby）領域の UX 磨き込み + 新機能 + 関連バグ修正**。前回計画（2026-07-16、main@74c5018、`prior-audit/implementation-plan.md` の I-01〜I-26）とは次のルールですみ分ける:

- **前回計画 I-xx が正典の項目は本計画で再起票しない**。本計画が触れる場合は「I-xx へ相乗り」「I-xx の baby 分先行」と明記し、採択時に I-xx 側の Issue 本文改訂を条件にする。
- 前回計画の P0（I-01 Next.js 7/20 パッチ / I-02 リポジトリ設定 / I-03 #92 実機診断）は**本計画のスコープ外**（人間トラックで並走）。ただし I-01 との干渉は §8.4 に注記。
- in-flight **PR #113（レシート→在庫 OCR、stock 領域）**: 本計画の全項目は stock 系ファイルに非接触（J2 が 30 提案全件で交差ゼロを確認済み）。唯一の全域ファイルは `src/app/layout.tsx`（Toaster 1 行）と `src/components/ui/sheet.tsx`（prop 透過のみ）で #113 と衝突しない。**例外**: #113 は `settings-content.tsx` を +4 行変更しており、F-01 PR-1（settings 性別 UI）とだけ交差しうる → F-01 PR-1 は **#113 マージ後に着手**（§6 に明記、R1 指摘）。
- in-flight **PR #112（dependabot: npm minor-patch group 8 件 — next / @supabase/* / vitest 等、package.json + pnpm-lock.yaml）**: 本計画で同 2 ファイルを触るのは **AX-00（axe devDependency 追加）のみ**。AX-00 は **#112 と I-01（7/20 パッチ）の決着後に着手**する（§8.4、R1 BLK-1 の解消）。#112 自体の扱い（7/20 パッチと一本化 or 先行マージ）は人間トラック I-01 の判断に委ねる。
- open issue **#91**（meal_reactions DELETE の構造制約）/ **#92**（本番 Realtime 不達・要実機観測）: 本計画の全設計は **Realtime 非依存**（サーバ props フォールバック + Server Action 応答ベース）で成立するよう選定済み。

### 1.2 現状スナップショット

- テスト: vitest 48 ファイル / 354 テスト green（T1 で 2026-07-18 実行確認）。e2e は Playwright 4 spec（`e2e/smoke|golden-path|calendar|offline.spec.ts`、実在確認済み）。
- 前回監査: AUDIT-001〜091、Critical 0（単一世帯運用前提。AUDIT-083 は round2 で**偽陽性確定** — 再実装禁止。AUDIT-091 は Important 格上げ）。
- 今回ハント: 新規 15 findings 中 **14 CONFIRMED / 1 REFUTED**（H3-03、React Compiler の memo 化により機構不成立 — `ws/H3-03-verdict.md`）。最重は **H2-01（Critical: 日跨ぎアクティブ睡眠の袋小路、毎晩発生）**。

---

## 2. トリアージ結果表（前回所見の現状 @ e77a376）

| 項目 | 対象 | 判定 | 根拠（現 HEAD） |
|---|---|---|---|
| I-19 成長曲線+月齢 | AUDIT-056/068 | **done** | line-chart.tsx / growth-chart-section.tsx / baby-age-header.tsx（T1 で品質確認: 実用品質、テスト 654 行同梱） |
| I-06 silent-fail 一掃 | AUDIT-012/006/022/044 + detector | **open（0/5）** | 3c61623 は baby/actions.ts 内で完結。baby-dashboard.tsx:211-213 の `.then` 残存、saveAsTemplate（meals/actions.ts:286-289）、low-stock.ts:56-64、deleteMeal（meals/actions.ts:149-150）、detector `.then` pass 全て未着手。**コミットメッセージ「一掃」を消化と誤読しないこと** |
| I-18 Server Actions テスト | AUDIT-004/007 | **partial** | baby actions 3/9 関数に 6 テスト（actions.test.ts 120 行）。deleteLog・approveUser/generateInvite 未カバー |
| AUDIT-042 baby server 検証 | — | **partial（観測面のみ）** | 全 9 関数に logSupabaseError 済み。入力検証本体はゼロ（actions.ts に clamp 系 grep 0 件） |
| I-04 鮮度フォールバック | AUDIT-016/017 | **open** | use-week-meals.ts に visibilitychange 0 件。実装済みは calendar のみ（use-month-events.ts:169-179） |
| I-07 baby-report 堅牢化 | AUDIT-008/009/052/074/075/064 | **open（6/6）** | route.ts / baby-report.ts / export-card.tsx 全て手つかず（T2 で行番号更新済み） |
| I-11 睡眠集計統一 | AUDIT-019/067/072 | **open** | aggregateSleep 全量計上のまま（baby-log-aggregation.ts:125-146）。**#114 が第 3 面（summarizeTodayCounts）を追加し悪化**（→ 本計画 B-02） |
| I-20 アレルギー / I-21 オフラインキュー | — | **open** | grep 0 件（T2）。本ラウンドも見送り維持（§6.4） |
| I-22 transition-all + theme_color | AUDIT-018/054 | **open** | ui/button.tsx:7, badge.tsx:8, tabs.tsx:61, switch.tsx:19 残存。manifest.ts:18 `#f97316` のまま |
| I-24 小粒バッチ | AUDIT-061/066/053/065/063/062/070/071 | **open（全項目）** | T2 §I-24 で全件残存確認。AUDIT-071 は挙動追認コメントが増えており実装前に意図確認要（§9） |
| AUDIT-091 誕生日 CHECK UTC 罠 | I-09a | **open + 露出増** | migration 未変更。#114 の月齢 CTA（baby-age-header.tsx:24-33）で登録導線が強化され遭遇確率上昇（→ B-04） |
| AUDIT-057 / 073（タイマー二タブ / wake-lock） | P3 | **open** | 現状維持（本計画では触らない） |
| round2 NEW-*（13 件） | I-26 | **open（全件）** | T2 §NEW で全件残存確認 |
| AUDIT-083 | — | **偽陽性確定** | 再実装禁止（round2-synthesis.md:187） |

#114 由来の新規残余: **NEW-114-01**（growth 全件クエリの pagination 同型 → I-14 相乗り、§3 B-11）/ **NEW-114-02**（summarizeTodayCounts が I-11 統一対象に追加 → B-02 に包含）。

---

## 3. バグ修正計画（CONFIRMED 14 件）

> 共通規律: **fail-red テスト先行**（修正前に赤くなるテストを書き、修正で緑化。PR 本文に red→green の実行ログを貼る）。全 PR で `pnpm lint` / `tsc --noEmit` / `pnpm test:run` green + e2e 4 spec green（§7a）。severity は verdict のまま（盛らない）。

### B-01 [Critical / M] H2-01: 日跨ぎアクティブ睡眠の袋小路（毎晩発生）

- **対象**: `src/app/(main)/baby/page.tsx:35-43`（完了睡眠限定の補助クエリのみで未終了睡眠クエリ不在）/ `src/components/baby/baby-dashboard.tsx:223-228`（activeSleep は選択日 logs のみから導出）/ `:300-307`（isToday ゲート）/ `src/app/(main)/baby/actions.ts:117-127`（23505 分岐）
- **修正方針**（D1-02 設計を採用。UX トラックと**同一根因ゆえ 1 本の PR に統合し二重実装しない**）:
  1. page.tsx に未終了睡眠クエリを追加: `.eq("log_type","sleep").is("ended_at", null).order("logged_at",{ascending:false}).limit(1).maybeSingle()`（UNIQUE index `idx_one_active_sleep`＝supabase/migrations/20260410000001_baby_logs.sql:85-87 により高々 1 件保証）。error は logSupabaseError。
  2. `activeSleepFallback` prop を dashboard へ渡し、導出を「ローカル導出 ?? サーバフォールバック（state 保持）」に変更。**endSleep 成功時に明示クリア**（Realtime 不達 #92 でもトグルが睡眠中に戻らないように）。
  3. これで日跨ぎ後もトグルが「睡眠中 Xh Ym / 起こす」を表示し、既存 `endSleep`（baby-quick-actions.tsx:92、唯一の呼び出し元）がそのまま機能。migration・23505 防御の変更なし。
- **PR 分割**: 単独 1 PR。**Critical（毎晩発生）ゆえ 7/20 bump を待たず最優先で merge してよい**（bump 後の rebase コスト M 1 本分を明示的に受容 — R3 指摘の明文化）。
- **検証**:
  - fail-red: activeSleep 導出を純関数に抽出し vitest —「logs に無く fallback に有る → activeSleep=fallback」。「endSleep 成功後のクリア」は state 遷移ゆえ純関数で表現できないため **component テスト（React Testing Library）で固定**する（R2 指摘 — 抜け穴の封鎖）。抽出前の現挙動（null）に対して赤 → 修正で緑。
  - 手動合否: ローカル Supabase に前夜 21:00 開始・未終了の睡眠をシード → 翌日 /baby でトグルが経過時間付き「起こす」表示になり、タップ 1 回で終了トーストが出れば**合格**。23505 エラーが出たら**不合格**。
  - e2e 候補: golden-path への 1 シナリオ追加。**シードは TZ=UTC の webServer 前提で相対時刻（now−10h 開始・未終了等）で組む**（固定時刻だと JST 日跨ぎ条件が時間帯依存になる — R1 指摘）。不可なら手動合否のみで可（理由を PR に明記）。

### B-02 [Important / M] H1-01 + H2-02: 睡眠集計の統一（前回計画 I-11 の拡張実装）

- **対象**: `src/lib/domain/baby-log-aggregation.ts:125-146`（aggregateSleep 開始日全量計上 = AUDIT-019）/ `:275-297`（summarizeTodayCounts、#114 新設の第 3 面）/ `src/app/(main)/baby/page.tsx:32-33`（today 窓が logged_at のみ）/ `src/app/api/baby-report/route.ts:57-59`（窓端 = AUDIT-067）/ 正実装: `src/lib/domain/baby-weekly-summary.ts:47-60`（overlap 按分）
- **修正方針**: **前回計画 I-11（019+067+072 の 3 点セット・分割禁止）に summarizeTodayCounts と today クエリ or() 拡張を加えた 4+1 点を 1 PR で**。週間側の按分ロジックを共通ヘルパへ抽出し、PDF 集計・summarizeTodayCounts を按分化。today クエリへ週間クエリ（page.tsx:51-53）と同型の `or(logged_at.gte...,and(log_type.eq.sleep,ended_at.gte...))` を追加。
- **or() 拡張の副作用規定（R3 BLK-2 の解消）**:
  1. **クエリ対称化を本 PR に含める**: 日付ナビの client refetch（baby-dashboard.tsx:205-213、現状 logged_at の gte/lt のみ）にも同型の or() を適用し、サーバ初回表示とクライアント refetch の窓を同一化する。これを怠ると「過去日へ移動して今日へ戻る」操作で今日のまとめの睡眠分が経路依存で変動し、下記合否条件が崩れる。同行域は B-08 が先に触るため **B-08 マージ後に rebase して実装**（§8.1 の直列順）。
  2. **timeline 表示方針**: 前日開始の睡眠行は**集計入力専用**とし、timeline には出さない。実装はサーバから `overlapLogs`（前日開始・当日終了/未終了の睡眠）を **logs と別 prop で渡し**、summarizeTodayCounts の入力にのみ合流させる。logs（= selectedDate 分）の意味は不変 — timeline・B-09・既存テストの前提を壊さない。
- **PR 分割**: 単独 1 PR（I-11 として。分割すると窓合計不一致の副作用チェーン — 前回計画の分割禁止指示を維持）。
- **検証**:
  - fail-red: (1) 22:00→翌 06:30 睡眠で `summarizeTodayCounts` が翌日 390 分を返すテスト（現状 0 で赤）。(2) AUDIT-072 の日跨ぎ回帰: aggregateSleep 按分テスト。(3) I-11 受け入れ: 19:30→06:30 睡眠で PDF 集計と週間サマリーの per-day 値が同値（round2 実証の 360 分乖離が解消）。
  - **cross-implementation 同値テスト**（R2 提案採用）: 同一入力 fixture に対し「PDF 集計・週間サマリー・summarizeTodayCounts」の per-day 睡眠値が一致することを assert する共通テストを 1 本置き、将来第 4 の実装面が乖離する再発（#114 で第 3 面が増えた経緯）を機械で封じる。
  - pass/fail: 同一夜間睡眠が「今日のまとめ」「週間サマリー今日棒」「PDF」の 3 面で同値、かつ日付ナビ往復後も値が不変なら合格。1 面でも食い違えば不合格。
- **依存**: B-08 の後（同行域）。UX-01（同関数の diaper 行に触る）は本 PR マージ後に rebase。

### B-03 [Important / M] H3-01: 記録反映の Realtime 単一経路 → 楽観 append

- **対象**: `src/components/baby/baby-dashboard.tsx:47`（`useState(initialLogs)` シード。revalidatePath の RSC は useState 保持で破棄 — next docs use-router.md:46 で裏取り済み）/ `src/components/baby/baby-quick-actions.tsx:67-111`（成功時 toast のみ）
- **修正方針**: Server Action が返す `id`（3c61623 で導入済み、actions.ts:76,109）を使い、成功時に `setLogs` へ楽観 append。既存の Realtime echo は id 重複スキップ（baby-dashboard.tsx:132）が吸収。deleteLog（Undo）成功時もローカル state から除去。feeding/diaper は UNIQUE 防御がないため（sleep のみ部分 UNIQUE）、**#92 発火環境での再タップ二重記録の実害を止血**する本命修正。
- **安全前提の明記**（R3 提案採用）: 楽観 append が正しいのは quick actions が **isToday ゲート（baby-dashboard.tsx:300-307）下にある**からこそ（過去日閲覧中に append すると日付不一致行が timeline に混入する）。この前提を実装コメントに残し、**F-03（過去日クイック記録の解禁）を採択する際は本設計の再検討を必須とする**。
- **PR 分割**: 単独 1 PR（quick-actions + form-sheet + feeding-timer の記録経路を同一パターンで。ハンドラごとの分割はしない — 同一関心事「記録反映の非 Realtime 化」）。
- **検証**:
  - fail-red: vitest — Realtime イベントを発火させずに記録アクション解決 → logs に新行が現れる（現状は現れず赤）。Undo → logs から消える。echo 二重 append が起きない（同 id INSERT イベント後も 1 件）。
  - 手動合否: DevTools で WS をブロックした状態で「おむつ」タップ → タイムライン・回数が即時更新されれば合格。無反応なら不合格。

### B-04 [Important / S] H2-03: 誕生日 CHECK UTC 罠のアプリ層防御（I-09a の migration と分界）

- **対象**: `src/app/(main)/settings/actions.ts:134-140`（形式 regex のみ）/ `:154-156`（CHECK 違反が汎用文言に化ける）/ `src/components/settings/baby-profile-card.tsx:60-66`（date input に max なし）。DB 側 `supabase/migrations/20260412000001_baby_profile.sql:6` の CHECK 自体は **I-09a（前回計画）管轄 — 本 PR に migration を含めない**。
- **修正方針**: (1) input に `max={todayJstString()}`。(2) Server Action に JST 基準の「未来日拒否」検証 + エラーメッセージ明確化（「誕生日には今日以前の日付を指定してください」）。(3) 23514（CHECK violation）を弁別して同文言を返す（I-09a の migration 適用前でも JST 00-09 時の当日登録失敗が「原因不明」でなくなる）。
- **注**: round2 で実 DB 発火済みの再現バグ。#114 の月齢 CTA で導線が増えたため**優先度注記を I-09a に追記すること**（採択時の Issue 改訂条件）。
- **検証**: fail-red — validator 単体テスト「JST 当日=許可 / JST 未来=拒否」（現状 validator 不在で赤）。**e2e で自動化**（R2 提案採用 — e2e スタックは既に TZ=UTC ゆえ手動に残す理由がない）: 当日誕生日を登録し、汎用文言でなく明確な文言（または成功）が出ることを assert。**登録が成功するか**は I-09a 適用後に再確認（本 PR の合否には含めない）。

### B-05 [Minor / S] H1-03: deleteLog の 0 行削除 silent success（server 側のみ）

- **対象**: `src/app/(main)/baby/actions.ts:314-318`（`.delete()` のみで行数検証なし — 本計画で実体再確認済み）。**client 側（baby-quick-actions.tsx:49-52）は result.error を toast.error 表示する実装が既に存在**するため対象外（R1 実測により縮小 — これで B-07 との行域重複も解消）。
- **修正方針**: `.select("id")` を付け 0 行なら「既に削除されています」を返す（同コミットの updateLog 修正 actions.ts:289-303 と対称化）。既存の client 側 error 表示がそのまま拾う。
- **検証**: fail-red — supabase mock が `data: []` を返すケースで error が返るテスト（現状 error:null で赤）。deleteLog は I-18 の未カバー関数でもあるため、このテスト追加が I-18 partial の穴埋めを兼ねる。

### B-06 [Minor / S] H3-05: amountMl の `parseInt(x) || null` 0ml falsy 衝突

- **対象**: `src/components/baby/baby-log-form-sheet.tsx:140-143`（CHECK は 0..999 許可 = migrations/20260410000001:42、Input min={0} = form-sheet:245）
- **修正方針**: `const n = parseInt(amountMl); updates.amountMl = Number.isFinite(n) && n >= 0 ? n : null`（完了前チェックリスト 5 準拠、AUDIT-071 と同型イディオム）。
- **検証**: fail-red — 「"0" 入力 → updateLog へ `amountMl: 0`」（現状 null で赤）。空文字 → null の回帰も固定。
- **後続依存**: UX-02 / UX-05 / UX-06 の前提（同ファイル・同 input）。

### B-07 [Minor / S] U3-9: 通信断 reject の catch 横展開（7 ハンドラ）

- **対象**: `src/components/baby/baby-quick-actions.tsx`（handleFeeding:67-76 / handleDiaper:78-87 / handleSleepToggle:89-111 / undoLog:46-55）+ `baby-log-form-sheet.tsx`（handleCreate:80-130 / handleUpdate:132-175 / handleDelete:177-189）。両ファイル try/catch grep 0 件（U3 実測）。対策済みの手本: `feeding-timer.tsx:118-131`。
- **根拠**: startTransition 内 unhandled reject は error boundary へ bubble（node_modules/next/dist/docs/01-app/01-getting-started/10-error-handling.md:374-375、J3 が実文書確認）。圏外タップ 1 回で全画面エラー + 記録無言喪失の恐れ。
- **修正方針**: feeding-timer と同型の try/catch + 「通信できませんでした。電波の良い場所でもう一度お試しください」toast.error を 7 ハンドラへ複製（D2-05 正典。I-21 オフラインキューの前哨であり I-21 の保留判断は不変）。
- **検証**: fail-red — 各 action mock を `Promise.reject` にし toast.error 呼び出し + unhandled rejection なしを 7 ハンドラ全てで固定（現状 reject が漏れて赤）。PR 本文に `grep -n "try {" src/components/baby/*.tsx` の網羅証跡を貼る（完了前チェックリスト 2）。e2e: offline.spec.ts 拡張（§7c）— offline 状態で「おむつ」タップ → エラートースト表示 & `error.tsx` 全画面に**ならない**ことを assert。**boundary 遷移の白黒は Playwright offline で決着する**（「実機でのみ確定」の根拠はなかったため撤回 — R2 指摘）。機内モード実機 1 回は必須条件から外し、任意の追加確認とする。
- **依存**: **B-06 マージ後**（handleUpdate:132-175 が B-06 の 140-143 を包含する同行域 — R1 BLK-2 の解消）。

### B-08 [Minor / S] AUDIT-012（I-06 の baby 分先行）+ H3-02: 日付ナビ fetch の error 握り潰し & インターリーブ上書き

- **対象**: `src/components/baby/baby-dashboard.tsx:211-213`（`.then(({ data }) => ...)` が error を捨てる = AUDIT-012 名指し箇所）+ 同行の無条件全置換（H3-02: in-flight fetch 解決が Realtime 先着行を上書きで消す）
- **修正方針**: (1) error を受領し logSupabaseError + 「読み込みに失敗しました」toast（logs は前状態維持）。(2) fetch 解決時は全置換でなく id ベースの dedupe マージ（Realtime で先着した選択日該当行を保持）。同一行の 2 欠陥ゆえ 1 PR。
- **すみ分け**: **I-06 は「baby-dashboard 分は済み」に縮小改訂**（残余 = saveAsTemplate / low-stock / deleteMeal / detector `.then` pass。これらは I-06 のまま）。
- **検証**: fail-red — (1) fetch reject で toast.error + logs 不変（現状 silent で赤）。(2) 「fetch in-flight 中に Realtime INSERT → fetch 解決後も該当行が残る」テスト（現状消えて赤）。

### B-09 [Minor / S] H1-02 + H2-04 + H1-05: まとめバーの過去日ラベルと aria

- **対象**: `src/components/baby/baby-dashboard.tsx:244,292-298`（isToday ガードなしで常時描画、logs は selectedDate 分）/ `src/components/baby/baby-summary-bar.tsx:41`（`aria-label="今日のまとめ"` 固定、role なし div = ARIA 1.2 Name prohibited）/ `:23-25`（過去日の最終授乳が「30時間前」等になる）
- **修正方針**: (1) `date` prop を追加しラベルを「今日のまとめ」⇔「M/D のまとめ」で切替（aria-label も同期）。(2) 過去日では経過系カード（最終授乳・睡眠中）を非表示 or 絶対時刻表示に切替。(3) コンテナへ `role="group"` 付与（H1-05）。
- **検証**: fail-red — (1) `getByRole("group", { name: "今日のまとめ" })`（現状 role なしで赤。既存 test.tsx:36,44 の getByLabelText は素通しのためテスト盲点も同時解消）。(2) 過去日 date でラベルが「M/D のまとめ」になるテスト（現状固定で赤）。(3) 過去日で経過表示が出ないテスト。

### B-10 [Minor / S] H2-05: 相対時刻の負値ガード

- **対象**: `src/lib/utils/baby-log-labels.ts:37-48`（formatElapsedMinutes が負値をそのまま表示）。発火機構は端末時計スキュー不要（useNow(60_000) の stale now × 記録直後 Realtime INSERT で約 5 割の確率、H2-05 verdict で机上確定）。クランプ済みは feeding-timer.tsx:107 のみ（call site grep 済み）。
- **修正方針**: `Math.max(0, ...)` の 1 行ガード（formatElapsedMinutes 入口 or minutesBetween 利用側。全 call site を grep して適用漏れゼロを PR 本文に記載）。
- **検証**: fail-red — `formatElapsedMinutes(-3)` が「0分」（現状「-3分」で赤）。境界 0 / 59 / 60 の回帰固定。

### B-11 [Minor / 起票のみ] H1-04: 成長ログ全件クエリの 1000 行キャップ → I-14 相乗り

- **対象**: `src/app/(main)/baby/page.tsx:60-68`（limit/ページングなし昇順。コメントで 1000 未満想定と明記済み — 本計画で実体再確認済み）
- **方針**: 単独 PR は立てない（毎日記録でも到達まで約 2.7 年、実害遠方）。**I-14（pagination 決定化）の Issue 本文に NEW-114-01 として追記**し、実装時に CLAUDE.md の設計指針（空ページ終端ループ + `.order("logged_at").order("id")` の一意最終ソートキー + 実 DB で切り詰め赤を固定する統合テスト）で同型是正する。
- **検証**（I-14 実装時）: 実 DB 統合テストで 1000 行超シード時に全件取得されることを固定（mock では原理的に検出不能 — CLAUDE.md pagination 則）。

### B-12（統合済み）H3-04: 保存中 dismiss の入力喪失

- **対象**: `src/components/baby/baby-log-form-sheet.tsx:203`（onOpenChange が isPending を見ない）
- **方針**: **UX-04b（dirty ガード）に統合**（同一箇所・同一関心事「シート dismiss の保護」。最小修正だけ先行させると UX-04b で二度触りになる）。UX-04b の受け入れ基準に H3-04 の回帰テストを含める（§5 参照）。

### REFUTED: H3-03（日跨ぎで quick actions が消える）

React Compiler（next.config.ts:4 `reactCompiler: true`）が `today = todayJstString()` を memo_cache_sentinel で凍結するため主張の機構は発火しない（実コンパイル + .next チャンクで確認、`ws/H3-03-verdict.md`）。**修正しない**。ただし派生観察「frozen-today staleness」は §4 D-1 の診断対象。

---

## 4. NEEDS_RUNTIME 項目の診断手順書

> 原則: 根因を断言しない。観測 → 分岐 → 次アクションの形で記す。「実機観察」単独表記は禁止（全項目に観測手順と合否/分岐を付す）。

### D-1: frozen-today staleness（H3-03 の派生観察）【合否条件を R2 指摘で改訂】

- **仮説（未確定）**: React Compiler により `today` / `selectedDateRef` / weekly 窓が初回レンダー値で凍結し、/baby を開いたまま JST 0:00 を跨ぐと、0:00 以降の新記録が Realtime date guard（baby-dashboard.tsx:128 `toJstDateString(newLog.logged_at) !== selectedDateRef.current`）で timeline に反映されない（症状は H3-01 と同型・日跨ぎ限定）。バックグラウンド復帰での fiber 再マウントがキャッシュをリセットする可能性あり（verdict 注記）。
- **観測手順**: 実機 PWA で 23:55 に /baby を開き画面を保持（スリープさせない）→ 0:05 に「おむつ」を記録。
- **分岐**: (a) タイムラインに即反映される → 非発火（fiber 再マウント等で緩和されている）。クローズ。 (b) 反映されない（トーストは成功）→ 発火確定。修正候補: `today` を `useNow` 由来の値から導出して reactive 化（コンパイラのキャッシュキーに now を含める）+ selectedDate の day-rollover 追従。B-03 の楽観 append が入っていれば自端末分は緩和されるため、**B-03 マージ後に再観測してから**着手判断。
- **合否条件**: **3 トライアル方式**（1 回の非再現でのクローズは禁止 — verdict が指摘するとおり fiber 再マウントでキャッシュが復旧しうる＝**非決定的**であり、R2 が旧記載「確率的要素なし」との自己矛盾を指摘）。3 回中 1 回でも (b) を再現 → 発火確定。3 回連続 (a) → 「観測条件下では発火せず」と**暫定**クローズ（断言しない）。可能なら React DevTools で再レンダー後の `today` 値を直接確認し、決定的計測で置き換える。

### D-2: #92 本番 Realtime 不達（前回計画 I-03 の管轄・参照のみ）

- 手順は前回計画 I-03（R2 成果物 A: WS 3 シグナル観測）を正とする。**本計画側の関係**: (a) 不達確定なら B-03（楽観 append）と UX-08（鮮度フォールバック）が実害の大半を止血する。(b) 到達確定なら H3-01 の severity は Important→Minor へ実質降格（構造欠陥自体は残るため修正は維持）。

### D-3: フォーカスリング視認性（U2-07）【客観基準主体に R2 指摘で再構成】

- **客観判定（実機不要・確定済み）**: リング実効コントラスト 1.27:1（U2 計算値）は **WCAG 1.4.11（非テキスト 3:1）を静的に fail 確定**。主観の「迷いなく分かる」を主基準にしない。
- **残る観測**: `--ring` のアルファ引き上げ（globals.css:62）の**度合い**のみ実機で体感確認（3:1 以上に引き上げた候補値 2〜3 案を並べ、ライト実機で glass 背景上の違和感がないものを選ぶ）。意匠 token 変更ゆえ §9 #3（primary コントラスト）と**同時に一度で判断**する。

### D-4: PWA テーマ外観（U3-2、UX-03b の事後確認）

- **観測**: UX-03b（viewport.themeColor）マージ後、Android 実機ダークモードで PWA 起動 → ステータスバー/ブラウザ UI がダーク追従するか。iOS standalone のステータスバー外観も併せて記録。
- **分岐**: 追従しない → `appleWebApp.statusBarStyle`（layout.tsx:23）や manifest 側（I-22 管轄）の再検討へ。manifest `background_color` 白スプラッシュは仕様上の限界のためコメントで判断記録のみ。

### D-5: /baby の動的レンダリング鮮度（H2 §6）

- **仮説（未確定）**: `todayJstString()`（page.tsx:11）は getAuthContext の cookies 参照で動的化される想定だが、本番のキャッシュ層実挙動は未確認。
- **決定的プリチェック（本番 0:00 待ちの前に実施 — R2 提案採用）**: `pnpm build` の route 出力で `/baby` が `ƒ (Dynamic)` か `○ (Static)` かを確認。`ƒ` なら動的レンダリング確定でクローズ（本番観測は不要）。`○` なら仮説が濃厚 → 下記の本番観測へ。
- **観測**: 本番で JST 0:00 直後に /baby をフルリロード → 「今日」の日付とログ窓が新日付になっているか（キャッシュ関連の応答ヘッダも記録。特定ヘッダ名の存在は docs 裏取り前ゆえ前提にしない）。
- **分岐**: 旧日付が出る → キャッシュ確定、`export const dynamic = "force-dynamic"` 等の明示を検討（Next docs 裏取りの上）。新日付 → クローズ。

### D-6: トースト到達性の実機確認（UX-03a の事後確認）【機械化を R2 提案で反映】

- **機械判定（e2e に格上げ）**: BottomNav 非重畳は **Playwright の boundingBox 交差判定**で自動化し UX-03a の e2e に含める（主観に残さない）。
- **観測（残る主観は親指到達のみ）**: 375px 幅実機・片手保持で記録 → トースト「取り消す」に親指が届くか（スクリーンショット保存）。**観測端末に safe-area（ホームインジケータ）最大級の端末 1 台を必ず含める**（`mobileOffset: {bottom: 80}` は safe-area 加算で重畳余地 — R3 指摘）。
- **合否**: e2e 非重畳 green + 実機で届けば合格。届かなければ mobileOffset 調整。

---

## 5. UX 磨き込み計画（審査済み・クラスタ統合後の PR 単位)

> 30 提案は 7 クラスタ + 単独案に収斂（J1/J2/J3 の三審一致）。**採用は各クラスタの正典 1 本のみ**。スコア表記は（価値 J1 / コスト J2 / 適合 J3）。共通受け入れ条件: §7a の no-regression ゲート + Liquid Glass 規約（glass + rounded-2xl、`transition-colors duration-200` のみ、min-h-11、Lucide、絵文字は meal reaction のみ — 典拠: docs/DESIGN_SYSTEM.md:86（影）/:99（44px タッチ）/:153-155（絵文字制限）+ CLAUDE.md「Design System」節。※R3 指摘で引用行を実体に合わせ修正。なお DESIGN_SYSTEM.md:104-109 の角丸表「カード=rounded-xl」は CLAUDE.md・実装（rounded-2xl）と矛盾したまま — doc-sync 判断を §9 #10 に登録）。
>
> **共通 UI 分界基準**（R3 提案採用）: `src/components/ui/`・共有ユーティリティへの**寸法・挙動の変更は I-24 管轄**（本計画では触らない）。**文言・aria 属性のみの変更**（AX-01(2) の sr-only 等）と **prop 透過の追加**（UX-04b の sheet.tsx）は本計画で可。

### UX-01 [M]（5/4/5）まとめバーを「引き継ぎの真実」に — 最終授乳の日跨ぎ復元 + 左右/量 + うんち内訳（正典: D4-01、D1-01/D2-06/D3-04 を吸収）

- **触るファイル**: `src/app/(main)/baby/page.tsx`（lastSleepData:35-43 と同型の「最新 feeding 1 件」クエリ追加）/ `baby-dashboard.tsx`（`lastFeeding ?? serverLastFeeding` フォールバック透過）/ `baby-summary-bar.tsx:66-76`（`getFeedingTypeLabel` = baby-log-labels.ts:12-17 既存 + bottle 時 amount_ml 併記）/ `baby-log-aggregation.ts:275-297`（summarizeTodayCounts の入力 Pick に diaper_type を追加し poopCount 返却 →「8回（うんち2）」）
- **分界**: 同関数の **sleep 集計行には触れない**（B-02/I-11 管轄、衝突回避を PR 本文に明記）。
- **受け入れ基準**: (1) 前夜 23:30 授乳が翌 2:00 の表示で「2時間30分前・左」形式（「---」でない）。(2) bottle は ml 併記。(3) おむつ枠に poop 内訳。
- **検証**: vitest — summarize の poopCount（pee/poop/both 混在・0 件）/ summary-bar 表示文字列 / serverLastFeeding フォールバック経路。手動合否: ローカルスタックに前夜 23:30 feeding シード → JST 日跨ぎ後の初回表示で経過+種別が出れば合格。
- **順序**: B-02・B-09 マージ後に rebase（同ファイル）。

### UX-02 [M]（5/4/5）編集シートに時刻フィールド — 遡及記録・台帳修正の開通（正典: D4-04、D1-07/D2-01 を吸収）

- **根拠**: U1 摩擦#1 = 全実測で唯一の「∞タップ（不可能）」。サーバ `updateLog` は loggedAt/endedAt 受理 + 0 行防御済み（actions.ts:242-303、J2 実測確認）で**サーバ変更ゼロ**。
- **触るファイル**: `baby-log-form-sheet.tsx`（編集モードに `<Input type="time">` min-h-11 + Label 関連付け必須 = U2 §6 準拠。sleep 種別には ended_at フィールドも。開始>終了は翌日解釈 + 負区間クライアント検証）/ `src/lib/utils/date-jst.ts`（selectedDate 基準の `+09:00` ISO 組み立てヘルパ。`new Date('YYYY-MM-DD')` 禁止則遵守）
- **スコープ外**: 過去日クイック記録の解禁・サーバ側検証追加（D2-01 の混載要素）は次段 F-03 へ。
- **受け入れ基準**: (1) 授乳ログの時刻を 30 分前へ変更 → タイムライン順序と最終授乳経過が追従。(2) 「睡眠中...」行に ended_at を設定して終了できる（B-01 と独立の脱出口）。(3) 終了<開始は翌日解釈、負区間は拒否文言。
- **検証**: vitest — JST 合成の境界（23:59/00:00/月末）、payload の loggedAt/endedAt、翌日解釈、拒否ケース。手動合否は受け入れ基準どおり。
- **依存**: B-06 先行（同ファイル）。

### UX-03a [S]（4/5/4）トースト bottom 化（正典: D1-05）

- **触るファイル**: `src/app/layout.tsx:56` — `position="bottom-center"` + `mobileOffset={{ bottom: 80 }}`（sonner ^2.0.7 の実 API、index.d.ts:113 で J3 確認済み）。Undo 付きトーストのみ `duration: 6000`（baby-quick-actions.tsx:57-65 に 1 オプション）。
- **受け入れ基準**: トーストが viewport 下半分・BottomNav 非重畳。meals/shopping 面でも入力 UI と非重畳（スクリーンショット確認）。
- **検証**: e2e — おむつ記録後のトースト要素の存在 + クラス assert（boundingBox 座標 assert は flaky ゆえ緩和 — J2 指摘採用）。手動合否は §4 D-6。

### UX-03b [S]（3/4/5）トーストのテーマ追従 + viewport.themeColor（正典: D1-06）

- **触るファイル**: `src/components/ui/sonner.tsx:3,8`（Provider 不在の next-themes `useTheme` → 自作 `src/lib/hooks/use-theme.ts` の resolvedTheme へ差し替え）/ `src/app/layout.tsx:31-37`（`viewport.themeColor` に media 付き配列 — generate-viewport.md:95-106 で公式サポート確認済み。dark 値は globals.css:72 の実背景値）
- **分界**: manifest.ts:18 の `theme_color: "#f97316"` 是正は **I-22 に残す**（採択時に I-22 と重複しないことを Issue 相互参照）。next-themes 依存の package.json からの削除は参照 0 化を確認した上で**別 PR**。
- **受け入れ基準**: アプリ設定=ダーク・OS=ライトで記録 → トーストが暗色。
- **検証**: vitest — use-theme mock で `theme="dark"` が Sonner へ渡る。Android 実機は §4 D-4。

### UX-03c [S]（4/3/4）Undo の一貫化 — 睡眠トグルとタイマー授乳へ拡張（D4-07 の Undo 部分を再設計）

- **触るファイル**: `baby-quick-actions.tsx`（睡眠開始 Undo = deleteLog / 睡眠終了 Undo = `updateLog(id, { endedAt: null })` — サーバ受理済み actions.ts:280）/ `feeding-timer.tsx:146`（recordFeeding の返却 id は既存・未使用）
- **必須設計（J2 指摘の解消）**: 睡眠終了 Undo は、取り消しまでに**別のアクティブ睡眠が開始されていると `idx_one_active_sleep` に衝突（23505）**する。23505 を捕捉し「新しい睡眠が始まっているため取り消せません」を表示する分岐を必ず実装（無言失敗禁止）。
- **依存**: B-05（H1-03）先行必須。UX-03a と同時期なら同ファイル rebase 調整。
- **受け入れ基準**: 睡眠終了 → 取り消す → トグルが「睡眠中（経過表示）」に復帰。衝突時は明示エラー。
- **検証**: vitest — undo 呼び出し引数 + 23505 分岐 + タイマー授乳トーストに Undo 付与。

### UX-04a [S]（4/4/4）タイマーの dismiss 非破壊化 + 実行中チップ（正典: D4-06 の 2 PR 分割案、D1-03/D2-04 を吸収）

- **触るファイル**: `feeding-timer.tsx:156-163`（handleOpenChange から破棄処理を除去 — dismiss はシートを閉じるだけで startedAt/localStorage 維持。破棄は明示「キャンセル（記録しない）」:150-154 のみ。復元ロジック :56-90 は既存のまま整合）/ `baby-dashboard.tsx`（マウント時 + visibilitychange で `localStorage["irori:feeding-timer"]` を確認し、実行中なら glass-subtle + Lucide Timer + min-h-11 のチップを QuickActions 直上に表示 → タップで再開。復元時「実行中のタイマーを再開しました」toast）
- **受け入れ基準**: (1) タイマー起動 → バックドロップタップ → localStorage 残存 + チップ表示。(2) チップタップで経過時間そのままのシート再開。(3) リロード後もチップが出る。(4) 明示キャンセルでのみ破棄。
- **検証**: vitest — dismiss 経路で localStorage 残存 / キャンセル経路で削除 / STORAGE_KEY 存在時にチップ描画。手動合否は受け入れ基準どおり。

### UX-04b [S]（4/4/4）フォームの dirty/保存中 dismiss ガード（D4-06-3、**H3-04 の修正を包含**）

- **触るファイル**: `baby-log-form-sheet.tsx:203`（onOpenChange ラップ: isPending 中は dismiss 不可 = H3-04 / dirty 時は確認 1 段）/ `src/components/ui/sheet.tsx`（Base UI Dialog の `disablePointerDismissal` prop 透過のみ — DialogRoot.d.ts:50 で実在確認済み。共通 UI の挙動変更はしない）
- **受け入れ基準**: (1) 体温入力途中のバックドロップタップで入力が残る。(2) 保存中は overlay/Esc で閉じない（H3-04 fail-red: 現状は閉じて formKey remount 全損）。(3) 未入力時は従来どおり 1 タップで閉じる。
- **検証**: vitest — dirty 判定分岐 / isPending 中の onOpenChange(false) 無視。
- **順序**: UX-02 の後（同ファイル）。**縮退条件**（R3 提案採用）: UX-02 の着手が 7 日以上遅延する場合、**H3-04 の isPending ガード（数行）のみ独立 S PR で先行切り出し可**（実バグ修正を UX 磨き込みの遅延に道連れにしない）。

### UX-05 [S]（4/4/4）記録直後トーストに「量を追加」（正典: D4-05 = D2-02）

- **触るファイル**: `baby-quick-actions.tsx:57-65`（successWithUndo 拡張: sonner の action + cancel 2 スロットで「量を追加」+「取り消す」共存）/ `baby-dashboard.tsx:260-265`（既存 handleEdit 経路で該当ログの編集シートを amount input autoFocus で開く）/ `baby-log-form-sheet.tsx`（autoFocus 対象 prop）
- **依存**: B-06 先行必須（0ml falsy）。UX-02 の後（同ファイル rebase 1 回化）。
- **受け入れ基準**: ミルク記録 → トースト 1 タップ → 量入力 → 更新の計 3 タップで timeline 行が「ミルク 120ml」表示。0ml も保存できる（B-06 回帰と共用）。
- **検証**: vitest — bottle 記録成功でトーストに両 action / タップで onEdit が該当 id。

### UX-06 [S]（3/4/4）体温・成長の前回値 placeholder + 桁誤り警告（正典: D3-07、D2-07 を吸収）

- **触るファイル**: `baby-log-form-sheet.tsx:64-66,296-318`（作成モードの placeholder を「前回: 5240」形式に。**値の自動充填はしない** — 未変更保存での同値重複事故を回避、D2-07 の自動充填案は不採用）/ `baby-dashboard.tsx`（直近 growth/temperature 値を props で。growthLogs は既にクライアント側に全件あり新クエリ不要）。体重の前回比 ±50% 超で `text-destructive text-xs` の警告文（ブロックしない）。
- **受け入れ基準**: (1) 前回値が placeholder 表示。(2) 前回なしは既存例文。(3) 5240→520 入力で警告表示・保存自体は可能。
- **検証**: vitest — 上記 3 分岐。
- **順序**: B-06 / UX-02 / UX-04b の後（同ファイル）。

### UX-07 [S]（4/5/5）記録者の可視化 — logged_by 表示（D4-02、完全新規・非重複）

- **根拠**: `logged_by` は全クエリで取得済み（page.tsx:29,47,64 / baby-dashboard.tsx:204）だが baby コンポーネントで表示 0 件（grep 実測）。shopping に既製パターン（shopping/page.tsx:29 の profiles 取得 + shopping-list.tsx:73,103 の memberMap）。
- **触るファイル**: page.tsx / baby-dashboard.tsx / baby-timeline.tsx / baby-timeline-item.tsx:80-95（時刻の隣に `text-xs text-muted-foreground` で記録者名。自分の記録は省略 = 名前が出る行が相手の記録）。Realtime payload に logged_by は含まれるため追加購読不要。
- **受け入れ基準**: 2 アカウントで各 1 件記録し、相手の記録にのみ表示名が付く。
- **検証**: vitest — 自分/相手の表示分岐。手動: ローカルスタック 2 アカウントで確認。

### UX-08 [M]（4/4/4）baby 鮮度フォールバック — **I-04 の baby 分先行実装**（D4-03）

- **触るファイル**: `baby-dashboard.tsx:192-218`（fetch を useCallback 化し、visibilitychange/focus で選択日 refetch — 移植元 `src/components/calendar/use-month-events.ts:169-179` の実証済みパターン。AbortController 維持）/ `baby-date-nav.tsx` 横に手動更新ボタン（Lucide RefreshCw、size-11、同期中 animate-spin）/ CHANNEL_ERROR/TIMED_OUT 時の「同期が不安定です」muted 表示
- **採択条件**: **I-04 本体の Issue を「baby 分は済み・meals/shopping が残」に改訂**すること（二重予約防止、J3 指摘）。**誤読禁止注記**: I-04 の実装済みは calendar（use-month-events.ts）のみで、use-week-meals 側は未実装のまま — 「済み」と誤読して meals 分を落とさないこと（R3 提案採用）。
- **受け入れ基準**: (1) クライアント A で記録 → クライアント B（Realtime 切断状態）でタブ復帰 → 手動操作なしで記録が現れる。(2) 手動更新ボタン押下で refetch が走り同期中は spinner 表示（vitest）。(3) CHANNEL_ERROR/TIMED_OUT 受領で「同期が不安定です」表示が出る（vitest）。※(2)(3) は R2 BLK の解消 — 新規コード 2 点に合否なしの状態を廃し、§7b「全 PR で対応テスト」の自己規律に整合させる。
- **検証**: vitest — refetch の dedupe（B-08 のマージロジックと整合）+ 受け入れ基準 (2)(3) の 2 本。手動 e2e はローカル 2 クライアントで (1) の合否（本番 #92 下の実効は §4 D-2 の分岐後に確認)。
- **順序**: B-08 の後（同ファイル・fetch 経路共通化）。

### UX-09 [S]（3/4/3）baby 面のタッチターゲット 44px 是正（D1-08、**I-24 の baby 分先行**）【R3 BLK-1 / R2 BLK で全面改訂】

- **スコープ訂正（R3 BLK-1）**: segmentCn の呼び出し元は baby 4 箇所ではなく **7 箇所**（baby: feeding-timer.tsx:184,191 / baby-log-form-sheet.tsx:225,263、**settings: default-page-card.tsx:53 / theme-card.tsx:37 / export-card.tsx:62**）。共有ユーティリティ `segment-cn.ts` への min-h-11 追加は settings UI も変えてしまい、上記「共通 UI 分界基準」（寸法変更は I-24 管轄）と自己矛盾する。→ **segment-cn.ts 本体は触らない**。
- **触るファイル（改訂後）**: baby 側の**呼び出し 4 箇所にのみ** `min-h-11` をクラス追記（segmentCn の結果に連結）/ `feeding-timer.tsx:222-228`（キャンセルを min-h-11 px-4 化）/ `baby-log-form-sheet.tsx:352-373`（削除確認 2 ボタンを min-h-11 上書き — 不可逆操作の確定ボタン 28px は U2 で Important 判定）
- **分界**: sheet.tsx の閉じる X（28px）・Button primitive 全 size・**segmentCn 本体と settings 3 箇所**は I-24 管轄 → 採択時に I-24 Issue へ「**baby 呼び出し側 4 箇所は済み（segmentCn 本体・settings は未済のまま I-24）**」と改訂。
- **受け入れ基準（R2 BLK の解消 — 検証手段と同レベルに統一）**: (1) クラスレベル: 対象 7 要素（セグメント 4 + キャンセル + 削除確認 2）に `min-h-11` が付与されている（vitest クラス assert — jsdom は computed layout を測れないため基準をクラスに置く）。(2) 実レイアウト: e2e で代表 2 要素（削除確認ボタン・タイマー左右）の boundingBox height ≥ 44px（打ち消しクラス・CSS 上書きの検出はこちらが担う）。
- **検証**: vitest クラス assert + e2e boundingBox 2 点。

### UX-10 [M]（3/4/5）折れ線チャートの計測適合性（D3-02。F-01 の前提）

- **触るファイル**: `src/components/baby/charts/line-chart.tsx`（124 行実測）— (1) x 軸を日付比例（date→ms 正規化。現 index 等間隔 :57-61 を置換）、(2) y 値域に種別別最小スパンフロア（体重 500g / 身長 2cm、props）、(3) min/max の y 軸ラベル 2 点表示。`growth-chart-section.tsx:55-75` は LineChartPoint への date 追加のみ。
- **受け入れ基準**: (1) 測定日 [d0, d0+3, d0+33] の x 座標が日数比例。(2) 値 [5000, 5050] のとき span が 500 にフロアされ視覚上ほぼ平坦（50g 変動の急勾配誤読を排除）。(3) 空/1 点/全同値の既存エッジが回帰しない（line-chart.test.tsx 既存 4 本 + 追加）。
- **検証**: 全て vitest 純関数/コンポーネントテストで固定可。

### UX-11 [S]（3/4/4）体重増加ペース g/日（D3-03）

- **触るファイル**: `baby-log-aggregation.ts`（`growthRatePerDay` 純関数新設。直近 2 測定差分 ÷ 日数。同日 2 回・単点・0 日間隔は null。**`Number.isFinite` ガード必須** — CLAUDE.md NaN 則）/ `growth-chart-section.tsx:49-53`（「+28g/日」を text-xs text-muted-foreground 併記）。医学的判定ラベルは付けない（事実提示のみ）。
- **PDF への列追加は I-07 の後**（route/report 同ファイル接触のため。I-07 未着手のうちは本 PR から除外）。
- **検証**: vitest — 通常/同日/単点/null 混在/減少（負値）/0 日間隔。

### UX-12 [S]（3/4/4）PDF 導線を baby ページへ + 日付入りファイル名（D3-05）

- **触るファイル**: `baby-dashboard.tsx:311` 付近（成長曲線の下に「受診用レポート」glass カード。`src/components/settings/export-card.tsx` の期間セグメント+DL を共通コンポーネント化して再利用、重複実装しない）/ export-card.tsx:34（`a.download = "baby-log.pdf"` 固定を廃しサーバの Content-Disposition = route.ts:95 の日付入り名を尊重）
- **縮退条件**: ファイル名修正は **AUDIT-064 = I-07 の一部と同一項目**。I-07 が先に入るなら (2) を落とし導線設置のみに縮小（1 関心事維持）。
- **受け入れ基準**: baby ページから 2 タップで PDF DL、ファイル名が `baby-log_YYYY-MM-DD_YYYY-MM-DD.pdf`。
- **検証**: コンポーネントテスト（DL ボタン表示 + `/api/baby-report?period=` fetch 呼び出し）。手動: ローカルスタックで DL ファイル名確認。

### AX-01 [S] a11y 補修バッチ（U2 由来・設計案外の機械検出分）

- **内容**: (1) `@media (prefers-reduced-motion: reduce)` を globals.css に追加（DESIGN_SYSTEM.md:118,167 の宣言が未実装 = U2-05。blur は維持しアニメーションのみ縮退）。(2) sheet.tsx/dialog.tsx の sr-only "Close" → 「閉じる」（U2-10、UI 全日本語規約）。(3) form-sheet の `<Label>種類</Label>` を fieldset/legend or radiogroup 化 + セグメントに aria-pressed（U2-08）。
- **順序**: §7c の axe 導入 PR の後（axe が検出する違反の緑化を兼ねる）。(3) は UX-02/04b/06 と同ファイルのため最後に rebase。
- **検証**: vitest（role/aria assert）+ axe spec green。**(1) prefers-reduced-motion は axe/vitest では検出不能**（R2 BLK の解消）: Playwright の `emulateMedia({ reducedMotion: 'reduce' })` 下で対象要素の computed style（`animation-duration` 等が縮退値）を assert する e2e を合否条件に含める。
- **対象外（人間判断へ）**: primary コントラスト 3.45:1（U2-04/NEW-A11Y-002、意匠）/ glass カード輪郭 1.02:1（U2-11）/ チャートのデータテーブル代替（U2-09、次ラウンド起票候補）。

---

## 6. 新機能計画（feature は polish と分離）

### F-01 [L] 成長曲線パーセンタイル帯（D3-01。価値 4 / コスト 3 / 適合 4）

- **価値仮説**: 「うちの子は帯の中か」= 育児不安の中心に母子手帳と同じ基準（厚労省 2010 年乳幼児身体発育調査）で答える。成長機能を「記録」から「評価」へ格上げする唯一の提案。
- **段階導入**（スタック 3 PR、D3-01 案どおり）:
  - PR-1: migration `households.baby_sex TEXT CHECK (baby_sex IN ('boy','girl'))` NULL 許容 + settings の性別セグメント（segmentCn + min-h-11）。**down migration（列 DROP）同梱必須**。RLS は既存 households ポリシー（SELECT/UPDATE/DELETE 分離）で列追加のみ・変更なし。**着手は #113 マージ後**（#113 が settings-content.tsx を +4 行変更済みのため — R1 指摘）。
  - PR-2: `src/lib/domain/growth-percentile.ts` 新設 — 月齢別 3/10/25/50/75/90/97 パーセンタイル値を静的 TS 定数で同梱（外部 API・新規依存ゼロ）。**転記検証を機械化する**（R2 指摘 — 転記者がテスト期待値も書くと循環検証で転記ミスが素通りする）: 独立二重転記（別担当/別セッションが同一出典から再転記した定数と diff ゼロ確認）、または公表資料からの機械抽出値との突合スクリプトを PR に同梱し、レビューを機械検証可能にする。転記ミスは実装バグより重い（J2 指摘）。
  - PR-3: LineChart に帯レイヤー（fill-muted の帯 + muted-foreground の中央値細線、semantic token のみ）。性別 or 生年月日未設定時は帯非表示 + 設定導線（baby-age-header.tsx:24-33 の既存パターン）。
- **前提**: (1) **人間の価値確認先行**（§9）。(2) UX-10 で座標系確定後（同一ファイル）。(3) I-09a（H2-03 誕生日 CHECK）先行推奨 — 性別設定導線の追加で誕生日登録の露出がさらに増えるため。
- **検証**: 公表参照値一致の unit test（男児 3 ヶ月中央値の再現、境界月齢・補間・帯外値）/ 性別未設定→帯なし / migration はローカルスタックで up→down→up。
- **撤退条件**: 一次資料の突合が取れない系列は帯を出さない（中央値のみ等へ縮退）。家庭内試用で「帯が不安を増幅する」フィードバックが出たら表示を settings でオフ可能にするか撤去（表示層のみの機能ゆえ撤去コスト小）。

### F-02 [M] 「くすり」クイック記録（D4-08。価値 4 / コスト 3 / 適合 3）

- **価値仮説**: 引き継ぎ 3 問のうち「薬あげた?」だけ記録手段自体が無い（`grep -rn "medicine|薬" src/` = 0 件）。**二重投与は全 30 提案で唯一「実害が子に及ぶ」項目**（ビタミン D なら毎日）。ENUM の実在先例（R1 指摘で cite 訂正）: `baby_log_type` は初期 migration（20260410000001）で 3 種、**20260411000001:15-17 の `ALTER TYPE ... ADD VALUE` で拡張済み** — F-02 はこの実在先例（+ CHECK 分離の 20260411000003）をそのまま踏襲する。
- **段階導入**:
  - Phase 1: migration① `ALTER TYPE baby_log_type ADD VALUE 'medicine'` / migration②（**別ファイル必須** — CLAUDE.md 既知罠「ALTER TYPE ADD VALUE と CHECK は別マイグレーション」）。memo 列を薬名に流用（新カラムなし）。クイックボタン（Lucide Pill、min-h-11）+ Undo + タイムライン表示 + まとめバーに本日投与の有無。
  - Phase 2（別判断）: PDF 表・薬名サジェスト。**服薬リマインダ/スケジュールには踏み込まない**（AUDIT-043B の保留判断尊重）。
- **前提（必須ゲート）**: (1) **人間の価値確認先行**（ENUM ADD VALUE は Postgres で DROP 不能＝**不可逆 migration を未検証仮説に先払いしない** — J2/J3 指摘）。(2) 色は D4-08 案の rose/teal（パレット外）を使わず、DESIGN_SYSTEM.md:35-46 のカテゴリ表 or 既存 semantic token から選定（意匠確認は §9）。
- **ロールバック**: down migration は「no-op + 文書化」（ENUM 値は残置で無害、UI の露出のみ revert で消す）。この不可逆性を PR 本文に明記。
- **検証**: actions テスト（medicine 記録/Undo）/ 集計 unit / migration ①→② の分離適用をローカルスタックで確認。
- **撤退条件**: 家庭内試用 2 週間で使用 0 なら UI から隠す（ENUM 値は残る）。

### F-03 [据え置き] 過去日クイック記録の解禁 + updateLog サーバ検証（D2-01 の残余要素）

- UX-02（時刻編集）で「昨日の記録し忘れ」の大半（記録→時刻修正）が救えるため、**UX-02 の価値検証後に次ラウンドで判断**。誤って過去日へ「今」を記録する新リスクとのトレードオフは実利用の声を待つ（D4 の見送り判断を採用）。updateLog の最小サーバ検証（endedAt>loggedAt 等）は AUDIT-042（入力検証ゼロ）の是正として I-xx 系の検証テーマに合流させるのが筋。

### 見送り継続（前回計画の判断維持）

- I-20 アレルギー管理 / AUDIT-043B 予防接種・検診 / I-21 オフライン書込キュー（B-07 が前哨）/ 非推奨 3 件（Places・家事分担・ツール major 追随）。理由は各 D レポートの再評価表と一致（D2 §2 / D3 §1 / D4 §2）。

---

## 7. 検証戦略

### (a) no-regression ゲート（全 PR 必須）

- `pnpm lint` / `tsc --noEmit` / `pnpm test:run` green + Playwright e2e green + `pnpm build` 成功。基準は**件数固定でなく「その時点の main の green と同等以上」**（本計画作成時点の参考値: 48 files / 354 tests @ e77a376。#112 の vitest bump 等で分母は動く — R1 提案採用）。
- CI が赤のまま merge しない（I-02 の ruleset 有効化が済めば機械強制される — 人間トラック）。

### (b) 新規変更のテスト必須

- 全 PR で対応テスト追加（不要なら理由を PR 本文に明記）。バグ修正は **fail-red 先行**を必須とし、red→green のログを PR に貼る（§3 各項に fail-red 内容を定義済み）。
- B-05 のテストは I-18（deleteLog 未カバー）の穴埋めを兼ねる。I-18 の残余（approveUser/generateInvite）は前回計画のまま。

### (c) a11y 自動チェックとオフライン e2e の格上げ（計画項目）

- **AX-00 [S] axe 導入 PR**: `@axe-core/playwright` を devDependencies に追加し、`e2e/a11y.spec.ts` 新設 — /login・/meals・/shopping・/baby・/settings を axe スキャン。**着手は #112 / I-01（7/20 パッチ）の決着後**（package.json + pnpm-lock.yaml の衝突回避 — R1 BLK-1）。**既知違反（primary コントラスト = NEW-A11Y-002 等、意匠判断待ち）は spec 内に理由付き waiver リストとして明示**し、waiver の追加はレビュー必須とする。初回から全 green を狙わず「新規違反の流入を止める回帰ゲート」として運用開始。AX-01（§5）が waiver を減らす。
- **オフライン e2e 拡張**: `e2e/offline.spec.ts` に「offline 状態で baby 記録タップ → エラートースト表示 & error boundary 全画面に遷移しない」を追加（B-07 とセットで同 PR or 直後）。sw.js APP_PAGES の /calendar 欠落（U3 補足観察）は **I-10 管轄**（本計画では触らない — 二重予約回避）。

### (d) 手動確認の規律

- 「実機観察」という語の単独使用は禁止。手動確認は必ず**観測手順 + 合否条件**をセットで PR 本文に記載する（§3・§5 の各項で定義済み。未確定事項は §4 の診断手順書形式で分岐まで書く）。

---

## 8. 実装順序・依存関係・ロールバック方針

### 8.1 ウェーブ構成

```
Wave 0（S 級 — R1 BLK-2 で直列規律を明記）:
  並列: B-05(server のみ), B-06, B-09, B-10
  直列: B-06 → B-07(+offline e2e)   ※form-sheet 同行域（132-175 ⊃ 140-143）
  AX-00(axe 導入) は #112/I-01 決着後（§8.4）

Wave 1（コア・バグ — baby-dashboard.tsx/page.tsx 接触 4 本は severity 優先の直列）:
  B-01(Critical・最優先/7-20 bump 非待機) → B-08 → B-02(=I-11 拡張+クエリ対称化) → B-03
  B-04 は独立・並列可

Wave 2（UX 磨き込み — ファイル衝突順に直列化、独立系は並列）:
  独立並列: UX-03a → UX-03b(同 layout.tsx) / UX-07 / UX-09 / UX-10 / UX-12
  form-sheet 系直列: (B-06, B-07) → UX-02 → UX-04b → UX-05 → UX-06 → AX-01(3)
  dashboard 系直列: (B-03, B-08) → UX-08 → UX-04a
  summary 系直列: (B-02, B-09) → UX-01
  Undo 系: (B-05) → UX-03c
  AX-01(1)(2) は AX-00 後いつでも

Wave 3（feature — 人間ゲート後）:
  (UX-10, 人間OK, I-09a, #113 マージ) → F-01 PR-1 → PR-2 → PR-3
  (人間OK, 意匠確認) → F-02 Phase 1
```

### 8.2 依存の要点

- **B-01 と UX-02 は独立に H2-01 の脱出口を作る**（B-01=トグル復活、UX-02=手動終了）。両方入れてよい（二重実装ではなく相補）。
- 同一ファイル多重接触の rebase 順は §8.1 の直列指定を厳守（baby-log-form-sheet.tsx が最混雑: B-06 → UX-02 → UX-04b → UX-05 → UX-06 → AX-01）。
- 前回計画への Issue 改訂条件（採択時必須）: I-06（baby-dashboard 分済みへ縮小 = B-08）/ I-04（baby 分済み = UX-08）/ I-24（baby 4 箇所済み = UX-09）/ I-14（NEW-114-01 追記 = B-11）/ I-09a（H2-03 露出増の優先度注記 = B-04）/ I-07（UX-11 PDF 列・UX-12 ファイル名の分界注記）。

### 8.3 ロールバック方針

- 全 PR は単一 revert で戻せる構成（機能 flag 不要の表示層中心）。
- **migration を含む PR（F-01 PR-1 / F-02 / I-09a）は down 手順必須**: F-01 = 列 DROP の逆 migration 同梱。F-02 = ENUM ADD VALUE は**不可逆**（down は no-op + 文書化、UI revert で露出を消す）— この非対称を PR 本文に明記し、だからこそ人間の価値確認をゲートにする。I-09a（CHECK 変更）は旧 CHECK 復元の逆 migration（前回計画の規律どおり）。
- コードデプロイ ≠ migration 適用（別途手動 — MEMORY.md の本番運用どおり）。migration を含む PR はデプロイ手順（migration 先行 or 後行の順序）を PR 本文に明記。

### 8.4 Next.js 7/20 セキュリティリリース（I-01）・PR #112 との干渉

- 明後日 2026-07-20 に 16.2 系パッチ公開予定（前回計画 I-01、人間トラック）。**in-flight PR #112**（npm minor-patch group 8 件: next / @supabase/* / vitest 等）も同 2 ファイル（package.json / pnpm-lock.yaml）を占有する（R1 BLK-1 の反映）。
- **干渉方針**: (0) #112 の扱いは I-01 と統合判断（人間トラック: 7/20 パッチと一本化して #112 を閉じ直すか、#112 先行→7/20 再 bump か）。本計画側で package.json を触るのは AX-00 のみで、**AX-00 は #112/I-01 決着後に着手**。(1) 7/19-20 は Wave 0 の S 級を merge。**例外: B-01 は Critical（毎晩発生）ゆえ bump を待たずに merge してよい**（bump 側 or B-01 側の rebase コストを明示的に受容 — R3 指摘の明文化）。B-02/B-03 は bump PR のマージ後に rebase + CI 再実行してから merge。(2) bump に breaking が混ざった場合は本計画の全 in-flight ブランチを rebase してから継続。(3) UX-03b は `viewport.themeColor` という Next.js API 面を触るため、bump 後に generate-viewport.md の該当節を再確認してから merge。

---

## 9. 人間判断が必要な項目（明示リスト）

| # | 判断事項 | 関連 | 期限感 |
|---|---|---|---|
| 1 | **F-01（パーセンタイル帯）を作るか** — L 級 + migration + 厚労省数値転記検証の重さに価値が見合うか | F-01 | Wave 3 前 |
| 2 | **F-02（くすり記録）を作るか** — 不可逆 ENUM migration の先払い判断。色選定（パレット外 rose/teal 回避）も併せて | F-02 | Wave 3 前 |
| 3 | **primary コントラスト 3.45:1（ライト）** — `--primary` の L 引き下げ or テキスト用トークン分離（意匠）。#114 で違反箇所増加（baby-age-header.tsx:45 等） | U2-04 / NEW-A11Y-002 / AX-00 waiver | 任意（waiver 運用で流入は止まる） |
| 4 | **AUDIT-071: 在庫 0 を許すか** — 現挙動追認コメントが追記済み（stock-form.ts:18）で監査指摘と衝突したまま | I-24 着手前 | I-24 前 |
| 5 | **タイムライン vs 週間サマリーの並び順**（U4-06、2 画面スクロール）— 情報設計の好み。UX-01 でまとめバーが 3 問に答えればスクロール頻度は下がる見込みのため、UX-01 後に再評価 | U4-06 | UX-01 後 |
| 6 | **DESIGN_SYSTEM 最小 14px 規約 vs 実装の 10-12px 慣行**（U4-12 / U2 §8）— 規約改定か実装引き上げかを一度決める | docs/DESIGN_SYSTEM.md:53 | 任意 |
| 7 | **glass カードのライト輪郭 1.02:1**（U2-11）— 意匠判断 + 実機体感 | U2-11 | 任意 |
| 8 | 前回計画からの継続: 公開サインアップ無効化（Critical=0 のゲート前提）/ web↔Flutter 戦略 / I-02・I-03 の人間作業 | implementation-plan §0-1 | 継続 |
| 9 | 採択時の **Issue 改訂**（I-04/I-06/I-09a/I-14/I-24/I-07 への分界注記 — §8.2） | 各 B/UX | 各 PR 起票時 |
| 10 | **角丸規約の doc-sync** — DESIGN_SYSTEM.md:104-109 の表（カード=rounded-xl）が CLAUDE.md・実装（glass+rounded-2xl）と矛盾。どちらを正とするか決めて他方を直す（R3 指摘。新規カード実装者が迷う） | docs/DESIGN_SYSTEM.md | UX-12/F 系のカード追加前 |

---

## 10. 却下した設計案とその理由

- **score 1-2 の提案はゼロ**（J1 明言: 「落とすべき提案（score 1-2）は無し。全提案が実測摩擦に根拠を持つ」。最低点は 3）。よって「価値疑義による却下」は無し。ただし以下を**不採用・吸収**とした:

| 不採用/吸収 | 理由 |
|---|---|
| D1-01 / D2-06（クラスタ A 変種） | D4-01 に吸収（うんち内訳まで 1 PR 完結 + I-11 分界明記が最良形）。D1-01 の aria 相乗りは B-09 へ分離（J2: 混載回避） |
| D1-07 / **D2-01**（クラスタ B/E 変種） | D4-04 に吸収。**D2-01 は時刻編集 + 過去日解禁 + サーバ検証の混載でスコープ膨張**（J2: M 申告過小、J3: 1 PR = 1 関心事に緊張）。過去日解禁は F-03 へ据え置き |
| D1-03 / **D2-04**（クラスタ C 変種） | D4-06 の 2 PR 分割案（UX-04a/b）に吸収。**D2-04 は共通 sheet.tsx の挙動改変で退行面が baby 外へ広がる**ため不採用（採用案は prop 透過のみ） |
| **D2-03**（トースト 3 関心事束ね） | 位置（UX-03a）/ テーマ配線（UX-03b）/ Undo 拡張（UX-03c）へ**分解**。1 PR = 1 関心事（J3: D4-07 の分界の方が忠実） |
| **D4-07 の Undo 拡張（原案のまま）** | 睡眠終了 Undo の **idx_one_active_sleep 23505 衝突経路が未検討**（J2 指摘）。UX-03c として 23505 分岐を必須要件に再設計して採用 |
| **D2-07（体温の値自動充填）** | D3-07（placeholder 限定 + 桁誤り警告）と方針衝突。**未変更のまま保存 → 同値重複レコード**の事故経路があるため placeholder 方式を採用（UX-06） |
| D1-04（catch 横展開の変種） | D2-05 と同一内容。grep 網羅を PR 本文に載せる検証規律を含む D2-05 を正典に（B-07） |
| D2-02（量を追加の変種） | D4-05 と同一内容。片方採用（UX-05） |
| **D1-08 の一部（共通 Button/sheet X）** | I-24 と二重予約（J3: 4 レポート間で唯一の相互矛盾）。baby 面 4 箇所のみ採用（UX-09）、共通 UI は I-24 へ |
| **D4-08 の rose/teal 配色** | Liquid Glass パレット外の新色導入。機能自体は F-02 として人間ゲート付きで採用、色は DS 内から再選定 |
| D3-05 の (2) ファイル名修正 | AUDIT-064 = I-07 と同一項目。I-07 先行時は落とす縮退条件付きで採用（UX-12） |
| **H3-03 の修正案** | finding 自体が REFUTED（React Compiler の memo 化で機構不成立）。修正せず、派生観察のみ §4 D-1 で診断 |

---

## 付録: 本計画の PR 総覧（見積は J2 の effort 妥当性審査済み値）

| ID | 種別 | 規模 | 一言 | 主対象 |
|---|---|---|---|---|
| B-01 | Bug(Critical) | M | 日跨ぎアクティブ睡眠の袋小路解消 | page.tsx / baby-dashboard.tsx |
| B-02 | Bug(Important) | M | 睡眠集計統一（I-11 拡張、4+1 点セット） | baby-log-aggregation.ts / page.tsx / route.ts |
| B-03 | Bug(Important) | M | 記録反映の楽観 append（Realtime 非依存化） | baby-dashboard.tsx / baby-quick-actions.tsx |
| B-04 | Bug(Important) | S | 誕生日 UTC 罠のアプリ層防御（migration は I-09a） | settings/actions.ts / baby-profile-card.tsx |
| B-05 | Bug(Minor) | S | deleteLog 0 行 silent success（server のみ・client は実装済み） | baby/actions.ts:314-318 |
| B-06 | Bug(Minor) | S | 0ml falsy 衝突 | baby-log-form-sheet.tsx:140-143 |
| B-07 | Bug(Minor) | S | 通信断 catch 7 ハンドラ横展開 + offline e2e | baby-quick-actions.tsx / baby-log-form-sheet.tsx |
| B-08 | Bug(Minor) | S | 日付ナビ fetch の error 処理 + dedupe マージ（I-06 baby 分） | baby-dashboard.tsx:211-213 |
| B-09 | Bug(Minor) | S | まとめバー過去日ラベル + role="group" | baby-summary-bar.tsx / baby-dashboard.tsx |
| B-10 | Bug(Minor) | S | 相対時刻の負値クランプ | baby-log-labels.ts |
| B-11 | Bug(Minor) | — | 起票のみ: growth 1000 行 → I-14 相乗り | page.tsx:60-68 |
| UX-01〜12, AX-00/01 | Polish | S〜M | §5 参照（クラスタ正典のみ採用） | baby 領域 + layout/sonner |
| F-01 / F-02 | Feature | L / M | §6 参照（人間ゲート必須） | migration 含む |
