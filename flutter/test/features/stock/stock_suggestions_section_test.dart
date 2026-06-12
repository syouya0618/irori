import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:irori/core/domain/item_category.dart';
import 'package:irori/core/domain/suggestions/types.dart';
import 'package:irori/features/meals/data/meals_repository.dart';
import 'package:irori/features/meals/data/pending_template_prefill_provider.dart';
import 'package:irori/features/meals/domain/meal.dart';
import 'package:irori/features/meals/domain/meal_template.dart';
import 'package:irori/features/stock/data/recipe_suggestions_provider.dart';
import 'package:irori/features/stock/presentation/widgets/stock_suggestions_section.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

/// `StockSuggestionsSection` (PR P2.5-F) の widget テスト。
///
/// web 原典 `stock-suggestions.tsx` + `suggestion-card.tsx`:
/// - matchRate バッジ 3 色閾値 (>=80 emerald / >=50 amber / 他 gray)
/// - 初期 5 件 + もっと見る（残りN件）/ 閉じる
/// - 空状態 2 行コピー
/// - 「献立に追加」→ loadTemplate → pendingTemplatePrefillProvider へ積む

/// 固定リストを返す AsyncNotifier (stock_page_test の流儀)。
class _FakeSuggestionsNotifier extends RecipeSuggestionsNotifier {
  _FakeSuggestionsNotifier(this._suggestions);

  final List<RecipeSuggestion> _suggestions;

  @override
  Future<List<RecipeSuggestion>> build() async => _suggestions;
}

