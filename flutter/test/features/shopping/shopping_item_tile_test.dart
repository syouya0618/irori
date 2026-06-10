import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:irori/core/domain/item_category.dart';
import 'package:irori/core/domain/store_type.dart';
import 'package:irori/features/shopping/data/shopping_repository.dart';
import 'package:irori/features/shopping/domain/shopping_item.dart';
import 'package:irori/features/shopping/presentation/widgets/shopping_item_tile.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

ShoppingItem _item({
  String id = 'i-1',
  String name = '牛乳',
  String? quantity,
  bool isChecked = false,
  String? checkedBy,
  DateTime? checkedAt,
}) {
  return ShoppingItem(
    id: id,
    householdId: 'hh-1',
    name: name,
    quantity: quantity,
    category: ItemCategory.dairy,
    storeType: StoreType.supermarket,
    isChecked: isChecked,
    checkedBy: checkedBy,
    checkedAt: checkedAt,
    sortOrder: 1,
    createdBy: 'user-1',
    createdAt: DateTime.utc(2026, 1, 1),
  );
}

/// 楽観更新検証用の fake repository (`meal_reactions_row_test._Repo` の流儀)。
class _Repo extends Fake implements ShoppingRepository {
  /// 非 null なら toggle がこの例外で失敗する。
  Object? toggleError;

  /// 非 null なら toggle がこの Completer の完了まで停止する。
  Completer<void>? toggleGate;

  Object? deleteError;

  int toggleCount = 0;
  ({String householdId, String itemId, bool isChecked, String userId})?
  lastToggle;

  int deleteCount = 0;
  ({String householdId, String itemId})? lastDelete;

  @override
  Future<void> toggleItem({
    required String householdId,
    required String itemId,
    required bool isChecked,
    required String userId,
  }) async {
    toggleCount++;
    lastToggle = (
      householdId: householdId,
      itemId: itemId,
      isChecked: isChecked,
      userId: userId,
    );
    if (toggleGate != null) await toggleGate!.future;
    if (toggleError != null) throw toggleError!;
  }

  @override
  Future<void> deleteItem({
    required String householdId,
    required String itemId,
  }) async {
    deleteCount++;
    lastDelete = (householdId: householdId, itemId: itemId);
    if (deleteError != null) throw deleteError!;
  }
}

Widget _wrap({
  required _Repo repo,
  required ShoppingItem item,
  String? checkedByName,
}) {
  return ProviderScope(
    overrides: [
      shoppingRepositoryProvider.overrideWithValue(repo),
      shoppingMutationContextProvider.overrideWith(
        (ref) async => (householdId: 'hh-1', userId: 'user-1'),
      ),
    ],
    child: MaterialApp(
      home: Scaffold(
        body: ShoppingItemTile(item: item, checkedByName: checkedByName),
      ),
    ),
  );
}

bool _checkboxValue(WidgetTester tester) =>
    tester.widget<Checkbox>(find.byType(Checkbox)).value!;

