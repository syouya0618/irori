# irori デザインシステム — Liquid Glass

## コンセプト

「囲炉裏」— 家族が集まる温かい場所。Apple Liquid Glass の透明感ある美しさと、
炉の温もりを感じるアンバー/オレンジを融合させた UI。

## 体験設計

| 項目 | 定義 |
|------|------|
| 対象ユーザー | 少人数の家族（Android / iOS 混在環境） |
| 利用シーン | 片手操作、抱っこ中、夜間の授乳 |
| 最重要UX品質 | **速さ** + **明快さ** |
| 最重要タスク | 育児ログの記録、今日・明日の予定確認 |
| 失敗しやすい操作 | 誤タップ（片手操作時） |

## カラーパレット

### Semantic Tokens (CSS Custom Properties)

```
--primary:            oklch(0.56 0.145 50)   // 温かみのあるオレンジ #b55508（白文字 4.5:1 の下限から決めた値）
--primary-foreground: oklch(1 0 0)            // 白
--primary-hover:      oklch(0.50 0.13 50)    // hover は薄めず暗く #9b4805（白文字 6.32:1。bg-primary/80 は 3.5:1 に落ちる）
--background:         oklch(0.985 0.005 75)   // わずかに温かみのある白
--foreground:         oklch(0.18 0.02 50)     // 深い暖色系ブラック
--card:               oklch(1 0 0 / 60%)      // Liquid Glass: 半透明白
--border:             oklch(0.92 0.01 75 / 60%)
--muted:              oklch(0.96 0.008 75)
--muted-foreground:   oklch(0.50 0.02 50)
--destructive:        oklch(0.58 0.22 27)     // 赤
--ring:               oklch(0.56 0.145 50 / 90%) // focus リング。部品は ring-ring（薄めず）。白地 3.98 / 殻の角 3.38 / muted 3.74
```

ダーク（`.dark`）の主色は `oklch(0.70 0.17 50)`（#ef7926）+ 黒文字 `oklch(0.13 0 0)`。hover は黒文字ゆえ明るい側
`oklch(0.75 0.16 50)`（#fc8c45、8.6:1）。主色の塗りに `hover:bg-primary/80` や `/90` を使わず `hover:bg-primary-hover` を使う。

### 主色のコントラスト（Playwright 実測値。`src/app/__tests__/color-contrast-contract.test.ts` が基準以上であることを固定）

| 対 | ライト | ダーク | 基準 |
|------|------|------|------|
| 白文字 / 主色（ボタン） | **4.92:1** | 7.11:1（黒文字） | 4.5:1 |
| 白文字 / primary-hover | **6.32:1** | 8.61:1（黒文字） | 4.5:1 |
| 主色の文字 / background | **4.72:1** | 7.11:1 | 4.5:1 |
| focus リング（--ring 90%）/ background・殻の角・muted | **3.98 / 3.38 / 3.74:1** | 5.88 / 5.45 / 5.41:1 | 3:1 |
| 主色の文字 / glass-nav（ナビの現在地 12px）※ | **4.87:1** | 7.06:1 | 4.5:1 |
| muted-foreground / glass-nav（ナビの非選択） | 5.96:1 | 5.04:1 | 4.5:1 |
| 白文字 / destructive | 4.78:1 | 5.37:1 | 4.5:1 |

2026-10 まで主色は `oklch(0.65 0.19 50)`（#e56200）で、白文字 3.45:1・白地の文字 3.31:1・ナビ 3.42:1 と
通常文字の基準を満たしておらなんだ。この橙は白文字でも暗い文字（foreground で 4.05:1）でも 4.5:1 に
届かぬ明度（相対輝度 0.25）ゆえ、文字色の側では直せず主色の明度を下げた。sRGB の外（青が負）でもあり、
ブラウザの丸め方で色が揺れておった。**主色を明るく戻す変更は上のテストが落ちる**。
※ glass-nav の値はナビの背後が平らな `--background` の時のもの。実際は背後の中身に blur(48px) saturate(2) が
掛かるゆえ、主色の塗りがナビの真下に来た瞬間は 3 台まで下がりうる（過渡状態。ナビの 70% 白が下限を支える）。
`bg-primary/10 text-primary` の帯（アイコンの丸・小さなバッジ）は background の上で 4.15:1、glass の上で 4.23:1
（`/15` なら 3.85:1）。アイコン（3:1）には足りるが**文字を載せると 4.5:1 に届かぬ**。文字を載せる帯は
`text-foreground` にするか、`bg-primary text-primary-foreground` にせよ。

## タイポグラフィ

