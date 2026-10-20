/**
 * React 19 の `<form action={fn}>` が action の後に行う**自動 reset を止める** ref（P2-30）。
 *
 * ## なぜ要るか
 * React 19 は action の後でフォームを無条件に reset する（`form.reset()`）。select の
 * defaultValue は初回描画の後は更新されぬゆえ、reset で初回の値へ戻り、続けて別の欄だけを
 * 直して保存すると**黙って巻き戻る**（授乳間隔で実際に起きる）。保存に失敗した時も入力が
 * 消え、打ち直しを強いる。
 *
 * ## ⚠️ `onReset={(e) => e.preventDefault()}` では止まらぬ（React 19.2 で実測）
 * React は reset を **commit の最中**に呼び（react-dom `recursivelyResetForms`）、その間は
 * 合成イベントの配送を止めておる（`dispatchEvent` が `_enabled` で門番する）。ゆえに
 * `onReset` は React 自身の reset では呼ばれぬ。**ネイティブの listener** なら、reset
 * イベント（cancelable — 取り消すと reset は中止される）をその場で取り消せる。
 *
 * ## ⚠️ `onSubmit` + `preventDefault` へ替えるな
 * `action={fn}` なら SSR が form の action を `javascript:` の番兵にし、hydration 前の
 * 送信を捕まえて hydration 後に再生する。onSubmit だけにすると hydration 前の保存タップが
 * 素の GET になり、入力（赤ちゃんの名前・生年月日）が URL・履歴・サーバのログに載る。
 *
 * 識別子を安定させるため module 直下の関数として渡すこと（インラインの ref callback は
 * 描画ごとに付け外しが走る）。React 19 の ref callback は cleanup を返せる。
 */
export function preventFormAutoReset(
  form: HTMLFormElement | null,
): (() => void) | undefined {
  if (!form) return undefined
  const cancel = (event: Event) => event.preventDefault()
  form.addEventListener("reset", cancel)
  return () => form.removeEventListener("reset", cancel)
}
