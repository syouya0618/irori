import 'package:flutter_test/flutter_test.dart';
import 'package:irori/features/settings/data/settings_repository.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import '../../support/fake_supabase.dart';

/// read select の期待値 (リポジトリ実装と独立にテスト側でも正を持つ)。
///
/// web `settings/page.tsx` の profiles select
/// (`id, display_name, avatar_url, household_id, role, default_page`) から、
/// Flutter サブセットで未使用の `id` / `avatar_url` を除いたもの
/// (意図的差異 — id は eq キーで取得済み、avatar 表示は移植対象外)。
const _kExpectedProfileColumns =
    'display_name, role, default_page, household_id';

/// web `settings/page.tsx` の households select
/// (`id, name, auto_stock_categories, baby_name, baby_birth_date`) から
/// `id` (eq キーで既知) を除いたもの。
const _kExpectedHouseholdColumns =
    'name, auto_stock_categories, baby_name, baby_birth_date';

const _kProfileRow = <String, dynamic>{
  'display_name': '太郎',
  'role': 'owner',
  'default_page': 'stock',
  'household_id': 'hh-1',
};

const _kHouseholdRow = <String, dynamic>{
  'name': 'いろり家',
  'auto_stock_categories': ['baby', 'cleaning'],
  'baby_name': 'はな',
  'baby_birth_date': '2026-01-15',
};

/// profiles / households 2 テーブルの fake 一式。
({
  SettingsRepository repo,
  FakeSupabaseClient client,
  FakeQueryBuilder profiles,
  FakeFilterBuilder profilesRead,
  FakeFilterBuilder profilesMutation,
  FakeQueryBuilder households,
  FakeFilterBuilder householdsRead,
  FakeFilterBuilder householdsMutation,
})
_repo({
  Map<String, dynamic>? profileRow,
  Object? profileError,
  Map<String, dynamic>? householdRow,
  Object? householdError,
  Object? mutationError,
}) {
  final profilesRead = FakeFilterBuilder(
    singleValue: profileRow ?? _kProfileRow,
    singleError: profileError,
  );
  final profilesMutation = FakeFilterBuilder(
    cannedValue: const [],
    singleValue: const {'id': 'user-1'},
    singleError: mutationError,
  );
  final profiles = FakeQueryBuilder(
    profilesRead,
    mutationFilter: profilesMutation,
  );

  final householdsRead = FakeFilterBuilder(
    singleValue: householdRow ?? _kHouseholdRow,
    singleError: householdError,
  );
  final householdsMutation = FakeFilterBuilder(
    cannedValue: const [],
    singleValue: const {'id': 'hh-1'},
    singleError: mutationError,
  );
  final households = FakeQueryBuilder(
    householdsRead,
    mutationFilter: householdsMutation,
  );

  final client = FakeSupabaseClient(
    fromBuilders: {'profiles': profiles, 'households': households},
  );
  return (
    repo: SettingsRepository(client),
    client: client,
    profiles: profiles,
    profilesRead: profilesRead,
    profilesMutation: profilesMutation,
    households: households,
    householdsRead: householdsRead,
    householdsMutation: householdsMutation,
  );
}

