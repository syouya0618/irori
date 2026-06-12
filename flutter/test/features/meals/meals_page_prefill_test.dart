import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:irori/core/domain/item_category.dart';
import 'package:irori/features/meals/data/meals_repository.dart';
import 'package:irori/features/meals/data/meals_week_notifier.dart';
import 'package:irori/features/meals/data/pending_template_prefill_provider.dart';
import 'package:irori/features/meals/domain/meal.dart';
import 'package:irori/features/meals/domain/meal_template.dart';
import 'package:irori/features/meals/presentation/meals_page.dart';
import 'package:irori/features/meals/presentation/widgets/meal_form_sheet.dart';

/// 在庫タブ「献立に追加」→ MealsPage の prefill 消費 (PR P2.5-F) のテスト。
///
/// web 原典 `meal-week-view.tsx:66-100`:
/// - `?template=` を 1 回だけ処理 (`hasProcessedUrlTemplate` ref)
/// - 成功時: 今日 + dinner + prefill で sheet open
/// - 処理後は `router.replace("/meals")` でパラメータ消去
///   (リロード/再 build で再 open しない)

/// 固定リストを返す AsyncNotifier (meals_page_test の流儀)。
class _FakeWeekNotifier extends MealsWeekNotifier {
  _FakeWeekNotifier(this._meals);

  final List<Meal> _meals;

  @override
  Future<List<Meal>> build() async => _meals;
}

/// prefill を初期値として持つ Notifier (「献立タブ未訪問のうちに在庫タブから
/// 積まれた」状況の再現)。
class _SeededPrefillNotifier extends PendingTemplatePrefillNotifier {
  _SeededPrefillNotifier(this._seed);

  final MealTemplatePrefill _seed;

  @override
  MealTemplatePrefill? build() => _seed;
}

const _prefill = (
  title: 'カレーライス',
  ingredients: [
    MealIngredient(
      name: '玉ねぎ',
      quantity: '2個',
      category: ItemCategory.vegetable,
    ),
  ],
);

Widget _harness({MealTemplatePrefill? seeded}) {
  return ProviderScope(
    overrides: [
      mealsWeekNotifierProvider.overrideWith(() => _FakeWeekNotifier(const [])),
      mealsMutationContextProvider.overrideWith(
        (ref) async => (householdId: 'hh-1', userId: 'user-1'),
      ),
      if (seeded != null)
        pendingTemplatePrefillProvider.overrideWith(
          () => _SeededPrefillNotifier(seeded),
        ),
    ],
    child: const MaterialApp(home: MealsPage()),
  );
}

ProviderContainer _containerOf(WidgetTester tester) =>
    ProviderScope.containerOf(tester.element(find.byType(MealsPage)));

void main() {
  testWidgets('build 前に積まれた prefill は初回 frame 後に 1 回だけ消費され sheet が開く', (
    tester,
  ) async {
    await tester.pumpWidget(_harness(seeded: _prefill));
    await tester.pumpAndSettle();

    // 追加モードの sheet が prefill 済みで開く (web: 今日 + dinner + prefill)。
    expect(find.byType(MealFormSheet), findsOneWidget);
    expect(find.text('献立を追加'), findsOneWidget);
    expect(find.widgetWithText(TextField, 'カレーライス'), findsOneWidget);
    expect(find.widgetWithText(TextField, '玉ねぎ'), findsOneWidget);

    // 消費済み (web router.replace のパラメータ消去相当)。
    expect(_containerOf(tester).read(pendingTemplatePrefillProvider), isNull);
  });

  testWidgets('消費後の再 build では sheet が再 open しない (1 回消費保証)', (tester) async {
    await tester.pumpWidget(_harness(seeded: _prefill));
    await tester.pumpAndSettle();
    expect(find.byType(MealFormSheet), findsOneWidget);

    // sheet を閉じる (barrier タップ)。
    await tester.tapAt(const Offset(400, 20));
    await tester.pumpAndSettle();
    expect(find.byType(MealFormSheet), findsNothing);

    // MealsPage の再 build を誘発 (watch 中の週 notifier を invalidate)。
    _containerOf(tester).invalidate(mealsWeekNotifierProvider);
    await tester.pumpAndSettle();

    expect(find.byType(MealFormSheet), findsNothing);
  });

  testWidgets('ページ生存中に積まれた prefill は listen 経由で消費され sheet が開く', (
    tester,
  ) async {
    await tester.pumpWidget(_harness());
    await tester.pumpAndSettle();
    expect(find.byType(MealFormSheet), findsNothing);

    // 在庫タブ側の set を模擬 (MealsPage は IndexedStack で生存中の想定)。
    _containerOf(
      tester,
    ).read(pendingTemplatePrefillProvider.notifier).set(_prefill);
    await tester.pumpAndSettle();

    expect(find.byType(MealFormSheet), findsOneWidget);
    expect(find.widgetWithText(TextField, 'カレーライス'), findsOneWidget);
    expect(_containerOf(tester).read(pendingTemplatePrefillProvider), isNull);
  });
}
