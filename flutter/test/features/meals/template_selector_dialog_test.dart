import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:irori/core/domain/item_category.dart';
import 'package:irori/features/meals/data/meals_repository.dart';
import 'package:irori/features/meals/domain/meal.dart';
import 'package:irori/features/meals/domain/meal_template.dart';
import 'package:irori/features/meals/presentation/widgets/template_selector_dialog.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

class _Repo extends Fake implements MealsRepository {
  List<MealTemplate> templates = [];
  Object? templatesError;
  Object? loadError;
  Object? deleteError;

  int getTemplatesCallCount = 0;
  String? lastGetTemplatesHouseholdId;
  ({String householdId, String templateId})? loadedTemplate;
  ({String householdId, String templateId})? deletedTemplate;

  MealTemplatePrefill prefill = (title: '', ingredients: []);

  @override
  Future<List<MealTemplate>> getTemplates(String householdId) async {
    getTemplatesCallCount++;
    lastGetTemplatesHouseholdId = householdId;
    if (templatesError != null) throw templatesError!;
    return templates;
  }

  @override
  Future<MealTemplatePrefill> loadTemplate({
    required String householdId,
    required String templateId,
  }) async {
    if (loadError != null) throw loadError!;
    loadedTemplate = (householdId: householdId, templateId: templateId);
    return prefill;
  }

  @override
  Future<void> deleteTemplate({
    required String householdId,
    required String templateId,
  }) async {
    if (deleteError != null) throw deleteError!;
    deletedTemplate = (householdId: householdId, templateId: templateId);
  }
}

MealTemplate _template(
  String id,
  String title, {
  List<MealIngredient> ingredients = const [],
}) {
  return MealTemplate(
    id: id,
    title: title,
    ingredients: ingredients,
    createdAt: DateTime.parse('2026-06-10T12:00:00+00:00'),
  );
}

/// open ボタン付きのハーネス。ダイアログの戻り値 (prefill) は [onResult] で
/// 受け取る。
Widget _wrap({
  required _Repo repo,
  ValueChanged<MealTemplatePrefill?>? onResult,
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
            onPressed: () async {
              final result = await showTemplateSelectorDialog(context, ref);
              onResult?.call(result);
            },
            child: const Text('open'),
          ),
        ),
      ),
    ),
  );
}

