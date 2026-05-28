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