void main() {
  group('SettingsRepository.fetchSettings', () {
    test('profiles → households の順に web と同じ列 + eq スコープで取得する', () async {
      final r = _repo();

      await r.repo.fetchSettings(userId: 'user-1');

      expect(r.client.fromTables, ['profiles', 'households']);
      expect(r.profiles.lastSelectColumns, _kExpectedProfileColumns);
      expect(r.profilesRead.eqFilters, [(column: 'id', value: 'user-1')]);
      expect(r.households.lastSelectColumns, _kExpectedHouseholdColumns);
      expect(r.householdsRead.eqFilters, [(column: 'id', value: 'hh-1')]);
    });

    test('バンドルを復元して返す', () async {
      final r = _repo();

      final settings = await r.repo.fetchSettings(userId: 'user-1');

      expect(settings.displayName, '太郎');
      expect(settings.role, 'owner');
      expect(settings.defaultPage, 'stock');
      expect(settings.householdId, 'hh-1');
      expect(settings.householdName, 'いろり家');
      expect(settings.autoStockCategories, ['baby', 'cleaning']);
      expect(settings.babyName, 'はな');
      expect(settings.babyBirthDate, '2026-01-15');
    });

    test('null 列は web と同じ既定値へ防御する', () async {
      final r = _repo(
        profileRow: const {
          'display_name': null,
          'role': null,
          'default_page': null,
          'household_id': 'hh-1',
        },
        householdRow: const {
          'name': null,
          'auto_stock_categories': null,
          'baby_name': null,
          'baby_birth_date': null,
        },
      );

      final settings = await r.repo.fetchSettings(userId: 'user-1');

      expect(settings.displayName, '');
      // role の DB DEFAULT は 'member' (initial_schema)。
      expect(settings.role, 'member');
      // web: `profile.default_page ?? "meals"`。
      expect(settings.defaultPage, 'meals');
      expect(settings.householdName, isNull);
      // web: `?? ["baby", "cleaning", "hygiene"]`。
      expect(settings.autoStockCategories, kDefaultAutoStockCategories);
      expect(settings.babyName, isNull);
      expect(settings.babyBirthDate, isNull);
    });

    test('auto_stock_categories の破損 (非配列 / 非文字列混入) に耐える', () async {
      // 非配列 → 既定値 (tolerant パーサ流儀 — 1 行の破損で画面全体を倒さない)。
      final r1 = _repo(
        householdRow: const {
          'name': 'いろり家',
          'auto_stock_categories': 'broken',
          'baby_name': null,
          'baby_birth_date': null,
        },
      );
      final s1 = await r1.repo.fetchSettings(userId: 'user-1');
      expect(s1.autoStockCategories, kDefaultAutoStockCategories);

      // 非文字列の混入 → 文字列のみ残す。
      final r2 = _repo(
        householdRow: const {
          'name': 'いろり家',
          'auto_stock_categories': ['baby', 42, 'hygiene'],
          'baby_name': null,
          'baby_birth_date': null,
        },
      );
      final s2 = await r2.repo.fetchSettings(userId: 'user-1');
      expect(s2.autoStockCategories, ['baby', 'hygiene']);
    });

    test('baby_birth_date が ISO 形式でも YMD へ正規化する', () async {
      final r = _repo(
        householdRow: const {
          'name': 'いろり家',
          'auto_stock_categories': ['baby'],
          'baby_name': null,
          'baby_birth_date': '2026-01-15T00:00:00',
        },
      );

      final settings = await r.repo.fetchSettings(userId: 'user-1');

      expect(settings.babyBirthDate, '2026-01-15');
    });

    test('household_id が null (世帯未参加) なら StateError を投げる', () async {
      final r = _repo(
        profileRow: const {
          'display_name': '太郎',
          'role': 'member',
          'default_page': null,
          'household_id': null,
        },
      );

      await expectLater(
        r.repo.fetchSettings(userId: 'user-1'),
        throwsA(isA<StateError>()),
      );
      // households へは到達しない。
      expect(r.client.fromTables, ['profiles']);
    });

    test('households 取得失敗は web 同様に縮退する (世帯名 null + 既定カテゴリ)', () async {
      // web `settings/page.tsx` は household エラーを log した上で
      // household=null のまま描画する。Flutter も同一挙動 (忠実移植)。
      final r = _repo(
        householdError: const PostgrestException(message: 'boom', code: '500'),
      );

      final settings = await r.repo.fetchSettings(userId: 'user-1');

      expect(settings.householdId, 'hh-1');
      expect(settings.householdName, isNull);
      expect(settings.autoStockCategories, kDefaultAutoStockCategories);
      expect(settings.babyName, isNull);
      expect(settings.babyBirthDate, isNull);
    });

    test('profiles 取得失敗 (PostgrestException) は握り潰されず rethrow される', () async {
      final r = _repo(
        profileError: const PostgrestException(message: 'boom', code: '500'),
      );

      await expectLater(
        r.repo.fetchSettings(userId: 'user-1'),
        throwsA(isA<PostgrestException>().having((e) => e.code, 'code', '500')),
      );
    });
  });

  group('SettingsRepository.updateDisplayName', () {
    test('payload は display_name のみ + id eq スコープ + 行数検証付き', () async {
      final r = _repo();

      await r.repo.updateDisplayName(
        userId: 'user-1',
        displayName: ' 太郎 ', // 前後空白は trim される (web: displayName.trim())
      );

      expect(r.client.fromTables, ['profiles']);
      // GRANT (security_hardening_rls.sql:74-75) 対象列のみの payload。
      expect(r.profiles.lastUpdateValues, {'display_name': '太郎'});
      expect(r.profilesMutation.eqFilters, [(column: 'id', value: 'user-1')]);
      // `.update()` は 0 行更新でも error: null のため select('id') で行数検証
      // (CLAUDE.md / StockRepository.updateItem と同形)。
      expect(r.profilesMutation.selectedColumns, 'id');
    });

    test('空 / 空白のみは reject され DB へ到達しない (文言は web と同一)', () async {
      final r = _repo();

      for (final input in ['', '   ']) {
        await expectLater(
          r.repo.updateDisplayName(userId: 'user-1', displayName: input),
          throwsA(
            isA<ArgumentError>().having(
              (e) => e.message,
              'message',
              '表示名を入力してください',
            ),
          ),
        );
      }
      expect(r.client.fromTables, isEmpty);
    });

    test('PostgrestException は握り潰されず rethrow される', () async {
      final r = _repo(
        mutationError: const PostgrestException(message: 'boom', code: '42501'),
      );

      await expectLater(
        r.repo.updateDisplayName(userId: 'user-1', displayName: '太郎'),
        throwsA(
          isA<PostgrestException>().having((e) => e.code, 'code', '42501'),
        ),
      );
    });
  });

  group('SettingsRepository.updateDefaultPage', () {
    test('payload は default_page のみ + id eq スコープ + 行数検証付き', () async {
      final r = _repo();

      await r.repo.updateDefaultPage(userId: 'user-1', page: 'shopping');

      expect(r.client.fromTables, ['profiles']);
      expect(r.profiles.lastUpdateValues, {'default_page': 'shopping'});
      expect(r.profilesMutation.eqFilters, [(column: 'id', value: 'user-1')]);
      expect(r.profilesMutation.selectedColumns, 'id');
    });

    test('whitelist 4 値 (meals/shopping/stock/baby) は全て受理する', () async {
      for (final page in kValidDefaultPages) {
        final r = _repo();
        await r.repo.updateDefaultPage(userId: 'user-1', page: page);
        expect(r.profiles.lastUpdateValues, {'default_page': page});
      }
    });

    test('whitelist 外は reject され DB へ到達しない (文言は web と同一)', () async {
      final r = _repo();

      for (final page in ['settings', 'evil', '', 'MEALS']) {
        await expectLater(
          r.repo.updateDefaultPage(userId: 'user-1', page: page),
          throwsA(
            isA<ArgumentError>().having(
              (e) => e.message,
              'message',
              '無効なページ指定です',
            ),
          ),
        );
      }
      expect(r.client.fromTables, isEmpty);
    });
  });

  group('SettingsRepository.updateAutoStockCategories', () {
    test('payload は auto_stock_categories のみ + household eq スコープ', () async {
      final r = _repo();

      await r.repo.updateAutoStockCategories(
        householdId: 'hh-1',
        categories: ['baby', 'other_daily'],
      );

      expect(r.client.fromTables, ['households']);
      expect(r.households.lastUpdateValues, {
        'auto_stock_categories': ['baby', 'other_daily'],
      });
      expect(r.householdsMutation.eqFilters, [(column: 'id', value: 'hh-1')]);
      expect(r.householdsMutation.selectedColumns, 'id');
    });

    test('空リストは受理する (全カテゴリ OFF — web every([]) は true)', () async {
      final r = _repo();

      await r.repo.updateAutoStockCategories(
        householdId: 'hh-1',
        categories: const [],
      );

      expect(r.households.lastUpdateValues, {
        'auto_stock_categories': <String>[],
      });
    });

    test('不正カテゴリ混入は reject され DB へ到達しない (文言は web と同一)', () async {
      final r = _repo();

      for (final categories in [
        ['baby', 'vegetable'], // 食品カテゴリは対象外
        ['unknown'],
        ['BABY'], // 大文字は別値
      ]) {
        await expectLater(
          r.repo.updateAutoStockCategories(
            householdId: 'hh-1',
            categories: categories,
          ),
          throwsA(
            isA<ArgumentError>().having(
              (e) => e.message,
              'message',
              '無効なカテゴリが含まれています',
            ),
          ),
        );
      }
      expect(r.client.fromTables, isEmpty);
    });
  });

  group('SettingsRepository.updateBabyProfile', () {
    test('payload は baby_name / baby_birth_date + household eq スコープ', () async {
      final r = _repo();

      await r.repo.updateBabyProfile(
        householdId: 'hh-1',
        babyName: ' はな ', // trim される (web: babyName.trim() || null)
        babyBirthDate: '2026-01-15',
      );

      expect(r.client.fromTables, ['households']);
      expect(r.households.lastUpdateValues, {
        'baby_name': 'はな',
        'baby_birth_date': '2026-01-15',
      });
      expect(r.householdsMutation.eqFilters, [(column: 'id', value: 'hh-1')]);
      expect(r.householdsMutation.selectedColumns, 'id');
    });

    test('空の名前 / 生年月日は null として保存する (web parity)', () async {
      final r = _repo();

      await r.repo.updateBabyProfile(
        householdId: 'hh-1',
        babyName: '   ',
        babyBirthDate: '',
      );

      expect(r.households.lastUpdateValues, {
        'baby_name': null,
        'baby_birth_date': null,
      });
    });

    test('null の生年月日も null として保存する', () async {
      final r = _repo();

      await r.repo.updateBabyProfile(householdId: 'hh-1', babyName: 'はな');

      expect(r.households.lastUpdateValues, {
        'baby_name': 'はな',
        'baby_birth_date': null,
      });
    });

    test('YYYY-MM-DD 以外の生年月日は reject され DB へ到達しない', () async {
      final r = _repo();

      for (final birth in [
        '2026/01/15',
        '2026-1-15',
        'abc',
        '2026-01-15T00:00:00',
        ' 2026-01-15', // web は trim 前の値を regex 検証するため空白付きは不正
      ]) {
        await expectLater(
          r.repo.updateBabyProfile(
            householdId: 'hh-1',
            babyName: 'はな',
            babyBirthDate: birth,
          ),
          throwsA(
            isA<ArgumentError>().having(
              (e) => e.message,
              'message',
              '生年月日の形式が不正です',
            ),
          ),
        );
      }
      expect(r.client.fromTables, isEmpty);
    });

    test('PostgrestException (DB CHECK 違反等) は握り潰されず rethrow される', () async {
      // chk_baby_birth_date (birth <= CURRENT_DATE) 違反は 23514 で返る。
      // user-facing 文言への丸めは UI 層の責務 (web parity)。
      final r = _repo(
        mutationError: const PostgrestException(
          message: 'check',
          code: '23514',
        ),
      );

      await expectLater(
        r.repo.updateBabyProfile(
          householdId: 'hh-1',
          babyName: 'はな',
          babyBirthDate: '2026-01-15',
        ),
        throwsA(
          isA<PostgrestException>().having((e) => e.code, 'code', '23514'),
        ),
      );
    });
  });
}
