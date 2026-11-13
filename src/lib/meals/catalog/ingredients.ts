/**
 * 食材辞書（コード同梱の正本）。
 *
 * 境界指令を持たない中立モジュール。DB へ seed しない。出所は Irori 独自作成。
 *
 * 別名（aliases）の規則:
 * - 入れるのは表記ゆれだけ（ひらがな・カタカナ・漢字、送り仮名、一般的な呼び方の違い）。
 * - 部位・加工品・似た名前は別名にしない。別の ID を立て、由来は `derivedFrom` で表す
 *   （豚こま ≠ 豚バラ、ツナ缶 ≠ まぐろ、木綿豆腐 ≠ 絹ごし豆腐）。
 * - 「ねぎ」「豆腐」「ひき肉」のように複数の食材を指しうる語は、どの別名にも入れない。
 * - かな畳み込み（カタカナ → ひらがな）をしても、別の食材と衝突しないこと
 *   （例: 鮭の別名「さけ」があるため、酒の別名に「さけ」を入れない）。
 *
 * アレルゲンの規則:
 * - `known`: 生鮮品・単一原料の食品・組成が定まった基礎調味料。一般的な製品に含まれうる
 *   ものは安全側に含める（例: サラダ油 → 大豆。大豆油を配合した製品が多いため）。
 * - `varies`: 商品によって原材料が異なる複合的な加工品。`allergens` には一般に含むことが
 *   多いものだけを書く。書いていないアレルゲンを「含まない」と読んではならない。
 * - 製造時の混入（コンタミネーション）は表していない。
 */
import type { IngredientDef, StoreSection } from "@/lib/meals/types"
import type { CatalogAllergenId } from "@/lib/meals/catalog/allergens"

interface IngredientOptions {
  aliases?: readonly string[]
  allergens?: readonly CatalogAllergenId[]
  /** 商品によって原材料が異なる加工品。 */
  varies?: boolean
  derivedFrom?: readonly string[]
  /** 精製品の由来（アレルギーの除外だけを及ぼす。苦手には及ぼさない）。 */
  refinedFrom?: readonly string[]
  /**
   * アレルギーとしてこの食材を登録したとき、同じアレルゲンを含む他の食材へ広げる対象。
   * 素の食材は省略する（`allergens` の全てへ広げる）。原因の成分を 1 つに決められない
   * 加工品だけ、ここで絞る。
   */
  allergySpread?: readonly CatalogAllergenId[]
  /** 部位・種類の総称（レシピの材料には使わない）。 */
  generic?: boolean
  /** 常備品の候補として提示してよい。 */
  staple?: boolean
  ageRule?: IngredientDef["ageRule"]
}

function def<const Id extends string>(
  id: Id,
  name: string,
  section: StoreSection,
  options: IngredientOptions = {},
): IngredientDef & { id: Id } {
  return {
    id,
    name,
    aliases: options.aliases ?? [],
    section,
    allergens: options.allergens ?? [],
    allergenInfo: options.varies ? "varies" : "known",
    ...(options.derivedFrom ? { derivedFrom: options.derivedFrom } : {}),
    ...(options.refinedFrom ? { refinedFrom: options.refinedFrom } : {}),
    ...(options.allergySpread ? { allergySpread: options.allergySpread } : {}),
    ...(options.generic ? { generic: true } : {}),
    ...(options.staple ? { stapleCandidate: true } : {}),
    ...(options.ageRule ? { ageRule: options.ageRule } : {}),
  }
}

