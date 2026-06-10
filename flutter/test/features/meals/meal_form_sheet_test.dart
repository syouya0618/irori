import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:irori/core/domain/item_category.dart';
import 'package:irori/features/meals/data/meals_repository.dart';
import 'package:irori/features/meals/domain/meal.dart';
import 'package:irori/features/meals/presentation/widgets/meal_form_sheet.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

class _Repo extends Fake implements MealsRepository {
  /// 非 null なら create/update/delete がこの例外で失敗する。
  Object? error;

  ({
    String householdId,
    String userId,
    String date,
    MealType mealType,
    String title,
    bool isEatingOut,
    List<MealIngredient> ingredients,
  })?
  created;

  ({
    String householdId,
    String mealId,
    String date,
    MealType mealType,
    String title,
    bool isEatingOut,
    List<MealIngredient> ingredients,
  })?
  updated;

  ({String householdId, String mealId})? deleted;

  @override
  Future<String> createMeal({
    required String householdId,
    required String userId,
    required String date,
    required MealType mealType,
    required String title,
    required bool isEatingOut,
    List<MealIngredient> ingredients = const [],
  }) async {
    if (error != null) throw error!;
    created = (
      householdId: householdId,
      userId: userId,
      date: date,
      mealType: mealType,
      title: title,
      isEatingOut: isEatingOut,
      ingredients: ingredients,
    );
    return 'meal-new';
  }

  @override
  Future<void> updateMeal({
    required String householdId,
    required String mealId,
    required String date,
    required MealType mealType,
    required String title,
    required bool isEatingOut,
    List<MealIngredient> ingredients = const [],
  }) async {
    if (error != null) throw error!;
    updated = (
      householdId: householdId,
      mealId: mealId,
      date: date,
      mealType: mealType,
      title: title,
      isEatingOut: isEatingOut,
      ingredients: ingredients,
    );
  }

  @override
  Future<void> deleteMeal({
    required String householdId,
    required String mealId,
  }) async {
    if (error != null) throw error!;
    deleted = (householdId: householdId, mealId: mealId);
  }
}

Meal _existingMeal() {
  return const Meal(
    id: 'meal-1',
    date: '2026-06-09',
    mealType: MealType.dinner,
    title: '肉じゃが',
    isEatingOut: false,
    ingredients: [
      MealIngredient(
        name: 'じゃがいも',
        quantity: '3個',
        category: ItemCategory.vegetable,
      ),
    ],
  );
}

Widget _wrap({
  required _Repo repo,
  Meal? existing,
  String date = '2026-06-10',
  MealType mealType = MealType.dinner,
}) {
  return ProviderScope(
    overrides: [
      mealsRepositoryProvider.overrideWithValue(repo),
      mealsMutationContextProvider.overrideWith(
        (ref) async => (householdId: 'hh-1', userId: 'user-1'),
      ),
    ],
    child: MaterialApp(
      home: Scaffold(
        body: Consumer(
          builder: (context, ref, _) => FilledButton(
            onPressed: () {
              showMealFormSheet(
                context,
                ref,
                date: date,
                mealType: mealType,
                existing: existing,
              );
            },
            child: const Text('open'),
          ),
        ),
      ),
    ),
  );
}

