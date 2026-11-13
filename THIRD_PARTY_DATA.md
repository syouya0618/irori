# Third-party data

The MIT license covers irori's code. It does not assert ownership of third-party facts, publications, or trademarks.

## Japanese infant/young child growth reference (2023 survey)

- Provider: Children and Families Agency, Japan (こども家庭庁).
- Source: [令和5年乳幼児身体発育調査](https://www.cfa.go.jp/policies/boshihoken/r5-nyuuyoujityousa/), released 2024-12-25.
- Numeric tables: [調査結果の概要, tables 1 and 2, pages 1–2](https://www.cfa.go.jp/assets/contents/node/basic_page/field_ref_resources/b32105e4-fa26-42eb-97d0-2e5cbaef703a/25a6391e/20241225_policies_boshihoken_r5-nyuuyoujityousa_10.pdf).
- Terms checked 2026-10-31: [agency copyright policy](https://www.cfa.go.jp/copyright-policy), [Public Data License 1.0](https://www.digital.go.jp/resources/open_data/public_data_license_v1.0). PDL section 1 excludes numerical data and simple tables from copyright protection and allows their free use; section 1.1 describes attribution and identification of modifications. No separate third-party right is indicated for these numeric tables. No photographs, original charts, logo or publication layout are bundled.
- Bundled file: `src/lib/data/japan-growth-2023.json`. Transcribed numerical values for seven percentiles, by sex, weight (kg) and length/height (cm). irori selected published bins from one month to under 78 months and renders rectangles/steps. Other neonatal/day-specific values are not included. No interpolation, unknown values, z-score conversion or percentile diagnosis is inferred.
- UI attribution: the agency's survey is linked and irori's processing is identified. No agency endorsement is implied. This population reference does not correct gestational age or replace medical assessment. Users choose the child's recorded sex and birth date; unknown settings suppress the reference.
- Reference changes must be reviewed against the official tables and terms, with version, numeric fixtures and attribution updated together.

## Household meals (2026-11): recipes, ingredient dictionary, allergen items, child-serving notes

Bundled under `src/lib/meals/catalog/`. Nothing in this section is seeded into the database; the catalog ships with the code.

### Recipes and ingredient dictionary (original to irori)

- `recipes.ts` (dinner recipes) and `ingredients.ts` (ingredient dictionary with aliases, store sections and structured allergen information) were written for irori. Every recipe carries `source.kind = "irori_original"`. No recipe text, photograph, nutrition table or brand data from a recipe site, book or app is bundled, and nothing is imported from an external recipe database at runtime.
- The catalog makes no nutrition claim and no claim of supervision by a dietitian or other professional. Nutrition values are not bundled.
- Allergen information on an ingredient is irori's own classification of that ingredient (including derived and processed ingredients). It is not product labelling: ingredients whose composition differs by product are marked as such and are excluded from automatic suggestions when a household has registered an allergy. The UI states that product-level ingredients and cross-contact cannot be judged.

### Allergen item list — Consumer Affairs Agency (消費者庁)

- Source: 消費者庁「食品表示基準について」（平成27年3月30日消食表第139号）別添 アレルゲンを含む食品に関する表示 — <https://www.caa.go.jp/policies/policy/food_labeling/food_labeling_act/assets/food_labeling_cms201_261001_07.pdf>.
- Bundled file: `allergens.ts`. Only the item names of the two official tiers (特定原材料 / 特定原材料に準ずるもの), in the official order, plus the source title, URL, version (`caa-2026-04-01`, the date the item set last changed) and the date irori checked it (2026-11-11). The number of items shown in the UI is computed from this data, not written into copy.
- The list is used as a set of selectable items for a household's "do not use" setting. irori does not claim conformity with the labelling system, which covers pre-packaged processed foods; households can also add free-text items.
- When the official item set changes, update the items, the version, the checked date and the fixture tests together.

### Child-serving and weaning notes — Children and Families Agency (こども家庭庁), Ministry of Health, Labour and Welfare (厚生労働省), Consumer Affairs Agency (消費者庁)

`child-guidance.ts` holds short notes written by irori, each tied to a source ID, a page or section, the date checked (2026-11-11) and how it was checked (`direct` = the official PDF text was read; `summary` = the official page was fetched and its points were extracted, without verbatim quotation). No passage, table, illustration or layout from these publications is reproduced.

| ID | Publisher | Document | Used for |
| --- | --- | --- | --- |
| `mhlw_honey_leaflet` | 厚生労働省 | [ハチミツを与えるのは1歳を過ぎてから。（リーフレット）](https://www.mhlw.go.jp/file/06-Seisakujouhou-11130500-Shokuhinanzenbu/0000161404.pdf) | No honey or honey-containing food under 12 months; ordinary cooking does not remove the risk |
| `cfa_weaning_guide_2019` | 「授乳・離乳の支援ガイド」改定に関する研究会（こども家庭庁ウェブサイト掲載） | [授乳・離乳の支援ガイド（2019年改定版）](https://www.cfa.go.jp/assets/contents/node/basic_page/field_ref_resources/6790a829-15c7-49d3-9156-9e40e8d9c20c/b0946e59/20230401_policies_boshihoken_junyuu_01.pdf), pp. 30–34 | Names and approximate months of the weaning stages; taking a portion before seasoning during weaning |
| `caa_choking_2021` | 消費者庁 | [食品による子どもの窒息・誤嚥事故に注意！（令和3年1月20日）](https://www.caa.go.jp/policies/policy/consumer_safety/caution/caution_047/assets/caution_047_210120_0001.pdf), pp. 1, 8 | Hard beans and nuts, round foods, posture while eating |
| `cfa_accident_handbook` | こども家庭庁 | [こどもの事故防止ハンドブック（窒息・誤飲事故）](https://www.cfa.go.jp/policies/child-safety-actions/handbook/content-1) — checked as `summary` | Cutting to the child's chewing ability; foods to avoid at ages 0–5 |
| `mhlw_dri_2025_sodium` | 厚生労働省 | [「日本人の食事摂取基準（2025年版）」策定検討会報告書 ミネラル（多量ミネラル）](https://www.mhlw.go.jp/content/10904750/001316468.pdf), p. 281 | Lower salt targets for ages 1–5 (the reason for lighter seasoning) |

- The age rule enforced in code (honey under 12 months) and each child-serving note resolve to one of these IDs; a recipe without a sourced note shows "この料理の取り分け案内は未対応です" instead of a generated one.
- No primary source was found that states "take a portion before seasoning" for toddlers; irori presents that step as a way to keep seasoning light and says that the cited guide describes it for the weaning period.
- These notes are general information compiled by irori. They are not supervised by a professional, do not replace medical advice, and do not decide when to introduce a food, diagnose an allergy or guide treatment. No agency endorsement is implied. Generative AI is not used to produce them.
- Terms: the agencies' site policies must be rechecked when a source, its URL or the wording derived from it changes; update the source table, the checked date and the tests together.

## Official municipal RSS (runtime only)

Source catalog: [Sapporo RSS guide](https://www.city.sapporo.jp/koho/hp/rss/index.html) and [Yokohama RSS guide](https://www.city.yokohama.lg.jp/aboutweb/usage/rss.html), checked 2026-10-31. irori acts as a private RSS reader: it stores the headline, official URL and source date, links to the publisher and does not fetch/reproduce article bodies or images. No actual articles are bundled with the code or test fixtures. Publisher rights remain with the publisher. There is no claim of MIT ownership over externally fetched content. Feed availability and terms must be rechecked when adding/changing sources.
