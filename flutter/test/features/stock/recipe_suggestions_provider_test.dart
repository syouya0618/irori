import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:irori/core/domain/item_category.dart';
import 'package:irori/core/supabase/supabase_providers.dart';
import 'package:irori/features/meals/data/meals_repository.dart';
import 'package:irori/features/meals/domain/meal.dart';
import 'package:irori/features/meals/domain/meal_template.dart';
import 'package:irori/features/stock/data/recipe_suggestions_provider.dart';
import 'package:irori/features/stock/data/stock_items_notifier.dart';
import 'package:irori/features/stock/domain/stock_item.dart';

/// `recipeSuggestionsProvider` (PR P2.5-F) のテスト。
///
/// web 原典 `stock-suggestions.tsx:44-75` の stale 防御:
/// (a) 在庫変化 → 1000ms デバウンス後 1 回だけ再計算 (クエリストーム防止)
/// (b) 世代ガードで古い fetch 結果を破棄
/// (c) reactionMap 集約 (template_id null 行 skip — recipe-suggestion-queries.ts:60)
/// (d) ingredients 非配列テンプレ → 除外 (matchRate 0)

/// 在庫ソースの fake。`build` を override するため realtime subscribe は
/// 走らない (stock_page_test の `_FakeStockNotifier` と同じ流儀)。
/// [emit] で realtime 由来の state 変化を模擬する。
class _StockSource extends StockItemsNotifier {
  _StockSource(this._initial);

  final List<StockItem> _initial;

  @override
  Future<List<StockItem>> build() async => _initial;

  /// realtime reducer による state 更新の模擬 (新リスト参照で置換)。
  void emit(List<StockItem> items) => state = AsyncData(items);
}

/// `MealsRepository` の fake (template_selector_dialog_test の `_Repo` と
/// 同じ流儀 + 呼び出し回数 / gate 制御)。
class _FakeMealsRepository extends Fake implements MealsRepository {
  List<MealTemplate> templates = [];
  List<TemplateReactionRow> reactionRows = [];

  int getTemplatesCallCount = 0;
  int fetchReactionsCallCount = 0;

  /// 非空なら `getTemplates` は呼び出しごとに先頭の completer を消費して
  /// その future を返す (世代ガード検証用 — 完了順をテストが制御する)。
  final List<Completer<List<MealTemplate>>> templateGates = [];

  @override
  Future<List<MealTemplate>> getTemplates(String householdId) {
    getTemplatesCallCount++;
    if (templateGates.isNotEmpty) {
      return templateGates.removeAt(0).future;
    }
    return Future.value(templates);
  }

  @override
  Future<List<TemplateReactionRow>> fetchTemplateReactions(
    String householdId,
  ) async {
    fetchReactionsCallCount++;
    return reactionRows;
  }
}

StockItem _stock(String id, String name, {String? expiresAt}) {
  return StockItem(
    id: id,
    householdId: 'hh-1',
    name: name,
    category: ItemCategory.vegetable,
    quantity: 1,
    expiresAt: expiresAt,
    createdBy: 'user-1',
    createdAt: DateTime.utc(2026, 6, 10),
  );
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
    createdAt: DateTime.utc(2026, 6, 10),
  );
}

MealIngredient _ingredient(String name) =>
    MealIngredient(name: name, category: ItemCategory.vegetable);

({ProviderContainer container, _FakeMealsRepository repo, _StockSource stock})
_makeContainer({
  List<StockItem> initialStock = const [],
  _FakeMealsRepository? repo,
}) {
  final fakeRepo = repo ?? _FakeMealsRepository();
  final stockSource = _StockSource(initialStock);
  final container = ProviderContainer(
    overrides: [
      currentHouseholdIdProvider.overrideWith((ref) async => 'hh-1'),
      stockItemsNotifierProvider.overrideWith(() => stockSource),
      mealsRepositoryProvider.overrideWithValue(fakeRepo),
    ],
  );
  return (container: container, repo: fakeRepo, stock: stockSource);
}