void main() {
  group('MealFormSheet 追加モード', () {
    testWidgets('メニュー名が空の間は保存ボタンが disabled', (tester) async {
      final repo = _Repo();
      await tester.pumpWidget(_wrap(repo: repo));

      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();

      final disabledButton = tester.widget<FilledButton>(
        find.widgetWithText(FilledButton, '追加する'),
      );
      expect(disabledButton.onPressed, isNull);

      // 入力すると enabled になり、保存できる。
      await tester.enterText(
        find.widgetWithText(TextField, '例: カレーライス'),
        '  カレーライス  ',
      );
      await tester.pumpAndSettle();

      final enabledButton = tester.widget<FilledButton>(
        find.widgetWithText(FilledButton, '追加する'),
      );
      expect(enabledButton.onPressed, isNotNull);

      await tester.tap(find.text('追加する'));
      await tester.pumpAndSettle();

      // title は trim されて送信される (原典 handleSubmit と同じ)。
      expect(repo.created, isNotNull);
      expect(repo.created!.title, 'カレーライス');
      expect(repo.created!.date, '2026-06-10');
      expect(repo.created!.mealType, MealType.dinner);
      expect(repo.created!.householdId, 'hh-1');
      expect(repo.created!.userId, 'user-1');
      expect(find.text('献立を追加しました'), findsOneWidget);
    });

    testWidgets('食材行を追加・削除できる', (tester) async {
      final repo = _Repo();
      await tester.pumpWidget(_wrap(repo: repo));

      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();

      // 空状態の破線風ボタンから 1 行目を追加。
      expect(find.text('食材を追加'), findsOneWidget);
      await tester.ensureVisible(find.text('食材を追加'));
      await tester.tap(find.text('食材を追加'));
      await tester.pumpAndSettle();
      expect(find.byIcon(LucideIcons.trash2), findsOneWidget);
      expect(find.text('食材を追加'), findsNothing);

      // ヘッダの「追加」ボタンから 2 行目を追加。
      await tester.ensureVisible(find.text('追加'));
      await tester.tap(find.text('追加'));
      await tester.pumpAndSettle();
      expect(find.byIcon(LucideIcons.trash2), findsNWidgets(2));

      // 1 行削除すると 1 行に戻る。
      await tester.ensureVisible(find.byIcon(LucideIcons.trash2).first);
      await tester.tap(find.byIcon(LucideIcons.trash2).first);
      await tester.pumpAndSettle();
      expect(find.byIcon(LucideIcons.trash2), findsOneWidget);
    });

    testWidgets('名前が空の食材行は送信から除外される', (tester) async {
      final repo = _Repo();
      await tester.pumpWidget(_wrap(repo: repo));

      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();

      await tester.enterText(
        find.widgetWithText(TextField, '例: カレーライス'),
        'カレーライス',
      );
      await tester.ensureVisible(find.text('食材を追加'));
      await tester.tap(find.text('食材を追加'));
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('追加'));
      await tester.tap(find.text('追加'));
      await tester.pumpAndSettle();

      // 1 行目だけ名前を入れる (2 行目は空のまま)。
      await tester.ensureVisible(find.widgetWithText(TextField, '食材名').first);
      await tester.enterText(
        find.widgetWithText(TextField, '食材名').first,
        'にんじん',
      );
      await tester.tap(find.text('追加する'));
      await tester.pumpAndSettle();

      expect(repo.created, isNotNull);
      expect(repo.created!.ingredients, hasLength(1));
      expect(repo.created!.ingredients.single.name, 'にんじん');
      // 新規行の既定カテゴリは other_food (原典 addIngredient と同じ)。
      expect(
        repo.created!.ingredients.single.category,
        ItemCategory.otherFood,
      );
    });

    testWidgets('重複 (DuplicateMealException) は専用文言で sheet を閉じない', (
      tester,
    ) async {
      final repo = _Repo()..error = const DuplicateMealException();
      await tester.pumpWidget(_wrap(repo: repo));

      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();
      await tester.enterText(
        find.widgetWithText(TextField, '例: カレーライス'),
        'カレーライス',
      );
      // onChanged → setState で保存ボタンが enabled になるのを反映させる。
      await tester.pump();
      await tester.tap(find.text('追加する'));
      await tester.pumpAndSettle();

      expect(repo.created, isNull);
      expect(find.text('この日時のメニューは既に登録されています。'), findsOneWidget);
      // sheet は開いたまま (再編集できる)。
      expect(find.text('追加する'), findsOneWidget);
    });
  });

  group('MealFormSheet 編集モード', () {
    testWidgets('初期値が埋まり、更新で repository に渡る', (tester) async {
      final repo = _Repo();
      await tester.pumpWidget(_wrap(repo: repo, existing: _existingMeal()));

      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();

      expect(find.text('献立を編集'), findsOneWidget);
      expect(find.text('肉じゃが'), findsOneWidget);
      await tester.ensureVisible(find.text('じゃがいも'));
      expect(find.text('じゃがいも'), findsOneWidget);
      expect(find.text('3個'), findsOneWidget);
      // 編集対象の日付 2026-06-09 (火) が表示される。
      expect(find.text('6/9（火）'), findsOneWidget);

      await tester.tap(find.text('更新する'));
      await tester.pumpAndSettle();

      expect(repo.updated, isNotNull);
      expect(repo.updated!.mealId, 'meal-1');
      expect(repo.updated!.date, '2026-06-09');
      expect(repo.updated!.title, '肉じゃが');
      expect(repo.updated!.ingredients, hasLength(1));
      expect(repo.updated!.ingredients.single.quantity, '3個');
      expect(
        repo.updated!.ingredients.single.category,
        ItemCategory.vegetable,
      );
      expect(find.text('献立を更新しました'), findsOneWidget);
    });

    testWidgets('削除は確認ステップを挟んでから実行される', (tester) async {
      final repo = _Repo();
      await tester.pumpWidget(_wrap(repo: repo, existing: _existingMeal()));

      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();

      await tester.ensureVisible(find.text('この献立を削除'));
      await tester.tap(find.text('この献立を削除'));
      await tester.pumpAndSettle();

      expect(find.text('本当に削除しますか？'), findsOneWidget);
      expect(repo.deleted, isNull);

      await tester.ensureVisible(find.text('削除する'));
      await tester.tap(find.text('削除する'));
      await tester.pumpAndSettle();

      expect(repo.deleted, (householdId: 'hh-1', mealId: 'meal-1'));
      expect(find.text('献立を削除しました'), findsOneWidget);
    });

    testWidgets('削除確認はキャンセルで戻れる', (tester) async {
      final repo = _Repo();
      await tester.pumpWidget(_wrap(repo: repo, existing: _existingMeal()));

      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('この献立を削除'));
      await tester.tap(find.text('この献立を削除'));
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('キャンセル'));
      await tester.tap(find.text('キャンセル'));
      await tester.pumpAndSettle();

      expect(find.text('本当に削除しますか？'), findsNothing);
      expect(find.text('この献立を削除'), findsOneWidget);
      expect(repo.deleted, isNull);
    });
  });
}
