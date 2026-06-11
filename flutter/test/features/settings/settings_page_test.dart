import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:irori/core/supabase/supabase_providers.dart';
import 'package:irori/core/theme/colors.dart';
import 'package:irori/features/settings/data/settings_provider.dart';
import 'package:irori/features/settings/data/settings_repository.dart';
import 'package:irori/features/settings/presentation/settings_page.dart';
import 'package:irori/features/settings/presentation/widgets/auto_stock_card.dart';
import 'package:irori/features/settings/presentation/widgets/baby_profile_card.dart';
import 'package:irori/features/settings/presentation/widgets/default_page_card.dart';
import 'package:irori/features/settings/presentation/widgets/profile_card.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import '../../support/fake_supabase.dart';

HouseholdSettings _settings({
  String displayName = '太郎',
  String role = 'owner',
  String defaultPage = 'meals',
  String? householdName = 'いろり家',
  List<String> autoStockCategories = const ['baby', 'cleaning', 'hygiene'],
  String? babyName = 'はな',
  String? babyBirthDate = '2026-01-15',
}) {
  return HouseholdSettings(
    displayName: displayName,
    role: role,
    defaultPage: defaultPage,
    householdId: 'hh-1',
    householdName: householdName,
    autoStockCategories: autoStockCategories,
    babyName: babyName,
    babyBirthDate: babyBirthDate,
  );
}

SettingsData _data({HouseholdSettings? settings}) =>
    (settings: settings ?? _settings(), email: 'taro@example.com');

/// 書き込み検証用の fake repository (`shopping_item_tile_test._Repo` の流儀)。
class _FakeSettingsRepository extends Fake implements SettingsRepository {
  Object? displayNameError;
  Object? defaultPageError;
  Object? autoStockError;
  Object? babyError;

  /// 非 null なら該当 update がこの Completer の完了まで停止する。
  Completer<void>? defaultPageGate;
  Completer<void>? autoStockGate;

  ({String userId, String displayName})? lastDisplayName;
  ({String userId, String page})? lastPage;
  ({String householdId, List<String> categories})? lastCategories;
  ({String householdId, String babyName, String? babyBirthDate})? lastBaby;

  @override
  Future<void> updateDisplayName({
    required String userId,
    required String displayName,
  }) async {
    lastDisplayName = (userId: userId, displayName: displayName);
    if (displayNameError != null) throw displayNameError!;
  }

  @override
  Future<void> updateDefaultPage({
    required String userId,
    required String page,
  }) async {
    lastPage = (userId: userId, page: page);
    if (defaultPageGate != null) await defaultPageGate!.future;
    if (defaultPageError != null) throw defaultPageError!;
  }

  @override
  Future<void> updateAutoStockCategories({
    required String householdId,
    required List<String> categories,
  }) async {
    lastCategories = (householdId: householdId, categories: categories);
    if (autoStockGate != null) await autoStockGate!.future;
    if (autoStockError != null) throw autoStockError!;
  }

  @override
  Future<void> updateBabyProfile({
    required String householdId,
    required String babyName,
    String? babyBirthDate,
  }) async {
    lastBaby = (
      householdId: householdId,
      babyName: babyName,
      babyBirthDate: babyBirthDate,
    );
    if (babyError != null) throw babyError!;
  }
}

Widget _harness({
  required _FakeSettingsRepository repo,
  FutureOr<SettingsData> Function(Ref ref)? data,
  FakeGoTrueClient? auth,
}) {
  final client = FakeSupabaseClient(auth: auth ?? FakeGoTrueClient());
  return ProviderScope(
    overrides: [
      supabaseClientProvider.overrideWithValue(client),
      settingsProvider.overrideWith(data ?? (ref) async => _data()),
      settingsRepositoryProvider.overrideWithValue(repo),
      settingsMutationContextProvider.overrideWith(
        (ref) async => (householdId: 'hh-1', userId: 'user-1'),
      ),
    ],
    child: const MaterialApp(home: SettingsPage()),
  );
}

/// 全カードがマウントされるよう縦長 viewport にする (stock_page_test の流儀)。
void _useTallViewport(WidgetTester tester) {
  tester.view.physicalSize = const Size(800, 3200);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
}

/// [card] 内の [label] テキストの色 (segment / chip の選択状態の観測点)。
Color? _labelColor(WidgetTester tester, Finder card, String label) {
  final text = tester.widget<Text>(
    find.descendant(of: card, matching: find.text(label)),
  );
  return text.style?.color;
}

