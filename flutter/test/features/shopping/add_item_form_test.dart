import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:irori/core/domain/item_category.dart';
import 'package:irori/core/domain/store_type.dart';
import 'package:irori/features/shopping/data/shopping_repository.dart';
import 'package:irori/features/shopping/presentation/widgets/add_item_form.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

class _Repo extends Fake implements ShoppingRepository {
  Object? addError;
  int addCount = 0;
  ({
    String householdId,
    String userId,
    String name,
    String? quantity,
    ItemCategory category,
    StoreType storeType,
  })?
  lastAdd;

  @override
  Future<void> addItem({
    required String householdId,
    required String userId,
    required String name,
    String? quantity,
    ItemCategory category = ItemCategory.otherFood,
    StoreType storeType = StoreType.supermarket,
  }) async {
    addCount++;
    lastAdd = (
      householdId: householdId,
      userId: userId,
      name: name,
      quantity: quantity,
      category: category,
      storeType: storeType,
    );
    if (addError != null) throw addError!;
  }
}

Widget _wrap({required _Repo repo}) {
  return ProviderScope(
    overrides: [
      shoppingRepositoryProvider.overrideWithValue(repo),
      shoppingMutationContextProvider.overrideWith(
        (ref) async => (householdId: 'hh-1', userId: 'user-1'),
      ),
    ],
    child: const MaterialApp(
      home: Scaffold(body: SingleChildScrollView(child: AddItemForm())),
    ),
  );
}

/// 名前入力欄 (メイン行の先頭 TextField)。
Finder get _nameField => find.byType(TextField).first;

/// 追加ボタンの IconButton widget (tooltip「追加」 — 原典 aria-label)。
IconButton _addButton(WidgetTester tester) {
  return tester.widget<IconButton>(
    find.ancestor(
      of: find.byTooltip('追加'),
      matching: find.byType(IconButton),
    ),
  );
}

void main() {
  testWidgets('名前が空 (空白のみ含む) の間は追加ボタンが disabled', (tester) async {
    final repo = _Repo();
    await tester.pumpWidget(_wrap(repo: repo));

    expect(_addButton(tester).onPressed, isNull);

    // 空白のみでも disabled (trim 検証)。
    await tester.enterText(_nameField, '   ');
    await tester.pump();
    expect(_addButton(tester).onPressed, isNull);

    await tester.tap(find.byTooltip('追加'), warnIfMissed: false);
    await tester.pumpAndSettle();
    expect(repo.addCount, 0);

    // 名前を入れると enabled。
    await tester.enterText(_nameField, '牛乳');
    await tester.pump();
    expect(_addButton(tester).onPressed, isNotNull);
  });

  testWidgets('既定値で追加: trim した名前 + other_food / supermarket / 数量 null', (
    tester,
  ) async {
    final repo = _Repo();
    await tester.pumpWidget(_wrap(repo: repo));

    await tester.enterText(_nameField, ' 牛乳 ');
    await tester.pump();
    await tester.tap(find.byTooltip('追加'));
    await tester.pumpAndSettle();

    expect(repo.addCount, 1);
    expect(
      repo.lastAdd,
      (
        householdId: 'hh-1',
        userId: 'user-1',
        name: '牛乳',
        quantity: null,
        category: ItemCategory.otherFood,
        storeType: StoreType.supermarket,
      ),
    );
  });

  testWidgets('オプション展開でカテゴリ/購入先/数量を指定して追加できる', (tester) async {
    final repo = _Repo();
    await tester.pumpWidget(_wrap(repo: repo));

    // 展開前はオプション行が無い。
    expect(find.text('カテゴリ:'), findsNothing);

    await tester.tap(find.byTooltip('オプションを開く'));
    await tester.pumpAndSettle();

    expect(find.text('カテゴリ:'), findsOneWidget);
    expect(find.text('購入先:'), findsOneWidget);
    expect(find.text('数量:'), findsOneWidget);
    expect(find.byTooltip('オプションを閉じる'), findsOneWidget);

    // カテゴリ: ベビー を選択 (メニューは選択中の「その他食品」を中心に開く
    // lazy ListView のため、近傍の値を使う — 表示順は displayOrder 準拠)。
    await tester.tap(find.byType(DropdownButtonFormField<ItemCategory>));
    await tester.pumpAndSettle();
    await tester.tap(find.text('ベビー').last);
    await tester.pumpAndSettle();

    // 購入先: ネット を選択。
    await tester.tap(find.byType(DropdownButtonFormField<StoreType>));
    await tester.pumpAndSettle();
    await tester.tap(find.text('ネット').last);
    await tester.pumpAndSettle();

    // 数量 (メイン行の名前入力に次ぐ 2 つ目の TextField)。
    await tester.enterText(find.byType(TextField).at(1), '2個');
    await tester.enterText(_nameField, 'おむつ');
    await tester.pump();

    await tester.tap(find.byTooltip('追加'));
    await tester.pumpAndSettle();

    expect(
      repo.lastAdd,
      (
        householdId: 'hh-1',
        userId: 'user-1',
        name: 'おむつ',
        quantity: '2個',
        category: ItemCategory.baby,
        storeType: StoreType.online,
      ),
    );
  });

  testWidgets('成功で名前と数量をクリアし、カテゴリ/購入先の選択は維持する', (tester) async {
    final repo = _Repo();
    await tester.pumpWidget(_wrap(repo: repo));

    await tester.tap(find.byTooltip('オプションを開く'));
    await tester.pumpAndSettle();
    await tester.tap(find.byType(DropdownButtonFormField<ItemCategory>));
    await tester.pumpAndSettle();
    await tester.tap(find.text('ベビー').last);
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField).at(1), '2個');
    await tester.enterText(_nameField, 'おむつ');
    await tester.pump();

    await tester.tap(find.byTooltip('追加'));
    await tester.pumpAndSettle();

    // 入力クリア (web: setName("") 相当 + 数量)。
    expect(tester.widget<TextField>(_nameField).controller!.text, isEmpty);
    expect(
      tester.widget<TextField>(find.byType(TextField).at(1)).controller!.text,
      isEmpty,
    );

    // 選択は維持 → 2 回目の追加も baby のまま (web と同一)。
    await tester.enterText(_nameField, 'おしりふき');
    await tester.pump();
    await tester.tap(find.byTooltip('追加'));
    await tester.pumpAndSettle();

    expect(repo.addCount, 2);
    expect(repo.lastAdd?.name, 'おしりふき');
    expect(repo.lastAdd?.quantity, isNull);
    expect(repo.lastAdd?.category, ItemCategory.baby);
  });

  testWidgets('失敗時は SnackBar を表示し、入力はクリアしない', (tester) async {
    final repo = _Repo()
      ..addError = const PostgrestException(message: 'boom', code: '500');
    await tester.pumpWidget(_wrap(repo: repo));

    await tester.enterText(_nameField, '牛乳');
    await tester.pump();
    await tester.tap(find.byTooltip('追加'));
    await tester.pumpAndSettle();

    // 文言は web `addItem` action と同一。
    expect(find.text('アイテムの追加に失敗しました'), findsOneWidget);
    expect(tester.widget<TextField>(_nameField).controller!.text, '牛乳');
  });
}
