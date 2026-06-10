import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:irori/core/domain/item_category.dart';
import 'package:irori/core/utils/jst_date.dart';
import 'package:irori/features/stock/data/stock_items_notifier.dart';
import 'package:irori/features/stock/data/stock_repository.dart';
import 'package:irori/features/stock/domain/stock_item.dart';
import 'package:irori/features/stock/presentation/stock_page.dart';
import 'package:irori/features/stock/presentation/widgets/stock_form_sheet.dart';
import 'package:irori/features/stock/presentation/widgets/stock_item_tile.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

/// 固定リストを返す AsyncNotifier (meals `_FakeWeekNotifier` と同じ流儀 —
/// build を override するため realtime subscribe は走らない)。
class _FakeStockNotifier extends StockItemsNotifier {
  _FakeStockNotifier(this._items);

  final List<StockItem> _items;

  @override
  Future<List<StockItem>> build() async => _items;
}

/// build をテスト側 closure に委譲する AsyncNotifier (再試行検証用)。
class _HookedStockNotifier extends StockItemsNotifier {
  _HookedStockNotifier(this._onBuild);

  final Future<List<StockItem>> Function() _onBuild;

  @override
  Future<List<StockItem>> build() => _onBuild();
}

class _FakeStockRepository extends Fake implements StockRepository {
  Object? error;

  ({String householdId, String itemId})? deleted;

  @override
  Future<void> deleteItem({
    required String householdId,
    required String itemId,
  }) async {
    if (error != null) throw error!;
    deleted = (householdId: householdId, itemId: itemId);
  }
}

StockItem _item(
  String id, {
  required String name,
  ItemCategory category = ItemCategory.otherFood,
  num quantity = 1,
  String? unit,
  String? expiresAt,
}) {
  return StockItem(
    id: id,
    householdId: 'hh-1',
    name: name,
    category: category,
    quantity: quantity,
    unit: unit,
    expiresAt: expiresAt,
    createdBy: 'user-1',
    createdAt: DateTime.utc(2026, 6, 8),
  );
}

Widget _harness({
  required StockItemsNotifier Function() notifier,
  _FakeStockRepository? repo,
}) {
  return ProviderScope(
    overrides: [
      stockItemsNotifierProvider.overrideWith(notifier),
      stockRepositoryProvider.overrideWithValue(repo ?? _FakeStockRepository()),
      stockMutationContextProvider.overrideWith(
        (ref) async => (householdId: 'hh-1', userId: 'user-1'),
      ),
    ],
    child: const MaterialApp(home: StockPage()),
  );
}

/// 全グループが ListView にマウントされるよう縦長 viewport にする
/// (meals_page_test と同じ流儀)。
void _useTallViewport(WidgetTester tester) {
  tester.view.physicalSize = const Size(800, 2400);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
}