class _FakeMealsRepository extends Fake implements MealsRepository {
  Object? loadError;
  ({String householdId, String templateId})? loadedTemplate;
  MealTemplatePrefill prefill = (title: '', ingredients: []);

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

RecipeSuggestion _suggestion(
  String id,
  String title, {
  double matchRate = 1.0,
  bool hasExpiringStock = false,
  List<MatchedIngredient> matched = const [],
  List<TemplateIngredient> missing = const [],
}) {
  return RecipeSuggestion(
    templateId: id,
    title: title,
    score: matchRate,
    scoreBreakdown: (matchRate: matchRate, expiryBonus: 0, reactionScore: 0),
    matchedIngredients: matched,
    missingIngredients: missing,
    hasExpiringStock: hasExpiringStock,
  );
}

Widget _harness({
  required List<RecipeSuggestion> suggestions,
  _FakeMealsRepository? repo,
}) {
  return ProviderScope(
    overrides: [
      recipeSuggestionsProvider.overrideWith(
        () => _FakeSuggestionsNotifier(suggestions),
      ),
      mealsRepositoryProvider.overrideWithValue(
        repo ?? _FakeMealsRepository(),
      ),
      mealsMutationContextProvider.overrideWith(
        (ref) async => (householdId: 'hh-1', userId: 'user-1'),
      ),
    ],
    child: const MaterialApp(
      home: Scaffold(
        body: SingleChildScrollView(child: StockSuggestionsSection()),
      ),
    ),
  );
}

/// カード全件 + もっと見るボタンが viewport に乗るよう縦長にする
/// (stock_page_test の `_useTallViewport` と同じ流儀)。
void _useTallViewport(WidgetTester tester) {
  tester.view.physicalSize = const Size(800, 2400);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
}

/// バッジ/チップの Container 背景色を取り出す。
Color? _decorationColor(WidgetTester tester, String text) {
  final container = tester.widget<Container>(
    find.ancestor(of: find.text(text), matching: find.byType(Container)).first,
  );
  return (container.decoration as BoxDecoration?)?.color;
}

void main() {
  group('matchRateBadgeColors (web matchRateBadgeClass の閾値)', () {
    test('80 以上は emerald-100/700', () {
      expect(
        matchRateBadgeColors(80),
        (
          background: const Color(0xFFD1FAE5),
          foreground: const Color(0xFF047857),
        ),
      );
      expect(matchRateBadgeColors(100).background, const Color(0xFFD1FAE5));
    });

    test('50 以上 80 未満は amber-100/700', () {
      expect(
        matchRateBadgeColors(79),
        (
          background: const Color(0xFFFEF3C7),
          foreground: const Color(0xFFB45309),
        ),
      );
      expect(matchRateBadgeColors(50).background, const Color(0xFFFEF3C7));
    });

    test('50 未満は gray-100/600', () {
      expect(
        matchRateBadgeColors(49),
        (
          background: const Color(0xFFF3F4F6),
          foreground: const Color(0xFF4B5563),
        ),
      );
      expect(matchRateBadgeColors(0).background, const Color(0xFFF3F4F6));
    });
  });

  testWidgets('バッジは matchRate に応じて 3 色 + %マッチ表記 (Math.round 相当)', (
    tester,
  ) async {
    await tester.pumpWidget(
      _harness(
        suggestions: [
          _suggestion('tpl-1', '高マッチ', matchRate: 0.9),
          _suggestion('tpl-2', '中マッチ', matchRate: 0.6),
          _suggestion('tpl-3', '低マッチ', matchRate: 0.333),
        ],
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('90%マッチ'), findsOneWidget);
    expect(find.text('60%マッチ'), findsOneWidget);
    expect(find.text('33%マッチ'), findsOneWidget);
    expect(_decorationColor(tester, '90%マッチ'), const Color(0xFFD1FAE5));
    expect(_decorationColor(tester, '60%マッチ'), const Color(0xFFFEF3C7));
    expect(_decorationColor(tester, '33%マッチ'), const Color(0xFFF3F4F6));
  });

  testWidgets('期限間近バッジ + マッチ食材チップ (isExpiring red / 他 emerald) + 不足チップ', (
    tester,
  ) async {
    await tester.pumpWidget(
      _harness(
        suggestions: [
          _suggestion(
            'tpl-1',
            'カレー',
            matchRate: 0.67,
            hasExpiringStock: true,
            matched: const [
              (name: '玉ねぎ', isExpiring: true),
              (name: 'にんじん', isExpiring: false),
            ],
            missing: const [
              TemplateIngredient(
                name: '豚肉',
                quantity: '200g',
                category: ItemCategory.meat,
              ),
            ],
          ),
        ],
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('期限間近'), findsOneWidget);
    expect(_decorationColor(tester, '期限間近'), const Color(0xFFFEE2E2));
    // マッチ食材チップ: isExpiring → red-50、それ以外 → emerald-50。
    expect(_decorationColor(tester, '玉ねぎ'), const Color(0xFFFEF2F2));
    expect(_decorationColor(tester, 'にんじん'), const Color(0xFFECFDF5));
    // 不足チップ。
    expect(find.text('不足:'), findsOneWidget);
    expect(find.text('豚肉'), findsOneWidget);
  });

  testWidgets('初期 5 件 + もっと見る（残りN件）→ 全件 + 閉じる → 5 件に戻る', (tester) async {
    _useTallViewport(tester);
    await tester.pumpWidget(
      _harness(
        suggestions: [
          for (var i = 1; i <= 7; i++) _suggestion('tpl-$i', '提案$i'),
        ],
      ),
    );
    await tester.pumpAndSettle();

    // ヘッダー件数は全 7 件。
    expect(find.text('7件'), findsOneWidget);
    expect(find.text('提案5'), findsOneWidget);
    expect(find.text('提案6'), findsNothing);
    expect(find.text('もっと見る（残り2件）'), findsOneWidget);

    await tester.tap(find.text('もっと見る（残り2件）'));
    await tester.pumpAndSettle();

    expect(find.text('提案6'), findsOneWidget);
    expect(find.text('提案7'), findsOneWidget);
    expect(find.text('閉じる'), findsOneWidget);

    await tester.tap(find.text('閉じる'));
    await tester.pumpAndSettle();

    expect(find.text('提案6'), findsNothing);
    expect(find.text('もっと見る（残り2件）'), findsOneWidget);
  });

  testWidgets('5 件以下なら「もっと見る」を出さない', (tester) async {
    await tester.pumpWidget(
      _harness(
        suggestions: [
          for (var i = 1; i <= 5; i++) _suggestion('tpl-$i', '提案$i'),
        ],
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('提案5'), findsOneWidget);
    expect(find.textContaining('もっと見る'), findsNothing);
  });

  testWidgets('空状態は web と同一の 2 行コピー (件数表示なし)', (tester) async {
    await tester.pumpWidget(_harness(suggestions: const []));
    await tester.pumpAndSettle();

    expect(find.text('おすすめ献立'), findsOneWidget);
    expect(find.text('0件'), findsNothing);
    expect(find.text('おすすめ献立がまだありません'), findsOneWidget);
    expect(
      find.text('献立を作成してテンプレート保存すると、在庫に合った提案が表示されます'),
      findsOneWidget,
    );
  });

  testWidgets('ヘッダータップで折りたたみ/展開できる', (tester) async {
    await tester.pumpWidget(
      _harness(suggestions: [_suggestion('tpl-1', 'カレー')]),
    );
    await tester.pumpAndSettle();

    expect(find.text('カレー'), findsOneWidget);
    expect(find.byIcon(LucideIcons.chevronDown), findsOneWidget);

    await tester.tap(find.text('おすすめ献立'));
    await tester.pumpAndSettle();

    expect(find.text('カレー'), findsNothing);
    expect(find.byIcon(LucideIcons.chevronRight), findsOneWidget);

    await tester.tap(find.text('おすすめ献立'));
    await tester.pumpAndSettle();

    expect(find.text('カレー'), findsOneWidget);
  });

  testWidgets('「献立に追加」で loadTemplate し prefill provider に積む', (tester) async {
    final repo = _FakeMealsRepository()
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
      _harness(suggestions: [_suggestion('tpl-1', 'カレー')], repo: repo),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.text('献立に追加'));
    await tester.pumpAndSettle();

    expect(repo.loadedTemplate, (householdId: 'hh-1', templateId: 'tpl-1'));
    final container = ProviderScope.containerOf(
      tester.element(find.byType(StockSuggestionsSection)),
    );
    final pending = container.read(pendingTemplatePrefillProvider);
    expect(pending, isNotNull);
    expect(pending!.title, 'カレー');
    expect(pending.ingredients.single.name, '玉ねぎ');
  });

  testWidgets('loadTemplate 失敗は web と同一文言で prefill を積まない', (tester) async {
    final repo = _FakeMealsRepository()..loadError = StateError('boom');
    await tester.pumpWidget(
      _harness(suggestions: [_suggestion('tpl-1', 'カレー')], repo: repo),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.text('献立に追加'));
    await tester.pumpAndSettle();

    expect(find.text('テンプレートが見つかりません。'), findsOneWidget);
    final container = ProviderScope.containerOf(
      tester.element(find.byType(StockSuggestionsSection)),
    );
    expect(container.read(pendingTemplatePrefillProvider), isNull);
  });
}
