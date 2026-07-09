# Phase A: バグ潰し — PR 分割と TDD 詳細

> 親計画: `docs/plans/2026-07-08-childcare-ux-and-shared-calendar.md`
> **For Claude:** 各 PR は必ず **red → green** で進める。落ちるテストを書き、`pnpm test:run` で**実際に落ちることを確認してから**修正する。

**ベースライン**: `pnpm test:run` → **268 passed / 28 files / 2.24s**。全 PR でこれを割らないこと。

## 共通事項（実装者がまず知るべきこと）

### テストファイルの置き場と拡張子（間違えると import で落ちる）

`vitest.config.ts` は 2 つの project に**厳密に分岐**している（実読で確認）:

```ts
{ name: "node",  environment: "node",  include: ["src/**/__tests__/**/*.test.ts"]  }
{ name: "jsdom", environment: "jsdom", include: ["src/**/__tests__/**/*.test.tsx"] }
```

- テストは必ず **`__tests__/` ディレクトリの中**に置く（外に置くと**どちらの project にも拾われず、静かにスキップされる**）。
- **`.test.ts` = node**。React plugin が無いため、**JSX を含むモジュールを import すると落ちる**。
- **`.test.tsx` = jsdom + react**。コンポーネント・**フック（`renderHook`）**・サーバコンポーネントのテストは全てこちら。

| 本 Phase のテスト | 拡張子 | 理由 |
|---|---|---|
| `src/components/baby/__tests__/feeding-timer.test.tsx` | `.tsx` | コンポーネント |
| `src/lib/utils/__tests__/meal-types.test.ts` | `.ts` | 純粋な定数（JSX なし） |
| `src/lib/supabase/__tests__/low-stock.test.ts` | `.ts` | 純関数 + fake client（JSX なし） |
| `src/app/(main)/stock/__tests__/actions.test.ts` | `.ts` | Server Action（JSX なし） |
| **`src/components/meals/__tests__/use-week-meals.test.tsx`** | **`.tsx`** | **`renderHook` が react を要る。`.ts` にすると落ちる** |
| `src/components/shopping/__tests__/shopping-item.test.tsx` | `.tsx` | コンポーネント |
| `src/components/baby/__tests__/baby-weekly-summary.test.tsx` | `.tsx` | コンポーネント |

### 握り潰し検出スクリプトの `--strict` と盲点

```bash
./scripts/check-supabase-error-destructure.py --strict   # ← --strict 必須
```
- スクリプトは `return 1 if strict else 0`。**`--strict` を付けないと違反があっても exit 0** で素通りする。CI は `ci.yml:44` で `--strict` を使っている。
- **現状の検出器は `.then(({ data }) =>` を検出できない**（`baby-dashboard.tsx:176` の実在する握り潰しを見逃し、`--strict` でも exit 0 になる）。
  → **A-6c で検出パターンを追加し、先に赤くしてから直す**（検出器を直さずにコードだけ直すと、回帰を防げない）。

### `pnpm build` が要る PR

`"use server"` の export 面を触る PR（A-1 / A-6a / A-6b / A-8 / A-10）では `pnpm build` を必ず回す。
**Turbopack は `"use server"` からの非関数 export でビルドを壊すが、`tsc` では検出できない。**

---

## 0. 到達性の検証（**バグスイープのラベルを鵜呑みにしない**）

自動スイープが付けた深刻度を、**実行経路の有無**で検証し直した。結果、筆頭 high とされた 1 件に実行経路が無かった。

| 主張 | 検証コマンド | 結果 |
|---|---|---|
| `feeding-timer` の `isSaving` 永久 true | `grep -rn "FeedingTimer" src/` | `baby-dashboard.tsx:11,275` で使用 → **到達可能** |
| 永久ローディングは 1 箇所か | `setIsLoading(true)`/`setIsSaving(true)` を立てて `finally` 無しのファイルを列挙 | **4 箇所**。setup / 世帯参加 / 招待受諾 を見落としていた → A-1 に統合 |
| その 4 箇所は同じ修正でよいか | 3 ファイルのコメントと `setup/actions.ts:36` の `redirect("/meals")` を実読、Next 公式 `unstable_rethrow.md` を参照 | **否**。redirect する 3 つは `finally` 禁止・`unstable_rethrow` 必須。機械的に `finally` を付けると遷移が壊れる |
| `eating-out-actions` のデータ消失 | `grep -rn "EatingOutForm\|eating-out-form" src/` | **import 元ゼロ = 死コード。実行経路なし** → 潜在バグへ降格 |
| 「間食」が週ビューに出ない | `meal-form-sheet.tsx:222` が `MEAL_TYPES` を map / `meal-day-row.tsx:10` は 3 種のみ / `initial_schema.sql:134` に `UNIQUE(household_id,date,meal_type)` | **到達可能。ユーザーが詰む** |
| `+09:00` 欠如 | `grep -rn 'T00:00:00' src/` | **2 箇所**（`low-stock.ts:40`, `stock/actions.ts:205`）。他 6 箇所は正しく `+09:00` 付き → この 2 つだけが異常 |

### 触ってはならない防御コード（誤削除の回避）

- `use-week-meals.ts:48,136` の `new Date(ymd + "T00:00:00")` は**意図的な UTC 罠回避**（`new Date("2026-07-08")` は UTC 解釈、`"...T00:00:00"` はローカル解釈）。コメントで明記されている。**変更禁止。**
- `use-week-meals.ts` の `else` 分岐（真値が取れない時に temp 楽観行のみ除去し、確定 id 行は残す）はコメント付きの防御。**A-4 の修正で潰さないこと。**
- `stock-form.ts:35` の `Number(...) || 1` は明文化された契約（親計画 §1 V3）。**Phase A では触らない。**

