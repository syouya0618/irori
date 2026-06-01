import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:irori/features/baby/domain/baby_weekly_summary.dart';
import 'package:irori/features/baby/presentation/widgets/baby_bar_chart.dart';
import 'package:irori/features/baby/presentation/widgets/baby_weekly_summary.dart';

List<BabyWeeklySummaryDay> _days() => const [
  (date: '2026-04-05', feedingCount: 0, diaperCount: 0, sleepMinutes: 0),
  (date: '2026-04-06', feedingCount: 1, diaperCount: 2, sleepMinutes: 60),
  (date: '2026-04-07', feedingCount: 0, diaperCount: 0, sleepMinutes: 0),
  (date: '2026-04-08', feedingCount: 3, diaperCount: 1, sleepMinutes: 120),
  (date: '2026-04-09', feedingCount: 0, diaperCount: 0, sleepMinutes: 0),
  (date: '2026-04-10', feedingCount: 2, diaperCount: 2, sleepMinutes: 90),
  (date: '2026-04-11', feedingCount: 1, diaperCount: 0, sleepMinutes: 0),
];

Widget _wrap(List<BabyWeeklySummaryDay> days) {
  return MaterialApp(
    home: Scaffold(
      body: SingleChildScrollView(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: BabyWeeklySummary(days: days),
        ),
      ),
    ),
  );
}

void main() {
  group('BabyWeeklySummary', () {
    testWidgets('セクション見出しと3つの棒グラフを表示する', (tester) async {
      await tester.pumpWidget(_wrap(_days()));
      await tester.pumpAndSettle();

      expect(find.text('週間サマリー'), findsOneWidget);
      // 授乳 / 睡眠 / おむつ の 3 metric ぶんの棒グラフ。
      expect(find.byType(BabyBarChart), findsNWidgets(3));
    });

    testWidgets('週間合計を StatHeader と各 metric 見出しに表示する', (tester) async {
      await tester.pumpWidget(_wrap(_days()));
      await tester.pumpAndSettle();

      // feeding 合計 = 0+1+0+3+0+2+1 = 7回 (StatHeader と授乳ブロック見出しの 2 箇所)。
      expect(find.text('7回'), findsNWidgets(2));
      // diaper 合計 = 0+2+0+1+0+2+0 = 5回。
      expect(find.text('5回'), findsNWidgets(2));
      // sleep 合計 = 0+60+0+120+0+90+0 = 270分 = 4時間30分。
      expect(find.text('4時間30分'), findsNWidgets(2));
    });

    testWidgets('全ゼロでもクラッシュせず 0 を表示する', (tester) async {
      final zero = <BabyWeeklySummaryDay>[
        for (var i = 5; i <= 11; i++)
          (
            date: '2026-04-${i.toString().padLeft(2, '0')}',
            feedingCount: 0,
            diaperCount: 0,
            sleepMinutes: 0,
          ),
      ];
      await tester.pumpWidget(_wrap(zero));
      await tester.pumpAndSettle();

      // 授乳/おむつ の 0回 (各 2 箇所) = 4、睡眠は 0分 (2 箇所)。
      expect(find.text('0回'), findsNWidgets(4));
      expect(find.text('0分'), findsNWidgets(2));
      expect(find.byType(BabyBarChart), findsNWidgets(3));
    });

    testWidgets('日付ラベル (M/D) を軸に描画する', (tester) async {
      await tester.pumpWidget(_wrap(_days()));
      await tester.pumpAndSettle();

      // fl_chart の bottomTitles が各チャートに日付ラベルを描く (3 チャート分)。
      expect(find.text('4/10'), findsNWidgets(3));
    });
  });
}
