import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:irori/core/domain/item_category.dart';
import 'package:irori/core/domain/suggestions/types.dart';
import 'package:irori/features/meals/data/meals_repository.dart';
import 'package:irori/features/meals/domain/meal.dart';
import 'package:irori/features/meals/domain/meal_template.dart';
import 'package:irori/features/meals/presentation/widgets/template_selector_dialog.dart';
import 'package:irori/features/stock/data/recipe_suggestions_provider.dart';

/// テンプレート選択ダイアログ「在庫から提案」タブ (PR P2.5-F) のテスト。
///
/// web 原典 `template-selector.tsx` (Tabs) + `suggestion-list-in-dialog.tsx`:
/// - タブ 2 枚 (テンプレート / 在庫から提案) + タブ別の説明文
/// - 提案行: title + {p}% バッジ + 期限間近 + マッチ食材チップ
///   (不足チップ・「献立に追加」ボタンは出さない)
/// - 行タップ → loadTemplate → prefill を返して close
/// - 空状態「おすすめ献立がありません」「在庫に合うテンプレートが見つかりませんでした」
/// - open ごとに provider を invalidate (E のテンプレート一覧と同じ裁定)

class _Repo extends Fake implements MealsRepository {
  List<MealTemplate> templates = [];
  Object? loadError;
  ({String householdId, String templateId})? loadedTemplate;
  MealTemplatePrefill prefill = (title: '', ingredients: []);

  @override
  Future<List<MealTemplate>> getTemplates(String householdId) async =>
      templates;

  @override
  Future<MealTemplatePrefill> loadTemplate({
    required String householdId,
    required String templateId,
  }) async {
    if (loadError != null) throw loadError!;
    loadedTemplate = (householdId: householdId, templateId: templateId);
    return prefill;
  }
}

/// 固定リストを返す fake notifier。build 回数で invalidate を検証する。
class _FakeSuggestionsNotifier extends RecipeSuggestionsNotifier {
  _FakeSuggestionsNotifier(this._suggestions, this._onBuild);

  final List<RecipeSuggestion> _suggestions;
  final void Function() _onBuild;

  @override
  Future<List<RecipeSuggestion>> build() async {
    _onBuild();
    return _suggestions;
  }
}

RecipeSuggestion _suggestion(
  String id,
  String title, {
  double matchRate = 1.0,
  bool hasExpiringStock = false,
  List<MatchedIngredient> matched = const [],
}) {
  return RecipeSuggestion(
    templateId: id,
    title: title,
    score: matchRate,
    scoreBreakdown: (matchRate: matchRate, expiryBonus: 0, reactionScore: 0),
    matchedIngredients: matched,
    missingIngredients: const [],
    hasExpiringStock: hasExpiringStock,
  );
}