---

## PR 優先順位

| PR | 関心事 | 到達性 | 深刻度 |
|---|---|---|---|
| **A-1** | server action の裸 `await` で**永久ローディング**（授乳タイマー / setup / 世帯参加 / 招待受諾 の**4 箇所**） | ✅ 到達可能 | **high** |
| **A-2** | 「間食」が保存できるが表示されず、再登録が `23505` で詰む | ✅ 到達可能 | **high** |
| **A-3** | 消費レート算出の週窓が **9 時間ズレる**（`+09:00` 欠如・2 箇所） | ✅ 到達可能 | medium |
| **A-4** | 楽観削除のロールバック欠如（UI から消えたまま DB に残存） | ✅ 到達可能 | medium |
| **A-5** | 週送り連打の応答順逆転 race | ✅ 到達可能 | medium |
| **A-6a** | **meals** の握り潰し + 偽の空状態（空週 fallback / `getTemplates` の `error:null` / `saveAsTemplate` の空 ingredients） | ✅ 到達可能 | medium |
| **A-6b** | **shopping/stock** の握り潰し（`shopping/actions.ts:90` 空 catch / `low-stock.ts:53` の 4 クエリ無ログ） | ✅ 到達可能 | medium |
| **A-6c** | **baby** の握り潰し + 偽の空状態（`baby-dashboard.tsx:176` の `.then(({data}))` / 空ダッシュボード）**+ 検出器の盲点を塞ぐ** | ✅ 到達可能 | medium |
| **A-8** | shopping/stock の追加・編集を楽観更新化 | ✅ 到達可能 | medium |
| **A-9** | web 週間サマリーのエラー時に全ゼロのグラフを表示 | ✅ 到達可能 | medium |
| **A-10** | eating-out の**潜在**データ消失 + `uploadPhoto` の権限/MIME 未検証 | ⚠️ **死コード** | latent |

> **A-6 を 3 分割した理由**: 当初の「エラー握り潰しの一掃」は 5 ファイル・4 ドメイン横断の**雑巾がけであって関心事ではない**。A-8 と `low-stock.ts` を、旧 A-7 と `meals/page.tsx` / `baby/page.tsx` を重複して触り、コンフリクトを自作していた。ドメイン単位に割り、「偽の空状態」は各ドメインの握り潰し修正に**吸収**する（error 伝播と UI 表示は同じ関心事）。

---

## PR A-1: server action の裸 `await` による「永久ローディング」を根絶（**最優先**・4 箇所）

**関心事**: 通信断で server action が reject すると、ローディング state が戻らずボタンが**永久 disabled** になる。同一パターン・同一の defect class ゆえ 1 PR。

### 全箇所の洗い出し（完了前チェックリスト #2）

```bash
$ for f in $(grep -rl "setIsSaving(true)\|setIsLoading(true)" src/ --include="*.tsx"); do
    grep -q "finally" "$f" || echo "$f"; done
src/app/setup/setup-form.tsx                          # createHousehold  → redirect("/meals")
src/app/setup/join-by-invite-form.tsx                 # joinByInviteToken → redirect
src/app/(auth)/invite/[token]/invite-accept-form.tsx  # acceptInvitation  → redirect
src/components/baby/feeding-timer.tsx                 # recordFeeding     → redirect しない
```

**4 箇所。** 見落としやすいのは `join-by-invite-form` と `invite-accept-form` — **夫婦のオンボーディング動線**であり、ここで固まると配偶者が世帯に入れない。

### ⚠️ 修正の形は 2 種類ある（機械的に `finally` を付けて回ると壊れる）

setup / invite の 3 ファイルにはコメントで意図が明記されている:
```ts
// 成功時: server action 内で redirect() が throw され、ここには戻らない
// 失敗時: { error: string } が返る
```
`createHousehold` は `src/app/setup/actions.ts:36` で `redirect("/meals")` を呼ぶ（実読で確認）。

**Next.js 公式ドキュメント原文**（`node_modules/next/dist/docs/01-app/03-api-reference/04-functions/unstable_rethrow.md`）:
> `redirect()` … rely on throwing an error which should be rethrown and handled by Next.js itself.
> This method should be called **at the top of the catch block**.
> Any resource cleanup … would have to either happen **prior to the call to `unstable_rethrow`** or within a `finally` block.

→ 素朴に `try/catch` で包むと **redirect を握り潰して画面遷移が壊れる**。
→ さらに `finally { setIsLoading(false) }` を付けると、**遷移中にボタンが再有効化されてちらつく**（成功時はスピナーを残すのが正しい）。

`unstable_rethrow` は `next/navigation` から公開されている（`node_modules/next/dist/client/components/navigation.d.ts:128` で確認。内部パス `next/dist/...` から import しないこと）。

#### 形 A: redirect する 3 ファイル（`finally` を使わない）

```tsx
import { unstable_rethrow } from "next/navigation"

setIsLoading(true)
try {
  const result = await createHousehold(trimmedName)
  // 成功時は redirect() が throw するためここには来ない
  if (result?.error) {
    toast.error(result.error)
    setIsLoading(false)
  }
} catch (err) {
  // catch の先頭で必ず。redirect()/notFound() の内部エラーを握り潰さない
  unstable_rethrow(err)
  console.error("[setup] createHousehold が例外を投げました", {
    message: err instanceof Error ? err.message : String(err),
  })
  toast.error("世帯の作成に失敗しました。通信状況を確認してください。")
  setIsLoading(false)   // finally ではなくここ（遷移成功時はスピナーを残す）
}
```
> この形は **redirect がクライアント側で throw として現れるか否かに関わらず正しい**。
> 現れなければ catch は本物のエラーでのみ発火し、現れれば `unstable_rethrow` が再送出する。