void main() {
  test('デバウンス既定値は web の 1000ms (stock-suggestions.tsx:67)', () {
    expect(
      RecipeSuggestionsNotifier.kStockChangeDebounce,
      const Duration(milliseconds: 1000),
    );
  });

  test('初回 build: 在庫 + templates/reactions から rankSuggestions を計算する', () async {
    final h = _makeContainer(initialStock: [_stock('s1', '玉ねぎ')]);
    addTearDown(h.container.dispose);
    h.repo.templates = [
      _template('tpl-1', 'カレー', ingredients: [_ingredient('玉ねぎ')]),
    ];

    final result = await h.container.read(recipeSuggestionsProvider.future);

    expect(result, hasLength(1));
    expect(result.single.templateId, 'tpl-1');
    expect(result.single.title, 'カレー');
    expect(result.single.scoreBreakdown.matchRate, 1.0);
    expect(h.repo.getTemplatesCallCount, 1);
    expect(h.repo.fetchReactionsCallCount, 1);
  });

  test('(a) 在庫変化の連打 → デバウンス窓内は再計算せず、窓経過後に 1 回だけ再計算する', () async {
    final h = _makeContainer(initialStock: [_stock('s1', '玉ねぎ')]);
    addTearDown(h.container.dispose);
    h.repo.templates = [
      _template('tpl-1', 'カレー', ingredients: [_ingredient('玉ねぎ')]),
      _template('tpl-2', 'サラダ', ingredients: [_ingredient('トマト')]),
    ];

    final initial = await h.container.read(recipeSuggestionsProvider.future);
    // 初回: トマト在庫なし → サラダは matchRate 0 で除外。
    expect(initial.map((s) => s.templateId), ['tpl-1']);
    expect(h.repo.getTemplatesCallCount, 1);

    // テストではデバウンス窓を短縮する (既定 1000ms は別テストで pin 済み)。
    final notifier = h.container.read(recipeSuggestionsProvider.notifier);
    notifier.debugDebounceDuration = const Duration(milliseconds: 40);

    // realtime 連打 (買い物チェック連打相当): 窓内 3 連発。
    h.stock.emit([_stock('s1', '玉ねぎ'), _stock('s2', 'トマト')]);
    h.stock.emit([_stock('s1', '玉ねぎ'), _stock('s2', 'トマト')]);
    h.stock.emit([_stock('s1', '玉ねぎ'), _stock('s2', 'トマト')]);

    // 窓内: まだ再計算されない (event ごとに 2 select 走るクエリストーム防止)。
    expect(h.repo.getTemplatesCallCount, 1);
    expect(h.repo.fetchReactionsCallCount, 1);

    await Future<void>.delayed(const Duration(milliseconds: 200));

    // 窓経過後: 1 回だけ再計算され、最新在庫でランクされる。
    expect(h.repo.getTemplatesCallCount, 2);
    expect(h.repo.fetchReactionsCallCount, 2);
    final state = h.container.read(recipeSuggestionsProvider);
    expect(state.value!.map((s) => s.templateId), ['tpl-1', 'tpl-2']);
  });

  test('(b) 世代ガード: 古い再計算の fetch 結果は破棄され、新しい結果が残る', () async {
    final h = _makeContainer(initialStock: [_stock('s1', '玉ねぎ')]);
    addTearDown(h.container.dispose);
    h.repo.templates = [
      _template('tpl-old', '初回', ingredients: [_ingredient('玉ねぎ')]),
    ];

    await h.container.read(recipeSuggestionsProvider.future);
    final notifier = h.container.read(recipeSuggestionsProvider.notifier);
    notifier.debugDebounceDuration = const Duration(milliseconds: 20);

    // 再計算 #1 (遅い fetch): gate1 で完了をテストが握る。
    final gate1 = Completer<List<MealTemplate>>();
    h.repo.templateGates.add(gate1);
    h.stock.emit([_stock('s1', '玉ねぎ'), _stock('s2', 'トマト')]);
    await Future<void>.delayed(const Duration(milliseconds: 80));
    expect(h.repo.getTemplatesCallCount, 2, reason: '再計算 #1 が開始しているはず');

    // 再計算 #2 (新しい世代): gate2。
    final gate2 = Completer<List<MealTemplate>>();
    h.repo.templateGates.add(gate2);
    h.stock.emit([_stock('s1', '玉ねぎ'), _stock('s3', 'なす')]);
    await Future<void>.delayed(const Duration(milliseconds: 80));
    expect(h.repo.getTemplatesCallCount, 3, reason: '再計算 #2 が開始しているはず');

    // 新しい世代 (#2) が先に完了 → state に反映される。
    gate2.complete([
      _template('tpl-new', '新世代', ingredients: [_ingredient('玉ねぎ')]),
    ]);
    await Future<void>.delayed(const Duration(milliseconds: 20));
    expect(
      h.container.read(recipeSuggestionsProvider).value!.single.templateId,
      'tpl-new',
    );

    // 古い世代 (#1) が遅れて完了 → 世代ガードで破棄され、上書きされない。
    gate1.complete([
      _template('tpl-stale', '旧世代', ingredients: [_ingredient('玉ねぎ')]),
    ]);
    await Future<void>.delayed(const Duration(milliseconds: 20));
    expect(
      h.container.read(recipeSuggestionsProvider).value!.single.templateId,
      'tpl-new',
      reason: '古い fetch 結果 (tpl-stale) は世代ガードで破棄されるはず',
    );
  });

  test('(c) reactionMap 集約: template_id null 行は skip し、同一 id は合算する', () async {
    final h = _makeContainer(initialStock: [_stock('s1', '玉ねぎ')]);
    addTearDown(h.container.dispose);
    h.repo.templates = [
      _template('tpl-1', 'カレー', ingredients: [_ingredient('玉ねぎ')]),
    ];
    h.repo.reactionRows = [
      (templateId: 'tpl-1', reactions: [MealReaction.good, MealReaction.good]),
      // null 行が skip されなければ bad がどこかに紛れて score が狂う。
      (templateId: null, reactions: [MealReaction.bad]),
      (templateId: 'tpl-1', reactions: [MealReaction.good]),
      // 在庫にマッチしないテンプレの行は無害 (rank 対象外)。
      (templateId: 'tpl-unknown', reactions: [MealReaction.bad]),
    ];

    final result = await h.container.read(recipeSuggestionsProvider.future);

    // good 3 件 × goodReactionBonus 0.05 = 0.15 (bad が混じれば 0.10 になる)。
    expect(result.single.scoreBreakdown.reactionScore, closeTo(0.15, 1e-9));
  });

  test('(d) ingredients 非配列テンプレ (防御パース後の空リスト) は matchRate 0 で除外される', () async {
    final h = _makeContainer(initialStock: [_stock('s1', '玉ねぎ')]);
    addTearDown(h.container.dispose);
    h.repo.templates = [
      // 破損 JSONB を MealTemplate.fromJson が空リストへ倒した状態と同じ
      // shape (mealTemplateIngredientsFromJson: 非配列 → [])。
      MealTemplate.fromJson(const {
        'id': 'tpl-broken',
        'title': '破損',
        'ingredients': 'not-an-array',
        'created_at': '2026-06-10T00:00:00+00:00',
      }),
      _template('tpl-ok', '正常', ingredients: [_ingredient('玉ねぎ')]),
    ];

    final result = await h.container.read(recipeSuggestionsProvider.future);

    expect(result.map((s) => s.templateId), ['tpl-ok']);
  });

  test('世帯未参加 (householdId null) は空リスト + fetch なし', () async {
    final repo = _FakeMealsRepository();
    final stockSource = _StockSource(const []);
    final container = ProviderContainer(
      overrides: [
        currentHouseholdIdProvider.overrideWith((ref) async => null),
        stockItemsNotifierProvider.overrideWith(() => stockSource),
        mealsRepositoryProvider.overrideWithValue(repo),
      ],
    );
    addTearDown(container.dispose);

    final result = await container.read(recipeSuggestionsProvider.future);

    expect(result, isEmpty);
    expect(repo.getTemplatesCallCount, 0);
  });

  test('再計算の fetch 失敗は前回データを保持する (web: 古い提案 + toast 相当)', () async {
    final h = _makeContainer(initialStock: [_stock('s1', '玉ねぎ')]);
    addTearDown(h.container.dispose);
    h.repo.templates = [
      _template('tpl-1', 'カレー', ingredients: [_ingredient('玉ねぎ')]),
    ];

    await h.container.read(recipeSuggestionsProvider.future);
    final notifier = h.container.read(recipeSuggestionsProvider.notifier);
    notifier.debugDebounceDuration = const Duration(milliseconds: 20);

    final gate = Completer<List<MealTemplate>>();
    h.repo.templateGates.add(gate);
    h.stock.emit([_stock('s1', '玉ねぎ'), _stock('s2', 'トマト')]);
    await Future<void>.delayed(const Duration(milliseconds: 80));

    gate.completeError(StateError('boom'));
    await Future<void>.delayed(const Duration(milliseconds: 20));

    final state = h.container.read(recipeSuggestionsProvider);
    expect(state.hasError, isFalse, reason: 'web parity: 古い提案を保持する');
    expect(state.value!.single.templateId, 'tpl-1');
  });
}
