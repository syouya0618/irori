import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/supabase/supabase_providers.dart';
import 'settings_repository.dart';

/// `default_page` の同期キャッシュ (GoRouter redirect 用)。
///
/// 設計裁定 (PR-H / p25plan risks): GoRouter の同期 redirect 内で profiles を
/// 非同期取得すると初期画面のチラつき/デッドロックの恐れがあるため、
/// **同期キャッシュ + fallback '/baby' の best-effort** に留める。
/// cold start での完全適用 (splash で profiles fetch 待ち) はスコープ外。
///
/// 書き込みタイミング:
/// - [settingsProvider] の fetch 成功時 (設定タブ表示ごと)
/// - 起動タブカードの更新成功時
/// - サインアウト時に null へ戻す (端末共用時に他ユーザーの値で
///   redirect しないための防御)
class DefaultPageCache {
  /// 直近に観測した `profiles.default_page`。未取得は null。
  String? value;
}

/// [DefaultPageCache] の DI provider。
///
/// root `ProviderContainer` と同寿命の mutable holder。router
/// (`appRouterProvider`) が redirect 評価時に `ref.read` で同期参照する。
final defaultPageCacheProvider = Provider<DefaultPageCache>((ref) {
  return DefaultPageCache();
});

/// 設定画面の表示データ (DB バンドル + auth 由来の email)。
///
/// email は web `settings/page.tsx` の `user.email ?? ""` に対応
/// (auth セッションから同期取得するため fetch は不要)。
typedef SettingsData = ({HouseholdSettings settings, String email});

/// 設定バンドルの FutureProvider。
///
/// profiles / households は **Realtime publication 非対象** (migrations grep
/// 検証済み) のため realtime 購読はせず、設定タブ表示ごとに `AppShell` が
/// invalidate して refetch する (PR-H 設計契約)。
///
/// auth-reactivity は `currentHouseholdIdProvider` と同じ流儀:
/// `authStateChangeProvider` 全体ではなく **user id の変化のみ** を watch し
/// (tokenRefreshed の周期発火で再取得しないため)、値は
/// `client.auth.currentUser` を直読する (startup null-window 回避)。
final settingsProvider = FutureProvider<SettingsData>((ref) async {
  final client = ref.watch(supabaseClientProvider);
  // login / logout で recompute させるため user id の変化のみを watch する。
  ref.watch(authStateChangeProvider.select((s) => s.value?.session?.user.id));
  final user = client.auth.currentUser;
  if (user == null) {
    throw StateError('settingsProvider: 未認証状態で設定を要求した');
  }

  final settings = await ref
      .read(settingsRepositoryProvider)
      .fetchSettings(userId: user.id);

  // best-effort 同期キャッシュへ反映 (router の /login redirect が読む)。
  ref.read(defaultPageCacheProvider).value = settings.defaultPage;

  return (settings: settings, email: user.email ?? '');
});
