import 'dart:async';

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

  /// `searchSuggestions` の canned 結果 (P2.5-D サジェスト用 — additive)。
  List<PurchaseSuggestion> suggestionResults = const [];

  /// 非 null なら [suggestionResults] の代わりに query ごとの応答を返す
  /// (世代ガード検証で応答順を制御するためのフック)。
  Future<List<PurchaseSuggestion>> Function(String query)? onSearch;

  int searchCount = 0;
  final searchQueries = <String>[];

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

  @override
  Future<List<PurchaseSuggestion>> searchSuggestions({
    required String householdId,
    required String query,
  }) {
    searchCount++;
    searchQueries.add(query);
    final handler = onSearch;
    if (handler != null) return handler(query);
    return Future.value(suggestionResults);
  }
}

/// サジェスト 1 件の省略形。
PurchaseSuggestion _sg(
  String name, {
  ItemCategory? category,
  StoreType? storeType,
}) => (name: name, category: category, storeType: storeType);

/// サジェスト行の finder (行 widget の `ValueKey('suggestion-$name')`)。
/// 選択後は名前入力欄にも同じ文字列が入るため、`find.text` ではなく key で
/// 「行そのもの」の有無を判定する。
Finder _suggestionRow(String name) => find.byKey(ValueKey('suggestion-$name'));

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

  group('購入履歴サジェスト (web add-item-form.tsx:40-89, 153-175)', () {
    testWidgets('300ms デバウンス: 連続入力は最後の 1 回だけ検索され、'
        'サジェスト行が表示される', (tester) async {
      final repo = _Repo()
        ..suggestionResults = [
          _sg('みかん', category: ItemCategory.fruit),
          _sg('みかんゼリー'),
        ];
      await tester.pumpWidget(_wrap(repo: repo));

      // 途中入力 (150ms 後に再入力) は前のデバウンスをキャンセルする。
      await tester.enterText(_nameField, 'み');
      await tester.pump(const Duration(milliseconds: 150));
      expect(repo.searchCount, 0);

      await tester.enterText(_nameField, 'みかん');
      await tester.pump(const Duration(milliseconds: 299));
      expect(repo.searchCount, 0, reason: '300ms 経過前は検索しない');

      await tester.pump(const Duration(milliseconds: 1));
      await tester.pump();

      // 最後の入力 1 回分のみ検索される。
      expect(repo.searchCount, 1);
      expect(repo.searchQueries, ['みかん']);
      expect(_suggestionRow('みかん'), findsOneWidget);
      expect(_suggestionRow('みかんゼリー'), findsOneWidget);
    });

    testWidgets('サジェストタップで name / category / storeType の 3 フィールドが'
        '反映され、サジェストが閉じる', (tester) async {
      final repo = _Repo()
        ..suggestionResults = [
          _sg('みかん', category: ItemCategory.fruit, storeType: StoreType.online),
        ];
      await tester.pumpWidget(_wrap(repo: repo));

      await tester.enterText(_nameField, 'み');
      await tester.pump(const Duration(milliseconds: 300));
      await tester.pump();
      expect(_suggestionRow('みかん'), findsOneWidget);

      await tester.tap(_suggestionRow('みかん'));
      await tester.pump();

      // 名前欄へ反映 + 行は閉じる (web selectSuggestion)。
      expect(tester.widget<TextField>(_nameField).controller!.text, 'みかん');
      expect(_suggestionRow('みかん'), findsNothing);

      // category / storeType の反映は追加時の repository 引数で検証する。
      await tester.tap(find.byTooltip('追加'));
      await tester.pumpAndSettle();
      expect(
        repo.lastAdd,
        (
          householdId: 'hh-1',
          userId: 'user-1',
          name: 'みかん',
          quantity: null,
          category: ItemCategory.fruit,
          storeType: StoreType.online,
        ),
      );
    });

    testWidgets('category が null のサジェストは現在の選択を維持する '
        '(web の falsy ガード)', (tester) async {
      final repo = _Repo()
        ..suggestionResults = [
          _sg('おしりふき', storeType: StoreType.online), // category: null
        ];
      await tester.pumpWidget(_wrap(repo: repo));

      // 既定 (other_food) ではなく明示選択した値が維持されることを検証する。
      await tester.tap(find.byTooltip('オプションを開く'));
      await tester.pumpAndSettle();
      await tester.tap(find.byType(DropdownButtonFormField<ItemCategory>));
      await tester.pumpAndSettle();
      await tester.tap(find.text('ベビー').last);
      await tester.pumpAndSettle();

      await tester.enterText(_nameField, 'おしり');
      await tester.pump(const Duration(milliseconds: 300));
      await tester.pump();

      await tester.tap(_suggestionRow('おしりふき'));
      await tester.pump();
      await tester.tap(find.byTooltip('追加'));
      await tester.pumpAndSettle();

      // category は現値 (baby) 維持、非 null の storeType だけ反映される。
      expect(repo.lastAdd?.name, 'おしりふき');
      expect(repo.lastAdd?.category, ItemCategory.baby);
      expect(repo.lastAdd?.storeType, StoreType.online);
    });

    testWidgets('世代ガード: 遅れて返った古い検索応答は新しい結果を上書きしない', (tester) async {
      final completers = <String, Completer<List<PurchaseSuggestion>>>{};
      final repo = _Repo()
        ..onSearch = (query) {
          final completer = Completer<List<PurchaseSuggestion>>();
          completers[query] = completer;
          return completer.future;
        };
      await tester.pumpWidget(_wrap(repo: repo));

      // 1 回目の検索 ('み') を未完了のまま保持する。
      await tester.enterText(_nameField, 'み');
      await tester.pump(const Duration(milliseconds: 300));
      await tester.pump();
      expect(completers.keys, ['み']);

      // 2 回目の検索 ('みかん') を発火し、先に完了させる。
      await tester.enterText(_nameField, 'みかん');
      await tester.pump(const Duration(milliseconds: 300));
      await tester.pump();
      expect(completers.keys, ['み', 'みかん']);

      // pump 2 回: 1 回目で応答の microtask (setState 予約) を消化し、
      // 2 回目で予約されたフレームを描画する (フレーム未スケジュール時の
      // `pump()` は microtask 消化が frame 処理の後になるため)。
      completers['みかん']!.complete([_sg('みかんゼリー')]);
      await tester.pump();
      await tester.pump();
      expect(_suggestionRow('みかんゼリー'), findsOneWidget);

      // 古い応答 ('み') が遅れて完了しても、新しい結果を潰さない。
      completers['み']!.complete([_sg('古いサジェスト')]);
      await tester.pump();
      await tester.pump();
      expect(_suggestionRow('古いサジェスト'), findsNothing);
      expect(_suggestionRow('みかんゼリー'), findsOneWidget);
    });

    testWidgets('空入力はサジェストを閉じるだけで検索しない (web parity)', (tester) async {
      final repo = _Repo()..suggestionResults = [_sg('みかん')];
      await tester.pumpWidget(_wrap(repo: repo));

      await tester.enterText(_nameField, 'み');
      await tester.pump(const Duration(milliseconds: 300));
      await tester.pump();
      expect(_suggestionRow('みかん'), findsOneWidget);
      expect(repo.searchCount, 1);

      // 空文字へ戻す → デバウンス後にサジェストが閉じ、検索は走らない
      // (web add-item-form.tsx:41-45 の早期 return)。
      await tester.enterText(_nameField, '');
      await tester.pump(const Duration(milliseconds: 300));
      await tester.pump();
      expect(_suggestionRow('みかん'), findsNothing);
      expect(repo.searchCount, 1);
    });

    testWidgets('追加成功でサジェストが閉じる (web add-item-form.tsx:105-107)', (
      tester,
    ) async {
      final repo = _Repo()..suggestionResults = [_sg('みかんゼリー')];
      await tester.pumpWidget(_wrap(repo: repo));

      await tester.enterText(_nameField, 'みかん');
      await tester.pump(const Duration(milliseconds: 300));
      await tester.pump();
      expect(_suggestionRow('みかんゼリー'), findsOneWidget);

      await tester.tap(find.byTooltip('追加'));
      await tester.pumpAndSettle();

      expect(repo.addCount, 1);
      expect(_suggestionRow('みかんゼリー'), findsNothing);
      expect(tester.widget<TextField>(_nameField).controller!.text, isEmpty);
    });
  });
}
