# scripts/

irori プロジェクトの開発・運用支援スクリプト集。

---

## check-supabase-error-destructure.py

(既存) Supabase エラーオブジェクトの destructure チェック。詳細はスクリプト先頭の docstring を参照。

---

## check-transition-reject-guard.py

`startTransition(async () => { await someAction() })` を try/catch で握らずに書いた箇所を検出する。
未握りだと圏外・不安定な電波下で Server Action が reject した瞬間に **error boundary へ全画面遷移し、
記録が無言で失われる**（Next 公式 docs: `01-app/01-getting-started/10-error-handling.md:375`）。

```bash
./scripts/check-transition-reject-guard.py            # report-only
./scripts/check-transition-reject-guard.py --strict   # 違反があれば exit 1 (CI)
./scripts/check-transition-reject-guard.py PATH       # 任意パス（反証テスト用）
```

出力の `checked` は「await を含む transition block の総数」。正規表現が壊れて何にも
マッチしなくなると `violations: 0` は出てしまうため、`checked` が 0 でないことを併せて見ること。

`.catch()` の無い floating promise（`void action()` / プレーン async onClick）は**別機序**
（error boundary へは飛ばず無言の unhandled rejection）ゆえ本検出器の対象外。
