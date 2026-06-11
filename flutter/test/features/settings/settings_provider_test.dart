import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:irori/core/supabase/supabase_providers.dart';
import 'package:irori/features/settings/data/settings_provider.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import '../../support/fake_supabase.dart';

const _kProfileRow = <String, dynamic>{
  'display_name': '太郎',
  'role': 'owner',
  'default_page': 'stock',
  'household_id': 'hh-1',
};

const _kHouseholdRow = <String, dynamic>{
  'name': 'いろり家',
  'auto_stock_categories': ['baby'],
  'baby_name': null,
  'baby_birth_date': null,
};

User _user({String? email}) => User(
  id: 'user-1',
  appMetadata: const {},
  userMetadata: const {},
  aud: 'authenticated',
  email: email,
  createdAt: DateTime.utc(2026, 6, 1).toIso8601String(),
);

ProviderContainer _container({User? currentUser, FakeGoTrueClient? auth}) {
  final profiles = FakeQueryBuilder(
    FakeFilterBuilder(singleValue: _kProfileRow),
  );
  final households = FakeQueryBuilder(
    FakeFilterBuilder(singleValue: _kHouseholdRow),
  );
  final client = FakeSupabaseClient(
    auth: auth ?? FakeGoTrueClient(cannedCurrentUser: currentUser),
    fromBuilders: {'profiles': profiles, 'households': households},
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
  group('settingsProvider', () {
    test('バンドル + email を返し、DefaultPageCache を温める', () async {
      final container = _container(
        currentUser: _user(email: 'taro@example.com'),
      );
      addTearDown(container.dispose);

      // fetch 前のキャッシュは cold (未取得 = null)。
      expect(container.read(defaultPageCacheProvider).value, isNull);

      final data = await container.read(settingsProvider.future);

      expect(data.settings.displayName, '太郎');
      expect(data.settings.defaultPage, 'stock');
      expect(data.email, 'taro@example.com');
      // fetch 成功で同期キャッシュへ反映 (router の /login redirect が読む)。
      expect(container.read(defaultPageCacheProvider).value, 'stock');
    });

    test('email が無い user は空文字へ防御する (web: user.email ?? "")', () async {
      final container = _container(currentUser: _user());
      addTearDown(container.dispose);

      final data = await container.read(settingsProvider.future);

      expect(data.email, '');
    });

    test('fetch 完了前にサインアウトしたら DefaultPageCache を書き戻さない', () async {
      // PR #40 レビュー対応 F3: provider doc が宣言する「サインアウト時に
      // null へ戻す」防御を stale-write レースからも守る (fetch 中に
      // signOut → cache.value=null した後、fetch 完了が旧ユーザーの値を
      // 書き戻す穴を塞ぐ)。
      final auth = FakeGoTrueClient(
        cannedCurrentUser: _user(email: 'taro@example.com'),
      );
      final container = _container(auth: auth);
      addTearDown(container.dispose);

      final future = container.read(settingsProvider.future);
      // fake の fetch はマイクロタスクで完了する — その前にサインアウト。
      auth.cannedCurrentUser = null;
      final data = await future;

      // バンドル自体は返る (呼び出し側は redirect 圏内) が、
      // キャッシュへ旧ユーザーの default_page を書き戻さない。
      expect(data.settings.defaultPage, 'stock');
      expect(container.read(defaultPageCacheProvider).value, isNull);
    });

    test('未認証 (currentUser=null) は StateError を投げる', () async {
      final container = _container();
      addTearDown(container.dispose);

      await expectLater(
        container.read(settingsProvider.future),
        throwsA(isA<StateError>()),
      );
    });
  });
}
