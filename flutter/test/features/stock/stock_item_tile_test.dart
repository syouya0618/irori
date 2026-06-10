import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:irori/core/domain/item_category.dart';
import 'package:irori/core/theme/colors.dart';
import 'package:irori/features/stock/domain/stock_item.dart';
import 'package:irori/features/stock/presentation/widgets/stock_item_tile.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

// 基準日は固定 (todayYmd 引数で注入 — 実時刻に依存しない)。
const _today = '2026-06-10';

// web `stock-item.tsx` の期限バッジ配色トーン (Tailwind)。
const _redBg = Color(0xFFFEE2E2); // red-100
const _redFg = Color(0xFFB91C1C); // red-700
const _amberBg = Color(0xFFFEF3C7); // amber-100
const _amberFg = Color(0xFFB45309); // amber-700
const _yellowBg = Color(0xFFFEFCE8); // yellow-50
const _yellowFg = Color(0xFFA16207); // yellow-700

StockItem _item({
  String name = '牛乳',
  num quantity = 1,
  String? unit,
  String? expiresAt,
}) {
  return StockItem(
    id: 'stock-1',
    householdId: 'hh-1',
    name: name,
    category: ItemCategory.dairy,
    quantity: quantity,
    unit: unit,
    expiresAt: expiresAt,
    createdBy: 'user-1',
    createdAt: DateTime.utc(2026, 6, 8),
  );
}

Widget _wrap(
  StockItem item, {
  ValueChanged<StockItem>? onEdit,
  ValueChanged<StockItem>? onDelete,
}) {
  return MaterialApp(
    home: Scaffold(
      body: StockItemTile(
        item: item,
        todayYmd: _today,
        onEdit: onEdit ?? (_) {},
        onDelete: onDelete ?? (_) {},
      ),
    ),
  );
}

/// バッジの pill Container (最も近い Container 祖先) を取り出す。
Container _badgeContainer(WidgetTester tester, String label) {
  return tester.widget<Container>(
    find.ancestor(of: find.text(label), matching: find.byType(Container)).first,
  );
}

void main() {
  group('数量表示 (num の web 書式)', () {
    testWidgets('小数 1.5 は "1.5"、単位があれば半角スペース区切り', (tester) async {
      await tester.pumpWidget(_wrap(_item(quantity: 1.5, unit: 'パック')));
      expect(find.text('1.5 パック'), findsOneWidget);
    });

    testWidgets('整数 2 は "2" (単位なしは数量のみ)', (tester) async {
      await tester.pumpWidget(_wrap(_item(quantity: 2)));
      expect(find.text('2'), findsOneWidget);
    });

    testWidgets('double の 2.0 も web (JS) と同じく "2" と表示する', (tester) async {
      // VM では (2.0).toString() == "2.0" になるため、書式関数を通さないと
      // web 表示 ("2") と食い違う — その回帰を検出する。
      await tester.pumpWidget(_wrap(_item(quantity: 2.0, unit: '個')));
      expect(find.text('2 個'), findsOneWidget);
      expect(find.text('2.0 個'), findsNothing);
    });
  });

  group('期限バッジ (classifyExpiry の分岐と web 配色トーン)', () {
    testWidgets('期限切れ (diff < 0) は「期限切れ」赤バッジ', (tester) async {
      await tester.pumpWidget(_wrap(_item(expiresAt: '2026-06-09')));

      expect(find.text('期限切れ'), findsOneWidget);
      final container = _badgeContainer(tester, '期限切れ');
      expect((container.decoration as BoxDecoration?)?.color, _redBg);
      final text = tester.widget<Text>(find.text('期限切れ'));
      expect(text.style?.color, _redFg);
    });

    testWidgets('当日 (diff == 0) は「今日まで」赤バッジ', (tester) async {
      await tester.pumpWidget(_wrap(_item(expiresAt: '2026-06-10')));

      expect(find.text('今日まで'), findsOneWidget);
      final container = _badgeContainer(tester, '今日まで');
      expect((container.decoration as BoxDecoration?)?.color, _redBg);
      final text = tester.widget<Text>(find.text('今日まで'));
      expect(text.style?.color, _redFg);
    });

    testWidgets('3日以内は「あとN日」アンバーバッジ', (tester) async {
      await tester.pumpWidget(_wrap(_item(expiresAt: '2026-06-12')));

      expect(find.text('あと2日'), findsOneWidget);
      final container = _badgeContainer(tester, 'あと2日');
      expect((container.decoration as BoxDecoration?)?.color, _amberBg);
      final text = tester.widget<Text>(find.text('あと2日'));
      expect(text.style?.color, _amberFg);
    });

    testWidgets('7日以内は M/D イエローバッジ (ゼロ詰めなし)', (tester) async {
      await tester.pumpWidget(_wrap(_item(expiresAt: '2026-06-16')));

      expect(find.text('6/16'), findsOneWidget);
      final container = _badgeContainer(tester, '6/16');
      expect((container.decoration as BoxDecoration?)?.color, _yellowBg);
      final text = tester.widget<Text>(find.text('6/16'));
      expect(text.style?.color, _yellowFg);
    });

    testWidgets('8日以上先は M/D を muted で表示 (pill 背景なし)', (tester) async {
      await tester.pumpWidget(_wrap(_item(expiresAt: '2026-07-05')));

      expect(find.text('7/5'), findsOneWidget);
      final container = _badgeContainer(tester, '7/5');
      expect(container.decoration, isNull);
      final text = tester.widget<Text>(find.text('7/5'));
      expect(text.style?.color, IroriColors.textMuted);
    });

    testWidgets('期限なし (null) はバッジを表示しない', (tester) async {
      await tester.pumpWidget(_wrap(_item(expiresAt: null)));
      expect(find.byKey(const Key('stockExpiryBadge')), findsNothing);
    });
  });

  group('操作', () {
    testWidgets('行タップで onEdit にアイテムが渡る', (tester) async {
      StockItem? edited;
      final item = _item();
      await tester.pumpWidget(_wrap(item, onEdit: (i) => edited = i));

      await tester.tap(find.text('牛乳'));
      await tester.pump();

      expect(edited, item);
    });

    testWidgets('削除は確認 2 タップ目で onDelete (1 タップ目では呼ばれない)', (tester) async {
      StockItem? deleted;
      final item = _item();
      await tester.pumpWidget(_wrap(item, onDelete: (i) => deleted = i));

      await tester.tap(find.byIcon(LucideIcons.trash2));
      await tester.pump();
      expect(deleted, isNull);

      await tester.tap(find.byIcon(LucideIcons.trash2));
      await tester.pump();
      expect(deleted, item);
    });

    testWidgets('確認状態は 3 秒で自動解除される (web の 3000ms と同一)', (tester) async {
      StockItem? deleted;
      await tester.pumpWidget(_wrap(_item(), onDelete: (i) => deleted = i));

      await tester.tap(find.byIcon(LucideIcons.trash2));
      await tester.pump();

      // 3 秒経過で確認状態が解除されるため、次のタップは「1 回目」扱い。
      await tester.pump(const Duration(seconds: 3, milliseconds: 100));
      await tester.tap(find.byIcon(LucideIcons.trash2));
      await tester.pump();
      expect(deleted, isNull);

      // 解除後でも連続 2 タップなら確定する。
      await tester.tap(find.byIcon(LucideIcons.trash2));
      await tester.pump();
      expect(deleted, isNotNull);
    });
  });
}
