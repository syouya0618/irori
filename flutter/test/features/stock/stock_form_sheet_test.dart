import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:irori/core/domain/item_category.dart';
import 'package:irori/features/stock/data/stock_repository.dart';
import 'package:irori/features/stock/domain/stock_item.dart';
import 'package:irori/features/stock/presentation/widgets/stock_form_sheet.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

class _Repo extends Fake implements StockRepository {
  /// 非 null なら addItem/updateItem がこの例外で失敗する。
  Object? error;

  ({
    String householdId,
    String userId,
    String name,
    ItemCategory category,
    num quantity,
    String? unit,
    String? expiresAt,
  })?
  added;

  ({
    String householdId,
    String itemId,
    String name,
    ItemCategory category,
    num quantity,
    String? unit,
    String? expiresAt,
  })?
  updated;

  @override
  Future<void> addItem({
    required String householdId,
    required String userId,
    required String name,
    ItemCategory category = ItemCategory.otherFood,
    num quantity = 1,
    String? unit,
    String? expiresAt,
  }) async {
    if (error != null) throw error!;
    added = (
      householdId: householdId,
      userId: userId,
      name: name,
      category: category,
      quantity: quantity,
      unit: unit,
      expiresAt: expiresAt,
    );
  }

  @override
  Future<void> updateItem({
    required String householdId,
    required String itemId,
    required String name,
    ItemCategory category = ItemCategory.otherFood,
    num quantity = 1,
    String? unit,
    String? expiresAt,
  }) async {
    if (error != null) throw error!;
    updated = (
      householdId: householdId,
      itemId: itemId,
      name: name,
      category: category,
      quantity: quantity,
      unit: unit,
      expiresAt: expiresAt,
    );
  }
}

StockItem _existingItem({
  num quantity = 1.5,
  String? unit = '本',
  String? expiresAt = '2026-12-31',
}) {
  return StockItem(
    id: 'stock-1',
    householdId: 'hh-1',
    name: '牛乳',
    category: ItemCategory.dairy,
    quantity: quantity,
    unit: unit,
    expiresAt: expiresAt,
    createdBy: 'user-1',
    createdAt: DateTime.utc(2026, 6, 8),
  );
}

Widget _wrap({required _Repo repo, StockItem? existing}) {
  return ProviderScope(
    overrides: [
      stockRepositoryProvider.overrideWithValue(repo),
      stockMutationContextProvider.overrideWith(
        (ref) async => (householdId: 'hh-1', userId: 'user-1'),
      ),
    ],
    child: MaterialApp(
      home: Scaffold(
        body: Consumer(
          builder: (context, ref, _) => FilledButton(
            onPressed: () {
              showStockFormSheet(context, ref, existing: existing);
            },
            child: const Text('open'),
          ),
        ),
      ),
    ),
  );
}

Finder _nameField() => find.widgetWithText(TextField, '例: 牛乳、豚バラ肉');

