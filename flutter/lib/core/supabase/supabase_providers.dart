import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

/// Supabase client への DI 注入用 provider。
/// main.dart で `Supabase.initialize()` 実行後にこの provider が値を返す。
///
/// Phase 0 では `Supabase.initialize` が未実行の場合 throw する
/// (Phase 1 で auth 機能を加える時に明示的に env を要求する設計)。
final supabaseClientProvider = Provider<SupabaseClient>((ref) {
  return Supabase.instance.client;
});

/// auth state change を Riverpod の reactive flow に乗せる StreamProvider。
/// Magic Link callback / sign in / sign out / token refresh をすべて捕捉。
final authStateChangeProvider = StreamProvider<AuthState>((ref) {
  final client = ref.watch(supabaseClientProvider);
  return client.auth.onAuthStateChange;
});

/// `Supabase` 呼び出し用タイムアウト (CLAUDE.md「外部API はタイムアウト必須」)。
const _kHouseholdQueryTimeout = Duration(seconds: 10);

/// 現在のユーザーの `household_id` を `profiles` から引く FutureProvider。
///
/// 実スキーマ確認済み (2026-05-29): `profiles.household_id` は `uuid` だが
/// **nullable (is_nullable=YES)**。世帯未参加ユーザーや setup 未完了ユーザーは
/// null を持ちうるため、戻り値も `String?` とする (`String` にすると
/// 未参加ユーザーで誤って空文字や例外に倒れる)。
///
/// **auth-reactivity (#54 item4 / PR #60 review)**: login / logout で recompute
/// させるため auth を watch する。ただし `authStateChangeProvider` を丸ごと watch
/// せず、`.select((s) => s.value?.session?.user?.id)` で **user id の変化のみ** を
/// watch する。値そのものは `client.auth.currentUser` を **直読**する。
/// この設計は 3 つの罠を同時に回避する:
///
/// 1. **tokenRefreshed 連鎖再取得の回避** (PR #60 review):
///    auth state 全体を watch すると、`tokenRefreshed` (JWT 既定 1h ごとに自動
///    発火) / `userUpdated` のたびに本 provider が再計算され、それを `.future` で
///    watch する `babyLogsNotifierProvider.build()` / `lastSleepEndedAtProvider`
///    が連鎖再実行 → baby ログ全再取得 + realtime 再subscribe + (`when` の
///    `skipLoadingOnReload` 既定 false により) ダッシュボードの loading ちらつきが
///    起きる。household_id は token refresh では不変なので、user id が変わった
///    (login/logout) ときだけ再計算すれば十分。select の戻り値は再計算トリガー
///    専用で、値には使わない。
/// 2. **startup null-window 回帰の回避**:
///    `authStateChangeProvider` は subscribe 後 `initialSession` を **非同期 emit**
///    するまで value=null の loading window がある。一方 `client.auth.currentUser`
///    は `Supabase.initialize` 時にストレージから **同期復元**済み。値を
///    `authState.value?.session?.user` から取ると起動直後に user=null と誤判定し
///    baby ダッシュボードが一瞬 error になる。currentUser 直読でこれを防ぐ。
/// 3. **別 Provider 経由読みの listener 競合の回避**:
///    `auth_notifier.dart` / `router.dart` が警告するとおり、別 Provider 経由で
///    auth を読むと listener 発火順序差で stale window が出る。本 provider は
///    client から直読することで構造的にこれを避ける。
///
/// **emit/currentUser 更新順序の確認** (gotrue 2.20.x `gotrue_client.dart`):
/// - signOut: `_removeSession()` (`_currentSession=null`) → **その後**
///   `notifyAllSubscribers(signedOut)`。emit 時点で currentUser は既に null。
/// - signIn 系: `_saveSession(session)` → **その後** notify。
/// - initialSession: session 代入 → emit。
///   いずれも「currentUser 更新 → emit」順のため、select の id 変化を trigger に
///   currentUser を直読する本設計は最新値を読める。
///
/// RLS により `profiles` は自分の行のみ可視。`.eq('id', user.id)` で自分の
/// プロファイルを引く。未ログイン時は `StateError` を投げる
/// (呼び出し側は authed 前提なので、明示的に失敗させて握り潰さない)。
final currentHouseholdIdProvider = FutureProvider<String?>((ref) async {
  final client = ref.watch(supabaseClientProvider);
  // login / logout で recompute させるため user id の変化のみを watch する
  // (#54 item4 / PR #60 review: 全体 watch だと tokenRefreshed の周期発火で
  //  baby ログ全再取得 + realtime 再subscribe が無駄に走る)。値は currentUser 直読。
  ref.watch(authStateChangeProvider.select((s) => s.value?.session?.user.id));
  final user = client.auth.currentUser;
  if (user == null) {
    throw StateError(
      'currentHouseholdIdProvider: 未認証状態で household_id を要求した',
    );
  }

  try {
    final row = await client
        .from('profiles')
        .select('household_id')
        .eq('id', user.id)
        .maybeSingle()
        .timeout(_kHouseholdQueryTimeout);
    // profiles 行が無い (= setup 未完了) / household_id が null の双方で null。
    return row?['household_id'] as String?;
  } on PostgrestException catch (e) {
    // 握り潰さず構造化ログして rethrow (CLAUDE.md)。
    debugPrint(
      'currentHouseholdIdProvider PostgrestException: '
      'code=${e.code} message=${e.message} '
      'details=${e.details} hint=${e.hint}',
    );
    rethrow;
  }
});