- **見出し**: Geist Sans, 600weight
- **本文**: Geist Sans, 400weight (日本語はシステムフォントフォールバック)
- **数値**: Geist Mono
- **最小フォントサイズ**: 14px (モバイル本文は16px)
- **入力欄**: 指で触る端末では 16px 以上（`src/app/touch-zoom.css` が `@media (pointer: coarse)` で床を敷く。
  iPhone Safari の自動拡大を防ぐため。18px 以上を明示した欄を除き 16px に持ち上がる。実機確認は未実施）
- **行間**: 本文 1.6, 見出し 1.3

## Liquid Glass エフェクト

### Glass パネル（3段階）

```css
/* メインカード（正本は src/app/globals.css。ぼかしは必ず --glass-filter 経由 — #169） */
.glass {
  --glass-filter: blur(40px) saturate(1.8);
  background: oklch(1 0 0 / 55%);
  -webkit-backdrop-filter: var(--glass-filter);
  backdrop-filter: var(--glass-filter);
  border: 1px solid oklch(1 0 0 / 30%);
}

/* 控えめなガラス */
.glass-subtle {
  --glass-filter: blur(24px) saturate(1.5);
  background: oklch(1 0 0 / 40%);
  -webkit-backdrop-filter: var(--glass-filter);
  backdrop-filter: var(--glass-filter);
  border: 1px solid oklch(1 0 0 / 20%);
}

/* ナビゲーション。上辺の線は border-top ではなく内側の box-shadow
   （border だと箱が --bottom-nav-h + 1px になり、pb-nav や退避量と 1px 食い違う） */
.glass-nav {
  --glass-filter: blur(48px) saturate(2);
  background: oklch(1 0 0 / 70%);
  -webkit-backdrop-filter: var(--glass-filter);
  backdrop-filter: var(--glass-filter);
  box-shadow: inset 0 1px 0 0 oklch(1 0 0 / 40%);
}
```

⚠️ ぼかしをリテラルで書くと Turbopack（lightningcss）が標準プロパティを削り、Chrome/Android で
ぼかしが掛からなくなる（globals.css の注記と `e2e/smoke.spec.ts` を参照）。

### 殻の背景（ナビを持たぬ画面）

ログイン・世帯作成・404・全体エラー・オフライン・承認待ちの背景は `bg-hearth`（囲炉裏の灯り）。
起点色 `--hearth-glow`（`:root` = primary の 14%、`.dark` = 10%。primary を変えたら対で変える）から
`--background` へ流す薄い暖色のグラデーションで、ダークにも追従する。
⚠️ `color-mix(in oklab, var(--primary) 14%, transparent)` で書いてはならぬ — ビルドの lightningcss が
color-mix を落として全開の primary を出す（2026-10-24 に build 後 CSS で実測。#169 の同族）。
`from-orange-50` のような**ライト固定のパレットを殻に直書きしない**（ダークで文字が読めなくなる。
`src/app/__tests__/shell-theme-contract.test.ts` が固定）。

### 影（深度表現）

```
カード:   shadow-lg shadow-black/[0.04]
モーダル: shadow-xl shadow-black/[0.08]
ナビ:     外側の影なし（上辺 1px の線を inset box-shadow で描く。箱の高さは --bottom-nav-h のまま）
```

## スペーシング

| 要素 | 値 |
|------|-----|
| ページ左右パディング | `px-4` (16px) |
| カード内パディング | `p-4` (16px) |
| セクション間 | `gap-6` (24px) |
| アイテム間 | `gap-3` (12px) |
| タッチターゲット最小 | 44x44px (`touch-target`) |
| ボトムナビ高さ | 64px (`--bottom-nav-h`) + safe-area (`--safe-bottom`) |
| (main) の下余白 | `pb-nav` = ナビ高さ + safe-area（layout が持つ。ページ側で足さない） |
| 浮く要素（FAB 等）の下端 | `above-bottom-nav` = ナビ高さ + safe-area + 16px（`bottom-24` の直書きは iPhone standalone で潜る） |
| FAB の高さ | `--fab-size` = 56px（`h-14`） |
| トーストの退避 | `--toast-clearance`: 既定 = ナビ高さ + safe-area + 12px。FAB を持つ画面 = ナビ高さ + safe-area + 16px + `--fab-size` + 16px（`ui/sonner.tsx` は変数名だけを渡す） |

ナビ・下余白・トースト・FAB は **同じ変数** `--bottom-nav-h` / `--safe-bottom`（globals.css の `:root`）から
導く。片方だけ変えて最後の行がナビの下に隠れる事故を構造で防ぐ。

### 浮く操作（FAB）とトーストの契約

画面下に浮く操作（予定追加の FAB。実装は Agent C の予定画面側）は次を守る。
守れば、下端トーストの本文の長さ・操作ボタンの有無・積み重なりに関わらず**操作領域が重ならぬ**。