#### 形 B: redirect しない `feeding-timer`（`finally` を使う）

**関心事**: 記録失敗後にタイマーが二度と使えなくなる。

### 現状（`src/components/baby/feeding-timer.tsx:111-133`）

```ts
async function handleStop() {
  if (isSavingRef.current) return
  isSavingRef.current = true
  setIsSaving(true)

  const duration = clampFeedingDuration(elapsedMinutes)
  const result = await recordFeeding({ feedingType, durationMin: duration })  // ← throw しうる

  isSavingRef.current = false   // ← 到達しない
  setIsSaving(false)            // ← 到達しない
  ...
}
```

Server Action はネットワーク断で **reject する**。`recordFeeding` が throw すると `isSavingRef.current` が `true` のまま残り:
1. 停止ボタンは `isSaving` で disabled のまま → **記録も停止もできない**
2. `handleOpenChange` は `!isSavingRef.current` を条件にしているため、**スワイプで閉じても復帰できない**

夜間・弱電波で授乳タイマーが死ぬ。育児中ユーザーの最頻用機能の一つ。

### Step 1: 落ちるテストを書く

`src/components/baby/__tests__/feeding-timer.test.tsx`（新規。既存 `*.test.tsx` と同じく `@/lib/supabase/client`・`sonner` をモックする）

```tsx
it("recordFeeding が throw しても停止ボタンが再び押せる（isSaving が戻る）", async () => {
  recordFeeding.mockRejectedValueOnce(new Error("network down"))
  render(<FeedingTimer open onOpenChange={vi.fn()} />)

  await user.click(screen.getByRole("button", { name: /開始/ }))
  const stop = screen.getByRole("button", { name: /停止/ })

  await user.click(stop)                     // 1 回目: throw する
  expect(stop).not.toBeDisabled()            // ← 現状は disabled のまま落ちる

  recordFeeding.mockResolvedValueOnce({ error: null })
  await user.click(stop)                     // 2 回目: 成功する
  expect(recordFeeding).toHaveBeenCalledTimes(2)
})
```

### Step 2: 落ちることを確認

```bash
pnpm test:run src/components/baby/__tests__/feeding-timer.test.tsx
```
期待: `expect(stop).not.toBeDisabled()` で FAIL（ボタンが disabled のまま）。

### Step 3: 修正

```ts
async function handleStop() {
  if (isSavingRef.current) return
  isSavingRef.current = true
  setIsSaving(true)

  const duration = clampFeedingDuration(elapsedMinutes)
  let result: Awaited<ReturnType<typeof recordFeeding>>
  try {
    result = await recordFeeding({ feedingType, durationMin: duration })
  } catch (err) {
    // Server Action は通信断で reject する。握り潰さず詳細を残す。
    console.error("[feeding-timer] recordFeeding が例外を投げました", {
      message: err instanceof Error ? err.message : String(err),
      feedingType,
      durationMin: duration,
    })
    toast.error("授乳の記録に失敗しました。通信状況を確認してもう一度お試しください。")
    return
  } finally {
    // throw / 正常 いずれの経路でも必ず解除する（永久 disabled の防止）
    isSavingRef.current = false
    setIsSaving(false)
  }

  if (result.error) {
    toast.error(result.error)
    return
  }

  localStorage.removeItem(STORAGE_KEY)
  setStartedAt(null)
  toast.success(`授乳を記録しました（${duration}分）`)
  onOpenChange(false)
}
```

> `finally` は `return` より先に走るため、`catch` 内の `return` でも解除される。

### Step 4: 残り 3 ファイル（形 A）のテストと修正

`src/app/setup/__tests__/setup-form.test.tsx` / `join-by-invite-form.test.tsx` / `src/app/(auth)/invite/[token]/__tests__/invite-accept-form.test.tsx`（いずれも `.tsx` = jsdom）

```tsx
it("通信断で server action が reject しても送信ボタンが再び押せる", async () => {
  createHousehold.mockRejectedValueOnce(new Error("network down"))
  render(<SetupForm />)
  await user.type(screen.getByLabelText(/世帯名/), "我が家")
  const submit = screen.getByRole("button", { name: /作成/ })
  await user.click(submit)
  expect(submit).not.toBeDisabled()          // ← 現状は disabled のまま落ちる
})

it("redirect の内部エラーは握り潰さず再送出する（画面遷移を壊さない）", async () => {
  const redirectErr = Object.assign(new Error("NEXT_REDIRECT"), {
    digest: "NEXT_REDIRECT;replace;/meals;307;",
  })
  createHousehold.mockRejectedValueOnce(redirectErr)
  render(<SetupForm />)
  await user.click(screen.getByRole("button", { name: /作成/ }))
  expect(toast.error).not.toHaveBeenCalled()   // redirect をエラー扱いしない
})
```
> 2 本目は `unstable_rethrow` を**モックせず実物**を使う（`digest` を見て再送出する挙動そのものを検証する）。
> `finally` を付けた実装ではこのテストは通っても、**遷移中のちらつき**は捕まらない — MCP 実ブラウザで目視すること。

