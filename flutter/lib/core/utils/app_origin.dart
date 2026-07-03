import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Web origin (Magic Link callback URL / 招待リンク URL 組み立て用)。
///
/// Next.js 原典 `src/lib/utils/app-origin.ts` (`getAppOrigin`) の Flutter
/// 対応物。web は `NEXT_PUBLIC_APP_URL` を最優先するが、Flutter web は
/// 自身の配信 origin (`Uri.base.origin`) が正 (意図的差異 — Flutter は
/// Vercel の Flutter web デプロイ 1 origin のみで動くため env 分岐が不要)。
///
/// 本番 Web では `Uri.base.origin` (例: `https://irori-flutter.vercel.app`)。
/// flutter-test VM では `Uri.base` が `file:` scheme になり `Uri.origin` が
/// `StateError` を投げるため、**テストでは必ず override する**
/// (例: `originProvider.overrideWithValue('https://test.example')`)。
///
/// 履歴: issue #76 (InviteCard) まで `app/router.dart` に定義していたが、
/// feature 層 (settings) からの参照で feature→app の循環 import になるため
/// core/utils へ移動した (router.dart が再 export し既存参照は不変)。
final originProvider = Provider<String>((ref) {
  final base = Uri.base;
  // 本番 Web は http(s) で origin が取れる。flutter-test VM は `file:` scheme で
  // `Uri.origin` が StateError を投げるため空文字を fallback とする
  // (テストでは originProvider を override して固定 origin を使う想定)。
  if (base.isScheme('http') || base.isScheme('https')) {
    return base.origin;
  }
  return '';
});