ProviderContainer _containerOf(WidgetTester tester) =>
    ProviderScope.containerOf(tester.element(find.byType(SettingsPage)));

void main() {
  testWidgets('設定タイトル・5 カード・世帯名/役割・email を表示する', (tester) async {
    _useTallViewport(tester);
    await tester.pumpWidget(_harness(repo: _FakeSettingsRepository()));
    await tester.pumpAndSettle();

    expect(find.text('設定'), findsOneWidget);
    // カードタイトル (web settings-content.tsx のサブセット 5 枚 + 世帯表示)。
    expect(find.text('プロフィール'), findsOneWidget);
    expect(find.text('世帯'), findsOneWidget);
    expect(find.text('起動時のページ'), findsOneWidget);
    expect(find.text('在庫自動追加'), findsOneWidget);
    expect(find.text('赤ちゃん情報'), findsOneWidget);
    expect(find.text('ログアウト'), findsOneWidget);
    // 世帯名 + 役割ラベル (web roleLabels: owner → オーナー)。
    expect(find.text('いろり家'), findsOneWidget);
    expect(find.text('あなたの役割: オーナー'), findsOneWidget);
    expect(find.text('taro@example.com'), findsOneWidget);
    // 赤ちゃん情報の初期値。
    expect(find.text('2026-01-15'), findsOneWidget);
  });

  testWidgets('世帯名 null は「世帯名未設定」/ member は「メンバー」を表示する', (tester) async {
    _useTallViewport(tester);
    await tester.pumpWidget(
      _harness(
        repo: _FakeSettingsRepository(),
        data: (ref) async =>
            _data(settings: _settings(householdName: null, role: 'member')),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('世帯名未設定'), findsOneWidget);
    expect(find.text('あなたの役割: メンバー'), findsOneWidget);
  });

  group('プロフィールカード', () {
    testWidgets('表示名が空の間は保存ボタンが disabled になる', (tester) async {
      _useTallViewport(tester);
      await tester.pumpWidget(_harness(repo: _FakeSettingsRepository()));
      await tester.pumpAndSettle();

      final card = find.byType(ProfileCard);
      final field = find.descendant(of: card, matching: find.byType(TextField));
      final button = find.descendant(
        of: card,
        matching: find.byType(FilledButton),
      );

      // 初期値 '太郎' があるため enabled。
      expect(tester.widget<FilledButton>(button).onPressed, isNotNull);

      await tester.enterText(field, '');
      await tester.pump();
      expect(tester.widget<FilledButton>(button).onPressed, isNull);

      // 空白のみも disabled (trim 後判定 — web の required 相当)。
      await tester.enterText(field, '   ');
      await tester.pump();
      expect(tester.widget<FilledButton>(button).onPressed, isNull);

      await tester.enterText(field, '次郎');
      await tester.pump();
      expect(tester.widget<FilledButton>(button).onPressed, isNotNull);
    });

    testWidgets('保存で入力値が repository へ渡り、成功 SnackBar が出る', (tester) async {
      _useTallViewport(tester);
      final repo = _FakeSettingsRepository();
      await tester.pumpWidget(_harness(repo: repo));
      await tester.pumpAndSettle();

      final card = find.byType(ProfileCard);
      await tester.enterText(
        find.descendant(of: card, matching: find.byType(TextField)),
        ' 次郎 ',
      );
      await tester.tap(
        find.descendant(of: card, matching: find.byType(FilledButton)),
      );
      await tester.pumpAndSettle();

      // trim は repository 層の責務 (settings_repository_test で固定済み)。
      expect(repo.lastDisplayName, (userId: 'user-1', displayName: ' 次郎 '));
      expect(find.text('プロフィールを更新しました'), findsOneWidget);
    });

    testWidgets('保存失敗は web と同じ文言の SnackBar を出す', (tester) async {
      _useTallViewport(tester);
      final repo = _FakeSettingsRepository()
        ..displayNameError = const PostgrestException(
          message: 'boom',
          code: '500',
        );
      await tester.pumpWidget(_harness(repo: repo));
      await tester.pumpAndSettle();

      final card = find.byType(ProfileCard);
      await tester.tap(
        find.descendant(of: card, matching: find.byType(FilledButton)),
      );
      await tester.pumpAndSettle();

      expect(find.text('プロフィールの更新に失敗しました'), findsOneWidget);
    });
  });

  group('起動タブカード', () {
    testWidgets('タップで楽観反映され、成功時に repository とキャッシュへ伝播する', (tester) async {
      _useTallViewport(tester);
      final repo = _FakeSettingsRepository()..defaultPageGate = Completer();
      await tester.pumpWidget(_harness(repo: repo));
      await tester.pumpAndSettle();

      final card = find.byType(DefaultPageCard);
      // 初期は meals (献立) が選択状態。
      expect(_labelColor(tester, card, '献立'), Colors.white);
      expect(_labelColor(tester, card, '在庫'), IroriColors.textMuted);

      await tester.tap(find.descendant(of: card, matching: find.text('在庫')));
      await tester.pump();

      // gate 未完了 (= サーバ応答前) でも即時に選択が切り替わる (楽観更新)。
      expect(_labelColor(tester, card, '在庫'), Colors.white);
      expect(_labelColor(tester, card, '献立'), IroriColors.textMuted);
      expect(repo.lastPage, (userId: 'user-1', page: 'stock'));

      repo.defaultPageGate!.complete();
      await tester.pumpAndSettle();

      // 成功後も維持され、同期キャッシュ (router の /login redirect 用) が温まる。
      expect(_labelColor(tester, card, '在庫'), Colors.white);
      expect(
        _containerOf(tester).read(defaultPageCacheProvider).value,
        'stock',
      );
    });

    testWidgets('失敗時は元の選択へ巻き戻して SnackBar を出す', (tester) async {
      _useTallViewport(tester);
      final repo = _FakeSettingsRepository()
        ..defaultPageError = const PostgrestException(
          message: 'boom',
          code: '500',
        );
      await tester.pumpWidget(_harness(repo: repo));
      await tester.pumpAndSettle();

      final card = find.byType(DefaultPageCard);
      await tester.tap(find.descendant(of: card, matching: find.text('在庫')));
      await tester.pumpAndSettle();

      // web default-page-card.tsx: setSelected(defaultPage) で初期値へ巻き戻し。
      expect(_labelColor(tester, card, '献立'), Colors.white);
      expect(_labelColor(tester, card, '在庫'), IroriColors.textMuted);
      expect(find.text('設定の更新に失敗しました'), findsOneWidget);
      // キャッシュは温まらない。
      expect(_containerOf(tester).read(defaultPageCacheProvider).value, isNull);
    });
  });

  group('在庫自動追加カード', () {
    testWidgets('トグルは楽観反映され、成功時に repository へ全選択値が渡る', (tester) async {
      _useTallViewport(tester);
      final repo = _FakeSettingsRepository()..autoStockGate = Completer();
      await tester.pumpWidget(_harness(repo: repo));
      await tester.pumpAndSettle();

      final card = find.byType(AutoStockCategoriesCard);
      // 初期: baby/cleaning/hygiene ON、other_daily (その他) OFF。
      expect(_labelColor(tester, card, 'その他'), IroriColors.textMuted);

      await tester.tap(find.descendant(of: card, matching: find.text('その他')));
      await tester.pump();

      // gate 未完了でも即時 ON (楽観更新 — web auto-stock-card.tsx:43-51 流儀)。
      expect(_labelColor(tester, card, 'その他'), IroriColors.primary);
      // record 内の List は == が同一性比較のためフィールド個別に検証する。
      expect(repo.lastCategories?.householdId, 'hh-1');
      expect(repo.lastCategories?.categories, [
        'baby',
        'cleaning',
        'hygiene',
        'other_daily',
      ]);

      repo.autoStockGate!.complete();
      await tester.pumpAndSettle();
      expect(_labelColor(tester, card, 'その他'), IroriColors.primary);
    });

    testWidgets('失敗時は初期値へ巻き戻して SnackBar を出す', (tester) async {
      _useTallViewport(tester);
      // gate で「サーバ応答前の楽観 OFF 表示」を観測してから失敗させる。
      final repo = _FakeSettingsRepository()
        ..autoStockGate = Completer()
        ..autoStockError = const PostgrestException(
          message: 'boom',
          code: '500',
        );
      await tester.pumpWidget(_harness(repo: repo));
      await tester.pumpAndSettle();

      final card = find.byType(AutoStockCategoriesCard);
      // ON のカテゴリ (洗剤 = cleaning) を OFF にしようとして失敗するケース。
      expect(_labelColor(tester, card, '洗剤'), IroriColors.primary);

      await tester.tap(find.descendant(of: card, matching: find.text('洗剤')));
      await tester.pump();
      // 楽観的に OFF 表示。
      expect(_labelColor(tester, card, '洗剤'), IroriColors.textMuted);
      expect(repo.lastCategories?.householdId, 'hh-1');
      expect(repo.lastCategories?.categories, ['baby', 'hygiene']);

      repo.autoStockGate!.complete();
      await tester.pumpAndSettle();

      // web auto-stock-card.tsx: setSelected(new Set(initialCategories)) で
      // **初期値** へ巻き戻す (直前状態ではない)。
      expect(_labelColor(tester, card, '洗剤'), IroriColors.primary);
      expect(find.text('設定の更新に失敗しました'), findsOneWidget);
    });
  });

  group('赤ちゃん情報カード', () {
    testWidgets('保存で名前と生年月日が repository へ渡り、成功 SnackBar が出る', (tester) async {
      _useTallViewport(tester);
      final repo = _FakeSettingsRepository();
      await tester.pumpWidget(_harness(repo: repo));
      await tester.pumpAndSettle();

      final card = find.byType(BabyProfileCard);
      await tester.enterText(
        find.descendant(of: card, matching: find.byType(TextField)),
        'ひより',
      );
      await tester.tap(
        find.descendant(of: card, matching: find.byType(FilledButton)),
      );
      await tester.pumpAndSettle();

      expect(
        repo.lastBaby,
        (householdId: 'hh-1', babyName: 'ひより', babyBirthDate: '2026-01-15'),
      );
      expect(find.text('赤ちゃん情報を更新しました'), findsOneWidget);
    });

    testWidgets('失敗 (DB CHECK 違反含む) は web と同じ文言へ丸める', (tester) async {
      _useTallViewport(tester);
      // chk_baby_birth_date (birth <= CURRENT_DATE) 違反相当。
      final repo = _FakeSettingsRepository()
        ..babyError = const PostgrestException(message: 'check', code: '23514');
      await tester.pumpWidget(_harness(repo: repo));
      await tester.pumpAndSettle();

      final card = find.byType(BabyProfileCard);
      await tester.tap(
        find.descendant(of: card, matching: find.byType(FilledButton)),
      );
      await tester.pumpAndSettle();

      expect(find.text('赤ちゃん情報の更新に失敗しました'), findsOneWidget);
    });
  });

  group('サインアウト', () {
    testWidgets('ログアウトで signOut が呼ばれ、default_page キャッシュを破棄する', (tester) async {
      _useTallViewport(tester);
      final auth = FakeGoTrueClient();
      await tester.pumpWidget(
        _harness(repo: _FakeSettingsRepository(), auth: auth),
      );
      await tester.pumpAndSettle();

      // 端末共用時に他ユーザーの値で redirect しないことの検証用に温めておく。
      _containerOf(tester).read(defaultPageCacheProvider).value = 'stock';

      await tester.tap(find.text('ログアウト'));
      await tester.pumpAndSettle();

      expect(auth.signOutCallCount, 1);
      expect(_containerOf(tester).read(defaultPageCacheProvider).value, isNull);
    });

    testWidgets('signOut 失敗は SnackBar で表面化する (握り潰さない)', (tester) async {
      _useTallViewport(tester);
      final auth = FakeGoTrueClient()
        ..signOutError = const AuthException('boom');
      await tester.pumpWidget(
        _harness(repo: _FakeSettingsRepository(), auth: auth),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.text('ログアウト'));
      await tester.pumpAndSettle();

      expect(find.text('ログアウトに失敗しました'), findsOneWidget);
    });
  });

  group('loading / error 分岐', () {
    testWidgets('loading 中はインジケータを表示する', (tester) async {
      final never = Completer<SettingsData>();
      await tester.pumpWidget(
        _harness(repo: _FakeSettingsRepository(), data: (ref) => never.future),
      );
      await tester.pump();

      expect(find.byType(CircularProgressIndicator), findsOneWidget);

      // teardown: pending timer を残さない。
      never.complete(_data());
      await tester.pumpAndSettle();
    });

    testWidgets('error は読み込み失敗を告知し、再試行で refetch する', (tester) async {
      var fetchCount = 0;
      await tester.pumpWidget(
        _harness(
          repo: _FakeSettingsRepository(),
          data: (ref) async {
            fetchCount++;
            throw StateError('boom');
          },
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('設定の読み込みに失敗しました。'), findsOneWidget);
      expect(fetchCount, 1);

      await tester.tap(find.text('再試行'));
      await tester.pumpAndSettle();

      expect(fetchCount, 2);
    });
  });
}