### Step 5: 機械検証（回帰防止）

```bash
# setIsLoading(true)/setIsSaving(true) を立てて、エラー経路で戻さないファイル → 0 件
for f in $(grep -rl "setIsSaving(true)\|setIsLoading(true)" src/ --include="*.tsx"); do
  grep -q "unstable_rethrow\|finally" "$f" || echo "VIOLATION: $f"
done
```
期待: **出力なし**。

### Step 6: 緑を確認 → commit

```bash
pnpm test:run && pnpm lint && pnpm build
```
> `pnpm build` 必須（`"use server"` の export 面に触れる）。

```
fix: server action の裸 await による「永久ローディング」を 4 箇所で根絶

通信断で server action が reject するとローディング state が戻らず、
ボタンが永久 disabled になっていた。特に setup / invite の 2 経路は
夫婦のオンボーディングで、配偶者が世帯に参加できなくなる。

redirect() を呼ぶ 3 ファイルは catch 先頭で unstable_rethrow し、
finally を使わない（遷移成功時はスピナーを残す）。
```

### Flutter 波及
**要確認**。Flutter の授乳タイマー・setup・招待受諾にも同型の `isSaving`/`isLoading` ガードがあるか調べ、あればリンク issue 化。

---

## PR A-2: 「間食」が保存できるのに表示されず、再登録で詰む

**関心事**: ユーザーから見て原因不明の「既に登録されています」エラーと、UI から消せない不可視データ。

### 現状（実証済み）

| ファイル | 実体 |
|---|---|
| `src/lib/utils/meal-types.ts:17` | `MEAL_TYPES = ["breakfast","lunch","dinner","snack"]` |
| `src/components/meals/meal-form-sheet.tsx:222` | `{MEAL_TYPES.map((type) => (<button ...>` ← **「間食」が選べる** |
| `src/components/meals/meal-day-row.tsx:10` | `WEEK_VIEW_MEAL_TYPES = ["breakfast","lunch","dinner"]` ← **間食は描画されない** |
| `supabase/migrations/20260406000001_initial_schema.sql:134` | `UNIQUE (household_id, date, meal_type)` |

**再現**: 間食を選んで保存 → 週ビューのどこにも出ない → 「登録し忘れた」と思って再度保存 → `23505` UNIQUE 違反 → 「既に登録されています」 → **見ることも消すこともできない。**

### 方針の選択（**1 PR = 1 関心事**を守るため、どちらか片方）

| 案 | 内容 | 判定 |
|---|---|---|
| **(a) 間食を週ビューに表示する** | `WEEK_VIEW_MEAL_TYPES` に `snack` を追加。1 日 4 スロットになり、週ビューの縦密度が 33% 増える | 情報密度が上がり、育児中の「一目で今日の夕飯」を損なう |
| **(b) フォームから間食を除外する** | 週ビューが扱う 3 種のみを選択肢にする。DB の ENUM は残す（Flutter/将来のため） | **推奨**。既存の不可視データは別途 migration で救済 |

**採用: (b)**。理由: 週ビューは「朝・昼・夕」の 3 スロット前提でレイアウトされており、間食の追加は Phase B の「閲覧性」目標と衝突する。間食を first-class にするなら別イニシアチブ。

### Step 1: 落ちるテストを書く

`src/lib/utils/__tests__/meal-types.test.ts`（新規）

```ts
import { MEAL_TYPES, WEEK_VIEW_MEAL_TYPES, MEAL_TYPE_LABELS } from "@/lib/utils/meal-types"

it("フォームの選択肢は週ビューが描画する種別と一致する（不可視データを作らない）", () => {
  expect([...MEAL_TYPES].sort()).toEqual([...WEEK_VIEW_MEAL_TYPES].sort())
})

it("ラベルは DB ENUM の全種別を持つ（間食データの表示に必要）", () => {
  // 既存データ・Flutter・将来の間食対応のためラベル自体は残す
  expect(Object.keys(MEAL_TYPE_LABELS)).toContain("snack")
})
```

### Step 2: 落ちることを確認
```bash
pnpm test:run src/lib/utils/__tests__/meal-types.test.ts
```
期待: 1 つ目が FAIL（`MEAL_TYPES` に `snack` があり `WEEK_VIEW_MEAL_TYPES` に無い）。

### Step 3: 修正

`src/lib/utils/meal-types.ts`:
```ts
/**
 * 週ビュー（meal-day-row）が描画する食事タイプ。
 * フォームの選択肢もこれと一致させる — 一致させないと、選べるが表示されない
 * 不可視データが生まれ、UNIQUE(household_id, date, meal_type) と組み合わさって
 * 「既に登録されています」の原因不明エラーになる（削除手段も無い）。
 *
 * DB の meal_type ENUM には 'snack' が残っている（Flutter・将来の間食対応のため）。
 * MEAL_TYPE_LABELS も全種別を保持し、既存の間食データを表示できるようにする。
 */
export const WEEK_VIEW_MEAL_TYPES: MealType[] = ["breakfast", "lunch", "dinner"]

/** フォームの選択肢 = 週ビューが描画できる種別（上のコメント参照） */
export const MEAL_TYPES: MealType[] = WEEK_VIEW_MEAL_TYPES
```
`meal-day-row.tsx:10` のローカル定義を削除し、`@/lib/utils/meal-types` から import する（単一の真実源）。

### Step 4: 既存の不可視データの救済（**同 PR に含める**）

既に `snack` 行を作ってしまったユーザーがいる可能性がある。migration で診断クエリを提供する（**自動削除はしない** — ユーザーのデータを勝手に消さない）:

