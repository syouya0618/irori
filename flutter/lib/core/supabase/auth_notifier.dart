import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import 'supabase_providers.dart';

/// GoRouter `refreshListenable` 用の `ChangeNotifier` ラッパー。
///
/// 設計意図 (設計書 Section 7.1.5 / Issue #47):
/// - `appRouterProvider` 内で `ref.watch(authStateChangeProvider)` を直接呼ぶと、
///   auth state 変化のたびに `Provider<GoRouter>` が rebuild され
///   `GoRouter` インスタンスが差し替わって NavigatorState が破棄される
///   (Riverpod Discussion #1357 で Remi Rousselet が警告)。
/// - 本クラスは `Stream<AuthState>` を subscribe し、変化時に
///   `notifyListeners()` を呼ぶだけの薄い `ChangeNotifier` で、
///   `GoRouter` を rebuild させずに `refresh` (= `redirect` 再評価) のみ起こす。
///
/// **User 状態を内部保持する理由** (subscription order 競合の回避):
/// auth state を別 Provider 経由 (`currentUserProvider`) で読むと、
/// `AuthNotifier` の listener と `currentUserProvider` の listener が
/// 別タイミングで stream を購読しているため、`notifyListeners()` 起動時に
/// `currentUserProvider` の値がまだ更新されていない window が生じうる
/// (broadcast stream の listener 通知順は登録順だが、同期 redirect 評価が
/// 通知ループ途中で走る)。
/// go_router 公式 example (redirection.dart) と同じく、Notifier 自身が
/// `user` を持ち redirect から直接読むことでこの race を構造的に排除する。
///
/// テスト容易性のため `Stream` を constructor injection で受け取る。
/// 本物の auth stream を渡せば prod 挙動、`StreamController` を渡せば
/// `notifyListeners` 発火と user 値を test から制御可能。
class AuthNotifier extends ChangeNotifier {
  AuthNotifier({Stream<AuthState>? authStateStream, User? initialUser})
    : _user = initialUser {
    _subscription = authStateStream?.listen((event) {
      _user = event.session?.user;
      notifyListeners();
    });
  }

  StreamSubscription<AuthState>? _subscription;
  User? _user;

  /// 直近の auth event 時点での認証ユーザー。未認証 (signedOut / 未初期化) は `null`。
  User? get user => _user;

  /// 認証済みか。redirect ガードでの分岐用ショートカット。
  bool get isAuthenticated => _user != null;

  @override
  void dispose() {
    _subscription?.cancel();
    _subscription = null;
    super.dispose();
  }
}

/// `AuthNotifier` の DI provider。
///
/// debug build で `SUPABASE_URL` / `SUPABASE_ANON_KEY` が未設定の場合、
/// `Supabase.instance` 参照は **`AssertionError`** を投げる
/// (supabase_flutter 2.12.4 `supabase.dart:42-48` の `assert(_isInitialized)`)。
/// CLAUDE.md 「エラー握り潰し禁止」に沿って、既知の debug-only 未初期化ケースのみ
/// 明示 catch + `debugPrint` でログ出力する。release build では main.dart の
/// `kReleaseMode` ガードが事前に `StateError` を投げるため、この catch まで
/// 到達することはない。
final authNotifierProvider = Provider<AuthNotifier>((ref) {
  Stream<AuthState>? stream;
  try {
    // ref.read を使い、supabaseClientProvider の rebuild で
    // 本 Provider が rebuild されないようにする (Stream 取得は一度だけで良い)。
    stream = ref.read(supabaseClientProvider).auth.onAuthStateChange;
  } on AssertionError catch (e) {
    // Phase 0 同様 debug build で env 未設定時に Supabase 未初期化となる
    // ケースを許容する。stream=null で AuthNotifier を構築し、
    // refreshListenable は notify を起こさず初期 redirect のみ評価される。
    debugPrint(
      'authNotifierProvider: Supabase 未初期化のため stream 無効化 '
      '(debug build かつ env 未設定): ${e.message}',
    );
  }

  final notifier = AuthNotifier(authStateStream: stream);
  ref.onDispose(notifier.dispose);
  return notifier;
});