1. **根の部品で `useFabClearance()`（`lib/hooks/use-fab-clearance.ts`）を呼ぶ**。React が
   `<html data-fab>` を立て、globals.css の `html[data-fab]` が画面に FAB が在る間だけ `--toast-clearance` を
   FAB の上端 + 16px へ上げる。要素に `data-fab` を付けるだけでは効かぬ（`body:has()` は Next の docs が
   戒める形で、Cache Components で隠れた route の FAB にも反応するため採らぬ）
2. **下端は `above-bottom-nav`**（ナビ + safe-area + 16px）。`bottom-[calc(4rem+…)]` の直書きと値は同じ
   じゃが、ナビの寸法を変えた時に追従せぬ
3. **高さは `--fab-size`（56px = `h-14`）**。変えるなら変数ごと変える
4. **横は列の右端**: `right-[max(1rem,calc(50%-16rem+1rem))]`（`max-w-lg` の列に揃える。広い画面で隅へ飛ばさぬ）。
   例外: 背の低い画面（高さ 500px 以下 = スマホの横向き）は画面の右端 `right-4` へ寄せてよい（C の実装の例外。
   殻の退避は縦に効くため必須ではないが、横向きでは縦の余裕が無く、横で離せる位置の方が害が少ない）
5. **重なり順は `z-10`〜`z-40`**（ナビ・シートの `z-50` より下。シートの暗幕が FAB を覆う）。トーストは sonner が
   `z-index: 999999999` を持ち、常に最前面
6. 下シートが開いておる間、トーストは上端へ逃げる（`[data-slot="sheet-content"]` の有無。上の「トースト」節）ゆえ
   FAB との縦の関係は変わらぬ。FAB は暗幕の下で触れぬ

幅 600px 以下（sonner の mobile 判定）ではトーストが全幅ゆえ横で避けられぬ。601px 以上でも中央 356px の
トーストは列の右端の FAB と横に重なる（1440px でも）。ゆえに**縦に退避する**のが唯一の手で、
どの幅でも同じ式を使う。**FAB 側でトーストの矩形を測って自分を持ち上げてはならぬ** — sonner の入場は
下から 400ms の translateY ゆえ、入場中の矩形が FAB の帯に掛かり FAB が一瞬跳ねて戻る（その方式の
`computeFabLift` に 390×844 の矩形を与えると、最終位置で 0、入場開始位置で 84px。C は独立レビューで外した）。

⚠️ **merge の順序**: この契約を知らぬ FAB（main の `calendar-view.tsx` の `bottom-24`）は下端トースト（下から
76px〜）に覆われる。殻の退避（A）は C の FAB の差分と**同時か、C が先**に入れること。
既知の限界: 横向き（844×390）で FAB を避けた位置に 3 件のトーストを展開すると、上端が画面の外へ出る
（畳んだ状態は問題ない）。

## 角丸

| 要素 | 値 |
|------|-----|
| ページパネル・glass カード | `rounded-2xl`（`glass rounded-2xl shadow-lg shadow-black/[0.04]`） |
| shadcn `Card` 基底 | `rounded-xl`（`className="glass"` を足して使う） |
| ボタン | `rounded-lg` |
| バッジ | `rounded-full` |
| 入力 | `rounded-lg` |

## トランジション

- **マイクロインタラクション**: `transition-colors duration-200`
- **パネル表示/非表示**: `transition-opacity duration-300`
- **シート**: shadcn Sheet のデフォルトアニメーション
- **禁止**: `transition-all`, `scale` による layout shift
- **`prefers-reduced-motion`**: アニメーションを無効化

## コンポーネントパターン

### BottomNav
- 3タブ: 育児 / 予定 / 設定（`src/components/common/bottom-nav.tsx`）
- glass-nav エフェクト。高さ 64px（`h-(--bottom-nav-h)`）+ `safe-bottom`
- Lucide アイコン（24px）。タブ名は `text-xs`（従来値。14px 規約との扱いは人間判断待ち:
  `docs/plans/2026-07-18-babycare-ux.md` §9 #6）
- アクティブ: `aria-current="page"` + primary カラー + 太線（strokeWidth 2.5）+ 太字 + アイコン裏の帯 `bg-primary/15`。
  色を抜いても太さの差で分かる。下位ページ（`/baby/search` 等）でも親タブが現在地
- 非アクティブ: muted-foreground（hover で foreground）
- タブ全体が押下領域（64px × 画面幅の 1/3）。キーボードは `focus-visible` の 2px 輪郭
  （`outline-none` を同居させない — Tailwind v4 では輪郭が none に解決する）

### 状態表現

