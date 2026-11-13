## R01 自由入力のアレルギー・苦手（「乳製品」「甲殻類」「魚」「ナッツ」「卵白」等）が何にも一致せず、該当料理が verdict=ok で自動献立に入る
- 区分: confirmed / 重大度 critical / 確信度 high / 観点 meal-logic
- 場所: src/lib/meals/exclusions.ts:160
- 要件: C-51, C-52, C-53, C-54, V-C4
- 原因: addCustomRule（exclusions.ts:160-182）は、ラベルが「アレルゲン名の完全一致」か「食材名・別名の完全一致」に解決できなければ nameRule に落とす。nameRule の照合は evaluateIngredient（279-285）の `names.some((name) => name.includes(rule.folded))`、つまり「食材名がラベルを含む」の一方向だけ。分類語（乳製品・甲殻類・魚・魚介類・ナッツ・小麦製品・大豆製品・乳成分・卵白・蟹・サーモン・山芋 など）は辞書のどの食材名にも含まれず、一致 0 件になる。その場合でも evaluateDish（333-334）は hits=0 → 'ok'（varies 材料が無い料理）を返すので、未解決のアレルギー指定は「該当なし＝不使用」と同じ扱いになる。
- 失敗シナリオ: 家族が「使わない食材」に自由入力で「乳製品」（理由=アレルギー）を登録 → partitionRecipes は allowed=56 / labelCheck=8 / blocked=0（何も登録していない別アレルゲンと同じ結果）。バター・牛乳を使う『たらのムニエル』『鶏肉のクリームシチュー』『鮭のホイル焼き』『ひき肉と野菜のオムレツ』『豆腐ステーキ』が allowed になり、generatePlan の 7 日献立に『たらのムニエル』が実際に入った。同様に「甲殻類」アレルギーで『えびとブロッコリーの塩炒め』が verdict=ok、「魚」（苦手）で魚料理 7 品すべて allowed、「ひき肉」（苦手）で『ハンバーグ』（合いびき肉は名前に「ひき肉」を含まない）が allowed。画面の注記は設定行の小さな文『食材の一覧にない名前のため、食材や料理の名前に含まれるかどうかで判定します』と献立の『名前で判定している設定: …』だけで、候補は通常どおり自動提案・確定できる。
- 根拠: 実カタログでの実行結果（scratchpad/review/logic/a-exclusion.rev.test.ts）: 「乳製品 allowed=56 label=8 blocked=0 limited=1」「甲殻類/魚/魚介類/ナッツ/ナッツ類/卵白/生卵/小麦製品/大豆製品/乳成分/蟹/サーモン/山芋」も全て同じ 56/8/0（基準: 無関係な abalone アレルギー = 56/8/0）。対照として「乳」「牛乳」「ミルク」は blocked=9、「卵」「たまご」は blocked=8。`乳製品 → allowed although contain milk: [鶏肉のクリームシチュー, ひき肉と野菜のオムレツ, 鮭のホイル焼き, たらのムニエル, 豆腐ステーキ きのこしょうゆ]`、`plan entries with milk: [たらのムニエル]`、`甲殻類 → shrimp recipe verdict: ok`。UI 文言は src/components/chores/meals/settings/settings-exclusions.tsx:117-121。台帳 C-54 は「未知の…アレルゲン情報を『不使用』と見なさず、アレルギー指定時の自動確定候補から外す」。
- 修正案: (1) 照合を双方向にする: ラベルがアレルゲン名の変種や食材名を「含む」場合も解決する（乳製品⊃乳→milk、卵白⊃卵→egg、小麦製品⊃小麦、えび・かに→shrimp+crab）。(2) 分類語の明示辞書を足す（甲殻類→shrimp/crab、ナッツ→walnut/cashew/almond/pistachio/macadamia(+peanut)、魚・魚介→売場 fish の全食材、肉→売場 meat、乳製品→milk、山芋→yam、サーモン→salmon 等）。(3) それでも辞書のどの名前にも当たらない **理由=アレルギー** の自由入力が 1 件でもあれば、自動確定を止める側へ倒す（全候補を label_check 以上にする、または保存時に『一覧から選ぶか、具体的な食材名で登録』を求める）。(4) 「一致 0 件の自由入力アレルギーで該当アレルゲンを含むレシピが ok にならない」回帰テストを実カタログで追加する。
- 反証検証: is_real=true / 重大度 critical
  - 反証できず、本物と判断する。実カタログで再現した。

**確認した事実**
- `src/lib/meals/exclusions.ts:160-182` の `addCustomRule` は、ラベルがアレルゲン名の変種か食材名・別名に完全一致したときだけ辞書へ解決する。それ以外は `nameRules` と `limited` に落とす。
- `nameRules` の照合は「食材名がラベルを含む」（279-285）と「料理名がラベルを含む」（313-317）の一方向だけ。ラベルが辞書名より長い語（乳製品⊃乳、卵白⊃卵、小麦製品⊃小麦、大豆製品⊃大豆）や分類語は一致 0 件になる。
- 「えび・かに」は `foldName` が中点を消して「えびかに」になるため、公式の併記表記でも一致しない。
- 一致 0 件でも `evaluateDish`（333-334）は hits=0 として、varies 材料の無い料理に `ok` を返す。
- 保存側（`src/lib/meals/server/settings-requests.ts:145-148`）は長さと文字種しか見ない。別の箇所での防御は見つからなかった。

**実行結果**（別レビュアーのテスト `scratchpad/review/logic/a-exclusion.rev.test.ts` の "custom labels" を再実行、3 件 pass）
- 理由=アレルギーの自由入力で、乳製品・甲殻類・えび・かに・蟹・魚・魚介類・ナッツ・ナッツ類・卵白・生卵・小麦製品・大豆製品・乳成分・サーモン・山芋・貝類がすべて allowed=56 / label=8 / blocked=0。無関係な abalone アレルギーの基準値と同じ。
- 対照: 「乳」「牛乳」は blocked=9、「卵」は 8、「小麦」は 37、「大豆」は 42。
- 「乳製品」で allowed になった乳含有料理: 鶏肉のクリームシチュー、ひき肉と野菜のオムレツ、鮭のホイル焼き、たらのムニエル、豆腐ステーキ きのこしょうゆ。
- `generatePlan` の 7 日献立に「たらのムニエル」が入った。
- 「甲殻類」で「えびとブロッコリーの塩炒め」が verdict=ok。

**反証として検討し、退けた点**
- 設計として開示済みか: `implementation-notes.md:82` は「解決できなければ名前の一致で除外し、限界を画面に出す」としており、注記は 3 か所にある（`meal-notices.tsx:26-27`、`settings-exclusions.tsx:117-121`、`plan-view.tsx:299-303`）。ただし文言は「名前に含まれるかどうかで判定」「別の呼び名は見分けられない」止まりで、「何にも一致しておらず何も外していない」とは伝えない。
- 同じフォームが無条件の約束を出している: `settings-exclusions.tsx:300` に「アレルギー・苦手のどちらで登録しても、献立と提案から必ず外します」とある。
- 自由入力へ誘導している: `ALLERGEN_LIST_DISCLAIMER` は「一覧にないものは自由入力で追加できます」と書く。対象品目のチップは 1 回に 1 品目しか選べないので、「甲殻類」「ナッツ類」をまとめて自由入力する動機がある。
- コード自身の意図に反する: 冒頭コメント（13 行目）は「除外は広く倒す側が安全」と言うが、長いラベルでは逆に狭く倒れる。
- C-54 の文面は材料側の未知を指すが、解釈できないアレルギー指定を「不使用」と同じに扱うのは同じ fail-open である。

**重大度**
critical を維持する。アレルギー登録済みの世帯で、該当アレルゲンを既知の材料として含む料理が、確認表示なしで自動献立に入る。指定の基準「安全上の誤り（アレルゲン混入）」に当たる。

**緩和要因と不確実な点**
- 既定のタブは構造化された一覧で、そこから「乳」「えび」を選べば正しく外れる。
- 発生には、利用者が自由入力で分類語や複合語を書くことが要る。その頻度は実測していない。
- ナッツ類は現カタログに該当レシピが無く、今は実害が出ない。
- 苦手の「魚」「ひき肉」（ハンバーグが通る）も同じ原因だが、安全ではなく要件 C-52 の未達（high 相当）。
  - 修正方針: 判定の純関数（`src/lib/meals/exclusions.ts`）とカタログで直し、fail-closed を最後の砦にする。

1. **分類語・同義語の辞書を足す**（`src/lib/meals/catalog/allergens.ts` の隣。fold 後の完全一致で引く）
   - 乳製品・乳成分・チーズ → milk
   - 甲殻類・えびかに（fold 後）→ shrimp + crab、蟹 → crab
   - 卵白・卵黄・生卵・鶏卵 → egg
   - 小麦製品・グルテン → wheat、大豆製品 → soybean
   - ナッツ・ナッツ類・木の実 → walnut / cashew / almond / pistachio / macadamia（広く倒すなら peanut も）
   - 山芋 → yam、サーモン → salmon
   - 魚・魚介・魚介類・青魚・生魚 → `section` が魚売場の全食材を `ingredientRules` に、加えて魚介系アレルゲン
   - 肉・ひき肉・挽き肉・ミンチ → 肉売場の該当食材（合いびき肉を含む）
   - `addCustomRule` の完全一致の直後にこの辞書を引き、当たれば `allergenRules` / `ingredientRules` を足して resolved 扱いにする。

2. **未解決のときだけ、逆向きの包含でアレルゲンへ解決する**
   - fold 済みラベルがアレルゲン名の変種を含めば、そのアレルゲン規則を足す。`limited` は残す。
   - 常時ではなく未解決時に限る。常時にすると「豆乳」が milk、「鶏もも肉」が peach に過剰解決する。
   - 「すいか⊃いか」のような誤解決は除外が広がる側なので許容する。

3. **残った未解決のアレルギー自由入力は fail-closed にする**
   - `ExclusionSet` に `unresolvedAllergy`（理由=アレルギーで `nameRules` に落ちた除外）を持たせる。
   - `evaluateDish` は、blocked でない料理を `label_check` にする（`UnverifiableReason` に `"unresolved_exclusion"` を追加）。これで `generatePlan` / `suggestNow` / `checkPlanAdoption` が自動確定しない。
   - 画面は「『○○』は食材の一覧と照合できないため、料理を自動では確定しません。対象品目か食材から選び直してください」と理由を出す。
   - これが重すぎる場合の代案: 登録フォームで、アレルギーかつ未解決なら保存前に「この名前では料理を外せません」と明示し、一覧からの選択を求める。いずれの場合も `settings-exclusions.tsx:300` の「必ず外します」は、未解決の自由入力には当てはまらないと分かる文言にする。
   - 苦手の未解決は現行どおり名前一致と `limited` 表示でよい。

4. **回帰テストを実カタログで足す**（`src/lib/meals/__tests__/catalog-integration.test.ts`）
   - 理由=アレルギーの自由入力「乳製品・乳成分・甲殻類・えび・かに・蟹・卵白・生卵・小麦製品・大豆製品・サーモン・魚・魚介類」について、派生をたどった真値で該当アレルゲンを含むレシピが `partitionRecipes().allowed` に 1 件も無いこと、`generatePlan` の entries にも無いこと。
   - 辞書に無い語（例「マンゴー」）のアレルギーでは allowed が 0 件（全件 label_check 以上）であること。
   - 対照: 苦手の「パクチー」は従来どおり allowed が減らず `limited` に載ること。既存の「キャベ」「きんぴら」のテストが通ること。

## R02 手動料理は材料を 1 つでも登録すると料理名の照合が外れ、「エビフライ」「かに玉」「卵焼き」「ざるそば」が除外に当たらなくなる
- 区分: confirmed / 重大度 high / 確信度 high / 観点 meal-logic
- 場所: src/lib/meals/exclusions.ts:318
- 要件: C-54, C-55, V-C4
- 原因: evaluateDish は料理名とアレルゲン・食材名の照合（titleNeedles）を `if (ingredients.length === 0)` の中でしか行わない（exclusions.ts:318-329）。材料が 1 件でもあれば、判定は登録された材料だけになる。手動料理の材料は任意で、辞書に無い名前は saveCustomDish が『名前を見直すか、外して保存してください』と外させる（src/app/(main)/chores/meals/plan/actions.ts:1186-1190）。しかも食材辞書には かに・あわび・いくら・カシューナッツ・ピスタチオ・マカダミアナッツ の食材が無く、これらは料理名でしか捕まえられない。
- 失敗シナリオ: かにアレルギー（一覧から選択）の世帯で、手動料理「かにクリームコロッケ」を材料なしで足すと blocked。そこへ買い物用に材料（じゃがいも・牛乳・バター。『かに』は辞書に無いので外すよう促される）を登録した瞬間に verdict=ok へ変わり、衝突一覧（findPlanConflicts）から消え、固定（setDinnerPin）・確定（confirmDinnerPlan）も通る。同様に、えびアレルギー ×「エビフライ」+材料キャベツ → ok、卵アレルギー ×「卵焼き」+砂糖 → ok、そばアレルギー ×「ざるそば」+小ねぎ → ok。後から家族がアレルギーを追加しても、材料つきの手動料理は C-55 の再検証に掛からない。
- 根拠: 実行結果（同 a-exclusion.rev.test.ts）: `allergy shrimp エビフライ ings=null → blocked` / `allergy shrimp エビフライ ings=cabbage → ok` / `allergy crab かにクリームコロッケ ings=null → blocked` / `ings=potato+milk+butter → ok` / `allergy egg 卵焼き ings=sugar → ok` / `allergy buckwheat ざるそば ings=green_onion → ok` / `allergy peanut ピーナッツ和え ings=spinach → ok`（dislike も同じ）。
- 修正案: 手動料理（recipeId=null）では、材料の有無に関係なく titleNeedles による料理名の照合を常に行う（カタログのレシピには適用しない。DishView に手動かどうかの印を持たせる）。加えて、アレルギーの除外がある世帯の手動料理は、材料が登録済みでも「材料が全部とは限らない」として少なくとも label_check に留めるのが C-54 に沿う。対の回帰テスト（材料なし=blocked と 材料あり=blocked）を追加。
- 反証検証: is_real=true / 重大度 high
  - 反証を試みたが崩せなんだ。指摘は本物じゃ。

【確認済み（コード）】
- src/lib/meals/exclusions.ts:318-329 — titleNeedles（アレルゲン名・食材名と料理名の照合）は `if (ingredients.length === 0)` の中だけ。常に走る料理名照合は nameRules（辞書へ解決できなかった自由入力）だけ（314-317）。
- 同 381-392 dishViewOfEntry は手動料理を `allergenStatus: "from_ingredients"` で渡すゆえ、材料が 1 件でもあり全て辞書に在れば unverifiable は空 → hasAllergy でも verdict=ok。
- 別の箇所での防ぎは無い。saveCustomDish（src/app/(main)/chores/meals/plan/actions.ts:1174-1231）は除外を一切評価せず保存する。setDinnerPin（1018）・confirmDinnerPlan（1268）・衝突一覧（src/lib/meals/server/views.ts:247）・isEntryAllowed（src/lib/meals/planner.ts:1035）は全て同じ evaluateEntry/findPlanConflicts に依る。
- 画面から到達できる: src/components/chores/meals/plan/plan-custom-dish-form.tsx は「材料（任意）」を名前で受け、辞書に無い名前は actions.ts:1186-1190 が「外して保存してください」と促す。

【確認済み（独立に書いた probe を実行。(scratch)/review/refute-title/title.rev.test.ts、4 件 pass・exit 0）】
- allergen:shrimp ×「エビフライ」 ings=null → blocked / ings=cabbage → ok（conflicts=0）
- allergen:crab ×「かにクリームコロッケ」 null → blocked / potato+milk+butter → ok
- allergen:egg ×「卵焼き」 null → blocked / sugar → ok
- allergen:buckwheat ×「ざるそば」 null → blocked / green_onion → ok
- allergen:peanut ×「ピーナッツ和え」+spinach → ok。ingredient:shrimp / ingredient:egg の除外でも同じく ok。allergy・dislike とも同じ。
- 辞書の裏取り: cashew / abalone / salmon_roe / pistachio / macadamia は該当食材 0 件、crab は crab_stick（かに風味かまぼこ）のみ。resolveIngredientId は「かに」「カニ」「蟹」「あわび」「いくら」「カシューナッツ」「ピスタチオ」「マカダミアナッツ」を全て null と返す → これらは材料として登録する手段が無く、料理名でしか捕まえられぬ。