void main() {
  testWidgets('楽観更新: 書き込み完了前にチェックが反映され、完了後も維持される', (tester) async {
    final repo = _Repo()..toggleGate = Completer<void>();
    await tester.pumpWidget(_wrap(repo: repo, item: _item()));

    expect(_checkboxValue(tester), isFalse);

    await tester.tap(find.byType(Checkbox));
    await tester.pump();

    // gate 未完了 (= サーバ応答前) でも即時チェック表示。
    expect(_checkboxValue(tester), isTrue);
    expect(repo.toggleCount, 1);
    expect(
      repo.lastToggle,
      (householdId: 'hh-1', itemId: 'i-1', isChecked: true, userId: 'user-1'),
    );

    // pending 中の連打は無視される (Checkbox disabled)。
    await tester.tap(find.byType(Checkbox));
    await tester.pump();
    expect(repo.toggleCount, 1);

    repo.toggleGate!.complete();
    await tester.pumpAndSettle();

    // 完了後も維持される (realtime UPDATE が届くまで楽観値を表示)。
    expect(_checkboxValue(tester), isTrue);
  });

  testWidgets('失敗時は巻き戻して SnackBar を表示する', (tester) async {
    final repo = _Repo()
      ..toggleError = const PostgrestException(message: 'boom', code: '500');
    await tester.pumpWidget(_wrap(repo: repo, item: _item()));

    await tester.tap(find.byType(Checkbox));
    await tester.pumpAndSettle();

    expect(_checkboxValue(tester), isFalse);
    // 文言は web `toggleItem` action と同一。
    expect(find.text('更新に失敗しました'), findsOneWidget);
  });

  testWidgets('チェック済みは取り消し線 + チェック者名を表示する', (tester) async {
    final repo = _Repo();
    await tester.pumpWidget(
      _wrap(
        repo: repo,
        item: _item(
          isChecked: true,
          checkedBy: 'user-2',
          checkedAt: DateTime.utc(2026, 1, 1, 10),
          quantity: '2本',
        ),
        checkedByName: '花子',
      ),
    );

    expect(_checkboxValue(tester), isTrue);
    expect(find.text('花子'), findsOneWidget);
    final nameText = tester.widget<Text>(find.text('牛乳'));
    expect(nameText.style?.decoration, TextDecoration.lineThrough);
    final quantityText = tester.widget<Text>(find.text('2本'));
    expect(quantityText.style?.decoration, TextDecoration.lineThrough);
  });

  testWidgets('未チェックならチェック者名は表示しない', (tester) async {
    final repo = _Repo();
    await tester.pumpWidget(
      _wrap(repo: repo, item: _item(), checkedByName: '花子'),
    );

    expect(find.text('花子'), findsNothing);
    final nameText = tester.widget<Text>(find.text('牛乳'));
    expect(nameText.style?.decoration, isNull);
  });

  testWidgets('削除は 2 タップ確認: 1 回目で確認状態、2 回目で楽観的に行を隠して削除する', (tester) async {
    final repo = _Repo();
    await tester.pumpWidget(_wrap(repo: repo, item: _item()));

    // 1 タップ目: まだ削除されず、確認 tooltip (原典 aria-label) に変わる。
    await tester.tap(find.byTooltip('牛乳を削除'));
    await tester.pump();
    expect(repo.deleteCount, 0);
    expect(find.byTooltip('牛乳を削除（確認）'), findsOneWidget);

    // 2 タップ目: 楽観的に行が消え、repository が呼ばれる。
    await tester.tap(find.byTooltip('牛乳を削除（確認）'));
    await tester.pumpAndSettle();

    expect(repo.deleteCount, 1);
    expect(repo.lastDelete, (householdId: 'hh-1', itemId: 'i-1'));
    expect(find.text('牛乳'), findsNothing);
  });

  testWidgets('削除確認は 3 秒で自動解除される', (tester) async {
    final repo = _Repo();
    await tester.pumpWidget(_wrap(repo: repo, item: _item()));

    await tester.tap(find.byTooltip('牛乳を削除'));
    await tester.pump();
    expect(find.byTooltip('牛乳を削除（確認）'), findsOneWidget);

    // 原典の 3000ms タイマーで通常状態へ戻る。
    await tester.pump(const Duration(seconds: 3));
    expect(find.byTooltip('牛乳を削除（確認）'), findsNothing);
    expect(find.byTooltip('牛乳を削除'), findsOneWidget);
    expect(repo.deleteCount, 0);
  });

  testWidgets('削除失敗時は行を復元して SnackBar を表示する', (tester) async {
    final repo = _Repo()
      ..deleteError = const PostgrestException(message: 'boom', code: '500');
    await tester.pumpWidget(_wrap(repo: repo, item: _item()));

    await tester.tap(find.byTooltip('牛乳を削除'));
    await tester.pump();
    await tester.tap(find.byTooltip('牛乳を削除（確認）'));
    await tester.pumpAndSettle();

    // 文言は web `deleteItem` action と同一。行は巻き戻しで復元される
    // (web は復元しないが、安全側の意図的差異 — tile doc 参照)。
    expect(find.text('削除に失敗しました'), findsOneWidget);
    expect(find.text('牛乳'), findsOneWidget);
  });
}
