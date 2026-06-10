import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:irori/core/domain/item_category.dart';
import 'package:irori/core/domain/store_type.dart';
import 'package:irori/features/shopping/data/household_members_provider.dart';
import 'package:irori/features/shopping/data/shopping_items_notifier.dart';
import 'package:irori/features/shopping/data/shopping_repository.dart';
import 'package:irori/features/shopping/domain/shopping_item.dart';
import 'package:irori/features/shopping/presentation/shopping_page.dart';
import 'package:irori/features/shopping/presentation/widgets/shopping_category_group.dart';

ShoppingItem _item({
  required String id,
  String name = 'アイテム',
  String? quantity,
  ItemCategory category = ItemCategory.otherFood,
  StoreType storeType = StoreType.supermarket,
  bool isChecked = false,
  String? checkedBy,
  DateTime? checkedAt,
  int sortOrder = 1,
}) {
  return ShoppingItem(
    id: id,
    householdId: 'hh-1',
    name: name,
    quantity: quantity,
    category: category,
    storeType: storeType,
    isChecked: isChecked,
    checkedBy: checkedBy,
    checkedAt: checkedAt,
    sortOrder: sortOrder,
    createdBy: 'user-1',
    createdAt: DateTime.utc(2026, 1, 1),
  );
}

/// 固定リストを返す AsyncNotifier (data 分岐用 — meals/baby の流儀)。
class _FakeItemsNotifier extends ShoppingItemsNotifier {
  _FakeItemsNotifier(this._items);

  final List<ShoppingItem> _items;

  @override
  Future<List<ShoppingItem>> build() async => _items;
}

/// build をテスト側 closure に委譲する AsyncNotifier (再試行検証用 —
/// `meals_page_test._HookedWeekNotifier` と同形)。
class _HookedItemsNotifier extends ShoppingItemsNotifier {
  _HookedItemsNotifier(this._onBuild);

  final Future<List<ShoppingItem>> Function() _onBuild;

  @override
  Future<List<ShoppingItem>> build() => _onBuild();
}

/// クリアダイアログ検証用の fake repository。
class _FakeRepository extends Fake implements ShoppingRepository {
  Object? clearError;
  int clearResult = 0;
  int clearCallCount = 0;
  String? lastClearHouseholdId;

  @override
  Future<int> clearChecked(String householdId) async {
    clearCallCount++;
    lastClearHouseholdId = householdId;
    if (clearError != null) throw clearError!;
    return clearResult;
  }
}

Widget _harness({
  required ShoppingItemsNotifier Function() notifier,
  List<HouseholdMember> members = const [],
  _FakeRepository? repository,
}) {
  return ProviderScope(
    overrides: [
      shoppingItemsNotifierProvider.overrideWith(notifier),
      householdMembersProvider.overrideWith((ref) async => members),
      shoppingMutationContextProvider.overrideWith(
        (ref) async => (householdId: 'hh-1', userId: 'user-1'),
      ),
      if (repository != null)
        shoppingRepositoryProvider.overrideWithValue(repository),
    ],
    child: const MaterialApp(home: ShoppingPage()),
  );
}

/// 全要素がマウントされるよう縦長 viewport にする
/// (`meals_page_test._useTallViewport` と同じ流儀)。
void _useTallViewport(WidgetTester tester) {
  tester.view.physicalSize = const Size(800, 2400);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
}

/// カテゴリグループの**ヘッダー** Text (w600)。同名 Text がタイルの
/// カテゴリバッジ (w500) や店舗タブにも出るため、グループ内 + 太さで絞る。
Finder _groupHeader(String label) {
  return find.descendant(
    of: find.byType(ShoppingCategoryGroup),
    matching: find.byWidgetPredicate(
      (w) =>
          w is Text &&
          w.data == label &&
          w.style?.fontWeight == FontWeight.w600,
    ),
  );
}

