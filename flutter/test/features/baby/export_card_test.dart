import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:irori/features/baby/domain/baby_report_period.dart';
import 'package:irori/features/baby/presentation/export_card.dart';

/// `ExportCard` (Phase 2.6-2) の widget テスト。
///
/// 実デバイス印刷 (`Printing.sharePdf`) を呼ばぬよう `onExport` を stub で注入し
/// (規約「実デバイス印刷を呼ばない形」)、期間選択・ボタン活性・loading 表示・
/// エラー時 SnackBar を検証する。

Widget _wrap({
  required Future<void> Function(WidgetRef ref, BabyReportPeriod period)
  onExport,
}) {
  return ProviderScope(
    child: MaterialApp(
      home: Scaffold(body: ExportCard(onExport: onExport)),
    ),
  );
}

void main() {
  group('ExportCard', () {
    testWidgets('タイトル・説明・3 セグメント・ボタンを表示する', (tester) async {
      await tester.pumpWidget(_wrap(onExport: (_, _) async {}));

      // 原典 export-card.tsx の文言。
      expect(find.text('記録エクスポート'), findsOneWidget);
      expect(find.text('小児科受診用のPDFレポートを生成します。'), findsOneWidget);
      expect(find.text('1週間'), findsOneWidget);
      expect(find.text('1ヶ月'), findsOneWidget);
      expect(find.text('3ヶ月'), findsOneWidget);
      expect(find.text('PDFをダウンロード'), findsOneWidget);
    });

    testWidgets('既定は 1週間、別セグメント選択でその period が export に渡る', (tester) async {
      final periods = <BabyReportPeriod>[];
      await tester.pumpWidget(
        _wrap(onExport: (_, period) async => periods.add(period)),
      );

      // 既定選択 (1週間) のままダウンロード。
      await tester.tap(find.text('PDFをダウンロード'));
      await tester.pumpAndSettle();
      expect(periods.last, BabyReportPeriod.oneWeek);

      // 3ヶ月を選んでダウンロード。
      await tester.tap(find.text('3ヶ月'));
      await tester.pump();
      await tester.tap(find.text('PDFをダウンロード'));
      await tester.pumpAndSettle();
      expect(periods.last, BabyReportPeriod.threeMonths);

      // 1ヶ月を選んでダウンロード。
      await tester.tap(find.text('1ヶ月'));
      await tester.pump();
      await tester.tap(find.text('PDFをダウンロード'));
      await tester.pumpAndSettle();
      expect(periods.last, BabyReportPeriod.oneMonth);
    });

    testWidgets('生成中はスピナーを表示しボタンを無効化する', (tester) async {
      final completer = Completer<void>();
      await tester.pumpWidget(
        _wrap(onExport: (_, _) => completer.future),
      );

      // ダウンロード開始 (future は未完了 = 生成中)。
      await tester.tap(find.text('PDFをダウンロード'));
      await tester.pump();

      // loading 中はスピナー表示 + ボタン disabled。
      expect(find.byType(CircularProgressIndicator), findsOneWidget);
      final button = tester.widget<OutlinedButton>(
        find.byType(OutlinedButton),
      );
      expect(button.onPressed, isNull);

      // 完了させて後片付け (pending タイマーを残さない)。
      completer.complete();
      await tester.pumpAndSettle();
      expect(find.byType(CircularProgressIndicator), findsNothing);
    });

    testWidgets('export 失敗で SnackBar「ダウンロードに失敗しました」を出す', (tester) async {
      await tester.pumpWidget(
        _wrap(onExport: (_, _) async => throw StateError('boom')),
      );

      await tester.tap(find.text('PDFをダウンロード'));
      await tester.pump(); // tap handler 実行
      await tester.pump(); // SnackBar アニメーション開始

      expect(find.text('ダウンロードに失敗しました'), findsOneWidget);
      // 失敗後はボタンが再度有効 (再試行可能)。
      await tester.pumpAndSettle();
      final button = tester.widget<OutlinedButton>(
        find.byType(OutlinedButton),
      );
      expect(button.onPressed, isNotNull);
    });
  });
}