`supabase/migrations/20260708000000_snack_meals_diagnostic.sql`:
```sql
-- 不可視の間食データを検出する。web UI からは表示・削除できないため、
-- 存在する場合は運用者が手動で判断する（自動削除はしない）。
DO $$
DECLARE cnt INTEGER;
BEGIN
  SELECT count(*) INTO cnt FROM meals WHERE meal_type = 'snack';
  IF cnt > 0 THEN
    RAISE WARNING '[snack-diagnostic] 週ビューに表示されない間食データが % 件あります。手動で確認してください。', cnt;
  END IF;
END $$;
```

### Step 5: 緑を確認 → commit

```bash
pnpm test:run   # 期待: meal-form-sheet.test.tsx / meal-week-view.test.tsx を含め全 pass
pnpm build
```
> ⚠️ 既存テスト（`meal-form-sheet.test.tsx` 等）が 4 種前提なら**同 PR で更新する**。

### Flutter 波及
**あり**。Flutter 側の meal フォームも同じ選択肢を持つか確認（`grep -rn "snack" flutter/lib/` では meal 用の間食は見つからず、`snack_food`（item_category）のみ）。**Flutter は既に 3 種のみの可能性が高いが、実装を読んで確認すること。**

---

## PR A-3: 消費レート算出の週窓が 9 時間ズレる（`+09:00` 欠如・2 箇所）

**関心事**: JST 日付境界の取り違え。

### 現状（実証済み）

```bash
$ grep -rn 'T00:00:00' src/ | grep -v __tests__
src/lib/supabase/low-stock.ts:40:        .gte("logged_at", `${weekAgo}T00:00:00`)      # ← 異常
src/app/(main)/stock/actions.ts:205:    .gte("logged_at", `${weekAgo}T00:00:00`)      # ← 異常
src/app/api/baby-report/route.ts:59:        .gte("logged_at", `${startDate}T00:00:00+09:00`)   # 正常
src/app/(main)/baby/page.tsx:14:  const todayStart = `${todayJst}T00:00:00+09:00`             # 正常
src/components/baby/baby-dashboard.tsx:172:      .gte("logged_at", `${selectedDate}T00:00:00+09:00`)  # 正常
...
```

`logged_at` は `TIMESTAMPTZ`。オフセット無しの `"2026-07-01T00:00:00"` は Postgres がセッション TZ（Supabase 既定 **UTC**）で解釈するため `2026-07-01T00:00:00Z` = **JST 09:00** になる。意図は JST 深夜 0 時（`2026-06-30T15:00:00Z`）。**週窓が 9 時間ずれ、深夜の授乳・おむつ記録が集計から漏れる**（消費レート → 低在庫の自動買い物リスト追加が狂う）。

コードベースの他 6 箇所は正しく `+09:00` を付けている。**この 2 箇所だけが異常。**

### Step 1: 落ちるテストを書く

`src/lib/supabase/__tests__/low-stock.test.ts`（新規）。fake Supabase client の `.gte()` に渡された引数を捕捉する。

```ts
it("logged_at の下限は JST 深夜 0 時（+09:00 明示）で問い合わせる", async () => {
  const gte = vi.fn().mockReturnThis()
  const supabase = makeFakeClient({ gte })   // .from().select().eq().in().gte().limit() をチェーン
  await autoAddLowStockItems(supabase, "house-1", "user-1")

  const loggedAtCall = gte.mock.calls.find(([col]) => col === "logged_at")
  expect(loggedAtCall?.[1]).toMatch(/T00:00:00\+09:00$/)   // ← 現状は "T00:00:00" で落ちる
})
```

同型のテストを `src/app/(main)/stock/__tests__/actions.test.ts` にも追加する（`meals/__tests__/actions.test.ts` の `vi.mock` idiom を踏襲）。

### Step 2: 落ちることを確認 → Step 3: 修正

```diff
- .gte("logged_at", `${weekAgo}T00:00:00`)
+ // JST 深夜 0 時。オフセットを省くと Postgres がセッション TZ(UTC) で解釈し
+ // 週窓が 9 時間ずれる（他の 6 箇所と同じく +09:00 を明示する）。
+ .gte("logged_at", `${weekAgo}T00:00:00+09:00`)
```
**2 箇所とも**（`low-stock.ts:40`, `stock/actions.ts:205`）。

### Step 4: 全箇所確認（完了前チェックリスト #2）
```bash
grep -rn 'T00:00:00' src/ | grep -v '+09:00' | grep -v 'new Date'
```
期待: **0 件**。
> `use-week-meals.ts:48,136` の `new Date(ymd + "T00:00:00")` は**ローカル解釈を意図した UTC 罠回避**（コメント有り）。除外すること。**変更してはならない。**

### Step 5: 緑 → commit

---

## PR A-4: 楽観削除のロールバック欠如

**関心事**: server action 失敗時に UI からアイテムが消えたまま DB には残る（リロードで復活し、ユーザーが混乱する）。

### 現状（`src/components/shopping/shopping-item.tsx:76-84`）

```ts
onOptimisticDelete(item.id)
startTransition(async () => {
  const result = await deleteItem(item.id)
  if (result.error) {
    toast.error(result.error)     // ← toast だけ。行は消えたまま
  }
})
```
`src/components/stock/stock-item.tsx` も同型。

### Step 1: 落ちるテストを書く

