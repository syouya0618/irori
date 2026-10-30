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