【指摘より悪い点（新たに確認）】
自由入力の除外「かに」「あわび」「えび」はアレルゲン名へ解決されて allergenRules になるため nameRules に入らず、材料つき手動料理では ok になる（custom:かに ×「かにクリームコロッケ」+potato → ok、custom:あわび ×「あわびのステーキ」+butter → ok）。一方、辞書に解決できぬ語（custom:きんぴら ×「きんぴらごぼう」+carrot）は blocked。つまり「認識できたアレルゲンのほうが、認識できぬ語より守りが弱い」という逆転が起きておる。意図した設計とは読めぬ。

【重大度の見直し: high を維持】
- critical へは上げぬ: 自動提案がアレルゲンを混ぜる経路ではない（generatePlan・suggestNow・AI 採用は手動料理を作らぬ）。料理名は人が打ったもの。
- medium へも下げぬ: C-55（設定変更後の衝突を見えるようにする）が、材料つき手動料理に対して無音で外れる。家族 A が材料つきで足した料理が、家族 B が後から登録したアレルギーの衝突一覧に出ず、確定も止まらぬ。加えて「材料を足した瞬間に blocked → ok へ緩む」のは、C-54 の「未知の原材料を不使用と見なさない」に反する向き。かに等は材料として登録不能ゆえ、利用者の入力ミスではなく仕組みとして必ず起きる。

【不確実な点】
- 実ブラウザでの通し（フォーム入力→保存→衝突一覧の表示）は未実行（dev サーバー不可）。上はドメイン関数と Action のコード読みに基づく。
- 修正案後半の「材料が登録済みでも label_check に留める」は、この指摘の再現例（料理名に品目名が在る）を塞ぐのには不要。料理名に品目が出ぬ場合（かにアレルギー ×「クリームコロッケ」+じゃがいも）の別の穴に効く追加策で、必須かは製品判断が要る。
  - 修正方針: 最小で安全な修正（src/lib/meals/exclusions.ts のみ + テスト）:

1. DishView に `manual?: boolean` を足す（省略可にして既存の evaluateDish 直呼びを壊さぬ）。dishViewOfEntry の手動料理の枝（recipeId === null）で `manual: true` を立てる。evaluateRecipe とカタログの枝は立てぬ。

2. evaluateDish の titleNeedles の照合を、`no_ingredients` の push から切り離す:
   - `if (ingredients.length === 0) unverifiable.push({ reason: "no_ingredients", ... })` はそのまま。
   - titleNeedles のループの条件を `dish.manual === true || ingredients.length === 0` にする（材料なしの既存挙動は不変、材料つき手動料理へ広げる）。
   - カタログのレシピへは広げるな。実行で確かめた対照: buckwheat ×「ソース焼きそば」が needle「そば」に当たり、今の label_check が blocked へ化ける。

3. 回帰テストを対で足す（src/lib/meals/__tests__/exclusions.test.ts）:
   - evaluateEntry: えびアレルギー × 手動「エビフライ」 材料 null → blocked ／ 材料 [cabbage] → blocked（修正前は ok で fail-red になること）。
   - かにアレルギー × 手動「かにクリームコロッケ」+[potato, milk, butter] → blocked、hit は via:"name"。
   - 自由入力「かに」（アレルゲン名へ解決される経路）でも同じく blocked。
   - findPlanConflicts に材料つき手動料理が出ること（C-55）。
   - 対照（偽の述語）: 同じ除外で 手動「野菜炒め」+[cabbage] → ok。カタログの「ソース焼きそば」× そばアレルギーは blocked にならぬ（label_check のまま）。

4. 既知の副作用（既存の材料なし手動料理と同じ挙動へ揃うだけ）: 含む一致ゆえ、そばアレルギー × 手動「焼きそば」、乳アレルギー × 手動「豆乳鍋」も材料つきで blocked になり、confirmDinnerPlan はその範囲の確定を止める。「除外は広く倒す側が安全」という exclusions.ts 冒頭の規則どおりで、緩める方向の調整はせぬこと。

任意の追加策（別の穴・製品判断つき）: アレルギーの除外がある世帯では、材料つきの手動料理も「登録した材料が全部とは限らない」として label_check に留める。UnverifiableReason に新しい値（例 `manual_ingredients_partial`）を足し、hasAllergy の時だけ unverifiable へ積む。label_check は confirmDinnerPlan を止めぬ（1268 は blocked だけを見る）ゆえ操作は塞がず、衝突一覧に「原材料の確認が必要」として出るだけ。足すなら src/lib/meals/server/views.ts の unverifiableView の文言と、exclusions.test.ts:289-298 付近の期待値を合わせて直す。

## R03 購入の記録が「作った後・日が過ぎた後・翌週」の必要量を相殺し続け、買うべき食材が買い物リストから消える
- 区分: confirmed / 重大度 high / 確信度 high / 観点 meal-server-ai
- 場所: supabase/migrations/20261111100003_dinner_tables.sql:1238
- 要件: C-41, C-45, C-46, V-C3
- 原因: 自動項目は item_key（食材ID|単位族）で 1 行に固定され、sync_grocery_auto_items の ON CONFLICT DO UPDATE（1238-1246 行）は purchased_quantity / purchased / restocked_quantity を一切触らない。不要化しても購入記録があれば still_needed=false で残し（1249-1251 行）、同じ食材が再び必要になると still_needed=true へ戻すだけ。残りは src/lib/meals/grocery.ts:348-359 remainingToBuy の「必要量 −（購入量 − 在庫へ足した量）」で、購入量には期限も対象の料理も無い。必要量の側は src/lib/meals/grocery.ts:194-196 が「今日以降の confirmed」だけを数えるため、料理を作った・日が過ぎただけで必要量が減り、過去の購入量がそのまま次の必要量の控除に回る。「在庫へ追加」（restock）を使わず購入チェックだけで運用する利用者（主経路）では購入量を消費する契機が無い。
- 失敗シナリオ: (1) 月曜と金曜に豚肉 300g ずつ（必要量 600g）。週前半ぶんとして「買った量 300g」を記録 → 残り 300g（正しい）。月曜の料理を「作った」にする／火曜になる → 必要量が 300g へ減り、残り = 300 − 300 = 0 で「購入済み」表示。金曜ぶんの豚肉が買い物リストに出ない。(2) 今週 300g を購入済みにして調理。翌週の献立でまた豚肉 300g が必要 → 行が still_needed=true に戻り、先週の purchased_quantity=300 で残り 0・購入済み。利用者が「献立からは不要になった項目」を毎回手で削除しない限り、2 週目以降の同じ食材が無音で欠落する。
- 根拠: コード読解に加え PGlite ハーネスで実行して確認（(scratch)/review/actions-reviewer-tests/carryover.sql、6/6 ok）: 300g 同期 → set_grocery_purchase(300,true) → 空の同期（still_needed=false, purchased_quantity=300 のまま）→ 再び 300g を同期 → 行は 'true:300.000:300.000:true'（必要 300・購入 300・購入済み印）。画面側は src/lib/meals/server/plan-views.ts:518-525 が remainingToBuy の 0 を state='purchased' にする。料理後の更新 applyCookedPantryUpdates（plan/actions.ts:1296-）は在庫行しか触らず、購入量を減らす経路は無い。既存テスト（supabase/tests/dinner_tables.sql:246,268）は「増えたら残り 200」「不要化で残す」までで、再必要化・調理後は未検証。
- 修正案: 購入量を「どの必要に対する購入か」と結び付ける。最小案: (a) sync_grocery_auto_items で still_needed=false → true へ戻る行は purchased_quantity / purchased / purchased_at / restocked_quantity / restock_ids を初期化する（履歴を残すなら別列へ退避）。(b) 必要量が「料理を作った・日が過ぎた」で減ったときは、外れた sources の量ぶんだけ未補充の購入量（purchased − restocked）を減らす（0 未満にしない）。RPC は旧 sources と新 sources を両方持っているので 1 トランザクションで計算できる。回帰テスト: 上の 2 シナリオで 2 回目の残りが必要量どおりになること。
- 反証検証: is_real=true / 重大度 high
  - 反証できず、本物と判断する（確信度 high、重大度は high のまま）。ただし元の修正案 (a) は C-45 と衝突するため、修正方針は差し替える。

**実行して確かめたこと**
- DB: 指摘者の `(scratch)/review/actions-reviewer-tests/carryover.sql` を PGlite ハーネス（PG 17.5、migration 58 本適用）で独立に再実行し、6/6 ok。300g 同期 → 300g 購入 → 空の同期 → 再び 300g 同期で、行は `true:300.000:300.000:true` になる。
- ロジック: `(scratch)/review/refute-carryover/carryover.rev.test.ts` を実コードに対して実行し、4/4 pass。
  - 2 品で豚肉 400g、うち 200g だけ購入 → 残り 200g。1 品目を cooked にすると必要量 200g・残り 0g になり、`mergeWithExisting` も `checked=true` を返す。
  - 枠を confirmed のまま日付だけ進めても同じ結果になる。
  - 翌週の新しい 200g の必要に対し、先週の購入 200g で残り 0g になる。
  - 対照: 購入分を全量在庫へ足していれば残りは 200g に戻る。壊れるのは「購入だけ記録して在庫へ足さない」経路に限られる。

**反証を試みた点（いずれも防がれていない）**
- 購入量を書き換える経路は `set_grocery_purchase`（`supabase/migrations/20261111100003_dinner_tables.sql:1345-1350`）だけ。`sync_grocery_auto_items` の ON CONFLICT（1238-1246）は購入・補充の列に触れず、不要化しても購入記録があれば `still_needed=false` で残す（1249-1251）。
- 「作った」は必ず同期を起こす。`markDinnerCooked` → `setEntryStatus` → `finishEntrySave` → `syncGroceryAutoItems`（`src/app/(main)/chores/meals/plan/actions.ts:1080-1092, 196-219`）。必要量は `status === "confirmed"` かつ今日以降だけを数える（`src/lib/meals/grocery.ts:194-196`、範囲は `src/lib/meals/server/grocery-sync.ts:129-132`）。
- `applyCookedPantryUpdates` は在庫行だけを触り、買い物の行には触れない。
- 画面は数値項目を残り 0 で `purchased` に分類する（`src/lib/meals/server/plan-views.ts:518-525`）。不要化した行は手動削除しかできず、自動の掃除は無い（`src/components/chores/meals/shopping/shopping-item-panel.tsx:296-297`）。
- 「在庫へ追加」は任意操作で、C-47 が購入と補充を別の事実と定めている。購入だけの運用は正規の状態で、利用者の誤用ではない。
- 設計メモ（`docs/plans/2026-11-10-household-chores/implementation-notes.md:85`）は「残り = 必要量 − 購入量」としか定めておらず、調理や日付経過で必要量が減る場合を扱っていない。意図された仕様とは読めない。

**重大度の根拠**
週次の献立 → 買い物という主経路で、2 週目以降に同じ食材が黙って「購入済み」へ回る（C-41 の「買うべき材料の表示」が成立しない）。`GROCERY_HORIZON_DAYS = 28`（`src/lib/meals/server/plan-requests.ts:31`）のため、複数週を先に確定して週ごとに買う使い方ではシナリオ (1) も普通に起きる。世帯間漏えいやデータ破損ではないので critical には上げない。

**元の修正案の問題**
- (a)「false → true で購入記録を初期化」は、豚 → 鶏 → 豚と献立を戻しただけの場合にも購入を消す。C-45（献立変更で購入履歴を消さない）に反し、不要化した行を残している目的とも矛盾する。シナリオ (1) も直らない。
- (b)「外れた sources の量ぶん減らす」は、現状の sources では実装できない。枠 ID が無く、`quantity` は在庫差引前の量（`grocery.ts:237-242`）なので、外れた理由（調理か献立変更か）も、買うべきだった量も分からない。

**不確実な点**
日付が過ぎたのに confirmed のままの枠を「消費済み」とみなすかは製品判断になる。修正案では買い漏れを避ける側（消費済み扱い）に倒している。
  - 修正方針: 購入量を消費するのは「調理した／日が過ぎた」ときだけにし、献立変更では保持する。判定と減算は `sync_grocery_auto_items` の中で、行ロック下に 1 回だけ行う。

1. **sources に 2 項目を足す**（`src/lib/meals/grocery.ts:237-242`、`src/lib/meals/server/rows.ts` の `grocerySourceToJson`、`irori_private.dinner_valid_sources`）
   - `entryId`: 献立の枠の ID。
   - `buy`: その枠が買い物へ載せた正味量 = `line.requiredBase − line.stockCertain`（基準単位、0 以上）。数値化しない行は null。
   - 総量でなく正味量を使う理由: 在庫でまかなった料理を作っても購入分は減らさないため。

2. **`sync_grocery_auto_items` の upsert の前に消費を反映する**
   - 世帯の既存 auto 行を `FOR UPDATE` で読み、旧 sources のうち次に当たるものの `buy` を合計する。
     - `dinner_plan_entries` の該当枠が `status = 'cooked'`。
     - または source の `date` が今日（Asia/Tokyo）より前。
   - 合計が 0 より大きければ `purchased_quantity = greatest(restocked_quantity, purchased_quantity − 合計)`。
   - 減らした行は `purchased = false` に戻し、`purchased_quantity` が 0 になったら `purchased_at` / `purchased_by` を NULL にする。
   - `skipped`・削除・差し替えで外れた source は消費扱いにしない（食材は家に残っている。C-45 の往復でも購入を保持する）。
   - 判定は DB の枠の状態から行い、クライアントの申告は使わない。

3. **一度きりの保証**
   - 続く upsert で sources が置き換わるので、同じ枠を二度引かない。
   - `still_needed = false` へ落とす UPDATE（1249-1251 行）では `sources = '[]'` も書く。
   - 購入量が 0 になり、メモ・補充記録も無い行は、既存の DELETE（1253-1255 行）でそのまま消える。
   - `restocked_quantity`、`restock_ids`、`note`、`section` は触らない。

4. **変えないもの**
   - `remainingToBuy` と `setGroceryPurchase` の「full」の式（購入量が補充量を下回らないため成り立つ）。
   - C-46（300g 購入後に 500g へ増えたら残り 200g）と C-47。

5. **回帰テスト**
   - pgTAP（`supabase/tests/dinner_tables.sql`）:
     - 2 枠 600g、300g 購入 → 1 枠を cooked にして同期 → 必要 300・購入 0。
     - 全量購入 → 全枠 cooked → 翌週の同じ食材は購入 0 の未購入行。
     - 対照: 枠を削除または skipped にして不要化 → 再び必要化 → 購入 300 を保持。
     - 対照: `buy = 0`（在庫でまかなう枠）を cooked にしても購入量は不変。
     - 同じ同期を別の操作 ID で 2 回流しても二重に引かない。
   - vitest: `buildGroceryNeeds` の sources に `entryId` / `buy` が載り、`buy` の合計が `required` と一致すること。

**既知の限界として明記するもの**
- cooked を confirmed に戻しても、消費した購入量は戻らない（買い過ぎ側に倒れる。利用者は買った量を入れ直せる）。
- 日が過ぎて confirmed のままの枠は消費済みとして扱う。
- 数値化できない項目（適量・少々）のチェックは持ち越したままにする。行の sources が全て消費されたときにチェックを外す選択肢もあり、これは製品判断になる。

