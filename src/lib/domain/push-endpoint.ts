/**
 * push サービスの宛先 URL を検証する純関数。
 *
 * ## なぜ allowlist が要るか（SSRF）
 *
 * `endpoint` はブラウザから送られてくる**任意の URL** で、`web-push` は宛先を
 * 検証せず素直にそこへ HTTP を撃つ。検証せねば、認証済みユーザーが
 * `http://169.254.169.254/...` のような内部アドレスを渡してサーバにリクエストを
 * 代行させられる（応答本文は返らぬが status は漏れる ＝ 盲目 SSRF）。
 * 同じ穴が「任意の宛先へ通知を中継させる open relay」でもある。
 *
 * ## denylist ではなく allowlist にする理由
 *
 * 「送る／送らぬ」は外向きの不可逆な分岐じゃ。CLAUDE.md の
 * 「再試行は広く、破棄は狭く」の裏返しで、**外部へ出す判断は狭く**取る。
 * 少数サンプルからの denylist は、知らぬホストを素通しする。
 *
 * ## 保守について
 *
 * ブラウザが増えれば push サービスも増える。ここに追加が要る時は
 * 「その端末で購読できたのに送信が 400 で落ちる」という形で現れる
 * （静かに壊れるのではなく、はっきり失敗する向き）。
 */

/**
 * 許可する push サービスのホスト。先頭が `.` のものはサフィックス一致。
 *
 * - Apple（Safari / iOS）: `*.push.apple.com`
 * - Chrome / Edge（FCM）: `fcm.googleapis.com`
 * - Firefox: `updates.push.services.mozilla.com`
 */
export const ALLOWED_PUSH_HOSTS = [
  ".push.apple.com",
  "fcm.googleapis.com",
  "updates.push.services.mozilla.com",
] as const

/**
 * DB の `upsert_push_subscription`（20261002100003）が持つ正規表現と**同じ文字列**。
 *
 * 小文字のホスト・port 無し・userinfo 無し・パス必須を、**生の文字列**に対して要求する。
 * `[a-z0-9-]+` はラベルの文字種（`_` や空ラベルを通さぬ）まで DB と揃えるためじゃ。
 * 片方だけ変えると受理集合が食い違う — `push_endpoint_allowlist.sql` の事例表を
 * vitest と pgTAP の両方が通すゆえ、食い違えばどちらかが赤くなる。
 */
const PUSH_ENDPOINT_PATTERN =
  /^https:\/\/(([a-z0-9-]+\.)+push\.apple\.com|fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com)\//

/**
 * push の endpoint として送信を許す URL か。
 *
 * ## ⚠️ `new URL()` の結果だけで判じるな（正規化が穴を隠す）
 * URL パーサは大文字のホストを小文字に、`%2e` を `.` に、`\` を `/` に、既定の
 * `:443` を空に直し、前後の空白を落とす。正規化後の hostname だけを見ると、
 * DB の正規表現（生の文字列を見る）が弾くものを TS が通してしまい、
 * 「Action は通ったのに RPC が 22023」という食い違いになる。ゆえに
 * **生の文字列が正規化後の `https://<host>/` で始まる**ことまで要求し、
 * 最後に DB と同じ正規表現を生の文字列へ当てる。
 *
 * 受理集合は「DB の正規表現 ∩ URL として解釈できる」で、DB 以下に収まる
 * （DB より甘くなる向きの食い違いは構造的に起こらぬ）。
 */
export function isAllowedPushEndpoint(endpoint: string): boolean {
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    return false
  }
  // http:// を弾く（平文で内部アドレスを叩かせぬ）。
  if (url.protocol !== "https:") return false
  // port・userinfo を持つ宛先は push サービスではない（`:443` は URL が空に直すゆえ、
  // 下の生文字列の照合が拾う）。
  if (url.port !== "" || url.username !== "" || url.password !== "") return false
  // 正規化で姿の変わった文字列を弾く（大文字・%2e・\・空白・パス無し 等）。
  if (!endpoint.startsWith(`${url.protocol}//${url.host}/`)) return false
  if (
    !ALLOWED_PUSH_HOSTS.some((host) =>
      host.startsWith(".") ? url.hostname.endsWith(host) : url.hostname === host,
    )
  ) {
    return false
  }
  return PUSH_ENDPOINT_PATTERN.test(endpoint)
}

/**
 * 端末の見分け用に User-Agent を要約する。
 *
 * 生の UA をそのまま保存せぬのは (a) DB の CHECK が 500 文字である (b) 設定カードに
 * 出す情報ゆえ読める必要がある、の 2 点から。判別できれば十分で、正確な機種名は要らぬ。
 * 判別できねば null を返し、UI 側で「不明な端末」へ退化させる（fail-soft）。
 */
export function summarizeUserAgent(ua: string | null | undefined): string | null {
  if (!ua) return null
  const platform = /iPhone|iPad/.test(ua)
    ? "iPhone/iPad"
    : /Android/.test(ua)
      ? "Android"
      : /Macintosh/.test(ua)
        ? "Mac"
        : /Windows/.test(ua)
          ? "Windows"
          : null
  // 判定順が load-bearing: Edge は Chrome を、Chrome は Safari を UA に含む。
  // 広い方から先に見ると全て Safari / Chrome に化ける。
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Firefox\//.test(ua)
      ? "Firefox"
      : /Chrome\//.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua)
          ? "Safari"
          : null

  if (platform && browser) return `${platform} の ${browser}`
  return platform ?? browser
}
