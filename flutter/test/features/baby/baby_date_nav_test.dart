import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:irori/features/baby/data/baby_repository.dart';
import 'package:irori/features/baby/data/selected_baby_date_provider.dart';
import 'package:irori/features/baby/presentation/widgets/baby_date_nav.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

/// `selectedBabyDateProvider` を任意の初期日付で固定するためのテスト用 Notifier。
class _FixedDateNotifier extends SelectedBabyDateNotifier {
  _FixedDateNotifier(this._initial);

  final String _initial;

  @override
  String build() => _initial;
}

Widget _harness(String initialDate) {
  return ProviderScope(
    overrides: [
      selectedBabyDateProvider.overrideWith(
        () => _FixedDateNotifier(initialDate),
      ),
    ],
    child: const MaterialApp(home: Scaffold(body: BabyDateNav())),
  );
}

void main() {
  testWidgets('今日のとき「今日」ラベル + 「今日」ボタンなし + 次ボタン disabled', (tester) async {
    final today = formatJstDate();
    await tester.pumpWidget(_harness(today));

    expect(find.text('今日'), findsOneWidget); // 見出しのみ (ボタンは出ない)

    // 次ボタン (chevronRight) は今日で disabled。
    final nextButton = tester.widget<IconButton>(
      find.widgetWithIcon(IconButton, LucideIcons.chevronRight),
    );
    expect(nextButton.onPressed, isNull);

    // 前ボタンは押せる。
    final prevButton = tester.widget<IconButton>(
      find.widgetWithIcon(IconButton, LucideIcons.chevronLeft),
    );
    expect(prevButton.onPressed, isNotNull);
  });

  testWidgets('過去日のとき「昨日」ラベル + 「今日」ボタンあり + 次ボタン有効', (tester) async {
    final today = formatJstDate();
    final yesterday = shiftYmd(today, -1);
    await tester.pumpWidget(_harness(yesterday));

    expect(find.text('昨日'), findsOneWidget);

    // 「今日」ボタン (TextButton) が出る。
    expect(find.widgetWithText(TextButton, '今日'), findsOneWidget);

    final nextButton = tester.widget<IconButton>(
      find.widgetWithIcon(IconButton, LucideIcons.chevronRight),
    );
    expect(nextButton.onPressed, isNotNull);
  });

  testWidgets('前ボタンで前日へ移動する', (tester) async {
    final today = formatJstDate();
    await tester.pumpWidget(_harness(today));

    await tester.tap(find.widgetWithIcon(IconButton, LucideIcons.chevronLeft));
    await tester.pump();

    // 今日 → 昨日 ラベルに変わる。
    expect(find.text('昨日'), findsOneWidget);
  });

  testWidgets('「今日」ボタンで今日へ戻る', (tester) async {
    final today = formatJstDate();
    final twoDaysAgo = shiftYmd(today, -2);
    await tester.pumpWidget(_harness(twoDaysAgo));

    await tester.tap(find.widgetWithText(TextButton, '今日'));
    await tester.pump();

    expect(find.text('今日'), findsOneWidget);
    // 戻った後は「今日」ボタンが消える。
    expect(find.widgetWithText(TextButton, '今日'), findsNothing);
  });

  testWidgets('アイコンボタンは 44px タッチターゲット', (tester) async {
    final today = formatJstDate();
    await tester.pumpWidget(_harness(today));

    final prevSize = tester.getSize(
      find.widgetWithIcon(IconButton, LucideIcons.chevronLeft),
    );
    expect(prevSize.width, greaterThanOrEqualTo(44));
    expect(prevSize.height, greaterThanOrEqualTo(44));
  });
}
