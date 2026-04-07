# irori デザインシステム — Liquid Glass

## コンセプト

「囲炉裏」— 家族が集まる温かい場所。Apple Liquid Glass の透明感ある美しさと、
炉の温もりを感じるアンバー/オレンジを融合させた UI。

## 体験設計

| 項目 | 定義 |
|------|------|
| 対象ユーザー | 少人数の家族（Android / iOS 混在環境） |
| 利用シーン | 片手操作、キッチン、スーパー |
| 最重要UX品質 | **速さ** + **明快さ** |
| 最重要タスク | 献立確認、買い物チェック |
| 失敗しやすい操作 | 誤タップ（片手操作時） |

## カラーパレット

### Semantic Tokens (CSS Custom Properties)

```
--primary:            oklch(0.65 0.19 50)    // 温かみのあるオレンジ #e07020
--primary-foreground: oklch(1 0 0)            // 白
--background:         oklch(0.985 0.005 75)   // わずかに温かみのある白
--foreground:         oklch(0.18 0.02 50)     // 深い暖色系ブラック
--card:               oklch(1 0 0 / 60%)      // Liquid Glass: 半透明白
--border:             oklch(0.92 0.01 75 / 60%)
--muted:              oklch(0.96 0.008 75)
--muted-foreground:   oklch(0.50 0.02 50)
--destructive:        oklch(0.58 0.22 27)     // 赤
--ring:               oklch(0.65 0.19 50 / 40%)
```

### カテゴリカラー（食材バッジ）

| カテゴリ | 色 | Tailwind |
|---------|-----|---------|
| 野菜 | 緑 | `bg-emerald-100 text-emerald-700` |
| 肉 | 赤 | `bg-red-100 text-red-700` |
| 魚介 | 青 | `bg-blue-100 text-blue-700` |
| 乳製品 | 紫 | `bg-violet-100 text-violet-700` |
| 穀物 | アンバー | `bg-amber-100 text-amber-700` |
| 調味料 | 黄 | `bg-yellow-100 text-yellow-700` |
| ベビー | ピンク | `bg-pink-100 text-pink-700` |
| その他 | グレー | `bg-gray-100 text-gray-600` |

## タイポグラフィ

- **見出し**: Geist Sans, 600weight
- **本文**: Geist Sans, 400weight (日本語はシステムフォントフォールバック)
- **数値**: Geist Mono
- **最小フォントサイズ**: 14px (モバイル本文は16px)
- **行間**: 本文 1.6, 見出し 1.3

## Liquid Glass エフェクト

### Glass パネル（3段階）

```css
/* メインカード */
.glass {
  background: oklch(1 0 0 / 55%);
  backdrop-filter: blur(40px) saturate(1.8);
  border: 1px solid oklch(1 0 0 / 30%);
}

/* 控えめなガラス */
.glass-subtle {
  background: oklch(1 0 0 / 40%);
  backdrop-filter: blur(24px) saturate(1.5);
  border: 1px solid oklch(1 0 0 / 20%);
}

/* ナビゲーション */
.glass-nav {
  background: oklch(1 0 0 / 70%);
  backdrop-filter: blur(48px) saturate(2);
  border-top: 1px solid oklch(1 0 0 / 40%);
}
```

### 影（深度表現）

```
カード:   shadow-lg shadow-black/[0.04]
モーダル: shadow-xl shadow-black/[0.08]
ナビ:     shadow-none (border-top のみ)
```

## スペーシング

| 要素 | 値 |
|------|-----|
| ページ左右パディング | `px-4` (16px) |
| カード内パディング | `p-4` (16px) |
| セクション間 | `gap-6` (24px) |
| アイテム間 | `gap-3` (12px) |
| タッチターゲット最小 | 44x44px (`touch-target`) |
| ボトムナビ高さ | 64px + safe-area |

## 角丸

| 要素 | 値 |
|------|-----|
| ページパネル | `rounded-2xl` |
| カード | `rounded-xl` |
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
- 3タブ: 献立 / 買い物 / 設定
- glass-nav エフェクト
- Lucide アイコン（24px）
- アクティブ: primary カラー
- 非アクティブ: muted-foreground

### MealCard
- glass カード
- 日付ヘッダー + meal_type バッジ
- リアクションボタン（😋😐🙅）※ UI要素としてのemoji使用は許容
- タップで編集シート展開

### ShoppingItem
- チェックボックス + アイテム名 + カテゴリバッジ
- チェック時: テキスト取り消し線 + opacity-50
- スワイプ不要（片手タップで完結）

### 状態表現

| 状態 | 表現 |
|------|------|
| 読み込み中 | Skeleton (animate-pulse) |
| 空 | イラスト + メッセージ + CTA |
| エラー | toast (sonner) + 赤色インジケータ |
| 同期中 | 小さなスピナーアイコン |
| 成功 | toast + チェックマーク |

## アンチパターン（禁止事項）

- `transition-all` 使用禁止 → `transition-colors` 等を使用
- layout shift を起こす `scale` ホバー禁止
- アイコンとしての絵文字使用禁止（Lucide SVG を使う）
  - 例外: リアクション（😋😐🙅）はUI要素として許容
- 過度な影やグロー効果
- カスタムスクロールバー
- 複雑なアニメーション（400ms超のトランジション）

## アクセシビリティ

- コントラスト比: テキスト 4.5:1 以上
- フォーカスリング: `outline-ring/50`（デフォルト維持）
- タッチターゲット: 最小 44x44px
- ラベル: 全フォーム要素に `<Label>` 必須
- `aria-label`: アイコンのみボタンに必須
- `prefers-reduced-motion`: Glass blur は維持、アニメーションのみ無効化