void main() {
  testWidgets('一覧が title + 食材数で表示される', (tester) async {
    final repo = _Repo()
      ..templates = [
        _template(
          'tpl-1',
          'カレーライス',
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
        ),
        _template('tpl-2', '肉じゃが'),
      ];
    await tester.pumpWidget(_wrap(repo: repo));

    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();

    expect(find.text('テンプレートから作成'), findsOneWidget);
    expect(find.text('保存済みのテンプレートを選択してください'), findsOneWidget);
    expect(find.text('カレーライス'), findsOneWidget);
    expect(find.text('食材 2品'), findsOneWidget);
    expect(find.text('肉じゃが'), findsOneWidget);
    expect(find.text('食材 0品'), findsOneWidget);
    expect(repo.lastGetTemplatesHouseholdId, 'hh-1');
  });

  testWidgets('行タップで loadTemplate され prefill を返して閉じる', (tester) async {
    MealTemplatePrefill? result;
    final repo = _Repo()
      ..templates = [_template('tpl-1', 'カレーライス')]
      ..prefill = (
        title: 'カレーライス',
        ingredients: const [
          MealIngredient(
            name: 'にんじん',
            quantity: '2本',
            category: ItemCategory.vegetable,
          ),
        ],
      );
    await tester.pumpWidget(_wrap(repo: repo, onResult: (r) => result = r));

    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('カレーライス'));
    await tester.pumpAndSettle();

    expect(
      repo.loadedTemplate,
      (householdId: 'hh-1', templateId: 'tpl-1'),
    );
    expect(result, isNotNull);
    expect(result!.title, 'カレーライス');
    expect(result!.ingredients.single.name, 'にんじん');
    expect(find.text('保存済みのテンプレートを選択してください'), findsNothing);
  });

  testWidgets('loadTemplate 失敗は web と同一文言でダイアログを閉じない', (tester) async {
    final repo = _Repo()
      ..templates = [_template('tpl-1', 'カレーライス')]
      ..loadError = StateError('load failed');
    await tester.pumpWidget(_wrap(repo: repo));

    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('カレーライス'));
    await tester.pumpAndSettle();

    // web は全失敗経路で「テンプレートが見つかりません。」に倒れる。
    expect(find.text('テンプレートが見つかりません。'), findsOneWidget);
    expect(find.text('保存済みのテンプレートを選択してください'), findsOneWidget);
  });

  testWidgets('行内ゴミ箱で deleteTemplate されローカル除去 + toast', (tester) async {
    final repo = _Repo()
      ..templates = [
        _template('tpl-1', 'カレーライス'),
        _template('tpl-2', '肉じゃが'),
      ];
    await tester.pumpWidget(_wrap(repo: repo));

    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();

    await tester.tap(find.byIcon(LucideIcons.trash2).first);
    await tester.pumpAndSettle();

    expect(
      repo.deletedTemplate,
      (householdId: 'hh-1', templateId: 'tpl-1'),
    );
    // web setTemplates(filter) 相当のローカル除去 (refetch しない)。
    expect(find.text('カレーライス'), findsNothing);
    expect(find.text('肉じゃが'), findsOneWidget);
    expect(find.text('テンプレートを削除しました'), findsOneWidget);
    expect(repo.getTemplatesCallCount, 1);
  });

  testWidgets('削除失敗は actions.ts と同一文言で行が残る', (tester) async {
    final repo = _Repo()
      ..templates = [_template('tpl-1', 'カレーライス')]
      ..deleteError = StateError('delete failed');
    await tester.pumpWidget(_wrap(repo: repo));

    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    await tester.tap(find.byIcon(LucideIcons.trash2));
    await tester.pumpAndSettle();

    expect(repo.deletedTemplate, isNull);
    expect(find.text('テンプレートの削除に失敗しました。'), findsOneWidget);
    expect(find.text('カレーライス'), findsOneWidget);
  });

  testWidgets('0 件は原典と同一文言の空状態を出す', (tester) async {
    final repo = _Repo();
    await tester.pumpWidget(_wrap(repo: repo));

    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();

    expect(find.text('テンプレートがまだありません'), findsOneWidget);
    expect(find.text('献立を作成後「テンプレートとして保存」できます'), findsOneWidget);
  });

  testWidgets('取得エラーは error 表示 + 再試行で復帰できる (rethrow 裁定の UI)', (tester) async {
    final repo = _Repo()
      ..templatesError = StateError('boom')
      ..templates = [_template('tpl-1', 'カレーライス')];
    await tester.pumpWidget(_wrap(repo: repo));

    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();

    // web は log + 空配列 (エラーでも「まだありません」表示) だが、Flutter は
    // エラーと 0 件を区別する意図的差異 (getTemplates doc)。
    expect(find.text('テンプレートの読み込みに失敗しました。'), findsOneWidget);
    expect(find.text('テンプレートがまだありません'), findsNothing);

    repo.templatesError = null;
    await tester.tap(find.text('再試行'));
    await tester.pumpAndSettle();

    expect(find.text('カレーライス'), findsOneWidget);
  });

  testWidgets('open のたびに invalidate → refetch される (realtime 非対象の裁定)', (
    tester,
  ) async {
    final repo = _Repo()..templates = [_template('tpl-1', 'カレーライス')];
    await tester.pumpWidget(_wrap(repo: repo));

    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    expect(repo.getTemplatesCallCount, 1);

    await tester.tap(find.text('キャンセル'));
    await tester.pumpAndSettle();

    // 他端末/web で追加されたテンプレートが次の open で届くこと。
    repo.templates = [
      _template('tpl-1', 'カレーライス'),
      _template('tpl-2', '肉じゃが'),
    ];
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();

    expect(repo.getTemplatesCallCount, 2);
    expect(find.text('肉じゃが'), findsOneWidget);
  });
}