```tsx
it("削除に失敗したらアイテムが復活する", async () => {
  deleteItem.mockResolvedValueOnce({ error: "削除に失敗しました" })
  render(<ShoppingList initialItems={[item]} ... />)

  await user.click(screen.getByRole("button", { name: /削除/ }))  // 1 回目: 確認モード
  await user.click(screen.getByRole("button", { name: /削除/ }))  // 2 回目: 実行

  await waitFor(() => expect(toast.error).toHaveBeenCalled())
  expect(screen.getByText(item.name)).toBeInTheDocument()   // ← 現状は消えたままで落ちる
})
```

### Step 3: 修正（`meal-week-view.tsx` の正典に倣う）

削除前に snapshot を取り、失敗時に復元する。**挿入位置も保つ**こと（末尾に復活すると並び順が壊れる）。

```ts
const handleDelete = () => {
  if (!confirmDelete) { /* 既存の 2 タップ確認 */ return }

  const snapshot = itemsRef.current           // 親が保持する現在の配列
  onOptimisticDelete(item.id)

  startTransition(async () => {
    let result: Awaited<ReturnType<typeof deleteItem>>
    try {
      result = await deleteItem(item.id)
    } catch (err) {
      console.error("[shopping] deleteItem が例外を投げました", {
        itemId: item.id,
        message: err instanceof Error ? err.message : String(err),
      })
      onRestoreItems(snapshot)                // 通信断でも復元する
      toast.error("削除に失敗しました。通信状況を確認してください。")
      return
    }
    if (result.error) {
      onRestoreItems(snapshot)
      toast.error(result.error)
    }
  })
}
```

> **Realtime に頼らないこと**（親計画 §1 V2）。Supabase 公式 docs: *"You can't filter Delete events when tracking Postgres Changes."* 自分の削除は楽観更新、配偶者の削除は refetch で拾う。

### Flutter 波及
**要確認**（Flutter の shopping/stock も同型の楽観削除を持つ）。

---

## PR A-5: 週送り連打の応答順逆転 race

**関心事**: 低速回線で週送りを連打すると、**表示中の週に別週のデータが載る**。

### 現状（`src/components/meals/use-week-meals.ts:74-117`）

`goToPreviousWeek` / `goToNextWeek` が `fetchMeals(newStart)` を呼ぶだけで、世代トークンも AbortController も無い。2 回連続で叩くと、遅い方のレスポンスが後着して `setMeals(data)` を上書きする。

### Step 1: 落ちるテストを書く

`src/components/meals/__tests__/use-week-meals.test.tsx`（新規）
> **拡張子は `.tsx` 必須**。`renderHook` は react を要り、node project（`.test.ts`）では落ちる。

```tsx
it("週送り連打で古い応答が新しい週を上書きしない", async () => {
  const slow = deferred(), fast = deferred()
  selectMock.mockReturnValueOnce(slow.promise).mockReturnValueOnce(fast.promise)

  const { result } = renderHook(() => useWeekMeals({ ... }))
  act(() => { result.current.goToNextWeek() })   // week+1 → slow
  act(() => { result.current.goToNextWeek() })   // week+2 → fast

  fast.resolve({ data: [mealInWeek2], error: null })
  await waitFor(() => expect(result.current.meals).toEqual([mealInWeek2]))

  slow.resolve({ data: [mealInWeek1], error: null })   // 古い応答が後着
  await tick()
  expect(result.current.meals).toEqual([mealInWeek2])  // ← 現状は week1 に上書きされ落ちる
})
```

### Step 3: 修正（**世代トークン**。既存の `else` 防御分岐を壊さない）

```ts
const fetchGenerationRef = useRef(0)

const fetchMeals = useCallback(async (start: Date) => {
  const generation = ++fetchGenerationRef.current
  setIsLoading(true)
  ...
  const { data, error: mealsError } = await supabase.from("meals")...

  // 後発の fetch が既に走っている場合、この応答は捨てる（応答順逆転ガード）
  if (generation !== fetchGenerationRef.current) return

  if (mealsError) { logSupabaseError(...) }

  if (data) {
    setMeals(data as unknown as MealWithDetails[])
  } else {
    // 既存の防御を維持: temp 楽観行のみ除去し、確定 id 行は残す
    setMeals((prev) => prev.filter((m) => !m.id.startsWith(OPTIMISTIC_MEAL_ID_PREFIX)))
  }
  setIsLoading(false)
}, [householdId])
```

> `setIsLoading(false)` も `return` の後ろにあるため、捨てた応答では触らない（最新の fetch が責任を持つ）。
> **AbortController は使わない** — Supabase JS クライアント経由で生 `fetch` を叩いていないため。世代トークンで十分。

---

## PR A-6a〜d: エラー握り潰しの一掃（**ドメイン単位に分割**）

**関心事（各 PR で 1 つ）**: 真因の隠匿と、その帰結である「偽の空状態」。
Supabase の error は `class Error` を継承しない plain object で、`String(err)` は `[object Object]` になる。

「握り潰し（error を捨てる）」と「偽の空状態（捨てた結果を空データとして描画する）」は**同じ関心事の表裏**ゆえ、ドメインごとに 1 PR にまとめる。

### A-6a: meals ドメイン

| ファイル | 現状 | 修正 |
|---|---|---|
| `src/app/(main)/meals/page.tsx` | `mealsError` 時に空週を fallback → **データ消失に見える** | error を伝播し `ErrorView` を描画 |
| `src/app/(main)/meals/actions.ts:382` (`getTemplates`) | 失敗時に `error: null` + 空配列 → 偽の「テンプレートがまだありません」 | `{ error: "...", data: null }` |
| `src/app/(main)/meals/actions.ts:275` (`saveAsTemplate`) | 食材取得失敗時に**空 ingredients のテンプレートを無音生成** | error を検査して中断 + ログ |