const INGREDIENT_DATA = [
  // ── 野菜・きのこ・果物 ───────────────────────────────────────────
  def("onion", "玉ねぎ", "vegetable", { aliases: ["たまねぎ", "タマネギ", "玉葱", "玉ネギ"] }),
  def("carrot", "にんじん", "vegetable", { aliases: ["人参", "ニンジン"] }),
  def("potato", "じゃがいも", "vegetable", { aliases: ["ジャガイモ", "じゃが芋", "馬鈴薯"] }),
  def("cabbage", "キャベツ", "vegetable", { aliases: ["きゃべつ"] }),
  def("napa_cabbage", "白菜", "vegetable", { aliases: ["はくさい", "ハクサイ"] }),
  def("daikon", "大根", "vegetable", { aliases: ["だいこん", "ダイコン"] }),
  def("turnip", "かぶ", "vegetable", { aliases: ["カブ", "蕪"] }),
  def("spinach", "ほうれん草", "vegetable", { aliases: ["ほうれんそう", "ホウレンソウ", "ホウレン草"] }),
  def("komatsuna", "小松菜", "vegetable", { aliases: ["こまつな", "コマツナ"] }),
  def("chingensai", "チンゲン菜", "vegetable", { aliases: ["ちんげん菜", "チンゲンサイ", "青梗菜"] }),
  def("mizuna", "水菜", "vegetable", { aliases: ["みずな", "ミズナ"] }),
  def("lettuce", "レタス", "vegetable", { aliases: ["れたす"] }),
  def("broccoli", "ブロッコリー", "vegetable", { aliases: ["ぶろっこりー"] }),
  def("green_pepper", "ピーマン", "vegetable", { aliases: ["ぴーまん"] }),
  def("bell_pepper", "パプリカ", "vegetable", { aliases: ["ぱぷりか"] }),
  def("eggplant", "なす", "vegetable", { aliases: ["ナス", "茄子", "なすび"] }),
  def("tomato", "トマト", "vegetable", { aliases: ["とまと"] }),
  // トマトの除外（苦手・アレルギー）はミニトマトにも及ぼす（逆向きには及ぼさない）。
  def("cherry_tomato", "ミニトマト", "vegetable", { aliases: ["プチトマト", "みにとまと"], derivedFrom: ["tomato"] }),
  def("cucumber", "きゅうり", "vegetable", { aliases: ["キュウリ", "胡瓜"] }),
  def("bean_sprouts", "もやし", "vegetable", { aliases: ["モヤシ"] }),
  def("long_onion", "長ねぎ", "vegetable", { aliases: ["長ネギ", "長葱", "白ねぎ", "白ネギ"] }),
  def("green_onion", "小ねぎ", "vegetable", { aliases: ["小ネギ", "小葱", "万能ねぎ", "万能ネギ", "細ねぎ"] }),
  def("garlic_chive", "にら", "vegetable", { aliases: ["ニラ", "韮"] }),
  def("kabocha", "かぼちゃ", "vegetable", { aliases: ["カボチャ", "南瓜"] }),
  def("sweet_potato", "さつまいも", "vegetable", { aliases: ["サツマイモ", "さつま芋", "薩摩芋"] }),
  def("taro", "里いも", "vegetable", { aliases: ["里芋", "さといも", "サトイモ"] }),
  def("nagaimo", "長いも", "vegetable", { aliases: ["長芋", "ながいも", "ナガイモ"], allergens: ["yam"] }),
  def("burdock", "ごぼう", "vegetable", { aliases: ["ゴボウ", "牛蒡"] }),
  def("lotus_root", "れんこん", "vegetable", { aliases: ["レンコン", "蓮根"] }),
  def("okra", "オクラ", "vegetable", { aliases: ["おくら"] }),
  def("asparagus", "アスパラガス", "vegetable", { aliases: ["アスパラ", "あすぱらがす"] }),
  def("green_beans", "いんげん", "vegetable", { aliases: ["インゲン", "さやいんげん", "サヤインゲン"] }),
  def("edamame", "枝豆", "vegetable", { aliases: ["えだまめ", "エダマメ"], allergens: ["soybean"], derivedFrom: ["soybean"] }),
  def("corn", "とうもろこし", "vegetable", { aliases: ["トウモロコシ", "玉蜀黍"] }),
  def("ginger", "しょうが", "vegetable", { aliases: ["ショウガ", "生姜"] }),
  def("garlic", "にんにく", "vegetable", { aliases: ["ニンニク", "大蒜"] }),
  def("shiso", "大葉", "vegetable", { aliases: ["おおば", "青じそ", "青ジソ", "青紫蘇"] }),
  // 総称の「きのこ」（豚肉・鶏肉と同じ扱い）。「きのこが苦手」の除外を各きのこへ及ぼすために置く。
  // レシピの材料には使わない。在庫に総称で入っても種類とは同一視せず、きのこを使う料理の材料は
  // 「確認が必要」へ回す（`generic`）。
  def("mushroom", "きのこ", "vegetable", { aliases: ["キノコ", "茸", "きのこ類"], generic: true }),
  def("shiitake", "しいたけ", "vegetable", { aliases: ["シイタケ", "椎茸", "生しいたけ"], derivedFrom: ["mushroom"] }),
  def("shimeji", "しめじ", "vegetable", { aliases: ["シメジ", "ぶなしめじ", "ブナシメジ"], derivedFrom: ["mushroom"] }),
  def("enoki", "えのき", "vegetable", { aliases: ["エノキ", "えのきたけ", "えのきだけ", "えのき茸"], derivedFrom: ["mushroom"] }),
  def("maitake", "まいたけ", "vegetable", { aliases: ["マイタケ", "舞茸"], derivedFrom: ["mushroom"] }),
  def("eringi", "エリンギ", "vegetable", { aliases: ["えりんぎ"], derivedFrom: ["mushroom"] }),
  def("lemon", "レモン", "vegetable", { aliases: ["れもん", "檸檬"] }),
  def("apple", "りんご", "vegetable", { aliases: ["リンゴ", "林檎"], allergens: ["apple"] }),
  def("banana", "バナナ", "vegetable", { aliases: ["ばなな"], allergens: ["banana"] }),
  def("kiwi", "キウイ", "vegetable", { aliases: ["キウイフルーツ", "きうい"], allergens: ["kiwifruit"] }),
  def("orange", "オレンジ", "vegetable", { aliases: ["おれんじ"], allergens: ["orange"] }),
  def("peach", "桃", "vegetable", { aliases: ["もも", "モモ"], allergens: ["peach"] }),

  // ── 肉・肉加工品 ─────────────────────────────────────────────────
  // 「鶏肉」「豚肉」「牛肉」は総称（`generic`）。部位は別の ID で、在庫の総称を部位と同一視しない。
  def("chicken", "鶏肉", "meat", { aliases: ["とり肉", "とりにく", "鶏にく", "チキン"], allergens: ["chicken"], generic: true }),
  def("chicken_thigh", "鶏もも肉", "meat", { aliases: ["鶏モモ肉", "鶏もも", "鶏腿肉", "とりもも肉", "とりもも"], allergens: ["chicken"], derivedFrom: ["chicken"] }),
  def("chicken_breast", "鶏むね肉", "meat", { aliases: ["鶏ムネ肉", "鶏むね", "鶏胸肉", "とりむね肉", "とりむね"], allergens: ["chicken"], derivedFrom: ["chicken"] }),
  def("chicken_tender", "鶏ささみ", "meat", { aliases: ["ささみ", "ササミ", "鶏ササミ", "笹身"], allergens: ["chicken"], derivedFrom: ["chicken"] }),
  def("chicken_drumette", "鶏手羽元", "meat", { aliases: ["手羽元", "鶏の手羽元"], allergens: ["chicken"], derivedFrom: ["chicken"] }),
  def("ground_chicken", "鶏ひき肉", "meat", { aliases: ["鶏挽き肉", "鶏挽肉", "鶏ひき", "鶏ミンチ", "とりひき肉"], allergens: ["chicken"], derivedFrom: ["chicken"] }),
  def("pork", "豚肉", "meat", { aliases: ["ぶた肉", "ぶたにく", "ポーク"], allergens: ["pork"], generic: true }),
  def("pork_komagire", "豚こま切れ肉", "meat", { aliases: ["豚こま", "豚コマ", "豚こま肉", "豚こま切れ", "豚小間切れ肉", "豚小間"], allergens: ["pork"], derivedFrom: ["pork"] }),
  def("pork_belly_slice", "豚バラ薄切り肉", "meat", { aliases: ["豚バラ", "豚バラ肉", "豚ばら", "豚ばら肉", "豚バラ薄切り", "豚ばら薄切り肉"], allergens: ["pork"], derivedFrom: ["pork"] }),
  def("pork_loin_slice", "豚ロース薄切り肉", "meat", { aliases: ["豚ロース", "豚ロース肉", "豚ロース薄切り", "豚ろーす"], allergens: ["pork"], derivedFrom: ["pork"] }),
  def("ground_pork", "豚ひき肉", "meat", { aliases: ["豚挽き肉", "豚挽肉", "豚ひき", "豚ミンチ"], allergens: ["pork"], derivedFrom: ["pork"] }),
  def("beef", "牛肉", "meat", { aliases: ["ぎゅうにく", "ビーフ"], allergens: ["beef"], generic: true }),
  def("beef_komagire", "牛こま切れ肉", "meat", { aliases: ["牛こま", "牛コマ", "牛こま肉", "牛こま切れ", "牛小間切れ肉", "牛小間"], allergens: ["beef"], derivedFrom: ["beef"] }),
  def("beef_thin_slice", "牛薄切り肉", "meat", { aliases: ["牛薄切り", "牛うす切り肉", "牛肉薄切り"], allergens: ["beef"], derivedFrom: ["beef"] }),
  def("ground_mixed", "合いびき肉", "meat", { aliases: ["合挽き肉", "合い挽き肉", "合びき肉", "合挽肉", "合いびき"], allergens: ["beef", "pork"], derivedFrom: ["beef", "pork"] }),
  def("bacon", "ベーコン", "meat", { aliases: ["べーこん"], allergens: ["pork"], varies: true, derivedFrom: ["pork"] }),
  def("ham", "ハム", "meat", { aliases: ["はむ", "ロースハム"], allergens: ["pork"], varies: true, derivedFrom: ["pork"] }),
  def("wiener", "ウインナー", "meat", { aliases: ["ウィンナー", "ういんなー", "ウインナーソーセージ", "ソーセージ"], allergens: ["pork"], varies: true, derivedFrom: ["pork"] }),

  // ── 魚・魚加工品 ─────────────────────────────────────────────────
  def("salmon", "鮭", "fish", { aliases: ["さけ", "サケ", "しゃけ", "シャケ", "生鮭", "生さけ"], allergens: ["salmon"] }),
  def("salted_salmon", "塩鮭", "fish", { aliases: ["塩さけ", "塩ざけ", "塩じゃけ"], allergens: ["salmon"], derivedFrom: ["salmon"] }),
  def("mackerel", "さば", "fish", { aliases: ["サバ", "鯖", "生さば"], allergens: ["mackerel"] }),
  def("saba_can", "さば缶", "fish", { aliases: ["サバ缶", "鯖缶", "さば水煮缶", "サバ水煮缶"], allergens: ["mackerel"], varies: true, derivedFrom: ["mackerel"] }),
  def("horse_mackerel", "あじ", "fish", { aliases: ["アジ", "鯵"] }),
  def("yellowtail", "ぶり", "fish", { aliases: ["ブリ", "鰤"] }),
  def("cod", "たら", "fish", { aliases: ["タラ", "鱈", "生たら", "真だら"] }),
  def("tuna", "まぐろ", "fish", { aliases: ["マグロ", "鮪"] }),
  def("bonito", "かつお", "fish", { aliases: ["カツオ", "鰹"] }),
  def("tuna_can", "ツナ缶", "fish", { aliases: ["ツナ", "つな缶"], allergens: ["soybean"], varies: true, derivedFrom: ["tuna", "bonito"] }),
  def("shrimp", "えび", "fish", { aliases: ["エビ", "海老", "むきえび", "むきエビ"], allergens: ["shrimp"] }),
  def("squid", "いか", "fish", { aliases: ["イカ", "烏賊"], allergens: ["squid"] }),
  def("asari", "あさり", "fish", { aliases: ["アサリ", "浅蜊"] }),
  def("shirasu", "しらす", "fish", { aliases: ["シラス", "しらす干し", "シラス干し"] }),
  def("chikuwa", "ちくわ", "fish", { aliases: ["チクワ", "竹輪"], allergens: ["egg", "wheat"], varies: true }),
  def("kamaboko", "かまぼこ", "fish", { aliases: ["カマボコ", "蒲鉾"], allergens: ["egg"], varies: true }),
  def("satsuma_age", "さつま揚げ", "fish", { aliases: ["さつまあげ", "薩摩揚げ"], varies: true }),
  def("crab_stick", "かに風味かまぼこ", "fish", { aliases: ["カニカマ", "かにかま", "カニ風味かまぼこ"], allergens: ["crab", "egg", "wheat"], varies: true }),

  // ── 卵・乳製品 ───────────────────────────────────────────────────
  def("egg", "卵", "egg_dairy", { aliases: ["たまご", "タマゴ", "玉子", "鶏卵"], allergens: ["egg"] }),
  def("milk", "牛乳", "egg_dairy", { aliases: ["ぎゅうにゅう", "ミルク"], allergens: ["milk"] }),
  def("butter", "バター", "egg_dairy", { aliases: ["ばたー", "有塩バター"], allergens: ["milk"], derivedFrom: ["milk"], staple: true }),
  def("sliced_cheese", "スライスチーズ", "egg_dairy", { aliases: ["すらいすちーず"], allergens: ["milk"], derivedFrom: ["milk"] }),
  def("pizza_cheese", "ピザ用チーズ", "egg_dairy", { aliases: ["ピザチーズ", "シュレッドチーズ", "ミックスチーズ"], allergens: ["milk"], derivedFrom: ["milk"] }),
  def("powdered_cheese", "粉チーズ", "egg_dairy", { aliases: ["粉ちーず", "パルメザンチーズ"], allergens: ["milk"], derivedFrom: ["milk"] }),
  def("yogurt", "ヨーグルト", "egg_dairy", { aliases: ["よーぐると", "プレーンヨーグルト"], allergens: ["milk"], varies: true, derivedFrom: ["milk"] }),
  def("fresh_cream", "生クリーム", "egg_dairy", { aliases: ["なまクリーム"], allergens: ["milk"], derivedFrom: ["milk"] }),

  // ── 豆腐・大豆製品 ───────────────────────────────────────────────
  def("soybean", "大豆", "soy", { aliases: ["だいず", "ダイズ", "大豆の水煮"], allergens: ["soybean"] }),
  def("tofu_momen", "木綿豆腐", "soy", { aliases: ["もめん豆腐", "木綿どうふ", "木綿とうふ", "もめんどうふ"], allergens: ["soybean"], derivedFrom: ["soybean"] }),
  def("tofu_kinu", "絹ごし豆腐", "soy", { aliases: ["絹豆腐", "絹どうふ", "絹とうふ", "きぬごし豆腐", "絹ごしどうふ"], allergens: ["soybean"], derivedFrom: ["soybean"] }),
  def("aburaage", "油揚げ", "soy", { aliases: ["油あげ", "あぶらあげ", "薄揚げ", "うすあげ"], allergens: ["soybean"], derivedFrom: ["soybean"] }),
  def("atsuage", "厚揚げ", "soy", { aliases: ["厚あげ", "あつあげ", "生揚げ"], allergens: ["soybean"], derivedFrom: ["soybean"] }),
  def("natto", "納豆", "soy", { aliases: ["なっとう", "ナットウ"], allergens: ["soybean"], varies: true, derivedFrom: ["soybean"] }),
  def("soy_milk", "豆乳", "soy", { aliases: ["とうにゅう", "無調整豆乳"], allergens: ["soybean"], derivedFrom: ["soybean"] }),
  def("koya_tofu", "高野豆腐", "soy", { aliases: ["こうや豆腐", "こうやどうふ", "凍り豆腐"], allergens: ["soybean"], derivedFrom: ["soybean"] }),

  // ── 米・麺・パン ─────────────────────────────────────────────────
  def("rice", "米", "staple", { aliases: ["お米", "こめ", "白米", "精白米"], staple: true }),
  def("udon", "うどん", "staple", { aliases: ["ウドン", "饂飩", "ゆでうどん", "冷凍うどん"], allergens: ["wheat"], derivedFrom: ["wheat_flour"] }),
  // つなぎの小麦を含む製品が多いので小麦も持つ。ただし「そば」のアレルギー登録を小麦へは広げない
  // （小麦アレルギーは「小麦」で登録する。広げると、しょうゆを使う料理が全て外れる）。
  def("soba", "そば", "staple", { aliases: ["ソバ", "蕎麦", "日本そば"], allergens: ["buckwheat", "wheat"], allergySpread: ["buckwheat"] }),
  def("somen", "そうめん", "staple", { aliases: ["ソーメン", "そーめん", "素麺"], allergens: ["wheat"], derivedFrom: ["wheat_flour"] }),
  def("spaghetti", "スパゲッティ", "staple", { aliases: ["スパゲティ", "スパゲッティー", "パスタ"], allergens: ["wheat"], derivedFrom: ["wheat_flour"] }),
  def("macaroni", "マカロニ", "staple", { aliases: ["まかろに"], allergens: ["wheat"], derivedFrom: ["wheat_flour"] }),
  def("chinese_noodles", "中華蒸し麺", "staple", { aliases: ["蒸し中華麺", "焼きそば麺", "焼そば麺", "焼きそば用麺"], allergens: ["wheat"], varies: true, derivedFrom: ["wheat_flour"] }),
  def("bread", "食パン", "staple", { aliases: ["しょくぱん", "食ぱん"], allergens: ["wheat", "milk"], varies: true, derivedFrom: ["wheat_flour"] }),
  def("mochi", "切り餅", "staple", { aliases: ["餅", "もち", "お餅", "切りもち", "切餅"] }),

  // ── 調味料・粉類 ─────────────────────────────────────────────────
  def("soy_sauce", "しょうゆ", "seasoning", { aliases: ["醤油", "正油", "しょう油", "濃口しょうゆ", "濃口醤油"], allergens: ["wheat", "soybean"], derivedFrom: ["soybean"], staple: true }),
  def("miso", "みそ", "seasoning", { aliases: ["味噌", "ミソ", "合わせみそ", "合わせ味噌"], allergens: ["soybean"], derivedFrom: ["soybean"], staple: true }),
  def("salt", "塩", "seasoning", { aliases: ["しお", "食塩"], staple: true }),
  def("sugar", "砂糖", "seasoning", { aliases: ["さとう", "上白糖", "白砂糖"], staple: true }),
  def("mirin", "みりん", "seasoning", { aliases: ["ミリン", "味醂", "本みりん"], staple: true }),
  def("sake", "酒", "seasoning", { aliases: ["料理酒", "清酒", "日本酒"], staple: true }),
  // 穀物酢は小麦を原料に含む製品が多く、米酢・果実酢など原料が種類で変わる。
  def("vinegar", "酢", "seasoning", { aliases: ["お酢", "穀物酢", "米酢"], allergens: ["wheat"], varies: true, staple: true }),
  // 大豆油を配合した製品が多いため、安全側に大豆を含める（大豆アレルギーではサラダ油の料理も外す）。
  // 逆に「サラダ油」のアレルギー登録を大豆へは広げない（配合油で、原因の成分を大豆とは決められない）。
  def("salad_oil", "サラダ油", "seasoning", { aliases: ["サラダオイル", "サラダあぶら"], allergens: ["soybean"], allergySpread: [], staple: true }),
  def("sesame_oil", "ごま油", "seasoning", { aliases: ["ゴマ油", "胡麻油", "ごまあぶら"], allergens: ["sesame"], derivedFrom: ["sesame_seeds"], staple: true }),
  def("olive_oil", "オリーブオイル", "seasoning", { aliases: ["オリーブ油", "おりーぶおいる"], staple: true }),
  // 米ぬかだけを原料にした油を指す（大豆油などを配合した調合油は「サラダ油」）。
  // 大豆・小麦の除外がある世帯でも炒め物・焼き物の候補が残るよう、塩味のレシピはこの油で書く。
  def("rice_oil", "こめ油", "seasoning", { aliases: ["米油", "こめあぶら", "米ぬか油"], staple: true }),
  def("pepper", "こしょう", "seasoning", { aliases: ["コショウ", "コショー", "胡椒"], staple: true }),
  // じゃがいものでんぷんを精製したもの。じゃがいもが「苦手」でも片栗粉を使うだけの料理は外さず、
  // 「アレルギー」のときだけ及ぼす（`refinedFrom`）。
  def("katakuriko", "片栗粉", "seasoning", { aliases: ["かたくり粉", "かたくりこ"], refinedFrom: ["potato"], staple: true }),
  def("wheat_flour", "小麦粉", "seasoning", { aliases: ["こむぎこ", "薄力粉"], allergens: ["wheat"], staple: true }),
  def("panko", "パン粉", "seasoning", { aliases: ["ぱん粉", "パンこ"], allergens: ["wheat"], varies: true, derivedFrom: ["wheat_flour"] }),
  def("mayonnaise", "マヨネーズ", "seasoning", { aliases: ["まよねーず", "マヨ"], allergens: ["egg", "soybean"], varies: true, derivedFrom: ["egg"], staple: true }),
  def("ketchup", "ケチャップ", "seasoning", { aliases: ["けちゃっぷ", "トマトケチャップ"], varies: true, derivedFrom: ["tomato"], staple: true }),
  def("worcester_sauce", "ウスターソース", "seasoning", { aliases: ["うすたーそーす", "ウスター"], allergens: ["apple"], varies: true }),
  def("chuno_sauce", "中濃ソース", "seasoning", { aliases: ["ちゅうのうソース", "中濃"], allergens: ["apple"], varies: true }),
  def("oyster_sauce", "オイスターソース", "seasoning", { aliases: ["おいすたーそーす"], allergens: ["wheat", "soybean"], varies: true }),
  def("mentsuyu", "めんつゆ", "seasoning", { aliases: ["麺つゆ", "メンツユ"], allergens: ["wheat", "soybean"], varies: true }),
  def("ponzu", "ポン酢", "seasoning", { aliases: ["ぽん酢", "ポン酢しょうゆ", "ぽん酢しょうゆ"], allergens: ["wheat", "soybean"], varies: true }),
  def("yakiniku_tare", "焼肉のたれ", "seasoning", { aliases: ["焼き肉のたれ", "焼肉のタレ", "焼き肉のタレ"], allergens: ["wheat", "soybean", "sesame", "apple"], varies: true }),
  def("dashi_granules", "顆粒だし", "seasoning", { aliases: ["顆粒和風だし", "和風だしの素", "だしの素"], varies: true }),
  def("consomme", "コンソメ", "seasoning", { aliases: ["顆粒コンソメ", "固形コンソメ", "コンソメの素"], allergens: ["wheat", "milk", "soybean"], varies: true }),
  def("chicken_stock_granules", "鶏がらスープの素", "seasoning", { aliases: ["鶏ガラスープの素", "顆粒鶏がらスープ", "鶏がらスープ"], allergens: ["chicken"], varies: true }),
  def("curry_roux", "カレールウ", "seasoning", { aliases: ["カレールー", "カレーのルウ", "カレーのルー"], allergens: ["wheat", "milk", "soybean"], varies: true }),
  def("stew_roux", "シチュールウ", "seasoning", { aliases: ["シチュールー", "クリームシチューのルウ", "クリームシチューのルー"], allergens: ["wheat", "milk"], varies: true }),
  def("curry_powder", "カレー粉", "seasoning", { aliases: ["カレーパウダー"] }),
  def("doubanjiang", "豆板醤", "seasoning", { aliases: ["トウバンジャン", "とうばんじゃん"], allergens: ["soybean"], varies: true }),
  // 年齢制約の根拠は child-guidance.ts の出典表（厚生労働省のリーフレット）。加熱しても対象から外れない。
  def("honey", "はちみつ", "seasoning", { aliases: ["ハチミツ", "蜂蜜"], ageRule: { minAgeMonths: 12, sourceId: "mhlw_honey_leaflet" } }),
  def("sesame_seeds", "いりごま", "seasoning", { aliases: ["ごま", "ゴマ", "胡麻", "白ごま", "炒りごま", "煎りごま", "白いりごま"], allergens: ["sesame"], staple: true }),
  def("ground_sesame", "すりごま", "seasoning", { aliases: ["すりゴマ", "すり胡麻", "白すりごま"], allergens: ["sesame"], derivedFrom: ["sesame_seeds"] }),

  // ── 乾物・缶詰・その他 ───────────────────────────────────────────
  // 「削り節」は別名にしない（さば節などを混ぜた製品があるため）。
  def("katsuobushi", "かつお節", "other", { aliases: ["かつおぶし", "鰹節", "かつお削り節", "花かつお"], derivedFrom: ["bonito"], staple: true }),
  def("kombu", "昆布", "other", { aliases: ["こんぶ", "コンブ", "だし昆布", "出汁昆布"] }),
  def("wakame", "乾燥わかめ", "other", { aliases: ["わかめ", "ワカメ", "若布", "乾燥ワカメ", "カットわかめ"] }),
  def("nori", "焼きのり", "other", { aliases: ["のり", "海苔", "焼のり", "焼き海苔"] }),
  def("hijiki", "乾燥ひじき", "other", { aliases: ["ひじき", "ヒジキ", "芽ひじき"] }),
  def("kiriboshi_daikon", "切り干し大根", "other", { aliases: ["切干大根", "切干し大根", "きりぼし大根"], derivedFrom: ["daikon"] }),
  def("dried_shiitake", "干ししいたけ", "other", { aliases: ["干し椎茸", "干しシイタケ", "乾しいたけ"], derivedFrom: ["shiitake"] }),
  def("harusame", "春雨", "other", { aliases: ["はるさめ", "ハルサメ"] }),
  def("konnyaku", "こんにゃく", "other", { aliases: ["コンニャク", "蒟蒻", "板こんにゃく"] }),
  def("shirataki", "しらたき", "other", { aliases: ["シラタキ", "白滝", "糸こんにゃく"], derivedFrom: ["konnyaku"] }),
  def("tomato_can", "トマト缶", "other", { aliases: ["カットトマト缶", "ホールトマト缶", "トマト水煮缶"], derivedFrom: ["tomato"] }),
  def("corn_can", "コーン缶", "other", { aliases: ["ホールコーン缶", "粒コーン缶"], derivedFrom: ["corn"] }),
  def("peanuts", "ピーナッツ", "other", { aliases: ["ピーナツ", "落花生", "らっかせい"], allergens: ["peanut"] }),
  def("almond", "アーモンド", "other", { aliases: ["あーもんど"], allergens: ["almond"] }),
  def("walnut", "くるみ", "other", { aliases: ["クルミ", "胡桃"], allergens: ["walnut"] }),
  def("gelatin", "粉ゼラチン", "other", { aliases: ["ゼラチン", "ぜらちん"], allergens: ["gelatin"] }),
  // はちみつ入りなど、商品によって原材料が大きく変わる。
  def("umeboshi", "梅干し", "other", { aliases: ["梅干", "梅ぼし", "うめぼし"], varies: true }),
  def("kimchi", "キムチ", "other", { aliases: ["きむち", "白菜キムチ"], varies: true, derivedFrom: ["napa_cabbage"] }),
]

/** 食材辞書に登録済みの ID（レシピの材料を型で検査するために使う）。 */
export type CatalogIngredientId = (typeof INGREDIENT_DATA)[number]["id"]

export const INGREDIENTS: readonly IngredientDef[] = INGREDIENT_DATA
