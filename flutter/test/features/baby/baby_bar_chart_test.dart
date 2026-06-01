import 'package:fl_chart/fl_chart.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:irori/features/baby/presentation/widgets/baby_bar_chart.dart';

/// 原典 `src/components/baby/charts/__tests__/bar-chart.test.ts` の主要回帰を
/// Dart に移植。fl_chart の `BarChart.data` を直接検査して、棒高ロジック
/// (safeMax 正規化・最小棒高フロア・真値 tooltip) を機械検証する。
const _violet = Color(0xFF8B5CF6);

Widget _wrap(Widget chart) => MaterialApp(
  home: Scaffold(body: SizedBox(width: 320, child: chart)),
);

BarChartData _readData(WidgetTester tester) =>
    tester.widget<BarChart>(find.byType(BarChart)).data;

void main() {
  group('BabyBarChart', () {
    testWidgets('maxValue baseline で疎データの棒が満杯にならない (safeMax=baseline)', (
      tester,
    ) async {
      await tester.pumpWidget(
        _wrap(
          const BabyBarChart(
            ariaLabel: '直近7日の睡眠時間',
            data: [(label: '4/16', value: 1)],
            barColor: _violet,
            maxValue: 840,
          ),
        ),
      );

      final data = _readData(tester);
      // baseline が効き、1分の棒が満杯 (maxY=1) にならない。
      expect(data.maxY, 840);
    });

    testWidgets('値 > 0 は最小棒高フロアまで嵩上げされる (原典 max(4px,...) 相当)', (
      tester,
    ) async {
      await tester.pumpWidget(
        _wrap(
          const BabyBarChart(
            ariaLabel: '直近7日の睡眠時間',
            data: [(label: '4/16', value: 1)],
            barColor: _violet,
            maxValue: 840,
          ),
        ),
      );

      final data = _readData(tester);
      final toY = data.barGroups[0].barRods[0].toY;
      // floor = safeMax(840) * 0.0625 = 52.5。真値 1 ではなく床まで嵩上げ。
      expect(toY, closeTo(52.5, 0.001));
    });

    testWidgets('値 == 0 の棒は toY = 0 (描かない)', (tester) async {
      await tester.pumpWidget(
        _wrap(
          const BabyBarChart(
            ariaLabel: '直近7日の睡眠時間',
            data: [(label: '4/16', value: 0)],
            barColor: _violet,
            maxValue: 840,
          ),
        ),
      );

      final data = _readData(tester);
      expect(data.barGroups[0].barRods[0].toY, 0);
    });

    testWidgets('maxValue 未指定だと疎データは満杯まで伸びる (safeMax=value)', (tester) async {
      await tester.pumpWidget(
        _wrap(
          const BabyBarChart(
            ariaLabel: 'x',
            data: [(label: '4/16', value: 1)],
            barColor: _violet,
          ),
        ),
      );

      final data = _readData(tester);
      // safeMax = max(0, 1, 1) = 1。floor = 1*0.0625 = 0.0625 < 1 → toY = 真値 1。
      expect(data.maxY, 1);
      expect(data.barGroups[0].barRods[0].toY, 1);
    });

    testWidgets('データが maxValue を上回れば safeMax が伸びる', (tester) async {
      await tester.pumpWidget(
        _wrap(
          const BabyBarChart(
            ariaLabel: 'x',
            data: [(label: '4/16', value: 10)],
            barColor: _violet,
            maxValue: 8,
          ),
        ),
      );

      final data = _readData(tester);
      // safeMax = max(8, 10, 1) = 10。
      expect(data.maxY, 10);
      expect(data.barGroups[0].barRods[0].toY, 10);
    });

    testWidgets('tooltip は嵩上げ後の toY ではなく真値を表示する', (tester) async {
      await tester.pumpWidget(
        _wrap(
          BabyBarChart(
            ariaLabel: '直近7日の睡眠時間',
            data: const [(label: '4/16', value: 1)],
            barColor: _violet,
            maxValue: 840,
            valueFormatter: (v) => '${v.round()}分',
          ),
        ),
      );

      final data = _readData(tester);
      final item = data.barTouchData.touchTooltipData.getTooltipItem(
        data.barGroups[0],
        0,
        data.barGroups[0].barRods[0],
        0,
      );
      // 棒高フロア (52.5) ではなく真値 1分 を表示。
      expect(item?.text, '4/16: 1分');
    });

    testWidgets('aria-label (Semantics) を付与する', (tester) async {
      await tester.pumpWidget(
        _wrap(
          const BabyBarChart(
            ariaLabel: '直近7日の授乳回数',
            data: [(label: '4/16', value: 2)],
            barColor: _violet,
            maxValue: 8,
          ),
        ),
      );

      // Semantics widget の config を直接検査 (semantics tree 有効化に依存しない)。
      expect(
        find.byWidgetPredicate(
          (w) => w is Semantics && w.properties.label == '直近7日の授乳回数',
        ),
        findsOneWidget,
      );
    });
  });
}