**落ちるテスト**（`src/app/(main)/meals/__tests__/actions.test.ts` に追記。既存の fake client idiom）:
```ts
it("getTemplates: クエリ失敗時に error を返す（空配列で成功を偽装しない）", async () => {
  fakeClient.__setError({ message: "boom", code: "500", details: "", hint: "" })
  const result = await getTemplates()
  expect(result.error).not.toBeNull()   // ← 現状は null で落ちる
  expect(result.data).toBeNull()
})
```

### A-6b: shopping / stock ドメイン

| ファイル | 現状 | 修正 |
|---|---|---|
| `src/app/(main)/shopping/actions.ts:90` | auto-stock 失敗が**空 catch** | `catch (err) { console.error("[shopping] auto-stock 失敗", { message: ... }) }` |
| `src/lib/supabase/low-stock.ts:53-60` | 4 クエリの error を無ログで `return { error: null, addedItems: [] }` | 各 error を `logSupabaseError` で個別に構造化ログ |

> **A-3 と `low-stock.ts` で衝突する。A-3 → A-6b の順に積むこと。**

**落ちるテスト**（`src/lib/supabase/__tests__/low-stock.test.ts`、node）: 「`households` クエリが error を返したら `logSupabaseError` が呼ばれる」（`vi.mock("@/lib/supabase/log-error")` でスパイ）。現状は呼ばれず落ちる。

### A-6c: baby ドメイン + **検出器の盲点を塞ぐ**

| ファイル | 現状 | 修正 |
|---|---|---|
| `src/components/baby/baby-dashboard.tsx:176` | `.then(({ data }) => ...)` で error を destructure すらしない | `.then(({ data, error }) => { if (error) logSupabaseError(...) })` |
| `src/app/(main)/baby/page.tsx` | サーバ側クエリ失敗時に空ダッシュボードを正常表示 | error を伝播し `ErrorView` を描画 |

**この PR は検出器の修正から始める**（さもなくば回帰を防げない）:

`scripts/check-supabase-error-destructure.py` は現状 **`.then(({ data }) =>` を検出できない**。実測:
```bash
$ ./scripts/check-supabase-error-destructure.py --strict ; echo "exit=$?"
exit=0      # ← baby-dashboard.tsx:176 の実在する握り潰しを見逃している
```

**Step 1**: 検出パターンに `.then(({ data })` / `.then(({data})` を追加 → `--strict` で **exit 1**（赤）になることを確認。
**Step 2**: `baby-dashboard.tsx:176` を修正 → **exit 0**（緑）。
**Step 3**: `baby/page.tsx` の偽の空状態を修正 + jsdom テスト。

### （A-6d は A-1 に吸収）

当初 `setup-form.tsx` の `try/catch` 欠如を A-6d として独立させていたが、**A-1 と同一の defect class**（server action の裸 `await` → 永久ローディング）であり、しかも同じ `redirect()` 依存の罠を共有する。`grep` で全 4 箇所を一度に潰す方が正しい。→ **A-1 に統合。**

### 共通の機械検証

```bash
./scripts/check-supabase-error-destructure.py --strict   # 期待: exit 0（A-6c で検出器を強化した後）
```
> **`--strict` を付けないと違反があっても exit 0**（`return 1 if strict else 0`）。CI は `ci.yml:44` で `--strict` を使っている。

---

## PR A-8: shopping / stock の追加・編集を楽観更新化

**関心事**: **自分の操作すら画面に反映されない**（Realtime 配信頼み）。issue #92 で本番の `postgres_changes` が不達のため、**店内でアイテムを追加しても入力欄が消えるだけでリストに出ない**。

> **#92 の帰趨に関わらず直す**（advisor 裁定）。本 PR は own-write の即時反映のみを扱い、#92 の調査には立ち入らない。

### 修正方針

`meal-week-view.tsx` の正典に倣う: temp id で楽観挿入 → `startTransition` → 成功で確定 id 差し替え / 失敗で remove + `toast.error`。

**地雷（必須）**: **temp → real id の照合が無いと二重挿入する**。Realtime の own-write INSERT は real id で届き、temp 行を素通りする。→ **server action は `.select().single()` で挿入行を返し**、temp id 行を real 行へ差し替える（`replaceMealIdOptimistic` と同流儀）。

```ts
const reconcile = (tempId: string, real: Item) =>
  setItems(prev => {
    if (prev.some(i => i.id === real.id)) return prev.filter(i => i.id !== tempId)  // realtime 先着
    return prev.map(i => (i.id === tempId ? real : i))
  })
```

### Step 1: 落ちるテスト
- 追加 → Realtime 発火前にリストへ即時反映
- server error → 行がロールバック
- **Realtime INSERT を先に emit → reconcile が temp を除去し、二重挿入しない**

---

## PR A-9: web 週間サマリーのエラー時に全ゼロのグラフを表示

**関心事**: 誤情報。「今週は一度も授乳していない」と読めるグラフが出る。

Flutter は #99（`d90314c`）で再試行ボタンを実装済み。**web だけが取り残されている。**

### 修正方針
`src/components/baby/weekly-summary/` でエラーを検知し、全ゼロのグラフではなく `ErrorView` 相当（「読み込めませんでした」+ 再試行ボタン）を描画する。Flutter の #99 実装を参照して文言・挙動を揃える。