| 状態 | 表現 |
|------|------|
| 読み込み中 | Skeleton (animate-pulse・`bg-muted-foreground/15`。`bg-muted` は glass の上で消える) |
| 空 | アイコン + メッセージ + CTA |
| エラー（画面） | `ErrorView`（glass カード・`bg-primary/10` の丸にアイコン・「もう一度試す」44px） |
| エラー（操作） | toast (sonner・`richColors`) |
| 同期中 | 小さなスピナーアイコン |
| 成功 | toast + チェックマーク |

### トースト（sonner）

- 位置は **下端・中央、ナビの上**（`ui/sonner.tsx` が `position` を持ち、退避量は globals.css の
  `--toast-clearance` を渡す。layout では `<Toaster />` のみ）。片手で押し間違えた直後の「取り消す」に親指が届く位置
- FAB を持つ画面（`useFabClearance()` が `<html data-fab>` を立てている間）では FAB の上端 + 16px まで上がる（上の「浮く操作（FAB）とトーストの契約」）
- 下シート（`SheetContent`）が開いている間だけ上端（top-center）へ逃がす。シートの下帯（削除・メモ欄）を覆わないため
- 画面の横向き（844×390 等）でも同じ式。ソフトキーボード表示中の位置は**実機未確認**（iOS Safari は
  fixed 要素をキーボードの下に残すことがある。問題が出れば viewport の `interactiveWidget` を検討）
- 操作ボタン（`[data-button]`）は 44px、本文 14px（globals.css が sonner の既定 24px / 13px を上書き）
- `richColors` のライトの文字色は globals.css が濃くする（success / info / warning / error = 5.8〜6.2:1。
  sonner の既定は 4.26 / 4.35 / 3.08 / 4.35:1 で 14px の本文に足りぬ。ダークは既定のまま 9〜12:1）
- テーマは `<html class="dark">` に追従（next-themes は使わない。Provider が無いため常に "system" になる）

## アンチパターン（禁止事項）

- `transition-all` 使用禁止 → `transition-colors` 等を使用
- layout shift を起こす `scale` ホバー禁止
- 絵文字使用禁止（アイコンは Lucide SVG を使う。例外なし）
- 過度な影やグロー効果
- カスタムスクロールバー
- 複雑なアニメーション（400ms超のトランジション）

## アクセシビリティ

- コントラスト比: テキスト 4.5:1 以上、アイコン・輪郭などの非テキスト 3:1 以上（上の「主色のコントラスト」。
  `color-contrast-contract.test.ts` がトークンの対を計算で固定する）
- フォーカスリング: `--ring`（主色 90%）を部品側で薄めず `focus-visible:ring-ring`（基底の outline も `outline-ring`）。
  白地 3.98 / 殻の角（bg-hearth）3.38 / muted 3.74:1、ダーク 5.4〜5.9:1（1.4.11 の 3:1）。以前は 40% × `/50` = 実効 20% で
  約 1.3:1 じゃった。80% は殻の角で 2.91 と割るため 90%。候補（実測）: 80% = 3.36 / 2.91 / 3.20、90% = 3.98 / 3.38 / 3.74、
  100% = 4.72 / 3.89 / 4.38。**濃さの最終判断は計画書 D-3 どおり実機で人間が決める**（ここは全ての地で 3:1 を満たす最小）。
  `ring-ring/50` のまま残る B の `baby-search-form.tsx:53` / `baby-date-nav.tsx:54` は実効 40% で約 1.8:1（引き継ぎ）。
  ナビの `focus-visible:outline-primary` は不透明な主色で 4.7:1 超。入力欄の境界 `--input` は白地の上 約 1.2:1 で、
  1.4.11 が境界に 3:1 を求めるかは他の手掛かり次第（人間判断）
- FAB を持つ画面のトースト退避は `useFabClearance()`（React が `<html data-fab>` を持つ。`:has()` は使わぬ）
- タッチターゲット: 最小 44x44px
- ラベル: 全フォーム要素に `<Label>` 必須
- `aria-label`: アイコンのみボタンに必須。装飾アイコンは `aria-hidden="true"`
- `prefers-reduced-motion`: Glass blur は維持、アニメーションのみ無効化
- **ピンチ拡大を禁じない**（WCAG 2.2 SC 1.4.4）: viewport に `maximumScale` / `userScalable: false` を書かない。
  ダブルタップ拡大は `html { touch-action: manipulation }` で切り、iPhone Safari の自動拡大は
  入力欄の 16px 床で防ぐ（どちらも `src/app/touch-zoom.css`。@layer の外に置く）。iOS 実機での確認は未実施
- 現在地・状態は色だけで示さない（ナビは帯、セグメントは塗り + 文字色）