## R04 家事の全画面で、圏外・通信失敗時の自動再取得（router.refresh）がハードナビゲーションに落ち、画面と未保存入力が /offline に置き換わる
- 区分: confirmed / 重大度 high / 確信度 high / 観点 ui-next
- 場所: src/components/chores/shared/refresh-on-visible.tsx:27
- 要件: X-03, C-72, V-PWA
- 原因: RefreshOnVisible（refresh-on-visible.tsx:27）は useVisibilityRefetch(() => router.refresh(), interval) を張る。src/lib/hooks/use-visibility-refetch.ts:36 は定期実行だけ navigator.onLine を見ており、visibilitychange / focus の経路は圏外でも router.refresh() を呼ぶ。定期実行も onLine=true のまま要求だけ落ちる回線（店内・地下）では防げない。Next 16.4.3 は RSC の fetch が reject すると SPA 更新を諦めて MPA 遷移へ倒す（experimental.useOffline は next.config.ts で意図的に無効）。/chores/* は public/sw.js の APP_PAGES 外なので navigate は nav-passthrough → fetch 失敗 → offlineFallback() で /offline が返る。既存の育児・予定は Supabase のクライアント取得で失敗を握る作りで、この壊れ方は家事の 9 画面（ハブ・ごみ・掃除・今夜・今あるもので・献立・買い物・食材・設定）で新しく入った。
- 失敗シナリオ: スーパーの店内（圏外・不安定回線）で買い物リストを開いたまま、別アプリから戻る／画面ロックを解除する（visibilitychange→visible または focus）。router.refresh() の RSC 取得が失敗 → Next が location.assign/replace で同じ URL へハードナビゲーション → SW が /offline を返す。見ていた買い物リストが消え、開いていたシートの入力（メモ・数量）、食材のまとめ入力の文と確認中の下書き、掃除フォーム、希望の文、手動料理の材料など React state だけに在る入力が全て失われる。「この端末に控えを残せていません。保存結果を確認するまで、この画面を閉じないでください」と出している最中（storageOk=false の結果不明）でも同じく画面が破棄され、控えも失う。買い物（30 秒）・献立/掃除/食材/設定（60 秒）の定期再取得でも、onLine=true で要求だけ落ちれば同じ結果になる。「今すぐ更新」と SectionError の「もう一度読み込む」も同じ経路。
- 根拠: (1) 再現テスト（(scratch)/review/ui/stale-version.repro.test.tsx、vitest 2 件 pass）: navigator.onLine=false で visibilitychange と focus を送ると router.refresh が 2 回呼ばれる。(2) node_modules/next/dist/client/components/router-reducer/fetch-server-response.js:199-232: fetch の reject は __NEXT_USE_OFFLINE が無ければ 'Falling back to browser navigation' で URL 文字列を返す。render-tree.js:956-969 と 1093-1102: exitStatus 2 →『network error. Trigger an MPA navigation』→ isHardRetry=true。reducers/server-patch-reducer.js:26-29: mpa なら completeHardNavigation。(3) next.config.ts は experimental.useOffline を入れない旨を明記（勝手な全画面再読込を避ける方針とも書いてある）。(4) public/sw.js:62 APP_PAGES=[/baby,/calendar,/settings]、199-203 と 431-437 で APP_PAGES 外の navigate は fetch 失敗時 offlineFallback()。実ブラウザでの再現は未実施（dev サーバ不可）。
- 修正案: 家事の再取得を router.refresh() に直結しない。最低限: visibility/focus 経路にも navigator.onLine===false のガードを入れ、RefreshOnVisible 側で (a) 圏外なら呼ばない (b) 入力中・送信中・結果不明の控えがある間は呼ばない。根本: 再取得を Route Handler／読み取り用 Server Action の fetch（AbortController・timeout つき）にして、失敗時は直前の表示を保ち「最新を確認できません」を出す（UpcomingEventsCard / use-month-events と同じ流儀）。あわせて、圏外で戻ったときに画面が残ることを e2e（offline.spec.ts の流儀）で固定する。
- 反証検証: is_real=true / 重大度 high
  - 反証を試みたが崩せなかった。指摘は本物と認める。ただし実ブラウザでの再現は未実施で、根拠はコード読みと jsdom テストに留まる。

**確認できたこと（コードと実行）**
- `src/components/chores/shared/refresh-on-visible.tsx:27` は `useVisibilityRefetch(() => router.refresh(), interval)`。`src/lib/hooks/use-visibility-refetch.ts:30-36` の `onVisible` は `visibilityState` しか見ず、`navigator.onLine` のガードは定期実行（36 行）だけ。
- 指摘者の再現テストを実行し pass（`navigator.onLine=false` で visibilitychange と focus を送ると `router.refresh` が 2 回呼ばれる）。
- Next 16.4.3 の経路を独立に追った。
  - `router-reducer/reducers/refresh-reducer.js:30-85`: refresh は現 URL への `navigateToKnownRoute(RefreshAll)`。
  - `router-reducer/fetch-server-response.js:199-232`: fetch の reject は `__NEXT_USE_OFFLINE` が偽なら URL 文字列を返す。`!res.ok`（5xx など）も 139-145 行で同じ MPA 扱い。
  - `client/components/render-tree.js:1093-1102`: 文字列なら exitStatus 2。956-969 行で `isHardRetry=true`。
  - `reducers/server-patch-reducer.js:26-29` → `app-router-state.js:316` の `completeHardNavigation` → `app-router.js:254-271` で `location.replace(canonicalUrl)` し、無限 suspend。
  - 指摘の `render-tree.js` のパスは `router-reducer/` 配下ではなく `client/components/render-tree.js` が正しい。内容は指摘どおり。
- `build/define-env.js:126` で `__NEXT_USE_OFFLINE = Boolean(config.experimental.useOffline)`。`next.config.ts` は未設定で、入れない旨をコメントで明記している。
- `public/sw.js` は差分なし。62 行の `APP_PAGES` は `/baby` `/calendar` `/settings` のみ。`/chores/*` の RSC fetch は SW 不関与（212 行で null）、navigate は `nav-passthrough`（203 行）で、fetch 失敗時は `offlineFallback()`（431-437 行）。
- `sw.js:542-546` のコメント自体が「reject すると Next が location.href へのハードナビゲーションにフォールバックする」と書いており、プロジェクト側もこの挙動を前提にしている。
- 家事コンポーネントに下書きの端末保存は無い（storage 参照はテストのみ）。`beforeunload` の守りも無い。開いたシートの入力は React state だけで、ハードナビゲーションで失われる。
- `implementation-notes.md:8,11` は「`APP_PAGES` に足さない」「`useVisibilityRefetch(router.refresh, pollMs)` で回収」と書くだけで、圏外時の挙動への言及は無い。意図して受け入れた制約ではない。

**指摘の言い過ぎ・補正**
- 「この壊れ方は家事で新しく入った」は不正確。基点 521f2fc2 の `src/components/feedback/feedback-refresh-on-visible.tsx:15` に同じ `useVisibilityRefetch(() => router.refresh())` が既にある。仕組みは既存で、家事はそれを入力・保留操作の多い画面へ広げた。対象は 9 画面と、「今すぐ更新」、`section-error.tsx:38`、`plan-view.tsx:277` の `onStale`。
- 控えは送信前に localStorage へ書かれる（`use-chore-save.ts:298`）。失われるのは、未送信の入力と、`storageOk=false` のときのメモリ上の控えに限られる。サーバのデータ破損や二重書込みは起きない。
- 定期実行の「onLine=true で要求だけ落ちる」場合は、fetch が reject したとき（または 5xx）に限る。タイムアウトせず待ち続ける回線では発火しない。
- V-PWA は「`sw.js` の拡張で消さない」という文言で、`sw.js` は未変更のため直接の違反とは言い切れない。主な未達は X-03（各画面のオフライン状態）。

**重大度**
high を維持する。圏外や不安定な回線で、アプリ切替・画面ロック解除というごく普通の操作により、買い物リストが `/offline` に置き換わる。店内での買い物は中心的な利用場面で、X-03 の未達にあたる。データ破損ではないので critical ではない。
  - 修正方針: 共有フック `use-visibility-refetch.ts` は変えない（育児・予定のコールバックは失敗を自前で握っており、挙動とテストを動かさないため）。家事側だけで閉じる。

1. **`router.refresh()` を直接呼ばない共通関数を作る**（例: `src/components/chores/shared/` に `useSafeRefresh()`）。
   - `navigator.onLine === false` なら何もしない。
   - そうでなければ、同一オリジンの軽い GET を `AbortController` と 3〜5 秒の timeout つき、`cache: "no-store"` で先に打つ。候補は既存の `GET /api/version`（`/api/` は SW 不関与）。proxy での認証の扱いは未確認なので、採用前に確かめる。
   - 応答が ok のときだけ `router.refresh()` を呼ぶ。reject・timeout・非 ok のときは呼ばず、直前の表示を保って「最新を確認できません」を出す（`UpcomingEventsCard` と同じ流儀）。
   - 多重起動は in-flight フラグで 1 本に絞り、unmount で abort する。
   - これで圏外と要求落ちの大半を防げる。probe と refresh の間に回線が落ちる競合は残る。

2. **呼び出し元をすべてこの関数へ差し替える。**
   - `refresh-on-visible.tsx:27`（自動）と `:39`（今すぐ更新）
   - `section-error.tsx:38`（既定の再読込）
   - `plan-view.tsx:277`（`onStale`）
   - `use-chore-save.ts:263`（保存確定後。直前に通信が成功しているので危険は低いが、揃える）

3. **自動経路だけ一時停止できるようにする。** `RefreshOnVisible` に `paused` prop を足し、各ビューから `save.saving || save.pending.length > 0 || !save.storageOk || シートやフォームが開いている` を渡す。手動の「今すぐ更新」は止めない。入力中に props が差し替わる問題も同時に抑えられる。

4. **テストで固定する。**
   - 単体: `onLine=false` で visibilitychange / focus を送っても `router.refresh` が呼ばれない。probe が reject / timeout のとき呼ばれず、案内が出る。`paused` 中は呼ばれない。
   - e2e（`offline.spec.ts` の流儀）: `/chores/meals/shopping` を開き、`context.setOffline(true)` の後に visibilitychange を送っても、URL と一覧が残り `/offline` に置き換わらない。

**採らない案**
- `sw.js` の `APP_PAGES` へ `/chores` を足す: ハードナビゲーション自体は起きて state は失われる。SW のバイト列を動かさない方針にも反する。
- `experimental.useOffline`: 復帰時に Server Action を無人で再送するため、`next.config.ts` が明示的に退けている。

**根本策（後続でよい）**: 家事の再取得を Route Handler の fetch に移し、失敗時は直前の表示を保つ。既存の `feedback-refresh-on-visible.tsx` も同じ穴を持つので、同じ関数へ寄せるとよい。

## R05 シリーズ全体の通知を予定シートで「なし」にすると全回が「個別の明示 OFF」になり、ごみ画面のシリーズ ON（OFF→ON でも）が 1 件も通知を戻さない
- 区分: unverified / 重大度 medium / 確信度 high / 観点 db-security
- 場所: supabase/migrations/20261111100001_event_purposes.sql:633
- 要件: A-07, V-A
- 原因: トリガ (b) event_reminders_record_opt_out（633-683 行）は event_reminders の DELETE を行単位でしか見られず、「この回だけ止めた」と「シリーズ全体を止めた」を区別できない。src/app/(main)/calendar/actions.ts:893-908 の setEventReminder({seriesId}, "none") は native シリーズの全回の通知を DELETE するため、既定 ON のごみシリーズでは今日以降の全回に reminder_opt_out=true の event 行が立つ（series 行の remind_default は 'prev_day_20' のまま）。save_event_purpose のシリーズ分岐は prev_day_20 の INSERT で opt-out の回を除外し（379-382 行）、'off' 分岐（387-397 行）も opt-out の印を降ろさない。
- 失敗シナリオ: native の繰り返し予定をごみに分類し前日 20:00 を既定 ON にする → カレンダーの通知シートで「シリーズ全体・なし」を選ぶ → 後日ごみ画面でシリーズに「前日 20:00」を選び直す。RPC は 1 行も通知を足さず replayed を返す。いったんシリーズ OFF にしてから ON にしても remind_default が none→prev_day_20 に変わるだけで saved を返し、通知は 0 件のまま。native シリーズは後から回が増えないため、シリーズ単位の操作では通知が二度と付かず、前日通知が無音で届かない（回ごとに付け直すか、予定シートでシリーズ全体へ時刻を設定し直すしかない）。フォームの説明は「個別に通知を止めた回は変えません」だが、利用者は個別には止めていない。
- 根拠: PGlite ハーネスで実行（scratchpad/review/db/tests/probe_event_purposes.sql）。P-17 でシリーズ 3 回の通知を authenticated として DELETE → P-18: reminder_opt_out の event 行が 3 件、P-19: series の remind_default は 'prev_day_20' のまま。P-20: save_event_purpose(series, garbage, prev_day_20) は 'replayed'（期待 saved）、P-21: 通知 0 件（期待 3）。P-22/P-23 でシリーズ OFF→ON はどちらも saved だが P-24: 通知 0 件（期待 3）。
- 修正案: シリーズ全体の「なし」を個別 OFF として記録しない。案 1: setEventReminder のシリーズ「なし」は、分類済みシリーズなら save_event_purpose 相当の series 'off'（remind_default='none' にしてから削除）を通す。案 2: save_event_purpose の series+'off' で、そのシリーズの今日以降の回の reminder_opt_out を降ろす（purpose NULL の行は削除）— シリーズ OFF は全回への明示操作なので、その後の ON が一様に効く。どちらでも pgTAP に「シリーズ一括 OFF → シリーズ ON で通知が戻る」を足す。


## R06 ごはんの pgTAP が 7 本の RPC の世帯またぎ拒否を固定していない（ガードを消しても全緑）
- 区分: unverified / 重大度 low / 確信度 high / 観点 db-security
- 場所: supabase/tests/dinner_tables.sql:323
- 要件: X-06, V-AUTH, V-DB
- 原因: 「11. 別世帯」（323-338 行）が撃つのは save_pantry_item / delete_pantry_item / delete_food_exclusion / delete_food_preference / delete_dish_feedback / save_dinner_entry / set_grocery_purchase / restock / apply_dinner_plan だけ。delete_dinner_entry、delete_grocery_item、update_grocery_item_meta、save_grocery_manual_item、save_food_exclusion（同 id の再送経路）、save_food_preference、save_dish_feedback の `r.household_id <> h` は別世帯の id で一度も呼ばれない。
- 失敗シナリオ: 現行の migration のガードは正しい（今は漏えいしない）。だが将来の修正でこれらの関数から世帯の照合が落ちても CI は緑のままで、別世帯の利用者が id を知っていれば献立の枠・買い物項目を削除・改変できる状態が検知されずに出荷される。
- 根拠: scratchpad/review/db/mutate.mjs で migration を複製し、pg_get_functiondef + replace で各関数の `IF r.household_id <> h THEN RAISE ...` だけを除いて dinner_tables.sql を実行。D1 delete_dinner_entry / D2 delete_grocery_item / D3 update_grocery_item_meta / D4 save_grocery_manual_item / D5 save_food_exclusion / D6 save_food_preference / D7 save_dish_feedback（household 側だけ除去）の 7 変異が exit 0（230/230 緑）で生存。対照として同じ仕組みの D12 delete_food_exclusion・D8 viewer 許可・D10 ポリシー USING(true)・E1-E4/E6/E7・C1-C4 は赤になった（計 23 変異中 15 検知、生存 8 のうち E5 は等価変異）。
- 修正案: dinner_tables.sql の 11 節に、世帯 B から世帯 A の id で上の 7 RPC を呼ぶ throws_ok('42501') を足し、15 節の「世帯 A の行は不変」に grocery の note/section と献立の件数が含まれることを確かめる。


## R07 既定 ON のシリーズで、過去から今日以降へ UPDATE で動いた回には前日通知が付かない（トリガが AFTER INSERT だけ）
- 区分: unverified / 重大度 low / 確信度 high / 観点 db-security
- 場所: supabase/migrations/20261111100001_event_purposes.sql:618
- 要件: A-07
- 原因: trg_calendar_events_purpose_default は AFTER INSERT のみ（618-620 行）。Google 同期の upsert は既存行を ON CONFLICT DO UPDATE で書き、native の日付変更も UPDATE ゆえ、INSERT の時点で「今日より前」だった回（594 行で早期 return）が後から将来日へ動いても既定の通知は足されない。
- 失敗シナリオ: 既定 ON の Google ごみシリーズで、過ぎた回（通知なし）が Google 側で将来日へ振り替えられる → 同期は UPDATE で反映 → その回は「ごみ」と表示されるが event_reminders は 0 件で、前日 20:00 の通知が来ない。利用者がその回を開いて手で付けるまで気付けない。
- 根拠: probe_event_purposes.sql の P-16: 既定 ON のシリーズへ start_date=今日-3 の回を INSERT（通知なし）→ start_date を今日+26 へ UPDATE → event_reminders は 0 件（期待 1）。同じ probe で service_role の upsert による新規 INSERT（P-6）と 410 後の入れ直し（P-13/P-14）には正しく付くことも確認。
- 修正案: 同じ関数を AFTER UPDATE OF start_date, recurring_event_id, series_id（WHEN で値の変化と NEW.start_date >= 今日を絞る）にも掛ける。ON CONFLICT DO NOTHING と opt-out の除外はそのまま効く。


## R08 ごみ画面「分類した予定」のシリーズ行が、例外で外した回を「次の収集日」として表示する
- 区分: unverified / 重大度 medium / 確信度 high / 観点 garbage
- 場所: src/lib/domain/garbage.ts:752
- 要件: A-03, A-04, V-A
- 原因: buildGarbageOverview の series 行は `seriesKeyOf(event) === row.targetKey` だけで今後の回を集め（752-756 行）、その先頭を nextDate にする（766 行）。回ごとの解決結果（event 行の例外）を見ておらぬ。コメントは「この分類が効いておる今後の回の数」だが、実際はシリーズに属する全ての回を数える。
- 失敗シナリオ: 毎週の「燃えるごみ」シリーズで、直近の回（11/12）を「この回だけ通常の予定に戻す」（祝日で収集なし等。A-04 の受け入れ手順そのもの）。/chores/garbage の上段「次の収集日」は正しく 11/19 を出すが、下段「分類した予定」のシリーズ行は「次の収集日: 11月12日（明日）」と表示する（garbage-view.tsx 452-456 行）。同じ画面で矛盾し、収集の無い日を収集日と告げる。直近の回だけ別名称（粗大ごみ）にした場合も、シリーズ行（燃えるごみ）の次の収集日がその日になる。
- 根拠: scratch の vitest probe（(scratch)/review/a-garbage/tests/overview.probe.ts）で実行: series 行 + ev-1 の normal 例外、窓に 11/12・11/19 → `collections: ['2026-11-19']` に対し `series entry nextDate: 2026-11-12 upcomingCount: 2`。別名称の例外でも series の nextDate は 2026-11-12。
- 修正案: series 行の nextDate / upcomingCount は、解決済みの用途が `kind==='garbage' && scope==='series' && purposeId===row.id` の回だけから数える（既に在る `resolved` を使う）。操作の起点（anchor）は従来どおりシリーズのどの回でもよいので別に選ぶ。回帰テストに「直近の回が normal 例外 / 別名称例外」を足す。


## R09 前日 20:00 を過ぎた回（当日・前日 20:15 以降の分類）でも「前日 20:00 に通知します」と表示し、届かぬことを伝えぬ
- 区分: unverified / 重大度 medium / 確信度 high / 観点 garbage
- 場所: src/lib/domain/garbage.ts:585
- 要件: A-07, A-09, V-A
- 原因: save_event_purpose は `start_date >= 今日(JST)` の回へ prev_day_20 を足す（migration 20261111100001 の 368-386 行・451-460 行、トリガ (a) 594 行）。当日の回の remind_at は昨日 20:00、明日の回を 20:15 以降に分類すれば今日 20:00 で、配信の窓 `remind_at > now-15分`（deliver.ts 583-588 行、delivery-rules.ts 29 行）に入らず永久に送られぬ。一方 garbageReminderEffect（585-589 行）と ごみ画面の reminderText（garbage-view.tsx 63-83 行）は時刻を見ずに「通知します」「前日 20:00 に通知」と言う。既存の予定シートの ReminderField は同じ状況で「すでに過ぎているため、通知は届きません」と出す（calendar-event-form-sheet.tsx 321-362 行）ので、ごみ側だけが偽る。
- 失敗シナリオ: 11/11 21:00 に、11/12 の「燃えるごみ」をごみ画面から分類（初期選択は前日 20:00）。フォームは「この予定の前日 20:00 に通知します」、保存後の一覧は BellRing つきで「前日 20:00 に通知」。実際には 1 通も送られず、利用者は初回の収集日を通知なしで迎える。当日の予定を分類した場合も同じ表示になる。
- 根拠: PGlite probe（(scratch)/review/a-garbage/sqltests/probe_event_purposes.sql）Q1: 当日の予定を prev_day_20 で分類 → event_reminders に 1 行入り、`remind_at < now() - interval '15 minutes'` が真（9/9 緑）。配信側の窓と文言はコード読み。
- 修正案: 表示側で remind_at（導出は既存の deriveRemindAtIso / isFutureIso を再利用）を見て、過ぎておれば「前日 20:00 は過ぎているため、この回の通知は届きません（次の回から届きます）」と出す。フォームの効果文（event 範囲は対象日、series 範囲は直近の回）と、ごみ画面の収集日の行の両方。DB の挙動は変えずともよい。


## R10 通知を明示 OFF にしたシリーズ（remind_default='none'）の回へ「この回だけ」の分類を足すと、初期選択が前日 20:00 になり通知が付く
- 区分: unverified / 重大度 medium / 確信度 medium / 観点 garbage
- 場所: src/components/chores/garbage/garbage-purpose-form.tsx:110
- 要件: A-07
- 原因: defaultReminder は範囲 event で event 行の名称が無ければ（labelAt('event')===null）無条件に 'prev_day_20' を返す（110-117 行。chooseScope が 148 行で適用）。ResolvedEventPurpose はシリーズの remind_default を運ばぬため、シリーズが既定 ON か明示 OFF かをフォームが知らぬ。RPC の event 範囲 prev_day_20 は new_opt_out=false にして通知を INSERT する（migration 416-422・451-460 行）。
- 失敗シナリオ: シリーズを「ごみの日・通知を止める」で分類済み（remind_default='none'。series の明示 OFF）。ある回だけ名称を変えようと予定を開き「この回だけ」を押すと、通知の選択が「前日 20:00 に通知する」へ切り替わる。名称だけ変えて保存すると、その回に前日通知が付く。フォームのコメントが自ら掲げる「名称の変更のついでに通知を書き換えぬ」に反し、A-07 の「既存の OFF を上書きしない」を既定の経路で破る（効果文は表示されるため無音ではない。ゆえに confidence は medium）。
- 根拠: コード読み: current={kind:'garbage',scope:'series',seriesLabel:X,reminderOptOut:false} のとき eventOptedOut=false・labelAt('event')=null → 'prev_day_20'。DB 側は既存 pgTAP の B-4 / S-3 が「event 範囲の prev_day_20 は未設定の回へ通知を足す」ことを固定している。フォームの初期値そのものは実行しておらぬ。
- 修正案: 解決結果にシリーズの remindDefault を載せ（resolveEventPurpose の seriesRow から）、event 範囲の初期選択を「シリーズ既定が prev_day_20 の時だけ prev_day_20、none の時は keep」にする。既にシリーズでごみになっておる回の例外追加は keep を初期値にするのが最も安全。フォームのテストに none シリーズのケースを足す。


## R11 個別に通知を止めた事実が、既定 ON のシリーズの回でしか記録されず、シリーズを前日通知へ切り替えると復活する
- 区分: unverified / 重大度 low / 確信度 high / 観点 garbage
- 場所: supabase/migrations/20261111100001_event_purposes.sql:659
- 要件: A-07
- 原因: トリガ (b) event_reminders_record_opt_out は、対象の回のシリーズ既定が 'prev_day_20' の時だけ reminder_opt_out を立てる（639-643・659-663 行）。既定 'none' のシリーズで利用者が通知を付けて外した回は「未設定」と区別されぬ。series 範囲の prev_day_20 は opt-out の無い全ての今後の回へ足す（368-386 行）。効果文は「個別に通知を止めた回は変えません」と約束している（garbage.ts 587 行）。
- 失敗シナリオ: シリーズを keep / off で分類（既定 none）。ある回に 30 分前の通知を付け、後で「なし」に戻す（明示 OFF）。その後シリーズを「前日 20:00 に通知する」へ変えると、その回にも前日通知が付く。
- 根拠: PGlite probe Q4（同上の probe_event_purposes.sql）: 既定 none のシリーズで通知を INSERT→DELETE した回に opt-out 行は 0 件（Q4-b）、series prev_day_20 の後その回の event_reminders が 1 件（Q4-d）。
- 修正案: トリガ (b) の条件を「既定 ON のシリーズ」から「ごみに分類されたシリーズ（series 行が在る）」へ広げて明示 OFF を記録する。広げぬなら、効果文を「既定の前日通知を個別に止めた回」に限る表現へ直す。


## R12 ごみフォームからシリーズの 1 回だけ通知を止めると、その回の分類がシリーズから分岐する
- 区分: unverified / 重大度 low / 確信度 medium / 観点 garbage
- 場所: src/components/chores/garbage/garbage-purpose-form.tsx:100
- 要件: A-03, A-04
- 原因: modesFor は範囲 event で event 行が無い時に 'garbage'（と 'normal'）しか出さぬ（100-105 行）。RPC は「用途なし・明示 OFF だけ」の行（event 範囲 clear + off、既定 ON のシリーズで new_opt_out=true。migration 416-422 行）を書けるが、フォームからは到達できぬ。
- 失敗シナリオ: ごみ画面の収集日の「変更」から、シリーズの次の回だけ通知を止めたい。「この回だけ」→「通知を止める」で保存すると、シリーズと同じ名称の event 行（この回だけの分類）ができる。一覧に「この回だけ」の行が増え、後でシリーズの名称を変えてもその回だけ古い名称のまま残る。予定シートの通知 Select で「なし」にした場合はトリガ (b) が用途なしの opt-out だけを記録するので、経路で結果が食い違う。
- 根拠: コード読み（フォームの modesFor と RPC の event 範囲の分岐）。実行はしておらぬ。
- 修正案: シリーズ既定でごみになっておる回（event 行なし）には「この回の通知だけ止める」操作を出し、`{scope:'event', action:'clear', reminder:'off'}` を送る（RPC は既に用途なしの opt-out 行として保存する）。


## R13 育児ホームの予定カードは、分類の取得に失敗しても何も示さず、ごみの日を通常の予定と同じ見た目で出す
- 区分: unverified / 重大度 low / 確信度 high / 観点 garbage
- 場所: src/components/calendar/upcoming-events-card.tsx:100
- 要件: A-01, X-03
- 原因: UpcomingEventsCard は purposeLoad が failed の時、全件を unknown に解決して印を出さぬだけで（100-107 行）、状態を画面へ出す経路が無い。取り直しの失敗も黙って前の分類を保つ（181-184 行）。カレンダーは purposeState の帯で「どれがごみの日かは表示できていません」と言うが、カードには相当するものが無い。
- 失敗シナリオ: /baby の SSR で event_purposes の取得だけ失敗（通信の瞬断、または migration より先にコードが出た環境）。「今日・明日の予定」に明日の燃えるごみが、ごみの印なしで並ぶ。利用者には未分類の予定と区別できぬ（migration 未適用の間は恒常的にこの表示）。予定の表示自体は倒れぬ。
- 根拠: コード読み。カードに purposeLoad.status を参照する描画が無いことを確認（差分全体）。
- 修正案: failed の時だけカードに 1 行（「ごみの日の分類を読み込めていません」）を出す。少なくとも unknown の行を「通常」と同じに見せぬ注記を足す。


## R14 既定 ON のシリーズで、過去から今日以降へ動かした回には既定の前日通知が付かぬ
- 区分: unverified / 重大度 low / 確信度 high / 観点 garbage
- 場所: supabase/migrations/20261111100001_event_purposes.sql:618
- 要件: A-07
- 原因: 既定の通知を足すトリガ (a) は AFTER INSERT だけ（618-620 行）。日付の UPDATE（native の編集、Google 同期の upsert の DO UPDATE 側）では走らぬ。分類時点で過去だった回は `start_date >= 今日` の条件で通知が足されておらぬ。
- 失敗シナリオ: 既定 ON のシリーズの、過ぎた回を将来の日付へ動かす（Google 側での振替、native の日付編集）。その回はごみとして表示されるが、シリーズの他の回と違い前日通知が付かぬ（「これから追加される回にも付けます」という表示と食い違う）。
- 根拠: PGlite probe Q3: 既定 ON で分類後、過去の回の start_date を +18 日へ UPDATE → その回の event_reminders は 0 件。
- 修正案: calendar_events の AFTER UPDATE（start_date が過去から今日以降へ動いた時だけの WHEN 句つき）でも同じ関数を呼ぶ。既存の trg_calendar_events_sync_remind_at_upd と同じ形で足せる。


## R15 履歴は世帯全体の新しい 300 件・項目ごと 20 件しか読めず、月次・年次の項目の記録を訂正・取り消しできなくなる
- 区分: unverified / 重大度 medium / 確信度 high / 観点 cleaning
- 場所: src/app/(main)/chores/cleaning/page.tsx:51
- 要件: B-04, B-05
- 原因: 履歴の読み取りは page.tsx:51-58 の 1 本だけで、世帯の全項目をまとめて created_at 降順 300 件（CLEANING_LOG_LIMIT）。項目の詳細は cleaning-view.tsx:279-283 でその配列を routine_id で絞るだけで、項目単位の取得もページ送りも無い（cleaning-item-detail.tsx:28,89 でさらに先頭 20 件に切る）。訂正・取り消しの釦は表示された行にしか付かない。
- 失敗シナリオ: 週次の項目が 6 個ある世帯は 1 年で約 312 件の履歴を作る。年 1 回の「年末の大掃除」の前回の記録（誤タップの完了・誤スキップを含む）は 300 件の窓から外れ、詳細には「直近の履歴の中に、この項目の記録は見つかりませんでした」と出るだけで、取り消しも実施日の訂正もできない。前回実施日と、閉じた回（maxOccurrence）は DB 集計（cleaning_log_marks）で効き続けるため、誤った前回実施日・誤って閉じた年次の回を画面から直す手段が無くなる。週次の項目でも 21 件目より古い記録は同じく触れない。
- 根拠: grep で cleaning_logs の読み取りは page.tsx:52 と actions.ts:249,308（操作 ID・回の照合用）のみ。actions.ts の export は saveCleaning だけで履歴取得の Action は無い。cleaning-item-detail.tsx:314-319,439-441 は打ち切りを文言で告げるのみ。
- 修正案: 詳細を開いた項目について、その routine_id の有効な履歴を新しい順に取得する経路（Server Action か RPC、ページ送り付き）を足す。または一覧取得を「項目ごとに直近 N 件」（window 関数の RPC）に変える。少なくとも lastDoneOn / maxOccurrence を決めている行は必ず取得対象に含める。


## R16 固定周期の変更後も、変更前の格子で閉じた鍵が新しい格子の予定日を覆い、予定が黙って飛ぶ
- 区分: unverified / 重大度 medium / 確信度 high / 観点 cleaning
- 場所: src/lib/domain/cleaning-schedule.ts:309
- 要件: B-02, V-B
- 原因: fixed の下限は start = max(anchor, resume_floor, maxOccurrence+1)（cleaning-schedule.ts:297-310）。maxOccurrence は cleaning_log_marks が全有効履歴から取る最大値で、周期変更（save_cleaning_routine の v_restart、migration 20261111100002:208-219）は resume_floor と延期だけを直し、旧い格子の鍵は有効なまま残る。
- 失敗シナリオ: 「毎月30日」の項目で 11/11 に今月分を早めに完了（鍵 = 11/30）→ 同じ日に「毎週土曜（基準 11/14）」へ変更。次回は 11/14 のはずが 12/05 になり、11/14・11/21・11/28 の 3 回は予定にも期限超過にも一度も出ない。年次（12/20）を早めに完了してから月次（20日）へ変えると 11/20・12/20 が飛び 2027-01-20 になる。先の回をスキップしてから周期を短くした時も同じ。フォームの注記（「変更前の予定日は期限超過として数え直しません」）はこの挙動を説明していない。
- 根拠: scratch の probe（(scratch)/review/cleaning-b/edit.probe.ts）で routineStatus を実行: 変更後 today=11/11・11/14・11/28 いずれも key/due=2026-12-05、12/05 で初めて open=1。PGlite で save_cleaning_routine による周期変更後も cleaning_log_marks.max_occurrence が旧い鍵（今日+19）のまま残ることを確認（probe_cleaning_b.sql の 9 番 ok）。
- 修正案: 周期（単位・間隔・方式・基準日）を変えた時刻を routine に持ち（例: cadence_changed_at）、cleaning_log_marks の max_occurrence / max_skip_occurrence はそれ以降に作られた履歴だけから取る（last_done_on は全履歴のまま）。または再開始時に resume_floor とは別の「鍵の下限」を持たせ、旧い格子の鍵を start の計算から外す。回帰テストに「早めの完了 → 周期を短く変更 → 次回は新しい格子の最初の日」を足す。


## R17 実施基準: 先の回をスキップした後に早めに実施すると、次回が実施日からではなくスキップした予定日から数えられる（鍵が逃げた回のスキップも 1 日ずれる）
- 区分: unverified / 重大度 low / 確信度 high / 観点 cleaning
- 場所: src/lib/domain/cleaning-schedule.ts:334
- 要件: B-07b, B-07d, B-07f
- 原因: after_done の起点が base = max(lastDoneOn, maxSkipOccurrence)（334-335 行）で、「最後の閉鎖」ではなく日付の大きい方を取る。スキップした回の鍵が実施日より後にあると、その後の実施が起点にならない。また nextAfterSkip / スキップ後の起点は予定日ではなく鍵（339, 347-351 行）で、鍵が afterClosed へ逃げた回では予定日 +1 日になる。
- 失敗シナリオ: (1) 週 1・前回 11/01（予定 11/08）。11/03 に今回をスキップ → 11/05 に実施。規則どおりなら次回は 11/12 だが 11/15 になる。月・年の周期では差が大きい（乱数探索の例: 年 1 回、2029-09-10 の回を先にスキップして 2028-12-17 に実施 → 次回は 2029-12-17 でなく 2030-09-10）。画面の「今日やると、次回は…」も同じ値を出すので食い違いは無いが、B-07b/B-07d の「実施日が新基準」に反する。(2) 初回予定 11/18 を 11/11 に実施（予定 11/18・鍵 11/19）→ その回をスキップすると次回は 11/25 でなく 11/26。
- 根拠: scratch の乱数探索（sched.probe.ts、3000 系列 × 12 手、完了・スキップ・取り消し・追記）で検出した不一致はこの 1 種類だけ（12 件。固定周期・鍵の未閉鎖・予測値との一致などほかの不変条件は全て成立）。個別再現: sched.out.txt 16-19 行（11/05 実施後 due=2026-11-15）、edit.out.txt 9-10 行（nextSkip=2026-11-26）。
- 修正案: 起点を「最後の閉鎖」で決める: done の起点は lastDoneOn、スキップの起点は「lastDoneOn より後に記録された skip」だけを数える（marks に skip の記録時刻か、done_on より新しい skip の鍵だけを返す集計を足す）。スキップの次回は鍵ではなく scheduledOn + 周期にする（鍵は一意性のためだけに使う）。


## R18 先の回を 2 回閉じた後は、DB の鍵の上限で 1 タップ完了・スキップが「入力内容を確認してください。」と拒まれる
- 区分: unverified / 重大度 low / 確信度 high / 観点 cleaning
- 場所: supabase/migrations/20261111100002_cleaning_routines.sql:371
- 要件: B-04
- 原因: record_cleaning_log は鍵が greatest(今日, 基準日) + 2 周期を越えると 22023 'occurrence out of range'（365-374 行）。Action（actions.ts:300-327）は上限を見ずに現在の鍵をそのまま渡し、messageOfDbError（actions.ts:59）は 'future' を含まない 22023 を一律 INVALID_MESSAGE にする。画面は釦を出したまま。
- 失敗シナリオ: 実施基準・週 1 の項目を今日完了し、旅行に備えて先の 2 回をスキップ（鍵 +7, +14 は通る）。その後 6 日以内に掃除して 1 タップ完了すると、鍵 +21 が上限 +14 を越えて拒否され、直す入力の無い画面に「入力内容を確認してください。」と出る。完了を記録する手段は「過去にやった日を記録」（鍵なし）だけ。固定周期でも先の回を 2 回閉じた後の 3 回目は同じ文言で止まる。
- 根拠: PGlite ハーネスで再現（(scratch)/review/cleaning-b/tests/probe_cleaning_b.sql の 3-6 番: skip +7 / +14 は saved、done の鍵 +21 は 22023 'occurrence out of range'、鍵なしの追記は saved）。TS 側の鍵の進み方は sched.out.txt 24-31 行。
- 修正案: Action で上限を先に判定し、「先の回を閉じ済みのため、次の予定日が近づくまで記録できません（今日の実施は「過去にやった日を記録」から）」のような理由の分かる拒否にする。併せて、上限に達した項目の完了・スキップの釦を無効にして理由を出す。実施基準の done は鍵の上限に関わらず受ける設計（done は起点を実施日へ戻すため黙らせる害が無い）も検討。


## R19 結果不明の完了を後日「同じ操作で確認」すると、先の送信が届いていなかった場合に実施日が確認した日で黙って記録される
- 区分: unverified / 重大度 low / 確信度 medium / 観点 cleaning
- 場所: src/app/(main)/chores/cleaning/actions.ts:326
- 要件: B-03, B-04
- 原因: close の要求は実施日を運ばず、行が無ければ毎回 todayJstString()（再送した時点のサーバーの今日）を done_on にする（actions.ts:294-327）。端末の控えには期限が無く（chore-pending.ts に失効なし）、再送は何日後でも同じ要求で通る。実施基準の鍵は今日に依らないので seenOccurrence の照合も通る。成功の文言は通常の「完了にしました」のまま（cleaning-view.tsx:181-188）。
- 失敗シナリオ: 11/14 に圏外で完了を押して結果不明のまま閉じる（送信は届いていない）。11/20 に開いて「同じ操作で確認」を押すと done_on=11/20 で記録され、前回実施日が 11/20、実施基準なら次回が 11/21 でなく 11/27 になる。利用者には日付が変わったことが伝わらない（履歴の訂正で直せるが、気づく手がかりが無い）。
- 根拠: コード読解のみ（実行での再現はしていない）。関連する既存契約: 育児記録は同じ状況で「届いた時刻」と直し方を成功の知らせで伝える（CLAUDE.md の保存の再送契約）。
- 修正案: 再送で新規に書いた場合（replayed でない saved）で、控えの firstAttemptAt の JST 日付と記録した done_on が違う時は、「実施日は今日（M月D日）で記録しました。違う時は履歴で直せます」と告げる。あるいは初回送信時にサーバー時刻の標本から得た日付を要求へ凍結し、サーバーが「今日以前・今日から数日以内」を検証して使う。


## R20 JST 0 時前後にアプリサーバーの時計が DB より進んでいると、1 タップ完了が「未来の日付は記録できません」で拒まれる
- 区分: unverified / 重大度 low / 確信度 low / 観点 cleaning
- 場所: src/app/(main)/chores/cleaning/actions.ts:300
- 要件: B-04, B-07g
- 原因: done_on はアプリサーバーの todayJstString()（actions.ts:300,326）、未来日の判定は DB の now()（migration 20261111100002:331-333 の p_done_on > v_today）。2 つの時計が日付の境をまたいで食い違うと、サーバーの「今日」が DB には「明日」になる。延期の下限（p_until <= v_today）も同じ構造。
- 失敗シナリオ: サーバー 00:00:00.2 JST・DB 23:59:59.9 JST の瞬間に完了を押すと 22023 'done_on in the future' → FUTURE_MESSAGE「未来の日付は実施日として記録できません。今日までの日付を選んでください。」が、日付を選んでいない 1 タップ操作に出る。記録はされず、押し直せば通る。二重記録や別の回の閉鎖は起きない（鍵はサーバーの今日で決まり、DB は一意制約で 1 行に確定する）。
- 根拠: コード読解のみ。時計のずれの幅だけ起きる窓で、実測はしていない。逆向き（DB が進んでいる）は done_on が DB の昨日になるだけで拒否されない。
- 修正案: 完了の実施日を RPC 側で決める（p_done_on を NULL で渡し、回を閉じる done は DB の今日を入れる）。または 22023 'future' を close の経路で受けた時は 1 回だけ読み直して再試行する。


## R21 1 日の差替えが、その日の主食・汁物の行を黙って削除する（選び直さない）
- 区分: unverified / 重大度 medium / 確信度 high / 観点 meal-logic
- 場所: src/lib/meals/planner.ts:883
- 要件: C-32, C-33, V-C2
- 原因: replaceDay（planner.ts:883-907）は、その日の固定・調理済み以外の枠を全て seeds から外し、`forced: []` で runFill する。runFill（768-773）が埋めるのは wantsRole が真の区分だけで、主食は `ctx.options.includeStaple`、汁物は `includeSoup` が真のときだけ（706-712）。外された主食・汁物の行は fallback にも使われず removedEntryIds へ入る。サーバーの replaceDinnerDay は includeStaple を渡さない（actions.ts:889-891。includeStaple は作成時の要求にしか無い）。結果は apply_dinner_plan が範囲内の非固定行を DELETE して plan.entries だけを INSERT するので（20261111100003_dinner_tables.sql:1089-1114）、行は実際に消える。gaps にも notices にも出ない。
- 失敗シナリオ: 「主食の枠も作る」をオンにして 7 日分を作成（各日に 主菜・副菜・主食）。ある日の「この日を差し替え」を押すと、主菜・副菜は選び直されるが主食の行が消える（新しい主菜が丼・カレー・麺でなくても）。確定済みだった場合は買い物の自動計算からも主食の材料が落ちる。汁物も同様で、設定の includeSoup をオフにした後や、汁物を手で足した日を差し替えると消える。
- 根拠: 実カタログでの実行（scratchpad/review/logic/c-more.rev.test.ts）: includeStaple+includeSoup で作成 → サーバーと同じ options（includeSoup のみ）で replaceDay を 122 回 → 「主食の行が消え、新しい主菜も主食を含まない」が 85/122。例: `before: 主菜:鶏の照り焼き | 副菜:もやしのナムル | 主食:バタートースト | 汁物:豆腐とわかめのみそ汁  after: 主菜:肉豆腐 | 副菜:トマトと玉ねぎのサラダ | 汁物:かきたま汁  gaps=[]`。includeSoup=false で手動追加の『豚汁』（confirmed）がある日を差し替えると removedEntryIds に入り結果から消えた。
- 修正案: replaceDay で、差替え対象の枠が持っていた区分を forced（fallback つき）として必ず選び直す。主食だけは「新しい主菜が includesStaple なら足さない」を保つ。主食の差替えでは元の料理（ごはん）を avoid に入れない（今は replaceable 全ての recipeId が avoid に入るので、選び直せても別の主食になる）。「差替え前後で区分の集合が保たれる」テストを追加。


## R22 「主食の枠も作る」で、米を常備品・在庫に入れていない世帯には ごはん が一度も選ばれず、バタートースト・かけうどん・おにぎりが並ぶ
- 区分: unverified / 重大度 medium / 確信度 high / 観点 meal-logic
- 場所: src/lib/meals/planner.ts:448
- 要件: C-31, C-32, C-36, V-C2
- 原因: 主食の候補にも timePoints（planner.ts:448-452）がそのまま掛かり、『ごはん』は minutes: 60（catalog/recipes.ts:1533。炊飯時間込み）で −4、『バタートースト』（5 分）は −0.33、『かけうどん』『おにぎり』（15 分）は −1。在庫が無ければ在庫点は全て 0 なので時間の差だけで決まり、repeatPoints（531-536。主食は 1 回につき −1）で 3 品が回る。ごはんが選ばれるのは、米が常備品か在庫にあって stockReady が付くときだけ。
- 失敗シナリオ: 初回ユーザー（常備品は未設定が初期値）が「主食の枠も作る」をオンにして 7 日分を作ると、主食は トースト/うどん/おにぎり の繰り返しになり、『ぶりの照り焼き＋豚汁＋バタートースト』『たらのムニエル＋かけうどん』のような夕食が提案される。確定すると買い物リストにも食パン・うどん・のりが載る。
- 根拠: 実行結果（c-more.rev.test.ts、seed 0〜39 × 7 日）: 常備品なし → `[バタートースト 97, おにぎり 69, かけうどん 63]`、ごはん 0 回。常備品に rice を入れると `[ごはん 168]`。seed なしの例: `11 主菜:牛肉とピーマンの塩こしょう炒め | 主食:バタートースト | 12 主菜:たらのムニエル | 主食:かけうどん | 13 主菜:豚のしょうが焼き | 主食:おにぎり …`。
- 修正案: 主食の区分は時間の採点から外す（または炊飯時間を minutes に含めない）。既定の主食は『ごはん』に寄せ、麺・パンは希望や在庫があるときだけ選ぶ、等の規則を明示する。初期状態（常備品なし・在庫なし）で主食が ごはん になるテストを追加。


## R23 「そば」（自由入力・食材指定）のアレルギーが小麦の除外に化け、しょうゆを使う料理が全て除外される（加工品を素の食材として展開）
- 区分: unverified / 重大度 medium / 確信度 high / 観点 meal-logic
- 場所: src/lib/meals/exclusions.ts:150
- 要件: C-52, C-54, C-36
- 原因: addIngredientRule（exclusions.ts:150-157）は「derivedFrom が空 = 素の食材」とみなし、アレルギー指定のときその食材の allergens を全てアレルゲン規則へ展開する。コメントは『加工品（しょうゆ等）を登録した場合は、その食材と派生品だけに留める（どの成分かを推測しない）』だが、derivedFrom を持たない加工品（そば=[buckwheat, wheat]、カレールウ=[wheat, milk, soybean]、サラダ油=[soybean]、酢=[wheat]、ちくわ・かまぼこ・各種ソース等）も「素」と判定される。自由入力「そば」はアレルゲン名にも食材名にも一致するため、両方の経路が走って wheat が足される。
- 失敗シナリオ: そばアレルギーを自由入力「そば」（または食材『そば』）で登録すると、アレルゲン規則が [buckwheat, wheat] になり、64 品中 37 品（しょうゆ・小麦粉・うどん等を使う料理すべて）が blocked。理由の表示は「そば に該当」となり、主菜の候補が塩味の数品だけになる。一覧から『そば』を選んだ場合（allergen 指定）は blocked=0。同様に『カレールウ』のアレルギー登録で 44 品、『サラダ油』で 42 品が除外される。
- 根拠: 実行結果（a-exclusion.rev.test.ts）: `{custom そば} allergenRules=[buckwheat, buckwheat, wheat] allowed/label/blocked 26 1 37`、`{ingredient soba} [buckwheat, wheat] 26 1 37`、`{allergen buckwheat} [buckwheat] 56 8 0`、`{ingredient curry_roux} [wheat, milk, soybean] 20 0 44`、`{ingredient salad_oil} [soybean] 21 1 42`、`{ingredient vinegar} [wheat] 26 1 37`。
- 修正案: アレルゲンへの展開は「生鮮・単一原料で、そのアレルゲンそのもの」の食材に限る（辞書に明示のフラグ、または allergenInfo='known' かつ allergens が 1 件かつ売場が調味料・加工品でない等）。自由入力がアレルゲン名に一致したときは、同名の食材の allergens を追加展開しない。そば・カレールウで他アレルゲンへ広がらないテストを追加。


## R24 在庫に「豚肉」「鶏肉」「牛肉」「きのこ」と入れると総称の ID に解決され、どのレシピの材料にも数えられない（ヒントも出ない）
- 区分: unverified / 重大度 medium / 確信度 high / 観点 meal-logic
- 場所: src/lib/meals/pantry-match.ts:197
- 要件: C-22, C-23, C-27, V-C1
- 原因: 在庫との突き合わせは `item.ingredientId === ingredient.ingredientId` の完全一致だけ（pantry-match.ts:197）。一方、辞書は「豚肉/ポーク」「鶏肉/チキン」「牛肉」「きのこ」を総称の食材（pork/chicken/beef/mushroom。catalog/ingredients.ts:95,109,115,120）へ解決し、レシピは部位別の ID（pork_komagire 等）しか使わない。解決は成功しているので unresolved_items のヒントにも掛からない。
- 失敗シナリオ: 在庫に「豚肉 300g・じゃがいも・玉ねぎ・にんじん・鶏肉 600g・牛肉 300g・大根・しょうが」を登録し、調味料を常備品にしても、『肉じゃが』『鶏肉と大根の煮物』『牛丼』は「買い足しが必要（豚こま切れ肉 / 鶏もも肉 / 牛こま切れ肉）」になり、揃う候補は『じゃがいもと玉ねぎのみそ汁』だけ。週間献立でも在庫利用の加点・引当が付かず、買い物リストに肉が全量載る。画面には「豚肉」は正しく登録済みに見える。
- 根拠: 実行結果（b-planner.rev.test.ts）: `resolved: [豚肉→pork, 鶏肉→chicken, 牛肉→beef …]`、`ready: [じゃがいもと玉ねぎのみそ汁] hints []`、`buy top: [… 豚のしょうが焼き: 豚ロース薄切り肉, 牛丼: 牛こま切れ肉 …]`。対照: 「豚こま 400g」なら『豚にら玉』等が ready。部位の同一視を禁じる C-22 との両立が要る点は設計上の論点。
- 修正案: 部位を同一視はせず、総称の在庫が由来元（derivedFrom の親）に当たる材料は『食材はあるが確認が必要』（uncertain、理由=部位・種類の確認）として check 枠へ出す。少なくとも、総称に解決した在庫があるときは『部位（豚こま・豚バラ等）で登録すると候補に数えます』というヒントを返す。


## R25 食材辞書の派生関係のずれ: 片栗粉が じゃがいも 由来で過剰除外、ミニトマトが トマト 由来でなく除外漏れ
- 区分: unverified / 重大度 low / 確信度 high / 観点 meal-logic
- 場所: src/lib/meals/catalog/ingredients.ts:196
- 要件: C-52, C-54
- 原因: katakuriko に `derivedFrom: ["potato"]`（ingredients.ts:196）があるため、じゃがいもの除外（苦手・アレルギー）が片栗粉を使う全料理へ及ぶ。逆に cherry_tomato（ingredients.ts:73）は derivedFrom を持たず、tomato の除外が及ばない（tomato_can・ketchup には及ぶ）。
- 失敗シナリオ: 「じゃがいも」を苦手に登録すると、じゃがいもを使わない『鶏のから揚げ』『麻婆豆腐』『ぶりの照り焼き』『かきたま汁』など 8 品も除外される。「トマト」をアレルギー登録しても、材料にミニトマトを入れた手動料理は verdict=ok（カタログのレシピは現状ミニトマトを使っていないので、漏れるのは手動料理だけ）。
- 根拠: 実行結果（d-misc.rev.test.ts）: `じゃがいも dislike: blocked 15 of which without potato: [鶏のから揚げ, 麻婆豆腐, ぶりの照り焼き, 豆腐ステーキ きのこしょうゆ, 豚肉と白菜の塩炒め, 鶏つくねの塩焼き, えびとブロッコリーの塩炒め, かきたま汁]`、`トマト allergy vs manual dish with ミニトマト: ok`。
- 修正案: 片栗粉の derivedFrom を外す（市販品はほぼ精製でんぷんで、じゃがいもを避ける人の対象とは言い難い。残すなら苦手には及ぼさない）。cherry_tomato に `derivedFrom: ["tomato"]` を付ける。


## R26 まとめ入力で「米 2合」「牛乳 1カップ」「しめじ 1株」「卵 1ケース」の数量が別の食材行になる
- 区分: unverified / 重大度 low / 確信度 high / 観点 meal-logic
- 場所: src/lib/meals/normalize.ts:281
- 要件: C-22, V-C1
- 原因: 後置の単位語（normalize.ts:100-116）に 合・株・カップ・ケース 等が無く、カップは前置（「カップ1」）だけ対応（118-122）。parseBulkInput（281-296）は、数量として読めず裸の数字でもない語を新しい食材として items に足す。
- 失敗シナリオ: 「米 2合、牛乳 1カップ、しめじ 1株」と入れると、確認一覧に 米・『2合』・牛乳・『1カップ』・しめじ・『1株』の 6 行が並び、数量は全て不明になる。空白なしの「牛乳1カップ」「水2カップ」は名前ごと未解決になる。確認画面で直せるが、気付かず保存すると未解決の在庫行が残る。
- 根拠: 実行結果（d-misc.rev.test.ts）: `"米 2合" → 米[-|]→rice , 2合[-|]→null`、`"牛乳 1カップ" → 牛乳[-|]→milk , 1カップ[-|]→null`、`"牛乳1カップ" → 牛乳1カップ[-|]→null`、`"しめじ 1株" → しめじ[-|]→shimeji , 1株[-|]→null`、`"卵 1ケース" → 卵[-|]→egg , 1ケース[-|]→null`。
- 修正案: 「数字で始まり辞書に解決できない語」は新しい食材にせず、直前の名前の quantityText として残す（数量は不明のまま）。後置の『カップ』を単位語に足す。


## R27 食事段階が未設定でも 24 か月以上なら取り分け案内を表示する（月齢だけからの表示）
- 区分: unverified / 重大度 low / 確信度 low / 観点 meal-logic
- 場所: src/lib/meals/child-serving.ts:161
- 要件: C-61, C-64
- 原因: resolveChildServing（child-serving.ts:161-175）は mealStage が null でも、生年月日から 24 か月以上なら `basis: "age_only"`・見出し「2 歳以降の目安」で案内を返す。保護者の設定が無いのに月齢だけで幼児向けの案内を出している。
- 失敗シナリオ: 2 歳 1 か月で、保護者がまだ食事段階を設定していない（離乳完了期相当の食事の）子に、カレーライス等の幼児向け取り分け案内が表示される。台帳 C-61 は「月齢だけで発達段階…を決めつけない」、C-64 は「未設定…では表示しない」、implementation-notes.md:83 は「未設定・対象外では『未対応』と表示する」。ただし『未設定』が生年月日の未登録だけを指す解釈なら仕様どおりで、見出しも目安と明示している。
- 根拠: 実行結果（b-planner.rev.test.ts）: `24m unset curry: SHOW(age_only)`、`23m unset → 対象月齢外`、`3y not_started → 離乳開始前`、`3y weaning_complete → 対象月齢外`、`no birth toddler → 未設定`。0 歳・未設定・対象外・1 歳未満のはちみつ警告（任意材料・生年月日なしを含む）は期待どおりだった。
- 修正案: 仕様の『未設定』の意味を確定する。段階の未設定も含むなら、stage===null のときは案内を出さず「食事段階を設定すると表示されます」に留める。


## R28 1 日の差替えが、その日の主食（と同じ区分の 2 品目など）の枠を知らせなしで削除する
- 区分: unverified / 重大度 medium / 確信度 high / 観点 meal-server-ai
- 場所: src/lib/meals/planner.ts:883
- 要件: C-33, C-32, V-C2
- 原因: replaceDay（planner.ts:883-907）は、その日の固定でも調理済みでもない枠を全て seeds から外し、fillDate で埋め直す。埋め直す区分は wantsRole（706-712 行）が決め、主食は options.includeStaple が true のときだけ。replaceDinnerDay（src/app/(main)/chores/meals/plan/actions.ts:889-891）は plannerOptions に seed しか渡さないため includeStaple は常に false（世帯設定にも主食の項目は無く、作成時の 1 回限りの指定）。fallback（元の枠へ戻す）は fillSlot が呼ばれた区分にしか効かない。結果、主食の枠は plan.entries に現れず、entriesToApply は送らず、apply_dinner_plan の DELETE（migration 1089-1091 行: 範囲内の NOT pinned AND status<>'cooked' を全削除）がその行を消す。同じ理由で、移動で同じ区分が 2 品になった日の 2 品目、設定で汁物を OFF にした後に残っている汁物の枠も消える。notices には何も載らない（actions.ts:918-921）。
- 失敗シナリオ: 「主食の枠を足す」を付けて 3 日分を作成 → 11/13 は 主菜・副菜・主食（いずれも未固定）。その日を「1 日差替え」→ 応答は status:saved / notices:[] で、DB のその日は主菜・副菜の 2 行だけになり主食の行が消える。確定済みだった場合は買い物リストから主食の材料も外れる。利用者は主食が消えたことを知らされない。
- 根拠: スクラッチの vitest プローブで実行（(scratch)/review/actions-reviewer-vitest/replace-day-e2e.probe.ts、repo の fake-dinner-db と実カタログを使用）: generateDinnerPlan(includeStaple:true) 後 before=['main:cod_meuniere','side:spinach_ohitashi','staple:butter_toast'] → replaceDinnerDay → {status:'saved',notices:[],gaps:[]}、after=['main:beef_bowl','side:broccoli_okaka_ae']、主食の行 0。純関数だけのプローブ（replace-day.probe.ts）でも、主食を含まない主菜（tofu_steak_mushroom）へ替わった日に staple が plan.entries から消え removedEntryIds に入ることを確認。
- 修正案: replaceDay で、その日に既に在った差替え対象の区分（主食・汁物を含む）は「埋め直す対象」として扱う（例: fallback に在る区分は forced 相当にする／その日に主食の枠が在れば includeStaple:true で runFill する）。新しい主菜が includesStaple のときだけ主食を外し、その場合は notices で知らせる。同じ区分が複数ある日は 1 品目だけ選び直し、残りは kept で送り返す。回帰テスト: 主食つきの日の差替えで主食の行数が保たれること、外したときは notices に出ること。


## R29 規則の解釈が「同じ日・同じ区分に 2 つの固定」を返し、その結果を渡した作成が「希望の内容を確認できませんでした」で拒否される
- 区分: unverified / 重大度 low / 確信度 high / 観点 meal-server-ai
- 場所: src/app/(main)/chores/meals/plan/actions.ts:570
- 要件: C-33, C-81
- 原因: wish-rules.ts:254-269 parsePins は、同じ日付・別の料理の固定を重複として弾かない（同じ日付かつ同じ料理だけを弾く）。一方 recheckWish（actions.ts:565-572）は同じ `日付|区分` の 2 つ目の固定を kind:'invalid'（改ざん・壊れた入力の扱い）にし、generateDinnerPlan は rejectedResult(invalidWish) を返す。interpretDinnerWish は pinNotices にも何も出さないため、画面は 2 つの固定を「読み取れた希望」として見せたまま作成だけが失敗する。
- 失敗シナリオ: 希望「金曜はカレー、13日はハンバーグ」（13 日が金曜）や「金曜はカレー、金曜はハンバーグ」を入力 → interpretDinnerWish は ok:true・pins 2 件（どちらも主菜）・unparsed 空を返す → その constraints で generateDinnerPlan → {error:'希望の内容を確認できませんでした。希望を入れ直してから、もう一度お試しください。', failure:'rejected'}。どこを直せばよいかは示されない。
- 根拠: スクラッチの vitest プローブで実行（同 replace-day-e2e.probe.ts の 2 本目）: interpret の結果 pins=[{2026-11-13,curry_rice},{2026-11-13,hamburg_steak}], unparsed=[], pinNotices=[] → generate は上記の rejected。
- 修正案: 解釈側で揃える: parsePins（または interpretDinnerWish の後段）で同じ `日付|区分` の 2 つ目を固定にせず unparsed／pinNotices へ回し「同じ日に主菜を 2 つは固定できません」と知らせる。recheckWish の invalid は改ざん・壊れた入力に限定する。


## R30 AI 補助が有効なとき、AI の結果が規則で読めた希望（固定・時間）を丸ごと置き換える
- 区分: unverified / 重大度 low / 確信度 medium / 観点 meal-server-ai
- 場所: src/app/(main)/chores/meals/plan/actions.ts:466
- 要件: C-81, C-87, C-33
- 原因: interpretDinnerWish は規則で一部でも読めなかった部分（rules.unparsed）があると AI を呼び、結果が空でなければ `constraints = result.constraints; unparsed = []`（466-474 行）で規則の結果を捨てる。AI の出力検証（validateWishOutput）は「候補・日付の範囲内か」だけで、規則が決定的に読めた固定（「金曜はカレー」）や時間上限を AI が返したかは見ない。
- 失敗シナリオ: AI 補助 ON。希望「金曜はカレー、あとはさっぱりしたもの」→ 規則は金曜カレーの固定を読み「あとはさっぱりしたもの」だけが unparsed。AI が preferTags だけを返す（pins を空で返す）と、規則が読めていた金曜カレーの固定が消え、unparsed も空になる。AI 補助 OFF なら固定されていた料理が、ON にすると固定されない（要約表示には出るが、消えた理由は示されない）。
- 根拠: コード読解（actions.ts:445-475）。実 API は未接続のため、既定モデルが pins を落とす頻度は未確認（confidence を medium に留めた）。
- 修正案: AI の結果は規則の結果へ「足す」形にする: 規則で読めた pins / maxMinutes は保持し、AI からは unparsed に対応する追加分（preferTags / avoidTags / preferRecipeIds、規則と衝突しない pins）だけを採用する。採用後に規則の pins が欠けていれば AI の結果を不採用にして規則へ戻す、でもよい。


## R31 出力 schema の maxMinutes が integer のみで、system 文の「指定なしは null」と食い違う（不採用と回数消費が常態化しうる）
- 区分: unverified / 重大度 low / 確信度 low / 観点 meal-server-ai
- 場所: src/lib/meals/ai.ts:595
- 要件: C-85, C-87, C-89
- 原因: outputSchema は `maxMinutes: { type: "integer" }`（595 行）で null を許さず、required にも入れていない。一方 system 文（103-104 行）は「integer 5 to 180, or null」「Use ... null when the wish does not say」と指示する。json_schema を厳密に守る実装では null を出せず、モデルが 0 などの整数で埋めると validateWishOutput（412-424 行）が範囲外として応答全体を不採用にし、invalid_output は retry 対象（669-675 行）なので 1 操作で 2 回ぶん計上される。
- 失敗シナリオ: AI 補助を有効化した環境で、時間の指定が無い希望（大半の希望）を送るたびに maxMinutes:0 が返る → 2 回とも不採用 → 世帯の 1 日 10 回が 5 操作で尽き、AI 補助は 1 度も採用されない（自動献立は動く。課金は起きない）。
- 根拠: コード読解のみ。実 API 試験は未実施（runbook も「json_schema の enum を守る度合いは未確認」と記載）で、既定モデルの実挙動は確認していない。推測のため confidence は low。
- 修正案: schema を `maxMinutes: { type: ["integer", "null"], minimum: 5, maximum: 180 }` にするか、system 文を「時間の指定が無ければ maxMinutes を省く」に揃える。あわせて validateWishOutput で maxMinutes だけは範囲外を null へ退化させる（固定や候補 ID の検証は厳格なまま）ことを検討。実 API 試験（最大 3 回）の確認項目に追加する。


## R32 PostgREST の max_rows（1000）で切られた読み込みを「全件読めた」として扱う（食後評価が現実的に超えうる）
- 区分: unverified / 重大度 low / 確信度 medium / 観点 meal-server-ai
- 場所: src/lib/meals/server/context.ts:343
- 要件: C-74, C-75
- 原因: loadMealContext の各読み込み（loadFeedback 343-357、loadPantry、loadExclusions、loadGrocery、loadPlanEntries）は .range() も件数の照合も持たず、supabase/config.toml:18 の max_rows = 1000 を超えた分は error 無しで欠ける。欠けた結果は unreadable にも failures にも現れない（「取得の失敗を空として返さない」の契約の外）。食後評価は 180 日ぶんを 1 回で読むため、2 人が毎晩 3 品を評価すると 1080 行で上限を超える。
- 失敗シナリオ: 評価を続けた世帯で 1000 行を超えると、eaten_on の古い側から無音で欠ける → 設定画面の「覚えた好み」に古い評価が出ず確認・削除できない（C-75）、採点にも入らない。画面には「全部は表示できていない」の表示が出ない。必須除外・在庫・買い物は現実的には 1000 行に届かないが、同じ形の読み込みで、欠けても検知されない。
- 根拠: コード読解（context.ts の各 loader に上限・ページングなし）と config.toml の max_rows 確認。実 PostgREST での切り捨ては未実行（ハーネスは PostgREST を通らない）。
- 修正案: 読み込みに明示の上限 +1（例: .range(0, LIMIT)）を付け、LIMIT を超えたら「読めていない」（failures または unreadable）として返す。必須除外は超過を失敗にする。食後評価は keyset で 2 ページ目以降を読むか、読む日数を上限に合わせる。


## R33 開いたままの編集フォームが「開いた時点の入力」＋「最新の版」を送り、楽観排他をすり抜けて家族の変更を黙って巻き戻す（掃除の項目編集・履歴の訂正・ごはんの設定カード）
- 区分: unverified / 重大度 medium / 確信度 high / 観点 ui-next
- 場所: src/components/chores/cleaning/cleaning-routine-form.tsx:140
- 要件: X-10, C-72
- 原因: CleaningRoutineForm は入力を mount 時に useState へ写すが、送る版は submit 時の props（version: editing?.updated_at、140 行）。親 cleaning-view.tsx:509-511 は key を routine.id だけにしており、同じ画面の RefreshOnVisible（pollMs=60 秒、470 行）と Server Action の revalidatePath が props を最新へ差し替えるので、フォームは古い入力のまま版だけ進む。同型: cleaning-item-detail.tsx:156（editingLog は開いた時の値、version は最新の log.updated_at）、meals/settings/settings-view.tsx:222（version: settings.version）＋ settings-household-cards.tsx:113-115 / 236-238（触った時点でカード全項目・常備品の全リストを draft に固定）。買い物・食材・手動料理・評価のフォームは key に版を入れて作り直しているので、この 3 箇所だけが漏れている。CLAUDE.md の契約「編集は開いた時点の updated_at を版に送る」に反する。
- 失敗シナリオ: A が掃除項目の編集フォームを開く（毎週）。B が別端末で同じ項目を「2 週間ごと」に変更。60 秒以内に A の画面の props が更新される（フォームの表示は毎週のまま）。A が名前だけ直して保存 → 要求は version=B の保存後の版・cadenceInterval=1。save_cleaning_routine は版一致で通し、B の周期変更が警告なく毎週へ戻る（conflict にならない）。設定でも、A が人数を触って保存前に B が汁物・調理時間（または常備品）を変えると、A の保存が B の変更を古い値で上書きする。
- 根拠: 再現テスト（同上 stale-version.repro.test.tsx、pass）: CleaningView を V1 で描画→詳細→編集→ routines を {cadence_interval:2, updated_at:V2} で rerender →「間隔」select は 1 のまま→名前を変えて保存→ saveCleaning の引数が version===V2 かつ cadenceInterval===1。サーバ側は supabase/migrations/20261111100002_cleaning_routines.sql:205（r.updated_at <> p_version で conflict）と 20261111100003_dinner_tables.sql:738 で、版が一致すれば全項目を UPDATE する。
- 修正案: フォームを開いた（draft を作った）時点の版を state に固定して送る。または他のフォームと同じく key に版を入れ（key={`${routine.id}:${routine.updated_at}`} / ログは `${log.id}:${log.updated_at}`）、版が進んだら入力を作り直して「別の端末で変更されました」を出す。設定カードは draft 作成時の settings.version を draft と一緒に持ち、送信時にその版を使う。上の再現を回帰テストとして cleaning-view.test.tsx / settings-view.test.tsx に入れる。


## R34 定期再取得中にサーバの読み取りが一時失敗すると error boundary が出て、入力中の Client 画面が unmount される
- 区分: unverified / 重大度 medium / 確信度 medium / 観点 ui-next
- 場所: src/app/(main)/chores/cleaning/page.tsx:61
- 要件: X-03
- 原因: 掃除（page.tsx:61-68, 84）・献立（meals/plan/page.tsx:47 の throw new MealContextError）・買い物（meals/shopping/page.tsx:21）・食材／今あるもので／設定（requireMealContext）は、読み取り失敗を throw で error boundary へ渡す。初回表示では正しいが、同じページを RefreshOnVisible が 30〜60 秒ごと（と復帰時）に router.refresh() で再実行するため、表示済みの画面に対する裏の再取得の失敗でも chores/error.tsx・meals/error.tsx が子を置き換える。error boundary は transition 中でも fallback を描く。
- 失敗シナリオ: 食材の画面で 20 件ぶんのまとめ入力を書いている途中（「内容を確認」前、または確認中の下書きを直している途中）に 60 秒の再取得が走り、Supabase の読み取りが一時的に失敗（timeout・5xx）→「ごはんの読み込みに失敗しました」に差し替わり、PantryView が unmount されて入力が消える。「もう一度試す」で戻っても入力は戻らない。掃除フォーム・手動料理・買い物の詳細シートでも同じ。
- 根拠: コード読解のみ（実行での再現なし）。各 page の throw 箇所、refresh-on-visible.tsx:26-27、cleaning-view.tsx:470 / plan-view.tsx:408 / shopping-view.tsx:448 / pantry-view.tsx:344 / settings-view.tsx:400 の pollMs。これらのフォームに下書きの永続化は無い。
- 修正案: 1 件目と同じく、裏の再取得は失敗しても直前の表示を保つ経路にする（データ取得を Server Action／Route Handler にして Client 側で握り、失敗は「最新を確認できません」表示）。router.refresh を残すなら、入力中（シートが開いている・下書きがある・送信中／結果不明）は再取得を止める。


## R35 保存の応答が、送信中に開いた別のシートを閉じて入力を消す
- 区分: unverified / 重大度 low / 確信度 high / 観点 ui-next
- 場所: src/components/chores/meals/shopping/shopping-view.tsx:129
- 要件: X-03
- 原因: onOutcome が、どの操作の応答かを見ずに setSheet(null) / setEditing(null) する（shopping-view.tsx:122,129、cleaning-view.tsx:146、plan-view.tsx:122,132,140、garbage-view.tsx:105）。一方、シートを開く釦（買い物の「詳細を開く」、掃除の「項目を追加」「詳細を開く」、献立の「移動・その他」、ごみの「変更」）は save.blocked で止めていないので、送信中でも開けて文字を打てる（送信釦だけ disabled）。
- 失敗シナリオ: 買い物で「牛乳」をチェック（回線が遅く応答まで 1〜3 秒）→ 続けて「卵」の詳細を開いてメモを打ち始める → 牛乳の応答が届いて setSheet(null) → シートが閉じ、打ちかけのメモが消える。掃除でも、1 タップ完了の直後に「項目を追加」を開いて名前を打つと、完了の応答でフォームごと閉じる。
- 根拠: コード読解。onOutcome は use-chore-save.ts の attempt が送信時点の closure で呼ぶ。ShoppingItemRow の詳細釦（shopping-item-row.tsx:86-95）と cleaning-view.tsx:373 の「項目を追加」に disabled が無い。
- 修正案: シートを閉じるのは、そのシートから送った操作の応答のときだけにする（送信時に「どのシートから送ったか」を控え、応答の payload の id／op と突き合わせる）。または送信中はシートを開く釦も止める。


## R36 育児ホームの「今日・明日の予定」は、分類を読めなかったとき、ごみの日を通常の予定と同じ見た目で出す（不明の表示が無い）
- 区分: unverified / 重大度 low / 確信度 medium / 観点 ui-next
- 場所: src/components/calendar/upcoming-events-card.tsx:101
- 要件: A-01, X-03
- 原因: purposeLoad が failed のとき attachEventPurposes は全件 unknown を載せ、garbageOf は null を返すので行には何も足されない。取り直しも status==='ok' のときだけ差し替える（181-184 行）ため、初回が failed だと failed のまま。カレンダー（calendar-view.tsx の purposeState バナー）と違い、「分類を読めていない」旨の表示がこのカードには無い。
- 失敗シナリオ: /baby の SSR で event_purposes の取得だけ失敗（migration 未適用の環境・一時的な失敗）。明日のごみの予定が「ごみ・燃えるごみ」の印なしで出る。利用者は通常の予定と区別できず、読めていないことにも気づけない（実装メモの「分類を不明として扱う（未分類と偽らない）」が、この面では見た目上は未分類と同じ）。
- 根拠: コード読解（upcoming-events-card.tsx:100-107, 181-184, 352-366。baby/page.tsx は fetchEventPurposeLoad の failed をそのまま渡す）。
- 修正案: purposeLoad.status==='failed' のとき、カードの下に小さく「ごみの日の分類を読み込めていません」と再試行を出す（既存の「最新を確認できません」行と同じ形）。取り直しで ok になれば消す。


## R37 編集フォームが「開いた時点の版」ではなく背景再取得後の最新版を送り、楽観的排他が素通りする（掃除の項目編集・履歴訂正、買い物の量/メモ、設定カード）
- 区分: unverified / 重大度 medium / 確信度 high / 観点 save-regression
- 場所: src/components/chores/cleaning/cleaning-routine-form.tsx:140
- 要件: X-10, V-SAVE
- 原因: フォームは入力値を mount 時の props から useState へ写して持つ一方、版は送信時に生きた props から読む（cleaning-routine-form.tsx:140 `version: editing?.updated_at`。フォームの key は `openEntry.routine.id` だけで版を含まぬ = cleaning-view.tsx:510）。画面には `RefreshOnVisible`（掃除 60 秒・買い物 30 秒の定期 router.refresh + 復帰時）が在り、シートを開いたまま props の行だけが新しい版へ差し替わる。同じ形: cleaning-item-detail.tsx:156（履歴訂正 `log.updated_at`）、shopping-item-panel.tsx:46 / 128（買った量・メモと売場 `item.version`、key は item.id のみ）、settings-view.tsx:222（`settings.version` + 触った後の draft 全体）。食材の編集だけは `key={`${id}:${version}`}`（pantry-view.tsx:363）、料理後の食材は `id|version` 鍵で守ってあり、対策が不揃い。
- 失敗シナリオ: A が掃除の項目の編集を開く（週 1 回・基準日 10/31）。その間に家族 B が周期を月 1 回・基準日 11/20 へ変更。60 秒以内の定期再取得（またはアプリ復帰）で A の画面の行が版 V2 になるが、フォームの入力は週 1 回のまま。A が名前だけ直して保存 → 要求は version=V2 + 週 1 回/10-31 → RPC は版一致で UPDATE し、B の周期変更を無言で巻き戻す。周期が変わった扱い（v_restart）になり延期も消え resume_floor も今日へ書き換わる。conflict は出ず「保存しました」と出る。買い物では B が買った量 500 を記録した後、A の古い入力 300 起点の値で上書き、メモも同様。
- 根拠: repo 外の probe（(scratch)/review/probe/stale-version.test.tsx を同 review/vitest.config.mjs で実行）: 編集を開く → 名前を変更 → rerender で routine を {cadence_unit: month, anchor_date: 2026-11-20, updated_at: V2} に差し替え → 「変更を保存」。送信された要求は `{"op":"routine","version":"2026-11-11T02:00:00.654321+00:00"(=V2),"cadenceUnit":"week","cadenceInterval":1,"anchorDate":"2026-10-31",...}`。save_cleaning_routine（20261111100002:205）は `r.updated_at <> p_version` の時だけ conflict ゆえ、この要求は書込まで進む。既存テスト（cleaning-view / shopping-view）に「開いたまま版が進む」ケースの固定は無い。
- 修正案: 版は「フォームを開いた（または最初に触った）時点」で state / ref に固定して送る。もしくは食材の編集と同じく key に版を含めて作り直す（入力は消えるが無言の上書きは起きぬ。作り直した旨を文で出す）。掃除の項目編集・履歴訂正、買い物の量/メモ、設定 3 カード（draft を作った時点の settings.version を持つ）を揃え、「開いたまま props の版が進む → 送る版は開いた時点」の回帰テストを各画面に 1 本ずつ足す。


## R38 ごみの分類は版を持たぬ状態設定ゆえ、結果不明の控えを後から「同じ操作で確認」すると家族の新しい分類と通知を無言で消す（控えに期限が無く、再送以外に解除手段も無い）
- 区分: unverified / 重大度 medium / 確信度 high / 観点 save-regression
- 場所: supabase/migrations/20261111100001_event_purposes.sql:222
- 要件: X-09, X-10, V-SAVE
- 原因: `save_event_purpose` は版も操作 ID も取らず「その鍵の用途をこの値にする」を後勝ちで書く（migration 222-224 行の設計注記、clear は 342-364、通知 OFF は 387-397 で今日以降の全回の event_reminders を削除）。要求型 `GarbageRequest`（src/lib/domain/garbage.ts:426）にも版が無い。一方、端末の控え（chore-pending.ts）には期限が無く、控えが 1 件在る間は kind 全体が塞がり、UI が出す操作は「同じ操作で確認」だけ（破棄ボタンは再送が rejected になった後にしか出ぬ = pending-chore-notice.tsx:174）。つまり古い要求をそのまま再実行する以外に先へ進めぬ。掃除・ごはんは版/操作 ID で conflict/replayed に落ちるが、ごみだけこの守りが無い。
- 失敗シナリオ: A が繰り返しの予定を「シリーズ全体の分類を解除 + 通知を止める」で保存 → 応答だけ失われ結果不明（DB には成立）。その後、家族 B が同じシリーズを「資源ごみ」に分類し直し前日 20:00 通知を付ける。翌日 A がカレンダーかごみの画面を開くと控えで操作が塞がっており、「同じ操作で確認」を押す → RPC は saved を返し、B の分類行と今日以降の全回の通知設定（個別に時刻を変えた回も）を削除。画面は「保存しました。」と出る。B には何も知らされず、前日通知が届かなくなる。逆向き（A の古い「燃えるごみ + 通知 ON」が B の解除・名称変更を上書き）も同じ。
- 根拠: PGlite ハーネスで実測（--tests に (scratch)/review/tests-garbage を指定、zz_review_stale_replay.sql）: A1 が series garbage → series clear+off（saved）、A2 が series garbage '資源ごみ' prev_day_20（saved。分類 1 行 + 通知 2 件を確認）、A1 が同じ clear+off を再送 → `have: saved / want: conflict`、分類 + 通知の残数 `have: 0 / want: 3`。破棄ボタンの条件は pending-chore-notice.tsx:174 `entry.retryError && !confirming`、retryError は use-chore-save.ts:282 で再送が rejected の時だけ立つ。
- 修正案: ごみの保存にも「画面が見ていた状態」を運ぶ: 要求に対象行（series / event）の `updated_at`（無い時は null = 未分類を見ていた）を載せ、RPC は現状がそれと違い、かつ求める状態とも違う時に conflict を返す（求める状態と同じなら replayed のまま）。併せて、結果不明の控えに「送り直さずに保存済みかを確かめる」手段（現在の分類を読んで一致なら片付ける）か、期限・明示の取り下げを設け、古い要求の再実行を唯一の出口にせぬこと。


## R39 送信中に画面を移ると、確定した操作が別インスタンスに「確認できていない操作」として残り続け、kind 全体を塞ぐ
- 区分: unverified / 重大度 low / 確信度 high / 観点 save-regression
- 場所: src/components/chores/shared/use-chore-save.ts:245
- 要件: X-09, V-SAVE
- 原因: 控えは送信の前に phase=sending で端末へ書かれ、mount 時の読み込み（184-216 行）は sending も含めて全て unknown として state へ取り込む（別タブ・別画面の送信中を伏せる猶予が無い）。離脱後に届いた成功は端末の控えだけを消す（245-250 行）が、既に読み込んだ別インスタンスの state は更新されず、storage イベントも聞いておらぬ。ごはんは 4 画面（献立・買い物・食材・設定）が同じ kind=meal の別インスタンス。
- 失敗シナリオ: 献立で「この献立で確定」を押し、応答を待たずに下のリンクで買い物へ移る（遅い回線で起きる）。買い物の画面は控えを unknown として読み、「保存できたか確認できていない操作: …献立を確定」を出して購入チェック等を全て無効化する。先の Server Action は正常に saved で終わり端末の控えも消えるが、買い物の画面の表示と blocked は残る。利用者が「同じ操作で確認」を押す（replayed/conflict）まで何も操作できぬ。初回が rejected だった場合は控えが端末に残り、再送 → rejected → 2 段の破棄まで要る。データは壊れぬが、通常の操作で偽の「結果不明」が出る。
- 根拠: repo 外の probe（同 review/probe/ghost-pending.test.tsx）: インスタンス A が send（未解決の Promise）→ A を unmount → 同じ owner/kind の B を mount → `B after mount: { pending: ['unknown'], blocked: true }` → A の run を {status:'saved'} で解決 → `storage after settle: 0` だが `B after settle: { pending: ['unknown'], blocked: true }`。
- 修正案: (1) 読み込み時、phase=sending かつ firstAttemptAt が直近（例 60 秒）の控えは「送信中」として表示を伏せ、猶予後に読み直す（安全の判定とは分ける。既存 pending-saves-storage の isAwaitingConfirmation と同じ分離）。(2) `storage` イベントか可視化復帰時に端末の控えを読み直し、消えた控えを state から外す。


## R40 控えの説明の上限を UTF-16 長で検査し、作る側は符号位置で切るため、絵文字等を多く含む名前の項目は全操作が「入力内容を確認してください」で送れぬ
- 区分: unverified / 重大度 low / 確信度 high / 観点 save-regression
- 場所: src/lib/domain/chore-pending.ts:131
- 要件: X-09
- 原因: `snapshotChorePending` は `label.length > 80`（UTF-16）で null を返し、`useChoreSave.send` は null を「invalid」として送信自体を止める（use-chore-save.ts:349-352）。説明を作る側は符号位置で数える: `labelOfCleaningRequest` は `[...name].slice(0, 40)`（cleaning.ts:382）、`garbageRequestLabel` は codePoints 24 字、献立の `labelOfDinnerRequest`（plan-labels.ts）は料理名（最大 60 符号位置）を切らずに入れる。BMP 外の文字は 1 字が length 2。
- 失敗シナリオ: 掃除の項目名に絵文字を 36 字以上含める（名前の上限は 60 符号位置）と、追加も完了も編集も `send` が null を返し「入力内容を確認してください。」としか出ぬ（名前のどこが悪いか示されず、検証は通っておる）。献立の手動料理も、60 字近い題名に BMP 外の文字が 7 字以上あると「作った」「作らなかった」等が送れぬ。
- 根拠: repo 外の probe（同 review/probe/stale-version.test.tsx の 2 本目）: 項目名 '🧹'×40 の close の説明は length 85、`snapshotChorePending` は null。
- 修正案: 上限の検査と切り詰めを 1 箇所へ寄せる: `send` の中で説明を UTF-16 長 80 以内へ切り詰めてから控えを組む（`meal-basics-request.ts` の `clipLabel` は既に UTF-16 長で切っておるので共通化する）。説明が長いことを理由に保存そのものを拒まぬ。


## R41 結果不明が続く控えには出口が無い（破棄は再送が rejected の時だけ。期限も、送らずに確かめる手段も無い）
- 区分: unverified / 重大度 low / 確信度 low / 観点 save-regression
- 場所: src/components/chores/shared/pending-chore-notice.tsx:174
- 要件: X-09, V-SAVE
- 原因: 控えが 1 件でも在ると kind 全体（ごはんは 4 画面まとめて）が blocked（use-chore-save.ts:221）。出口は (a) 再送が確定する (b) 再送が rejected になり 2 段の破棄 (c) 持ち主の交代、の 3 つだけ。再送が unknown を返し続ける場合（Action が例外を投げ続ける・戻り値の形が読めず `unknownResult()` が決定的に返る等）は破棄ボタンが出ず、端末の保存を消す以外に解除できぬ。既存の予定の作成の控えには「確認をやめる」と 7 日の期限が在るが、家事の控えには無い。
- 失敗シナリオ: 推測の域: ある行の状態に対して Action が決定的に unknown を返す不具合・版ずれ（例: RPC の戻り行を parse できぬ）が 1 件起きると、その端末ではその機能の全保存が恒久的に止まり、利用者には「同じ操作で確認」を押し続ける以外の手段が無い。また届いておらぬ破壊的操作（除外の削除・履歴の取り消し等）を、気が変わっても取り下げられず、再実行するしか先へ進めぬ。決定的に unknown になる具体の入力は今回の読みでは見つけておらぬ（RPC の RAISE は全て 22/23/42 系で rejected に分類される）。
- 根拠: コードの読み: pending-chore-notice.tsx:174 `entry.retryError && !confirming` の時だけ「控えを破棄」。use-chore-save.ts:282 `retryError = failure?.failure === "rejected" ? failure.error : undefined`。chore-pending.ts に期限の処理は無い。実行での再現はしておらぬ。
- 修正案: 再送が N 回（または一定時間）unknown のままなら、警告つきの明示の取り下げ（2 段）を出す。可能なら操作ごとに「送らずに現在の状態を読む照合」を用意し、取り下げの前に保存済みかを示す。


## R42 掃除の「完了」は実施日を凍結せず、届いていなかった控えを日を跨いで再送すると再送日の実施として記録される
- 区分: unverified / 重大度 low / 確信度 medium / 観点 save-regression
- 場所: src/app/(main)/chores/cleaning/actions.ts:326
- 要件: X-09
- 原因: close の要求は実施日を持たず（設計上サーバーの今日を使う）、`closeOccurrence` は同じ ID の行が無い時に `doneOn = today`（再送を受けた時点の JST 今日）で書く。初回が届いておれば既存行の値で replayed になるが、届いておらぬ時は再送日の日付になる。
- 失敗シナリオ: 11/14 23:50 に期限超過の項目を「完了」→ 通信断で結果不明（未着）。翌朝「同じ操作で確認」→ 対象回と定義の版が変わっておらぬので成立し、done_on=11/15 で記録される。実施基準（after_done）の項目は次回の予定日が 1 日ずれる。画面は「完了にしました」とだけ出て、日付が押した日と違うことは伝わらぬ。
- 根拠: コードの読み: actions.ts:275-328（found.log が無い分岐で `doneOn = request.kind === "done" ? today : null`）、record_cleaning_log は p_done_on をそのまま保存（20261111100002:383）。実行での再現はしておらぬ。
- 修正案: 初回の送信時点の JST 日付を payload に固定して運び、サーバーは「今日以前・今日から 1〜2 日以内」だけ受ける。もしくは再送で日付が初回の送信日（firstAttemptAt）と違う時、成功の文に実施日を明示して履歴から直せることを伝える。


## R43 献立の確定が途中で止まった後の「同じ操作で確認」は必ず stale_plan の conflict になり（注記の「続きから進む」と逆）、確定済みの分の買い物同期も走らぬ
- 区分: unverified / 重大度 low / 確信度 medium / 観点 save-regression
- 場所: src/app/(main)/chores/meals/plan/actions.ts:1262
- 要件: X-09, V-SAVE
- 原因: `confirmDinnerPlan` は 1 品ずつ `save_dinner_entry` を呼び、各回が献立の版を +1 する。途中で失敗・例外になった後の再送は、まだ proposed が残るため 1262 行の `context.plan.revision !== request.expectedRevision` に必ず当たり conflict を返す（1239 行の注記「同じ操作のやり直しで続きから進む」は成立せぬ）。途中の失敗が rejected（SQLSTATE）の時は初回ゆえ控えが消え「保存されていない」と出るが、先頭の何品かは確定済みで、revalidate も買い物の同期も走っておらぬ。
- 失敗シナリオ: 7 日分（20 品前後）を確定中、10 品目でサーバーと DB の間の通信が切れる → 結果不明。再送 → 「別の端末が先に更新していました。上書きはしていません」（実際は自分の操作の途中）。9 品は確定済みだが買い物リストは未同期のまま。利用者が画面を読み直してもう一度「確定」を押せば残りが進み同期も走るので自己回復はするが、文言が事実と違い、買い物の画面は「古い可能性があります」の表示に頼ることになる。
- 根拠: コードの読み: actions.ts:1252-1287。saveEntry の成功ごとに `dinner_bump`（20261111100003:1167）で revision が進む。実行での再現はしておらぬ。
- 修正案: 確定を 1 トランザクションの RPC にまとめる（範囲・期待する版・対象の枠 ID と版の一覧を渡す）か、再送時は「要求の範囲内で、まだ proposed の枠だけを続きから確定」できるよう版の照合を枠ごとの版に寄せ、部分成立で終わった時も買い物の同期と revalidate を走らせる。


## R44 C-75: 「覚えた好み」（食後評価）は 7 日を過ぎると編集できず、設定画面には削除しか無い
- 区分: unverified / 重大度 medium / 確信度 high / 観点 completeness
- 場所: src/components/chores/meals/settings/settings-preferences.tsx:324
- 要件: C-75, C-73, V-C5
- 原因: 食後評価の編集 UI は献立の 1 品シート（src/components/chores/meals/plan/plan-entry-panel.tsx:199-258 の FeedbackForm）にしか無く、その入口は「画面に並んだ枠」だけ（src/app/(main)/chores/meals/plan/plan-page-data.ts:47-53 の shown）。献立の開始日は today-7 が下限（src/components/chores/meals/plan/plan-query.ts:21-23, DINNER_ENTRY_PAST_DAYS=7）。一方、評価は 180 日ぶん推薦に使われる（src/lib/meals/server/today.ts:20 FEEDBACK_WINDOW_DAYS）。設定画面の FeedbackList（settings-preferences.tsx:324-432）は onDelete だけで、編集の操作を持たない。Server Action saveDishFeedback 自体は過去日の更新を受け付ける（plan/actions.ts:1363-1407。未来日だけ拒否）ので、Action は在るが画面から到達できない。
- 失敗シナリオ: 11/1 に作った料理へ「苦手」と誤って評価 → 11/9 以降に気づく。献立の画面は 11/2 より前の枠を表示できず、設定の「覚えた好み」には削除ボタンしか無い。直すには削除するしかなく、削除後は評価し直す導線も無い（評価の入口は 7 日以内の献立の枠だけ）。同様に、評価後に「作った」を取り消して料理を差し替え・削除した場合も、その評価は編集不能になる。要件の「確認・編集・削除」のうち編集が、7 日を過ぎた評価では欠ける。
- 根拠: コード読解: settings-view.tsx:374-384 は FeedbackList に onDelete だけを渡す。plan-query.ts の resolvePlanStart は min 未満の start を today へ倒す。プラン側の feedbackByEntry は view.days に出た枠だけ。該当テスト（settings-view.test.tsx / plan-view.test.tsx）は緑だが、古い評価の編集を扱うテストは無い。
- 修正案: 設定の「覚えた好み」の自分の行に編集（味・手間・また食べたい・好みに反映しない）を足し、既存の saveDishFeedback（id と version つき）へ送る。あるいは最低限、編集できる期間を画面に明示する。


## R45 人数の変更が既存の献立へ反映されず、枠ごとに人数を直す操作も無い（固定枠・1 品差替えは旧人数のまま買い物が計算される）
- 区分: unverified / 重大度 medium / 確信度 high / 観点 completeness
- 場所: src/app/(main)/chores/meals/plan/actions.ts:969
- 要件: C-31, C-41, C-43, V-C3
- 原因: 人数は枠の作成時に写して保存し、以後は枠の値を使う。設定の保存（settings/actions.ts:80-126 saveDinnerSettings）は既存の枠に触れない。全体の作り直しは固定枠・作った枠を送らない（plan/actions.ts:695-696）。1 品差替えは entryInputOf(target, …) で同じ行の人数を引き継ぐ（plan/actions.ts:969-984、コメントも「同じ人数」）。枠の人数を変える UI は無い（plan-day-card.tsx:110 は表示のみ。plan-custom-dish-form.tsx は servings を送らない）。generateDinnerPlan の request.servings（actions.ts:832）と saveCustomDish の request.servings（actions.ts:1204,1218）は受け口が在るが、画面（plan-view.tsx:166-177）から送られない。
- 失敗シナリオ: 初回ユーザーが標準 2 人分で 7 日分を作り「金曜はカレー」を固定 → 設定で人数を 4 人に変更。献立の作成カードは「人数: 4人分」と出るが、固定したカレーは 2人分のまま残り、作り直しても変わらない。固定していない料理も「差し替え」（1 品）で替えた場合は 2人分のまま。買い物リストはその枠の人数（2 人分）で計算され、レシピ詳細は世帯の人数（4 人分）で材料を出すので、買う量が黙って半分になる。直すには固定を解除して料理ごと差し替える（=固定した料理を失う）か、希望文で固定し直すしかない。
- 根拠: コード読解（上記の行）。grep で src/components/chores/meals/plan 配下の servings の出現は表示 2 箇所だけ。planner.ts:843 は既存枠の servings を優先。該当の単体テスト（人数を増やすと必要量も増える・人数変更は元レシピ量から一度だけ）は純関数の検証で、設定変更後の既存枠の扱いを確かめるテストは無い。
- 修正案: 1 品シートに人数の変更（saveEntry で servings だけ更新。版つき）を足す。あわせて、設定の人数と違う人数の提案・確定枠が在るときに献立画面で件数を知らせる（勝手には書き換えない）。1 品差替えは世帯の現在の人数で作り直すか、どちらの人数かを明示する。


## R46 C-65: 週間献立・今夜の画面では 1 歳未満のはちみつ等の年齢制約が出ない（在庫提案とレシピ詳細にだけ出る）
- 区分: unverified / 重大度 medium / 確信度 medium / 観点 completeness
- 場所: src/lib/meals/server/plan-views.ts:157
- 要件: C-65, C-64, V-C4
- 原因: 年齢制約の警告（findAgeRuleWarnings）を呼ぶのは「今あるもので」（src/lib/meals/server/views.ts:473-502）とレシピ詳細（views.ts:874-899）だけ。献立の表示型 DinnerEntryView（plan-views.ts:157-183）に年齢制約の項目が無く、献立ページは子どもを読み込みもしない（src/app/(main)/chores/meals/plan/plan-page-data.ts:36 PLAN_PAGE_PARTS に children が無い）。planner.ts / suggest-now.ts にも子どもの入力は無く、はちみつ料理は通常の候補として選ばれる。
- 失敗シナリオ: 生後 8 か月の子がいる世帯で 7 日分を作る → 副菜に「さつまいものはちみつレモン煮」（src/lib/meals/catalog/recipes.ts:1208-1227、honey に ageRule 12 か月）が入りうる。献立のカードと「今夜」には何の注意も出ず、確定→買い物→「作った」まで進める。同じ料理は「今あるもので」では赤い注意つきで出るため、画面によって安全上の注意の有無が食い違う。手動料理に材料としてはちみつを足した場合も同じ。
- 根拠: grep: ageWarning / findAgeRuleWarnings / children は plan-views.ts・planner.ts・plan-page-data.ts・tonight-view.tsx・plan-day-card.tsx に 1 件も無い。child-serving.test.ts の C-65 のテストは純関数（警告を返すこと）だけで、献立の画面に出ることを確かめるテストは無い。要件の受け入れ手順（単体テスト）は満たしているため、要件未達というより提示面の欠落として medium。
- 修正案: 献立のビルド時に children を読み、枠ごとに findAgeRuleWarnings の結果を DinnerEntryView へ載せて PlanDayCard・今夜に「◯◯ちゃん（◯か月）には与えない」を出す（除外や置換はしない）。


## R47 B-04/B-05: 掃除の履歴は世帯全体の直近 300 件しか読まず、そこから外れた記録は訂正・取り消しの導線が無くなる
- 区分: unverified / 重大度 medium / 確信度 medium / 観点 completeness
- 場所: src/app/(main)/chores/cleaning/page.tsx:51
- 要件: B-04, B-05, B-01
- 原因: 履歴は項目を絞らず世帯全体を created_at 降順で CLEANING_LOG_LIMIT=300 件（src/lib/domain/cleaning.ts:44）だけ取得し、項目の詳細はその中から routine_id で絞る（cleaning-view.tsx:279-283）。前回実施日は別の要約 RPC（cleaning_log_marks）から出るので表示は正しいが、訂正・取り消しのボタンは一覧に載った行にしか無い（cleaning-item-detail.tsx:321-436）。載っていない時は「直近の履歴の中に、この項目の記録は見つかりませんでした。古い記録は表示していません。」（同 314-319）と出るだけ。
- 失敗シナリオ: 週次の項目が 7 個ある世帯は年 364 件の履歴が溜まる。年 1 回の「換気扇」を 1 月に完了（日付を誤って記録）→ 11 月頃には その記録が直近 300 件から外れる。詳細には「前回 1/10」と出るのに履歴は空で、実施日の訂正も取り消しもできない（＝前回実施日・次回予定を直せない）。年次・半年ごとの項目ほど起きる。
- 根拠: コード読解（上記の行）。cleaning-view.test.tsx / page.test.tsx に、上限を超えた世帯で対象項目の履歴を引けることを確かめるテストは無い（historyTruncated の文言表示のみ）。件数の前提は計算上のもので実データでは未確認のため confidence は medium。
- 修正案: 項目の詳細を開いた時にその項目の履歴を routine_id で別に取得する（例: 直近 20 件 + もっと見る）。少なくとも cleaning_log_marks が返す「前回実施の行」は常に訂正・取り消しできるよう、その行 ID と版を要約に含める。


## R48 「今あるもので」の候補・レシピ詳細から献立へ入れる操作が無く、在庫提案で選んだ料理は「作った」・食材更新・評価へ繋がらない
- 区分: unverified / 重大度 low / 確信度 high / 観点 completeness
- 場所: src/components/chores/meals/now/now-view.tsx:44
- 要件: C-23, C-37, C-74
- 原因: NowView はリンクだけの Server Component（now-view.tsx:44-138。操作はレシピ詳細へのリンクのみ）で、RecipeDetail（src/components/chores/meals/recipes/recipe-detail.tsx）にも献立へ入れる操作が無い。カタログの特定の料理を特定の日に置く経路は、献立の希望文（例「今日は肉じゃが」→ wish-rules の固定）か、偶然の差し替えだけ。「作った」・料理後の食材更新・食後評価は献立の枠にしか付かない（plan-entry-panel.tsx）。
- 失敗シナリオ: 「今あるもので」で揃う 3 案の 1 つを選んで作る → その料理を「作った」にして食材を「使い切った」にする・評価を付けるには、献立画面へ移って希望欄に料理名を打ち直し、当日 1 日分を作り直す必要がある（その日の固定していない他の料理も作り直される）。手順を知らなければ、在庫提案由来の料理は評価が残らず次の提案へ反映されない。
- 根拠: コード読解。now-view.tsx に Server Action の import・ボタンは無い。grep で saveDinnerRequest を呼ぶのは plan/shopping の画面だけ。要件は直接の導線を明記していないため low。
- 修正案: 候補カードとレシピ詳細に「今日の献立に入れる」（既存の generate の pins か saveEntry を使う 1 品追加。除外・版の再検証つき）を足す。
