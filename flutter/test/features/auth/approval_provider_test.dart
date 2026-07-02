import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:irori/core/supabase/supabase_providers.dart';
import 'package:irori/features/auth/data/approval_provider.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import '../../support/fake_supabase.dart';

/// Issue #74: 承認ゲートの fetch 側 (`approvalStatusProvider`) と同期キャッシュ
/// (`ApprovalCache`) の fail-closed 契約を固定する。
///
/// web 原典 `src/proxy.ts:60-73`: profile 取得失敗・行なしはすべて
/// `is_approved=false` 扱い (絶対に通さない)。

User _user(String id) => User(
  id: id,
  appMetadata: const {},
  userMetadata: const {},
  aud: 'authenticated',
  createdAt: DateTime.utc(2026, 7, 1).toIso8601String(),
);

ProviderContainer _container({
  FakeGoTrueClient? auth,
  Map<String, Object?>? profileRow,
  Object? profileError,
}) {
  final profiles = FakeQueryBuilder(
    FakeFilterBuilder(
      maybeSingleValue: profileRow,
      maybeSingleError: profileError,
    ),
  );
  final client = FakeSupabaseClient(
    auth: auth ?? FakeGoTrueClient(cannedCurrentUser: _user('user-1')),
    fromBuilders: {'profiles': profiles},
  );
  return ProviderContainer(
    overrides: [
      supabaseClientProvider.overrideWithValue(client),
      // 実 stream は不要 (auth-reactivity の watch は select で user id のみ)。
      authStateChangeProvider.overrideWith(
        (ref) => const Stream<AuthState>.empty(),
      ),
    ],
  );
}

void main() {
  group('ApprovalCache', () {
    test('未取得は null、set 後は該当ユーザーのみ値を返す (userId キー)', () {
      final cache = ApprovalCache();
      expect(cache.isApprovedFor('user-1'), isNull);

      cache.set(userId: 'user-1', isApproved: true);
      expect(cache.isApprovedFor('user-1'), isTrue);
      // 別ユーザーの参照は構造的に null (= fail-closed で未承認扱い)。
      expect(cache.isApprovedFor('user-2'), isNull);
    });

    test('clear で破棄され null (= fail-closed) に戻る', () {
      final cache = ApprovalCache()
        ..set(userId: 'user-1', isApproved: true)
        ..clear();
      expect(cache.isApprovedFor('user-1'), isNull);
    });
  });

  group('approvalStatusProvider (Issue #74, fail-closed)', () {
    test('is_approved=true は true を返しキャッシュを温める', () async {
      final container = _container(profileRow: {'is_approved': true});
      addTearDown(container.dispose);

      expect(
        container.read(approvalCacheProvider).isApprovedFor('user-1'),
        isNull,
        reason: 'fetch 前は cold (null = 未承認扱い)',
      );

      final result = await container.read(approvalStatusProvider.future);

      expect(result, isTrue);
      expect(
        container.read(approvalCacheProvider).isApprovedFor('user-1'),
        isTrue,
        reason: 'router の承認ゲートが読む同期キャッシュへ反映される',
      );
    });

    test('is_approved=false は false を返しキャッシュも false', () async {
      final container = _container(profileRow: {'is_approved': false});
      addTearDown(container.dispose);

      final result = await container.read(approvalStatusProvider.future);

      expect(result, isFalse);
      expect(
        container.read(approvalCacheProvider).isApprovedFor('user-1'),
        isFalse,
      );
    });

    test('行なし (profile 未作成) は false (web の `?? false` と同じ安全側)', () async {
      final container = _container();
      addTearDown(container.dispose);

      expect(await container.read(approvalStatusProvider.future), isFalse);
    });

    test(
      '取得失敗 (PostgrestException) は throw せず false へ倒す (fail-closed)',
      () async {
        final container = _container(
          profileError: const PostgrestException(message: 'boom', code: '500'),
        );
        addTearDown(container.dispose);

        // web proxy.ts:66-73 parity: logSupabaseError 後 `?? false` で未承認扱い。
        // throw すると呼び出し側の分岐次第で fail-open になりうるため値で返す。
        expect(await container.read(approvalStatusProvider.future), isFalse);
        expect(
          container.read(approvalCacheProvider).isApprovedFor('user-1'),
          isFalse,
        );
      },
    );

    test('未認証 (currentUser=null) は StateError を投げる', () async {
      final container = _container(auth: FakeGoTrueClient());
      addTearDown(container.dispose);

      await expectLater(
        container.read(approvalStatusProvider.future),
        throwsA(isA<StateError>()),
      );
    });

    test('fetch 完了前にサインアウトしたらキャッシュを書き戻さない (stale-write 防御)', () async {
      // settingsProvider と同じレース: fetch 中に signOut → cache.clear() した後、
      // 遅れて完了した fetch が旧ユーザーの値で上書きする穴を塞ぐ。
      final auth = FakeGoTrueClient(cannedCurrentUser: _user('user-1'));
      final container = _container(
        auth: auth,
        profileRow: {'is_approved': true},
      );
      addTearDown(container.dispose);

      final future = container.read(approvalStatusProvider.future);
      // fake の fetch はマイクロタスクで完了する — その前にサインアウト。
      auth.cannedCurrentUser = null;
      final result = await future;

      // 値自体は返る (呼び出し側は redirect 圏内) が、キャッシュは cold のまま。
      expect(result, isTrue);
      expect(
        container.read(approvalCacheProvider).isApprovedFor('user-1'),
        isNull,
      );
    });
  });
}