void main() {
  testWidgets('AppBar に見出しと「残り N / M 件」を表示する', (tester) async {
    await tester.pumpWidget(
      _harness(
        notifier: () => _FakeItemsNotifier([
          _item(id: 'i-1', name: 'にんじん'),
          _item(id: 'i-2', name: 'たまねぎ'),
          _item(
            id: 'i-3',
            name: '牛乳',
            isChecked: true,
            checkedAt: DateTime.utc(2026, 1, 1, 10),
          ),
        ]),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('買い物リスト'), findsOneWidget);
    expect(find.text('残り 2 / 3 件'), findsOneWidget);
  });

  testWidgets('カテゴリグループは displayOrder 順・グループ内は sort_order 昇順', (tester) async {
    _useTallViewport(tester);
    await tester.pumpWidget(
      _harness(
        notifier: () => _FakeItemsNotifier([
          // displayOrder 末尾のカテゴリを先頭の sort_order で混ぜ、
          // 「配列順ではなく displayOrder 順」を検証する。
          _item(
            id: 'i-1',
            name: 'ティッシュ',
            category: ItemCategory.otherDaily,
            sortOrder: 1,
          ),
          _item(
            id: 'i-2',
            name: 'にんじん',
            category: ItemCategory.vegetable,
            sortOrder: 3,
          ),
          _item(
            id: 'i-3',
            name: 'たまねぎ',
            category: ItemCategory.vegetable,
            sortOrder: 2,
          ),
          _item(
            id: 'i-4',
            name: '豚肉',
            category: ItemCategory.meat,
            sortOrder: 4,
          ),
        ]),
      ),
    );
    await tester.pumpAndSettle();

    // グループヘッダー (同名 Text のバッジ/店舗タブと区別して検証)。
    expect(_groupHeader('野菜'), findsOneWidget);
    expect(_groupHeader('肉'), findsOneWidget);
    expect(_groupHeader('その他'), findsOneWidget);
    // ヘッダーに出ないカテゴリのグループは作られない。
    expect(_groupHeader('魚介'), findsNothing);

    // 縦位置で順序検証: 野菜 (たまねぎ → にんじん) → 肉 (豚肉) → その他。
    final yOnion = tester.getTopLeft(find.text('たまねぎ')).dy;
    final yCarrot = tester.getTopLeft(find.text('にんじん')).dy;
    final yPork = tester.getTopLeft(find.text('豚肉')).dy;
    final yTissue = tester.getTopLeft(find.text('ティッシュ')).dy;
    expect(yOnion, lessThan(yCarrot)); // sort_order 2 < 3
    expect(yCarrot, lessThan(yPork)); // vegetable グループが meat より上
    expect(yPork, lessThan(yTissue)); // meat グループが other_daily より上
  });

  testWidgets('店舗フィルタタブで一覧と件数が絞り込まれる', (tester) async {
    _useTallViewport(tester);
    await tester.pumpWidget(
      _harness(
        notifier: () => _FakeItemsNotifier([
          _item(
            id: 'i-1',
            name: 'にんじん',
            category: ItemCategory.vegetable,
          ),
          _item(
            id: 'i-2',
            // カテゴリラベル「洗剤」(バッジ) と衝突しない名前にする。
            name: '食器用スポンジ',
            category: ItemCategory.cleaning,
            storeType: StoreType.drugstore,
            sortOrder: 2,
          ),
        ]),
      ),
    );
    await tester.pumpAndSettle();

    // 「全て」(既定): 両方表示。
    expect(find.text('にんじん'), findsOneWidget);
    expect(find.text('食器用スポンジ'), findsOneWidget);
    expect(find.text('残り 2 / 2 件'), findsOneWidget);

    // ドラッグストアに絞る。
    await tester.tap(find.text('ドラッグストア'));
    await tester.pumpAndSettle();

    expect(find.text('にんじん'), findsNothing);
    expect(find.text('食器用スポンジ'), findsOneWidget);
    expect(find.text('残り 1 / 1 件'), findsOneWidget);

    // 「全て」へ戻す。
    await tester.tap(find.text('全て'));
    await tester.pumpAndSettle();

    expect(find.text('にんじん'), findsOneWidget);
    expect(find.text('残り 2 / 2 件'), findsOneWidget);
  });

  testWidgets('空のときは「アイテムがありません」とクリアボタン disabled', (tester) async {
    await tester.pumpWidget(
      _harness(notifier: () => _FakeItemsNotifier(const [])),
    );
    await tester.pumpAndSettle();

    expect(find.text('アイテムがありません'), findsOneWidget);
    expect(find.text('残り 0 / 0 件'), findsOneWidget);

    final clearButton = tester.widget<OutlinedButton>(
      find.widgetWithText(OutlinedButton, 'チェック済みを削除'),
    );
    expect(clearButton.onPressed, isNull);
  });

  testWidgets('全件チェック済みなら「全てチェック済みです」を表示する', (tester) async {
    await tester.pumpWidget(
      _harness(
        notifier: () => _FakeItemsNotifier([
          _item(
            id: 'i-1',
            name: '牛乳',
            isChecked: true,
            checkedAt: DateTime.utc(2026, 1, 1, 10),
          ),
        ]),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('全てチェック済みです'), findsOneWidget);
    expect(find.text('チェック済み (1件)'), findsOneWidget);
    expect(find.text('アイテムがありません'), findsNothing);
  });

  testWidgets('チェック済みは折りたたみ、展開で checked_at 降順 + チェック者名を表示する', (
    tester,
  ) async {
    _useTallViewport(tester);
    await tester.pumpWidget(
      _harness(
        notifier: () => _FakeItemsNotifier([
          _item(id: 'i-1', name: 'にんじん'),
          _item(
            id: 'i-2',
            name: '牛乳',
            isChecked: true,
            checkedBy: 'user-2',
            checkedAt: DateTime.utc(2026, 1, 1, 10),
            sortOrder: 2,
          ),
          _item(
            id: 'i-3',
            name: 'パン',
            isChecked: true,
            checkedBy: 'user-2',
            checkedAt: DateTime.utc(2026, 1, 1, 11),
            sortOrder: 3,
          ),
        ]),
        members: const [(id: 'user-2', displayName: '花子')],
      ),
    );
    await tester.pumpAndSettle();

    // 折りたたみ中: ラベルだけ出てアイテムは見えない。
    expect(find.text('チェック済み (2件)'), findsOneWidget);
    expect(find.text('牛乳'), findsNothing);
    expect(find.text('パン'), findsNothing);

    await tester.tap(find.text('チェック済み (2件)'));
    await tester.pumpAndSettle();

    // 展開: checked_at 降順 (パン 11:00 → 牛乳 10:00)。
    expect(find.text('牛乳'), findsOneWidget);
    expect(find.text('パン'), findsOneWidget);
    final yBread = tester.getTopLeft(find.text('パン')).dy;
    final yMilk = tester.getTopLeft(find.text('牛乳')).dy;
    expect(yBread, lessThan(yMilk));

    // チェック者の表示名 (householdMembersProvider 経由の memberMap)。
    expect(find.text('花子'), findsNWidgets(2));

    // 再タップで折りたたむ。
    await tester.tap(find.text('チェック済み (2件)'));
    await tester.pumpAndSettle();
    expect(find.text('牛乳'), findsNothing);
  });

  testWidgets('チェック済みクリア: 確認ダイアログ → 成功 SnackBar → ダイアログが閉じる', (tester) async {
    _useTallViewport(tester);
    final repository = _FakeRepository()..clearResult = 2;
    await tester.pumpWidget(
      _harness(
        notifier: () => _FakeItemsNotifier([
          _item(
            id: 'i-1',
            name: '牛乳',
            isChecked: true,
            checkedAt: DateTime.utc(2026, 1, 1, 10),
          ),
          _item(
            id: 'i-2',
            name: 'パン',
            isChecked: true,
            checkedAt: DateTime.utc(2026, 1, 1, 11),
            sortOrder: 2,
          ),
        ]),
        repository: repository,
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.text('チェック済みを削除'));
    await tester.pumpAndSettle();

    // 文言は web Dialog と同一。
    expect(find.text('チェック済みアイテムを削除'), findsOneWidget);
    expect(
      find.text('チェック済みの2件のアイテムを削除します。購入履歴に記録されます。この操作は取り消せません。'),
      findsOneWidget,
    );

    await tester.tap(find.text('削除する'));
    await tester.pumpAndSettle();

    expect(repository.clearCallCount, 1);
    expect(repository.lastClearHouseholdId, 'hh-1');
    expect(find.text('2件のアイテムを削除しました'), findsOneWidget);
    // 成功時のみダイアログが閉じる (web `setClearDialogOpen(false)`)。
    expect(find.text('チェック済みアイテムを削除'), findsNothing);
  });

  testWidgets('チェック済みクリア: 0 件例外は専用文言でダイアログは開いたまま', (tester) async {
    _useTallViewport(tester);
    final repository = _FakeRepository()
      ..clearError = const NoCheckedShoppingItemsException();
    await tester.pumpWidget(
      _harness(
        notifier: () => _FakeItemsNotifier([
          _item(
            id: 'i-1',
            name: '牛乳',
            isChecked: true,
            checkedAt: DateTime.utc(2026, 1, 1, 10),
          ),
        ]),
        repository: repository,
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.text('チェック済みを削除'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('削除する'));
    await tester.pumpAndSettle();

    expect(find.text('チェック済みのアイテムがありません'), findsOneWidget);
    // エラー時はダイアログを閉じない (web と同一)。
    expect(find.text('チェック済みアイテムを削除'), findsOneWidget);
  });

  testWidgets('エラー時は再試行 UI、タップで refetch して復帰する', (tester) async {
    var attempts = 0;
    await tester.pumpWidget(
      _harness(
        // StateError (Error 系) を使う: Riverpod 3 の自動 retry は Exception を
        // 200ms 後に再実行するため (meals_page_test と同じ理由)。
        notifier: () => _HookedItemsNotifier(() async {
          attempts++;
          if (attempts == 1) throw StateError('boom');
          return [_item(id: 'i-1', name: 'リトライ後のアイテム')];
        }),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('買い物リストの読み込みに失敗しました。'), findsOneWidget);
    expect(find.text('再試行'), findsOneWidget);

    await tester.tap(find.text('再試行'));
    await tester.pumpAndSettle();

    expect(attempts, 2);
    expect(find.text('買い物リストの読み込みに失敗しました。'), findsNothing);
    expect(find.text('リトライ後のアイテム'), findsOneWidget);
  });
}
