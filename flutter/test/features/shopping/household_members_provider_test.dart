import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:irori/core/supabase/supabase_providers.dart';
import 'package:irori/features/shopping/data/household_members_provider.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import '../../support/fake_supabase.dart';

({
  ProviderContainer container,
  FakeQueryBuilder profiles,
  FakeFilterBuilder read,
})
_make({
  required String? householdId,
  PostgrestList rows = const [],
  Object? readError,
}) {
  final read = FakeFilterBuilder(cannedValue: rows, cannedError: readError);
  final profiles = FakeQueryBuilder(read);
  final container = ProviderContainer(
    overrides: [
      supabaseClientProvider.overrideWithValue(
        FakeSupabaseClient(fromBuilders: {'profiles': profiles}),
      ),
      currentHouseholdIdProvider.overrideWith((ref) async => householdId),
    ],
  );
  return (container: container, profiles: profiles, read: read);
}

/// `.future` を await せず、state が条件を満たすまで event loop を bounded に
/// 回して待つ (baby/meals テストと同じ流儀 — build throw 時に `.future` が
/// pending のまま残る既知の挙動を踏まないため)。
Future<void> _pumpUntil(bool Function() done) async {
  for (var i = 0; i < 50 && !done(); i++) {
    await Future<void>.delayed(const Duration(milliseconds: 1));
  }
}

void main() {
  group('householdMembersProvider', () {
    test('profiles から id, display_name を household スコープで取得する '
        '(web page.tsx の members select と同一)', () async {
      final m = _make(
        householdId: 'hh-1',
        rows: [
          {'id': 'user-1', 'display_name': 'わっち'},
          {'id': 'user-2', 'display_name': 'パートナー'},
        ],
      );
      addTearDown(m.container.dispose);

      final members = await m.container.read(householdMembersProvider.future);

      expect(m.profiles.lastSelectColumns, 'id, display_name');
      expect(m.read.eqFilters, [(column: 'household_id', value: 'hh-1')]);
      expect(members, [
        (id: 'user-1', displayName: 'わっち'),
        (id: 'user-2', displayName: 'パートナー'),
      ]);
    });

    test('世帯未参加 (householdId null) は空リストで profiles を引かない', () async {
      final m = _make(householdId: null);
      addTearDown(m.container.dispose);

      final members = await m.container.read(householdMembersProvider.future);

      expect(members, isEmpty);
      expect(m.profiles.lastSelectColumns, isNull);
    });

    test('display_name の null 混入は空文字に防御する', () async {
      final m = _make(
        householdId: 'hh-1',
        rows: [
          {'id': 'user-1', 'display_name': null},
        ],
      );
      addTearDown(m.container.dispose);

      final members = await m.container.read(householdMembersProvider.future);

      expect(members.single.displayName, '');
    });

    test('PostgrestException は握り潰されず AsyncError に伝播する', () async {
      final m = _make(
        householdId: 'hh-1',
        readError: const PostgrestException(message: 'boom', code: '500'),
      );
      addTearDown(m.container.dispose);

      // `.future` は build throw 時に pending のまま残る既知の挙動があるため、
      // baby/meals の error テストと同じく state 経由で AsyncError を検証する。
      m.container.listen(
        householdMembersProvider,
        (_, _) {},
        fireImmediately: true,
      );
      await _pumpUntil(
        () => !m.container.read(householdMembersProvider).isLoading,
      );

      final state = m.container.read(householdMembersProvider);
      expect(state.hasError, isTrue, reason: 'fetch 失敗で AsyncError になるはず');
      expect(state.error, isA<PostgrestException>());
    });
  });
}
