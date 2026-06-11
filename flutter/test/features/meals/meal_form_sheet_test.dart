import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:irori/core/domain/item_category.dart';
import 'package:irori/features/meals/data/meals_repository.dart';
import 'package:irori/features/meals/domain/meal.dart';
import 'package:irori/features/meals/domain/meal_template.dart';
import 'package:irori/features/meals/presentation/widgets/meal_form_sheet.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

class _Repo extends Fake implements MealsRepository {
  /// 非 null なら create/update/delete がこの例外で失敗する。
  Object? error;

  /// 非 null なら saveAsTemplate がこの例外で失敗する。
  Object? saveTemplateError;

  /// getTemplates が返す一覧 (選択ダイアログ用)。
  List<MealTemplate> templates = [];

  /// loadTemplate が返す prefill。
  MealTemplatePrefill prefill = (title: '', ingredients: []);

  ({String householdId, String userId, String mealId})? savedAsTemplate;
  ({String householdId, String templateId})? loadedTemplate;

  @override
  Future<String> saveAsTemplate({
    required String householdId,
    required String userId,
    required String mealId,
  }) async {
    if (saveTemplateError != null) throw saveTemplateError!;
    savedAsTemplate = (
      householdId: householdId,
      userId: userId,
      mealId: mealId,
    );
    return 'tpl-new';
  }

  @override
  Future<List<MealTemplate>> getTemplates(String householdId) async {
    return templates;
  }

  @override
  Future<MealTemplatePrefill> loadTemplate({
    required String householdId,
    required String templateId,
  }) async {
    loadedTemplate = (householdId: householdId, templateId: templateId);
    return prefill;
  }

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

  group('MealFormSheet テンプレート連携', () {
    testWidgets('追加モード: 「テンプレートから作成」のみ表示 (保存ボタンは編集時のみ)', (
      tester,
    ) async {
      final repo = _Repo();
      await tester.pumpWidget(_wrap(repo: repo));

      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();

      expect(find.text('テンプレートから作成'), findsOneWidget);
      expect(find.text('テンプレート保存'), findsNothing);
    });

    testWidgets('編集モード: 「テンプレート保存」で saveAsTemplate が呼ばれ sheet は閉じない', (
      tester,
    ) async {
      final repo = _Repo();
      await tester.pumpWidget(_wrap(repo: repo, existing: _existingMeal()));

      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();

      expect(find.text('テンプレート保存'), findsOneWidget);
      await tester.tap(find.text('テンプレート保存'));
      await tester.pumpAndSettle();

      expect(
        repo.savedAsTemplate,
        (householdId: 'hh-1', userId: 'user-1', mealId: 'meal-1'),
      );
      // 原典 handleSaveAsTemplate と同一文言。sheet は開いたまま。
      expect(find.text('テンプレートとして保存しました'), findsOneWidget);
      expect(find.text('更新する'), findsOneWidget);
    });

    testWidgets('テンプレート保存の失敗は actions.ts と同一文言で sheet を閉じない', (tester) async {
      final repo = _Repo()
        ..saveTemplateError = StateError('saveAsTemplate failed');
      await tester.pumpWidget(_wrap(repo: repo, existing: _existingMeal()));

      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('テンプレート保存'));
      await tester.pumpAndSettle();

      expect(repo.savedAsTemplate, isNull);
      expect(find.text('テンプレートの保存に失敗しました。'), findsOneWidget);
      expect(find.text('更新する'), findsOneWidget);
    });

    testWidgets('「テンプレートから作成」→ 行タップでメニュー名と食材がプリフィルされる', (tester) async {
      final repo = _Repo()
        ..templates = [
          MealTemplate(
            id: 'tpl-1',
            title: 'カレーライス',
            ingredients: const [
              MealIngredient(
                name: 'にんじん',
                quantity: '2本',
                category: ItemCategory.vegetable,
              ),
            ],
            createdAt: DateTime.parse('2026-06-10T12:00:00+00:00'),
          ),
        ]
        ..prefill = (
          title: 'カレーライス',
          ingredients: const [
            MealIngredient(
              name: 'にんじん',
              quantity: '2本',
              category: ItemCategory.vegetable,
            ),
            MealIngredient(
              name: '豚肉',
              quantity: null,
              category: ItemCategory.meat,
            ),
          ],
        );
      await tester.pumpWidget(_wrap(repo: repo));

      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('テンプレートから作成'));
      await tester.pumpAndSettle();

      // ダイアログに一覧 (title + 食材数) が出る。
      expect(find.text('保存済みのテンプレートを選択してください'), findsOneWidget);
      expect(find.text('食材 1品'), findsOneWidget);

      await tester.tap(find.text('カレーライス'));
      await tester.pumpAndSettle();

      // ダイアログが閉じ、フォームへプリフィルされる (原典 handleTemplateSelect)。
      expect(
        repo.loadedTemplate,
        (householdId: 'hh-1', templateId: 'tpl-1'),
      );
      expect(find.text('保存済みのテンプレートを選択してください'), findsNothing);
      expect(find.widgetWithText(TextField, 'カレーライス'), findsOneWidget);
      expect(find.widgetWithText(TextField, 'にんじん'), findsOneWidget);
      expect(find.widgetWithText(TextField, '豚肉'), findsOneWidget);

      // プリフィル後そのまま保存すると食材ごと repository に渡る。
      await tester.tap(find.text('追加する'));
      await tester.pumpAndSettle();
      expect(repo.created, isNotNull);
      expect(repo.created!.title, 'カレーライス');
      expect(repo.created!.ingredients, hasLength(2));
      expect(repo.created!.ingredients[1].name, '豚肉');
      // quantity null は空文字 controller 経由で '' → repository 側で null 化
      // される入力契約 (_validIngredients は raw 値を渡す)。
      expect(repo.created!.ingredients[1].quantity, '');
    });

    testWidgets('プリフィルは既存の食材行を置換する (継ぎ足さない)', (tester) async {
      final repo = _Repo()
        ..templates = [
          MealTemplate(
            id: 'tpl-1',
            title: 'うどん',
            ingredients: const [],
            createdAt: DateTime.parse('2026-06-10T12:00:00+00:00'),
          ),
        ]
        ..prefill = (
          title: 'うどん',
          ingredients: const [
            MealIngredient(
              name: 'ねぎ',
              quantity: null,
              category: ItemCategory.vegetable,
            ),
          ],
        );
      await tester.pumpWidget(_wrap(repo: repo, existing: _existingMeal()));

      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();
      expect(find.widgetWithText(TextField, 'じゃがいも'), findsOneWidget);

      await tester.tap(find.text('テンプレートから作成'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('うどん'));
      await tester.pumpAndSettle();

      expect(find.widgetWithText(TextField, 'うどん'), findsOneWidget);
      expect(find.widgetWithText(TextField, 'ねぎ'), findsOneWidget);
      // 既存の食材行 (じゃがいも) は置換されて消える (web setIngredients 同様)。
      expect(find.widgetWithText(TextField, 'じゃがいも'), findsNothing);
    });
  });
}