void main() {
  testWidgets('AppBar に件数、バナーに期限間近件数 (期限切れ + 3日以内) を表示する', (tester) async {
    _useTallViewport(tester);
    final today = formatJstDate();
    await tester.pumpWidget(
      _harness(
        notifier: () => _FakeStockNotifier([
          // 期限切れ / 今日まで / あと3日 → アラート対象 (web `diffDays <= 3`)。
          _item('a', name: '豚肉', expiresAt: shiftYmd(today, -1)),
          _item('b', name: '牛乳', expiresAt: today),
          _item('c', name: '卵', expiresAt: shiftYmd(today, 3)),
          // あと4日 / 期限なし → 対象外。
          _item('d', name: '玉ねぎ', expiresAt: shiftYmd(today, 4)),
          _item('e', name: 'ティッシュ'),
        ]),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('在庫'), findsOneWidget);
    expect(find.text('5件'), findsOneWidget);
    expect(find.text('3件のアイテムが期限切れ間近です'), findsOneWidget);
  });

  testWidgets('期限間近 0 件のときバナーを表示しない', (tester) async {
    _useTallViewport(tester);
    final today = formatJstDate();
    await tester.pumpWidget(
      _harness(
        notifier: () => _FakeStockNotifier([
          _item('a', name: '玉ねぎ', expiresAt: shiftYmd(today, 10)),
          _item('b', name: 'ティッシュ'),
        ]),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.textContaining('期限切れ間近です'), findsNothing);
  });

  testWidgets('カテゴリ別に displayOrder 順でグループ表示し、グループ内は name 昇順', (tester) async {
    _useTallViewport(tester);
    await tester.pumpWidget(
      _harness(
        notifier: () => _FakeStockNotifier([
          // displayOrder と逆順 + グループ内も逆順で渡し、表示側の並べ替えを検証。
          _item('a', name: 'ティッシュ', category: ItemCategory.otherDaily),
          _item('b', name: 'トマト', category: ItemCategory.vegetable),
          _item('c', name: '豚バラ肉', category: ItemCategory.meat),
          _item('d', name: 'キャベツ', category: ItemCategory.vegetable),
        ]),
      ),
    );
    await tester.pumpAndSettle();

    // グループ見出し: 野菜 → 肉 → その他 (categoryDisplayOrder 順)。
    expect(find.text('野菜'), findsOneWidget);
    expect(find.text('肉'), findsOneWidget);
    expect(find.text('その他'), findsOneWidget);
    final vegetableY = tester.getTopLeft(find.text('野菜')).dy;
    final meatY = tester.getTopLeft(find.text('肉')).dy;
    final otherY = tester.getTopLeft(find.text('その他')).dy;
    expect(vegetableY, lessThan(meatY));
    expect(meatY, lessThan(otherY));

    // グループ内 name 昇順: キャベツ → トマト。
    final cabbageY = tester.getTopLeft(find.text('キャベツ')).dy;
    final tomatoY = tester.getTopLeft(find.text('トマト')).dy;
    expect(cabbageY, lessThan(tomatoY));
    // 野菜グループは肉グループより上にある。
    expect(tomatoY, lessThan(meatY));
  });

  testWidgets('空状態はメッセージ + 追加導線を出し、タップで追加 sheet が開く', (tester) async {
    await tester.pumpWidget(_harness(notifier: () => _FakeStockNotifier([])));
    await tester.pumpAndSettle();

    expect(find.text('0件'), findsOneWidget);
    expect(find.text('在庫が登録されていません'), findsOneWidget);
    expect(find.text('最初のアイテムを追加'), findsOneWidget);

    await tester.tap(find.text('最初のアイテムを追加'));
    await tester.pumpAndSettle();

    expect(find.byType(StockFormSheet), findsOneWidget);
    expect(find.text('在庫を追加'), findsOneWidget);
  });

  testWidgets('AppBar の追加ボタンで追加 sheet が開く', (tester) async {
    await tester.pumpWidget(_harness(notifier: () => _FakeStockNotifier([])));
    await tester.pumpAndSettle();

    await tester.tap(find.text('追加'));
    await tester.pumpAndSettle();

    expect(find.byType(StockFormSheet), findsOneWidget);
    expect(find.text('在庫を追加'), findsOneWidget);
  });

  testWidgets('行タップで編集 sheet が初期値入りで開く', (tester) async {
    await tester.pumpWidget(
      _harness(
        notifier: () => _FakeStockNotifier([
          _item('a', name: '牛乳', category: ItemCategory.dairy, quantity: 1.5),
        ]),
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.text('牛乳'));
    await tester.pumpAndSettle();

    expect(find.byType(StockFormSheet), findsOneWidget);
    expect(find.text('在庫を編集'), findsOneWidget);
    // タイル表示とフォーム初期値の 2 箇所に現れる。
    expect(find.text('牛乳'), findsNWidgets(2));
    expect(find.widgetWithText(TextField, '1.5'), findsOneWidget);
  });

  testWidgets('削除は確認 2 タップで楽観除外し repository を呼ぶ', (tester) async {
    final repo = _FakeStockRepository();
    await tester.pumpWidget(
      _harness(
        notifier: () => _FakeStockNotifier([
          _item('a', name: 'ヨーグルト', category: ItemCategory.dairy),
        ]),
        repo: repo,
      ),
    );
    await tester.pumpAndSettle();

    expect(find.byType(StockItemTile), findsOneWidget);

    // 1 タップ目は確認状態 (まだ削除されない)。
    await tester.tap(find.byIcon(LucideIcons.trash2));
    await tester.pump();
    expect(repo.deleted, isNull);
    expect(find.text('ヨーグルト'), findsOneWidget);

    // 2 タップ目で楽観更新 (即時除外) + repository 呼び出し。
    await tester.tap(find.byIcon(LucideIcons.trash2));
    await tester.pumpAndSettle();

    expect(repo.deleted, (householdId: 'hh-1', itemId: 'a'));
    expect(find.text('ヨーグルト'), findsNothing);
    expect(find.text('0件'), findsOneWidget);
    expect(find.text('在庫が登録されていません'), findsOneWidget);
  });

  testWidgets('削除失敗時は文言を出し refetch で一覧を復元する', (tester) async {
    final repo = _FakeStockRepository()..error = StateError('boom');
    await tester.pumpWidget(
      _harness(
        notifier: () => _FakeStockNotifier([
          _item('a', name: 'ヨーグルト', category: ItemCategory.dairy),
        ]),
        repo: repo,
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.byIcon(LucideIcons.trash2));
    await tester.pump();
    await tester.tap(find.byIcon(LucideIcons.trash2));
    await tester.pumpAndSettle();

    // web `deleteStockItem` の error 文言と同一。
    expect(find.text('削除に失敗しました'), findsOneWidget);
    // invalidate → 再 build で fetch 結果 (= 元の 1 件) に復元される。
    expect(find.text('ヨーグルト'), findsOneWidget);
  });

  testWidgets('エラー時は再試行 UI、タップで refetch して復帰する', (tester) async {
    var attempts = 0;
    await tester.pumpWidget(
      _harness(
        // StateError (Error 系) を使う: Riverpod 3 の自動 retry は Exception を
        // 200ms 後に再実行するため、Exception だと pumpAndSettle 中に勝手に
        // 復帰してしまう (meals_page_test と同じ理由)。
        notifier: () => _HookedStockNotifier(() async {
          attempts++;
          if (attempts == 1) throw StateError('boom');
          return [_item('a', name: 'リトライ後の在庫')];
        }),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('在庫の読み込みに失敗しました。'), findsOneWidget);
    expect(find.text('再試行'), findsOneWidget);

    await tester.tap(find.text('再試行'));
    await tester.pumpAndSettle();

    expect(attempts, 2);
    expect(find.text('在庫の読み込みに失敗しました。'), findsNothing);
    expect(find.text('リトライ後の在庫'), findsOneWidget);
  });
}
