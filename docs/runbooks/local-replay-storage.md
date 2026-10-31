# 保存結果不明の控えと端末保存

対象は `record-requests.ts` の医療・独自記録・子ども追加の再送控え。
本番migration・deploy・mergeの許可や、アプリ全体の暗号化を意味しない。

## 守る契約

- 操作ID、対象行ID、子ども、所有者、送信本文、版文字列を最初の押下で固定する。
- 同じキーの控えを上書きしない。結果不明の後の拒否でも控えを残す。
- 自動再送はしない。利用者の明示操作で同じ内容を送る。
- 新形式の本文はWebCrypto AES-GCM（256 bit、毎回96 bit IV）で暗号化する。
  所有者・世帯・子ども・操作IDを含む保存キーをAADに使う。
- non-extractable CryptoKeyをIndexedDBへ保存し、transaction完了を待つ。
  同時タブの鍵作成はreadwrite transactionのget-or-addで一つに揃える。
  localStorageへ置くのは暗号文、IV、schema/encoding、所有者と操作の識別子だけ。
  記録の種別・名称・日付・メモは平文metadataへ含めない。
- 新規のネットワーク送信は暗号化保存の試行後。保存不可時は平文へfallbackせず、
  この画面だけの控えと、閉じる前に確認する警告を維持する。

## 脅威と保証の限界

| 状況 | この変更の効果・残る限界 |
|---|---|
| 共有端末・localStorageだけの持出し | 医療本文を平文JSONで直接読む経路を減らす。識別子と控えの存在は残る。 |
| 端末紛失・ブラウザprofile全体の取得 | OSのロック・ディスク暗号化を代替しない。鍵も同じprofileにあるため、復号不能とは保証しない。 |
| 同一オリジンJavaScript・XSS | 同じコード権限でIndexedDBの鍵を使える。XSS対策や認可境界として扱わない。 |
| ログアウト | 同じ本人の再ログイン後に未確定操作を戻せるよう、控えと鍵を残す。ログアウトを遠隔消去と表示しない。 |
| アカウント・世帯切替 | 読みを所有者で分離。既知形式の別所有者の控えを除去し、対応する不要鍵を整理する。非同期処理中の古い書込みはowner epochと操作fenceで拒む。 |
| 古いPWA | 従来の`irori:record-request:v1:`名前空間へschema 2の暗号envelopeを置く。旧版は未知控えとして新規保存を止める。既に開いた旧版タブの判定や、旧版自体の平文書込みを遠隔で直す保証はない。 |
| オフライン・再読込・ブラウザ再起動 | ネットワークなしで鍵と暗号文を読み、固定本文を復元する。ブラウザによるstorage消去・evictionは防げない。 |
| 鍵欠損・破損・暗号文改竄 | 空の待ち行列と見なさない。bytesと件数を残し、新規保存を止める。新しいIDを勝手に発行しない。 |

既存の予定には医療名・日付を含むものがあり、カレンダーのHTML/RSCは従来の
所有者付きService Worker cacheの対象。下書き等の他の保存機構もこの変更の対象外。
この控えの暗号化を「医療情報全体が暗号化された」と説明してはならない。

## 旧データの移行と復旧

1. 現所有者のschema 1を既存validatorで検証し、固定ID・版・空文字・0・falseを保持する。
2. 鍵の永続化と暗号化が成功するまで旧bytesを残す。
3. 読み始めたbytes・owner epoch・操作fenceが変わっていないことを確認し、
   同じキーへ暗号文を書き、読み戻した値と一致することを確認する。
4. 鍵・quota・暗号化が失敗しても旧bytesを消さず、未読控えとして知らせる。
   未対応の旧body・未知schemaも保全するため、移行不能の平文が残る場合がある。
5. 未来schemaが残る所有者の鍵は削除しない。downgradeで未知控えを消してはならない。

復号不能時は保存済み一覧と照合し、控えを消したり別IDで再作成する前に
元の保存結果を確認する。鍵や本文をログ・問い合わせ添付・CI artifactへ出さない。
機能をrollbackする際も追加した鍵DBと未知envelopeを保持する。

## 検証

- Vitest: `record-request-encryption.test.ts`、既存storage/再送/所有者試験。
- `node scripts/test-record-request-browser.mjs`: 使い捨てprofileと合成データで、
  Chromium/WebKitの実WebCrypto・IndexedDB・再起動・オフライン・改竄・鍵欠損・並行タブを検証。
  外部ネットワークは全て拒否する。実Supabaseの保存・認可E2Eとは別の証拠。
- GitHub-hosted E2E: 全migration/33 pgTAP、Playwright全体とWebKit中核経路。
- CodeQLは同じ修正HEADで再評価する。ローカルの暗号化試験だけでHigh解消と判定しない。
