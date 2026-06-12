import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:irori/core/domain/item_category.dart';
import 'package:irori/features/stock/domain/stock_item.dart';
import 'package:irori/features/stock/presentation/widgets/stock_item_tile.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

/// PR-G: 残日数バッジ (消費レートベース) + 買い物リスト追加ボタンの
/// widget テスト。web 原典 `stock-item.tsx` `getRemainingDaysStatus` /
/// 「買い物リストに追加」ボタン。
///
/// 期限バッジ側の既存テストは `stock_item_tile_test.dart` (無修正)。

const _today = '2026-06-10';

// web `stock-item.tsx` の残日数バッジ配色トーン (Tailwind)。
const _redBg = Color(0xFFFEE2E2); // red-100
const _redFg = Color(0xFFB91C1C); // red-700
const _amberBg = Color(0xFFFEF3C7); // amber-100
const _amberFg = Color(0xFFB45309); // amber-700
const _blueBg = Color(0xFFEFF6FF); // blue-50
const _blueFg = Color(0xFF1D4ED8); // blue-700

StockItem _item({
  String name = 'おむつ',
  num quantity = 1,
  String? expiresAt,
  ItemCategory category = ItemCategory.baby,
}) {
  return StockItem(
    id: 'stock-1',
    householdId: 'hh-1',
    name: name,
    category: category,
    quantity: quantity,
    unit: null,
    expiresAt: expiresAt,
    createdBy: 'user-1',
    createdAt: DateTime.utc(2026, 6, 8),
  );
}

Widget _wrap(
  StockItem item, {
  num? dailyRate,
  ValueChanged<StockItem>? onAddToShopping,
}) {
  return MaterialApp(
    home: Scaffold(
      body: StockItemTile(
        item: item,
        todayYmd: _today,
        dailyRate: dailyRate,
        onEdit: (_) {},
        onDelete: (_) {},
        onAddToShopping: onAddToShopping,
      ),
    ),
  );
}

/// バッジの pill Container (最も近い Container 祖先) を取り出す
/// (`stock_item_tile_test.dart` と同じ流儀)。
Container _badgeContainer(WidgetTester tester, String label) {
  return tester.widget<Container>(
    find.ancestor(of: find.text(label), matching: find.byType(Container)).first,
  );
}

void _expectBadgeColors(
  WidgetTester tester,
  String label, {
  required Color background,
  required Color foreground,
}) {
  final container = _badgeContainer(tester, label);
  final decoration = container.decoration! as BoxDecoration;
  expect(decoration.color, background);
  final text = tester.widget<Text>(find.text(label));
  expect(text.style?.color, foreground);
}

void main() {
  group('残日数バッジ (web getRemainingDaysStatus 1:1)', () {
    testWidgets('dailyRate null ならバッジを出さない', (tester) async {
      await tester.pumpWidget(_wrap(_item(quantity: 6)));

      expect(find.textContaining('日分'), findsNothing);
    });

    testWidgets('remaining == 0 (今日切れ) は「あと0日分」red で表示する '
        '(0 を falsy 扱いすると漏れる回帰の機械防御)', (tester) async {
      await tester.pumpWidget(_wrap(_item(quantity: 0), dailyRate: 4));

      expect(find.text('あと0日分'), findsOneWidget);
      _expectBadgeColors(
        tester,
        'あと0日分',
        background: _redBg,
        foreground: _redFg,
      );
    });

    testWidgets('remaining <= 3 は red-100', (tester) async {
      await tester.pumpWidget(_wrap(_item(quantity: 6), dailyRate: 2));

      expect(find.text('あと3日分'), findsOneWidget);
      _expectBadgeColors(
        tester,
        'あと3日分',
        background: _redBg,
        foreground: _redFg,
      );
    });

    testWidgets('remaining <= 7 は amber-100', (tester) async {
      await tester.pumpWidget(_wrap(_item(quantity: 14), dailyRate: 2));

      expect(find.text('あと7日分'), findsOneWidget);
      _expectBadgeColors(
        tester,
        'あと7日分',
        background: _amberBg,
        foreground: _amberFg,
      );
    });

    testWidgets('remaining > 7 は blue-50', (tester) async {
      await tester.pumpWidget(_wrap(_item(quantity: 16), dailyRate: 2));

      expect(find.text('あと8日分'), findsOneWidget);
      _expectBadgeColors(
        tester,
        'あと8日分',
        background: _blueBg,
        foreground: _blueFg,
      );
    });

    testWidgets('小数 quantity は floor (web Math.floor) で日数化する', (tester) async {
      // 1.5 / 1.0 = 1.5 → floor 1。
      await tester.pumpWidget(_wrap(_item(quantity: 1.5), dailyRate: 1));

      expect(find.text('あと1日分'), findsOneWidget);
    });

    testWidgets('期限バッジと残日数バッジは共存する (期限 → 残日数の順)', (tester) async {
      await tester.pumpWidget(
        _wrap(_item(quantity: 6, expiresAt: _today), dailyRate: 2),
      );

      // 期限バッジ (今日まで) と残日数バッジの両方が出る。
      expect(find.text('今日まで'), findsOneWidget);
      expect(find.text('あと3日分'), findsOneWidget);
      // web の DOM 順: 期限バッジが先 (左)。
      final expiryX = tester.getTopLeft(find.text('今日まで')).dx;
      final remainingX = tester.getTopLeft(find.text('あと3日分')).dx;
      expect(expiryX, lessThan(remainingX));
    });
  });

  group('買い物リストに追加ボタン', () {
    testWidgets('カートアイコンのタップで onAddToShopping にアイテムが渡る', (tester) async {
      StockItem? added;
      await tester.pumpWidget(
        _wrap(_item(), onAddToShopping: (item) => added = item),
      );

      await tester.tap(find.byIcon(LucideIcons.shoppingCart));
      await tester.pump();

      expect(added, isNotNull);
      expect(added!.id, 'stock-1');
    });

    testWidgets('onAddToShopping 未指定ならカートボタンを出さない', (tester) async {
      await tester.pumpWidget(_wrap(_item()));

      expect(find.byIcon(LucideIcons.shoppingCart), findsNothing);
    });

    testWidgets('tooltip は web の aria-label と同文言', (tester) async {
      await tester.pumpWidget(_wrap(_item(), onAddToShopping: (_) {}));

      expect(
        find.byTooltip('おむつを買い物リストに追加'),
        findsOneWidget,
      );
    });
  });
}
