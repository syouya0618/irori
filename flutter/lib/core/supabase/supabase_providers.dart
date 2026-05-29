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

/// 現在のユーザー (簡易 derived state)
///
/// Riverpod 3.x で `AsyncValue.valueOrNull` は廃止され、`value` (nullable)
/// が公式 API。data 不在時は null を返す。
final currentUserProvider = Provider<User?>((ref) {
  final authState = ref.watch(authStateChangeProvider);
  return authState.value?.session?.user;
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
/// RLS により `profiles` は自分の行のみ可視。`.eq('id', user.id)` で自分の
/// プロファイルを引く。未ログイン時は `StateError` を投げる
/// (呼び出し側は authed 前提なので、明示的に失敗させて握り潰さない)。
final currentHouseholdIdProvider = FutureProvider<String?>((ref) async {
  final client = ref.watch(supabaseClientProvider);
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
