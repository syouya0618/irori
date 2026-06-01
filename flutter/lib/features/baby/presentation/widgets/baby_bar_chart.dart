import 'dart:math' as math;

import 'package:fl_chart/fl_chart.dart';
import 'package:flutter/material.dart';

/// 棒グラフ 1 本分のデータ。原典 `charts/bar-chart.tsx` の `BarChartDatum`。
typedef BabyBarChartDatum = ({String label, double value});

/// 週間サマリーの棒グラフ。原典 `charts/bar-chart.tsx` (custom SVG) を fl_chart の
/// `BarChart` で移植。
///
/// 原典との対応:
/// - y 軸スケール: `max(maxValue ?? 0, ...values, 1)` (原典 `safeMax`)。疎データで
///   1 本だけ画面いっぱいに伸びるのを防ぐ baseline を [maxValue] で与える。
/// - x 軸ラベル: 各バー下に [BabyBarChartDatum.label] (日付 "M/D")。原典 `<text>`。
/// - tooltip (タップ時): `"label: valueFormatter(value)"`。原典 `<title>` (hover) 相当。
/// - アクセシビリティ: [ariaLabel] を `Semantics` で付与。原典 svg `aria-label`。
class BabyBarChart extends StatelessWidget {
  const BabyBarChart({
    required this.ariaLabel,
    required this.data,
    required this.barColor,
    this.maxValue,
    this.valueFormatter,
    super.key,
  });

  /// スクリーンリーダー向けラベル (原典 `aria-label`)。
  final String ariaLabel;

  /// バー列。空なら何も描画しない。
  final List<BabyBarChartDatum> data;

  /// バーの塗り色 (metric ごとに amber/violet/sky)。
  final Color barColor;

  /// y 軸スケールの最低基準値 (原典 `WEEKLY_CHART_BASELINE`)。
  final double? maxValue;

  /// tooltip 表示時の値整形。省略時は整数表示。
  final String Function(double value)? valueFormatter;

  /// 原典 SVG の plot 高さ (PLOT_HEIGHT 64 + 余白) に概ね合わせる。
  static const double _chartHeight = 104;

  /// 値 > 0 の棒に与える最小高 (maxY に対する比)。原典 `Math.max(4, ...)` の
  /// 4/64 = 0.0625 を踏襲。極小値が不可視になるのを防ぐ。
  static const double _minBarFraction = 0.0625;

  @override
  Widget build(BuildContext context) {
    final formatter = valueFormatter ?? (v) => v.round().toString();

    // 原典 safeMax = max(maxValue ?? 0, ...values, 1)。
    final safeMax = <double>[
      maxValue ?? 0,
      ...data.map((d) => d.value),
      1,
    ].reduce(math.max);

    // 原典 `Math.max(4, normalized * PLOT_HEIGHT)` (bar-chart.tsx) の最小棒高
    // フロア。値 > 0 の棒が極小値 (例: 睡眠 1分 / baseline 840) で事実上不可視に
    // ならないよう、最低限の高さを確保する。原典 4/64=0.0625 比を踏襲し、
    // `safeMax * _minBarFraction` を toY の下限にする。tooltip は真値を出す
    // (棒高だけ嵩上げ、表示値は嵩上げしない — 原典 `<title>` も真値)。
    final minBarY = safeMax * _minBarFraction;

    return Semantics(
      label: ariaLabel,
      container: true,
      child: SizedBox(
        height: _chartHeight,
        child: BarChart(
          BarChartData(
            alignment: BarChartAlignment.spaceBetween,
            maxY: safeMax,
            minY: 0,
            gridData: const FlGridData(show: false),
            borderData: FlBorderData(show: false),
            titlesData: FlTitlesData(
              leftTitles: const AxisTitles(
                sideTitles: SideTitles(showTitles: false),
              ),
              rightTitles: const AxisTitles(
                sideTitles: SideTitles(showTitles: false),
              ),
              topTitles: const AxisTitles(
                sideTitles: SideTitles(showTitles: false),
              ),
              bottomTitles: AxisTitles(
                sideTitles: SideTitles(
                  showTitles: true,
                  reservedSize: 20,
                  getTitlesWidget: (value, meta) {
                    final i = value.round();
                    if (i < 0 || i >= data.length) {
                      return const SizedBox.shrink();
                    }
                    return Padding(
                      padding: const EdgeInsets.only(top: 4),
                      child: Text(
                        data[i].label,
                        style: const TextStyle(
                          fontSize: 10,
                          color: Color(0xFF475569), // muted
                        ),
                      ),
                    );
                  },
                ),
              ),
            ),
            barTouchData: BarTouchData(
              touchTooltipData: BarTouchTooltipData(
                tooltipBorderRadius: BorderRadius.circular(8),
                getTooltipColor: (_) => const Color(0xF20F172A), // slate-900/95
                getTooltipItem: (group, _, rod, _) {
                  final i = group.x;
                  if (i < 0 || i >= data.length) return null;
                  // 真値で表示 (棒高フロアの嵩上げ分を出さない。原典 `<title>` 同様)。
                  return BarTooltipItem(
                    '${data[i].label}: ${formatter(data[i].value)}',
                    const TextStyle(
                      color: Colors.white,
                      fontSize: 12,
                      fontWeight: FontWeight.w600,
                    ),
                  );
                },
              ),
            ),
            barGroups: [
              for (var i = 0; i < data.length; i++)
                BarChartGroupData(
                  x: i,
                  barRods: [
                    BarChartRodData(
                      // 値 > 0 は最小棒高フロアまで嵩上げ (原典の 4px 床に相当)。
                      // 値 == 0 は 0 のまま (棒を描かない)。
                      toY: data[i].value > 0
                          ? math.max(data[i].value, minBarY)
                          : 0,
                      color: barColor,
                      width: 16,
                      borderRadius: const BorderRadius.vertical(
                        top: Radius.circular(4),
                      ),
                    ),
                  ],
                ),
            ],
          ),
        ),
      ),
    );
  }
}