void main() {
  group('StockFormSheet 追加モード', () {
    testWidgets('名前が空のまま送信すると必須検証の文言を出し、sheet は閉じない', (tester) async {
      final repo = _Repo();
      await tester.pumpWidget(_wrap(repo: repo));

      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();

      expect(find.text('在庫を追加'), findsOneWidget);
      expect(find.text('冷蔵庫・冷凍庫・パントリーの在庫を記録します'), findsOneWidget);

      await tester.tap(find.text('追加'));
      await tester.pumpAndSettle();

      // 原典 handleSubmit の toast.error と同一文言。repository は呼ばれない。
      expect(find.text('アイテム名を入力してください'), findsOneWidget);
      expect(repo.added, isNull);
      expect(find.text('追加'), findsOneWidget);
    });

    testWidgets('小数の数量 (1.5) が num のまま repository に渡る', (tester) async {
      final repo = _Repo();
      await tester.pumpWidget(_wrap(repo: repo));

      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();

      await tester.enterText(_nameField(), '  牛乳  ');
      // 数量の初期値は "1" (原典と同じ)。
      await tester.enterText(find.widgetWithText(TextField, '1'), '1.5');
      await tester.tap(find.text('追加'));
      await tester.pumpAndSettle();

      expect(repo.added, isNotNull);
      // name は trim される (原典 `name.trim()`)。
      expect(repo.added!.name, '牛乳');
      expect(repo.added!.quantity, 1.5);
      // 既定値: カテゴリ other_food / 単位なし ('' は repository が null 正規化)
      // / 期限なし。
      expect(repo.added!.category, ItemCategory.otherFood);
      expect(repo.added!.unit, '');
      expect(repo.added!.expiresAt, isNull);
      expect(repo.added!.householdId, 'hh-1');
      expect(repo.added!.userId, 'user-1');
      expect(find.text('在庫を追加しました'), findsOneWidget);
      // sheet は閉じる。
      expect(find.text('在庫を追加'), findsNothing);
    });

    testWidgets('数量が空なら 1 を補完する (原典 `quantity || "1"`)', (tester) async {
      final repo = _Repo();
      await tester.pumpWidget(_wrap(repo: repo));

      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();

      await tester.enterText(_nameField(), '卵');
      await tester.enterText(find.widgetWithText(TextField, '1'), '');
      await tester.tap(find.text('追加'));
      await tester.pumpAndSettle();

      expect(repo.added, isNotNull);
      expect(repo.added!.quantity, 1);
    });

    testWidgets('カテゴリと単位を選択して送信できる', (tester) async {
      final repo = _Repo();
      await tester.pumpWidget(_wrap(repo: repo));

      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();

      await tester.enterText(_nameField(), 'おむつ');

      // カテゴリ: 既定の「その他食品」→「ベビー」。
      // メニューは選択中項目を中心に開き、遠い項目 (先頭の「野菜」等) は
      // viewport 外で未マウントになるため、隣接する「ベビー」を選ぶ。
      await tester.tap(find.text('その他食品'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('ベビー').last);
      await tester.pumpAndSettle();

      // 単位: 既定の「なし」→「パック」(メニュー先頭側なのでマウント済み)。
      await tester.tap(find.text('なし'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('パック').last);
      await tester.pumpAndSettle();

      await tester.tap(find.text('追加'));
      await tester.pumpAndSettle();

      expect(repo.added, isNotNull);
      expect(repo.added!.category, ItemCategory.baby);
      expect(repo.added!.unit, 'パック');
    });

    testWidgets('repository の ArgumentError は message のみ表示する (raw 形式を漏らさない)', (
      tester,
    ) async {
      final repo = _Repo()
        ..error = ArgumentError.value(0, 'quantity', '数量は0より大きい値で入力してください');
      await tester.pumpWidget(_wrap(repo: repo));

      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();

      await tester.enterText(_nameField(), '牛乳');
      await tester.enterText(find.widgetWithText(TextField, '1'), '0');
      await tester.tap(find.text('追加'));
      await tester.pumpAndSettle();

      // ユーザー向け文言 (web `parseStockFormData` と同系) のみが出る。
      expect(find.text('数量は0より大きい値で入力してください'), findsOneWidget);
      // `ArgumentError.toString()` の生文字列は画面に出さない。
      expect(find.textContaining('Invalid argument'), findsNothing);
      // sheet は開いたまま (再編集できる)。
      expect(find.text('在庫を追加'), findsOneWidget);
    });

    testWidgets('想定外エラーは汎用文言 (原典 actions.ts と同一) を出す', (tester) async {
      final repo = _Repo()..error = Exception('boom');
      await tester.pumpWidget(_wrap(repo: repo));

      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();

      await tester.enterText(_nameField(), '牛乳');
      await tester.tap(find.text('追加'));
      await tester.pumpAndSettle();

      expect(find.text('在庫の追加に失敗しました'), findsOneWidget);
      expect(find.textContaining('boom'), findsNothing);
      expect(find.text('在庫を追加'), findsOneWidget);
    });
  });

  group('StockFormSheet 編集モード', () {
    testWidgets('初期値 (名前・小数数量・単位・期限) が埋まり、更新で repository に渡る', (tester) async {
      final repo = _Repo();
      await tester.pumpWidget(_wrap(repo: repo, existing: _existingItem()));

      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();

      expect(find.text('在庫を編集'), findsOneWidget);
      expect(find.text('在庫情報を更新します'), findsOneWidget);
      // 初期値: 名前 / 数量 (num 1.5 → "1.5") / 単位 / 期限 / カテゴリ。
      expect(find.widgetWithText(TextField, '牛乳'), findsOneWidget);
      expect(find.widgetWithText(TextField, '1.5'), findsOneWidget);
      expect(find.text('本'), findsOneWidget);
      expect(find.text('2026-12-31'), findsOneWidget);
      expect(find.text('乳製品'), findsOneWidget);

      await tester.tap(find.text('更新'));
      await tester.pumpAndSettle();

      expect(repo.updated, isNotNull);
      expect(repo.updated!.itemId, 'stock-1');
      expect(repo.updated!.householdId, 'hh-1');
      expect(repo.updated!.name, '牛乳');
      expect(repo.updated!.quantity, 1.5);
      expect(repo.updated!.category, ItemCategory.dairy);
      expect(repo.updated!.unit, '本');
      expect(repo.updated!.expiresAt, '2026-12-31');
      expect(find.text('在庫を更新しました'), findsOneWidget);
      expect(repo.added, isNull);
    });

    testWidgets('整数数量 (2) の初期値は "2" (web の String(2) と同一)', (tester) async {
      final repo = _Repo();
      await tester.pumpWidget(
        _wrap(repo: repo, existing: _existingItem(quantity: 2)),
      );

      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();

      expect(find.widgetWithText(TextField, '2'), findsOneWidget);
      expect(find.widgetWithText(TextField, '2.0'), findsNothing);
    });

    testWidgets('期限のクリアで null を送信できる', (tester) async {
      final repo = _Repo();
      await tester.pumpWidget(_wrap(repo: repo, existing: _existingItem()));

      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();

      await tester.tap(find.byIcon(LucideIcons.x));
      await tester.pumpAndSettle();
      expect(find.text('2026-12-31'), findsNothing);
      expect(find.text('選択'), findsOneWidget);

      await tester.tap(find.text('更新'));
      await tester.pumpAndSettle();

      expect(repo.updated, isNotNull);
      expect(repo.updated!.expiresAt, isNull);
    });
  });
}
