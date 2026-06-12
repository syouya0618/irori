import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:irori/core/domain/item_category.dart';
import 'package:irori/features/stock/data/consumption_rates_provider.dart';
import 'package:irori/features/stock/data/low_stock_check_store.dart';
import 'package:irori/features/stock/data/stock_items_notifier.dart';
import 'package:irori/features/stock/data/stock_repository.dart';
import 'package:irori/features/stock/domain/stock_item.dart';
import 'package:irori/features/stock/presentation/stock_page.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

/// PR-G: StockPage の「在庫⇆買い物」結線テスト。
///
/// - 残日数バッジ (consumptionRatesProvider → tile)
/// - カートボタン → `StockRepository.addToShoppingList` + SnackBar
/// - 低在庫自動追加の初回 build 発火 + 追加 toast
///
/// 既存の一覧表示系テストは `stock_page_test.dart` (無修正)。

class _FakeStockNotifier extends StockItemsNotifier {
  _FakeStockNotifier(this._items);

  final List<StockItem> _items;

  @override
  Future<List<StockItem>> build() async => _items;
}

class _FakeStockRepository extends Fake implements StockRepository {
  Object? addError;
  final added = <({String householdId, String userId, String itemId})>[];

  @override
  Future<void> addToShoppingList({
    required String householdId,
    required String userId,
    required String itemId,
  }) async {
    if (addError != null) throw addError!;
    added.add((householdId: householdId, userId: userId, itemId: itemId));
  }
}

class _MemoryStore implements LowStockCheckStore {
  DateTime? value;

  @override
  Future<DateTime?> loadLastCheckedAt() async => value;

  @override
  Future<void> saveLastCheckedAt(DateTime newValue) async {
    value = newValue;
  }
}

StockItem _item(
  String id, {
  required String name,
  ItemCategory category = ItemCategory.baby,
  num quantity = 1,
}) {
  return StockItem(
    id: id,
    householdId: 'hh-1',
    name: name,
    category: category,
    quantity: quantity,
    unit: null,
    expiresAt: null,
    createdBy: 'user-1',
    createdAt: DateTime.utc(2026, 6, 8),
  );
}

Widget _harness({
  required List<StockItem> items,
  _FakeStockRepository? repo,
  Map<ItemCategory, double?> rates = const {},
  AutoAddLowStockResult? autoAddResult,
}) {
  return ProviderScope(
    overrides: [
      stockItemsNotifierProvider.overrideWith(() => _FakeStockNotifier(items)),
      stockRepositoryProvider.overrideWithValue(repo ?? _FakeStockRepository()),
      stockMutationContextProvider.overrideWith(
        (ref) async => (householdId: 'hh-1', userId: 'user-1'),
      ),
      consumptionRatesProvider.overrideWith((ref) async => rates),
      lowStockAutoAddRunnerProvider.overrideWithValue(
        LowStockAutoAddRunner(
          store: _MemoryStore(),
          runCheck: () async =>
              autoAddResult ?? (error: null, addedItems: const <String>[]),
        ),
      ),
    ],
    child: const MaterialApp(home: StockPage()),
  );
}

void main() {
  testWidgets('consumptionRates の dailyRate が tile の残日数バッジに届く', (tester) async {
    await tester.pumpWidget(
      _harness(
        items: [_item('s1', name: 'おむつ', quantity: 6)],
        rates: const {ItemCategory.baby: 2.0},
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('あと3日分'), findsOneWidget);
  });

  testWidgets('レート未取得 (空 map) ならバッジを出さずページは通常表示', (tester) async {
    await tester.pumpWidget(
      _harness(items: [_item('s1', name: 'おむつ', quantity: 6)]),
    );
    await tester.pumpAndSettle();

    expect(find.text('おむつ'), findsOneWidget);
    expect(find.textContaining('日分'), findsNothing);
  });

  testWidgets('カートボタンで addToShoppingList を呼び成功 toast を出す', (tester) async {
    final repo = _FakeStockRepository();
    await tester.pumpWidget(
      _harness(
        items: [_item('s1', name: 'おむつ')],
        repo: repo,
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.byIcon(LucideIcons.shoppingCart));
    await tester.pumpAndSettle();

    expect(repo.added, [
      (householdId: 'hh-1', userId: 'user-1', itemId: 's1'),
    ]);
    // web stock-item.tsx:120 と同一文言。
    expect(find.text('おむつを買い物リストに追加しました'), findsOneWidget);
  });

  testWidgets('重複時は「既に買い物リストにあります」を出す', (tester) async {
    final repo = _FakeStockRepository()
      ..addError = const DuplicateShoppingItemException();
    await tester.pumpWidget(
      _harness(
        items: [_item('s1', name: 'おむつ')],
        repo: repo,
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.byIcon(LucideIcons.shoppingCart));
    await tester.pumpAndSettle();

    expect(find.text('既に買い物リストにあります'), findsOneWidget);
  });

  testWidgets('追加失敗時は「買い物リストへの追加に失敗しました」を出す', (tester) async {
    final repo = _FakeStockRepository()..addError = StateError('boom');
    await tester.pumpWidget(
      _harness(
        items: [_item('s1', name: 'おむつ')],
        repo: repo,
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.byIcon(LucideIcons.shoppingCart));
    await tester.pumpAndSettle();

    expect(find.text('買い物リストへの追加に失敗しました'), findsOneWidget);
  });

  testWidgets('初回 build で低在庫自動追加が走り、追加件数 + 品名 toast を出す', (tester) async {
    await tester.pumpWidget(
      _harness(
        items: [_item('s1', name: 'おむつ')],
        autoAddResult: (error: null, addedItems: ['おむつ', 'おしりふき']),
      ),
    );
    await tester.pumpAndSettle();

    // web stock-list.tsx:127-130 の toast.success(message, {description})。
    expect(
      find.textContaining('在庫が少ない2件を買い物リストに追加しました'),
      findsOneWidget,
    );
    expect(find.textContaining('おむつ、おしりふき'), findsOneWidget);
  });

  testWidgets('自動追加 0 件なら toast を出さない', (tester) async {
    await tester.pumpWidget(
      _harness(items: [_item('s1', name: 'おむつ')]),
    );
    await tester.pumpAndSettle();

    expect(find.textContaining('買い物リストに追加しました'), findsNothing);
  });

  testWidgets('自動追加が error を返したら toast を出さない (web: if (result.error) return)', (
    tester,
  ) async {
    await tester.pumpWidget(
      _harness(
        items: [_item('s1', name: 'おむつ')],
        autoAddResult: (
          error: '買い物リストへの追加に失敗しました',
          addedItems: const <String>[],
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.textContaining('買い物リスト'), findsNothing);
  });
}
