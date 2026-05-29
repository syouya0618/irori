/// Magic Link callback の `returnTo` クエリを Open Redirect から防御する。
///
/// 元 Next.js 実装 (`src/app/auth/callback/route.ts`) を基にした判定:
/// 「相対パス (`/` 始まり) かつ 2 文字目が `/` でも `\` でもない」ものだけ許可する。
/// `//evil.com` (protocol-relative) はブラウザが絶対 URL 扱いし、`/\evil.com` も
/// 一部 UA が `//evil.com` に正規化するため、いずれも拒否する。
/// (Next.js 原典は `//` のみ弾くが、こちらは defense-in-depth で `\` も弾く / PR #48 review。
///  現状の唯一の呼び出し先は in-app の `context.go` ゆえ実害は無いが、再利用に備える。)
///
/// 不正値 (null / 空 / 絶対 URL / protocol-relative / backslash variant) は
/// 安全な default を返す。
///
/// 注意: Next.js 側 callback の default は `/` だが、Issue #48 の仕様では
/// 認証後の安全 default を `/baby` とする (親が router wiring 時に再確認)。
String sanitizeReturnTo(String? returnTo, {String fallback = '/baby'}) {
  if (returnTo == null) return fallback;
  if (returnTo.isEmpty) return fallback;
  if (!returnTo.startsWith('/')) return fallback;
  // protocol-relative (`//`) と backslash variant (`/\`) の両方を拒否。
  if (returnTo.length >= 2 && (returnTo[1] == '/' || returnTo[1] == r'\')) {
    return fallback;
  }
  return returnTo;
}