### Step 1: 落ちるテスト
```tsx
it("週間サマリーの取得に失敗したら全ゼロのグラフではなく再試行 UI を出す", async () => {
  fetchWeekly.mockResolvedValueOnce({ data: null, error: { message: "boom" } })
  render(<BabyWeeklySummary ... />)
  expect(await screen.findByRole("button", { name: /再試行/ })).toBeInTheDocument()
  expect(screen.queryByTestId("weekly-chart")).not.toBeInTheDocument()  // ← 現状は全ゼロ chart が出て落ちる
})
```

---

## PR A-10: eating-out の潜在バグ（**死コードにつき方針の判断が要る**）

### 到達性
```bash
$ grep -rn "EatingOutForm\|eating-out-form" src/ | grep -v "^src/components/meals/eating-out-form.tsx:"
(0 件)
```
**`EatingOutForm` はどこからも描画されていない。** 「外食」トグル（`is_eating_out`）は動くが、店名・評価・写真を記録する UI が存在しない。`eating_out_logs` テーブル・Server Actions・フォームコンポーネントが揃って**到達不能**。

### 潜在する欠陥（配線した瞬間に露出する）

| 箇所 | 欠陥 |
|---|---|
| `eating-out-actions.ts:125-131` `getEatingOutLog` | `logError` をログして**なお `error: null, data: null` を返す** → フォームが空でロード |
| `eating-out-actions.ts:57-69` `saveEatingOutLog` | 上記の空フォームを保存すると **既存記録を全 null で upsert（データ消失）**。かつ `if (error)` で `logSupabaseError` を通さない |
| `eating-out-actions.ts:63` | `rating: input.rating \|\| null` → **評価 0 が null に化ける** |
| `eating-out-actions.ts:75-111` `uploadPhoto` | **meal の所有権を検証しない**（認証のみ）。**MIME 未検証**。公開読み取りバケットへ保存 |
| `eating-out-actions.ts:102-104` | upload 失敗を無ログ |

### 方針の選択（**ユーザーの判断が要る**）

| 案 | 内容 | 判定 |
|---|---|---|
| **(a) 先に欠陥だけ塞ぐ** | 死コードのまま、握り潰し・データ消失経路・所有権/MIME 検証を修正 | **推奨**。安く、将来の地雷を撤去できる。配線 PR が安全に書ける |
| (b) 欠陥を塞ぎ、同時に配線する | 機能を完成させる（外食記録が使えるようになる） | 「1 PR = 1 関心事」に反する。**(a) → 別 PR で配線**なら可 |
| (c) 死コードを削除する | `eating-out-form.tsx` + `eating-out-actions.ts` + `eating_out_logs` を撤去 | `is_eating_out` トグルが宙に浮く。DB テーブルの削除は不可逆 |

**推奨は (a)**。修正内容:
1. `getEatingOutLog`: error を呼び出し側へ伝播（`return { error: "外食記録を読み込めませんでした。", data: null }`）
2. `saveEatingOutLog`: `logSupabaseError` を通す。`rating: input.rating ?? null`（`||` → `??`）
3. `uploadPhoto`: **meal の所有権を検証**（`saveEatingOutLog` と同じ household チェック）+ **MIME allowlist**（`image/jpeg|png|webp`）+ 失敗を構造化ログ
4. **配線は別 PR**。配線する際は `eating-out-photos` バケットの public 読み取りを見直す（署名付き URL への移行検討）

---

## 実装順序と依存

```
A-1  (永久ローディング×4) ── 独立・最優先（授乳タイマー / setup / 世帯参加 / 招待受諾）
A-2  (間食)               ── 独立（到達可能な high・ユーザーが詰む）
A-3  (+09:00)             ── 独立。※ A-6b が同じ low-stock.ts を触る → A-3 を先に
A-5  (週送り race)        ── 独立。※ Phase B の「週スワイプ」PR の前提
A-4  (楽観削除 rollback)  ─┐ 同じファイル（shopping-item / stock-item）を触る
A-8  (楽観追加/編集)      ─┘ A-4 → A-8 の順に積む
A-6a (meals 握り潰し)     ── 独立
A-6b (shopping/stock)     ── A-3 の後（low-stock.ts で衝突）
A-6c (baby + 検出器強化)  ── 独立。検出器を先に赤くしてから直す
A-9  (週間サマリー)       ── 独立
A-10 (eating-out)         ── 独立。方針の判断待ち（`eating-out-actions.ts:67,102,125-131` の
                             握り潰しも同一ファイル・同一関心事ゆえ本 PR に同梱）
```

## 各 PR の完了ゲート

```bash
pnpm test:run    # 268 + 新規 が全 pass
pnpm lint        # 0 error
pnpm build       # "use server" の export 面を触る PR（A-1/A-6a/A-6b/A-8/A-10）は必須

# A-3 のみ（意図的な UTC 罠回避の new Date(...T00:00:00) は除外する）
grep -rn 'T00:00:00' src/ | grep -v '+09:00' | grep -v 'new Date'   # → 0 件

# A-6a〜d のみ。--strict が無いと違反があっても exit 0（CI は ci.yml:44 で --strict）
./scripts/check-supabase-error-destructure.py --strict               # → exit 0
```

Flutter に波及する PR（A-1 / A-2 / A-4）:
```bash
cd flutter && fvm flutter test   # 950 + 新規 が全 pass
```
> `flutter.yml` は `paths: flutter/**` でのみ発火する。**web だけを変更した PR では Flutter CI が走らない。** 手動で回すこと。