Widget _wrap({
  required _Repo repo,
  List<RecipeSuggestion> suggestions = const [],
  void Function()? onSuggestionsBuild,
  ValueChanged<MealTemplatePrefill?>? onResult,
}) {
  return ProviderScope(
    overrides: [
      mealsRepositoryProvider.overrideWithValue(repo),
      mealsMutationContextProvider.overrideWith(
        (ref) async => (householdId: 'hh-1', userId: 'user-1'),
      ),
      recipeSuggestionsProvider.overrideWith(
        () =>
            _FakeSuggestionsNotifier(suggestions, onSuggestionsBuild ?? () {}),
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
  testWidgets('タブ 2 枚 + タブ切替で説明文が web と同一文言で切り替わる', (tester) async {
    final repo = _Repo();
    await tester.pumpWidget(_wrap(repo: repo));

    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();

    expect(find.text('テンプレート'), findsOneWidget);
    expect(find.text('在庫から提案'), findsOneWidget);
    expect(find.text('保存済みのテンプレートを選択してください'), findsOneWidget);

    await tester.tap(find.text('在庫から提案'));
    await tester.pumpAndSettle();

    expect(find.text('在庫に合ったおすすめ献立を選択してください'), findsOneWidget);
    expect(find.text('保存済みのテンプレートを選択してください'), findsNothing);

    await tester.tap(find.text('テンプレート'));
    await tester.pumpAndSettle();

    expect(find.text('保存済みのテンプレートを選択してください'), findsOneWidget);
  });

  testWidgets('提案行は title + %バッジ + 期限間近 + マッチ食材チップを表示する', (tester) async {
    final repo = _Repo();
    await tester.pumpWidget(
      _wrap(
        repo: repo,
        suggestions: [
          _suggestion(
            'tpl-1',
            'カレー',
            matchRate: 0.67,
            hasExpiringStock: true,
            matched: const [(name: '玉ねぎ', isExpiring: true)],
          ),
          _suggestion('tpl-2', 'サラダ', matchRate: 0.4),
        ],
      ),
    );

    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('在庫から提案'));
    await tester.pumpAndSettle();

    expect(find.text('カレー'), findsOneWidget);
    // ダイアログ行のバッジは % のみ (suggestion-list-in-dialog.tsx — section の
    // %マッチ とは表記が違う)。
    expect(find.text('67%'), findsOneWidget);
    expect(find.text('期限間近'), findsOneWidget);
    expect(find.text('玉ねぎ'), findsOneWidget);
    expect(find.text('サラダ'), findsOneWidget);
    expect(find.text('40%'), findsOneWidget);
    // 「献立に追加」ボタンは section 専用 (web 同様、行タップで選択)。
    expect(find.text('献立に追加'), findsNothing);
  });

  testWidgets('提案行タップで loadTemplate され prefill を返して閉じる', (tester) async {
    MealTemplatePrefill? result;
    var resultCalled = false;
    final repo = _Repo()
      ..prefill = (
        title: 'カレー',
        ingredients: const [
          MealIngredient(
            name: '玉ねぎ',
            quantity: '2個',
            category: ItemCategory.vegetable,
          ),
        ],
      );
    await tester.pumpWidget(
      _wrap(
        repo: repo,
        suggestions: [_suggestion('tpl-1', 'カレー')],
        onResult: (r) {
          resultCalled = true;
          result = r;
        },
      ),
    );

    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('在庫から提案'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('カレー'));
    await tester.pumpAndSettle();

    expect(repo.loadedTemplate, (householdId: 'hh-1', templateId: 'tpl-1'));
    expect(resultCalled, isTrue);
    expect(result, isNotNull);
    expect(result!.title, 'カレー');
    expect(result!.ingredients.single.name, '玉ねぎ');
    expect(find.text('在庫に合ったおすすめ献立を選択してください'), findsNothing);
  });

  testWidgets('loadTemplate 失敗は web と同一文言でダイアログを閉じない', (tester) async {
    final repo = _Repo()..loadError = StateError('boom');
    await tester.pumpWidget(
      _wrap(repo: repo, suggestions: [_suggestion('tpl-1', 'カレー')]),
    );

    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('在庫から提案'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('カレー'));
    await tester.pumpAndSettle();

    expect(find.text('テンプレートが見つかりません。'), findsOneWidget);
    expect(find.text('在庫に合ったおすすめ献立を選択してください'), findsOneWidget);
  });

  testWidgets('提案 0 件は web と同一文言の空状態を出す', (tester) async {
    final repo = _Repo();
    await tester.pumpWidget(_wrap(repo: repo));

    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('在庫から提案'));
    await tester.pumpAndSettle();

    expect(find.text('おすすめ献立がありません'), findsOneWidget);
    expect(find.text('在庫に合うテンプレートが見つかりませんでした'), findsOneWidget);
  });

  testWidgets('open ごとに提案 provider を invalidate して refetch する', (tester) async {
    var buildCount = 0;
    final repo = _Repo();
    await tester.pumpWidget(
      _wrap(
        repo: repo,
        suggestions: [_suggestion('tpl-1', 'カレー')],
        onSuggestionsBuild: () => buildCount++,
      ),
    );

    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('在庫から提案'));
    await tester.pumpAndSettle();
    expect(buildCount, 1, reason: 'タブ表示で初回 build');

    await tester.tap(find.text('キャンセル'));
    await tester.pumpAndSettle();

    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('在庫から提案'));
    await tester.pumpAndSettle();

    expect(buildCount, 2, reason: '再 open の invalidate で refetch されるはず');
  });
}
