import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:irori/features/baby/domain/baby_log.dart';
import 'package:irori/features/baby/presentation/widgets/baby_timeline.dart';
import 'package:irori/features/baby/presentation/widgets/baby_timeline_item.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

BabyLog _log({
  required String id,
  required BabyLogType logType,
  DateTime? loggedAt,
  FeedingType? feedingType,
  int? amountMl,
  String? memo,
}) {
  return BabyLog(
    id: id,
    householdId: 'hh-1',
    logType: logType,
    loggedAt: loggedAt ?? DateTime.utc(2026, 1, 1, 3, 0),
    loggedBy: 'user-1',
    feedingType: feedingType,
    amountMl: amountMl,
    memo: memo,
    createdAt: DateTime.utc(2026, 1, 1, 3, 0),
  );
}

Widget _wrap(Widget child) => MaterialApp(home: Scaffold(body: child));

void main() {
  group('BabyTimeline', () {
    testWidgets('空リストは空状態 (Baby アイコン + メッセージ)', (tester) async {
      await tester.pumpWidget(_wrap(const BabyTimeline(logs: [])));

      expect(find.byIcon(LucideIcons.baby), findsOneWidget);
      expect(find.text('まだ記録がありません'), findsOneWidget);
      // 見出しは出ない。
      expect(find.text('タイムライン'), findsNothing);
    });

    testWidgets('非空は見出し + 行を表示', (tester) async {
      final logs = [
        _log(
          id: 'a',
          logType: BabyLogType.feeding,
          feedingType: FeedingType.bottle,
          amountMl: 100,
          loggedAt: DateTime.utc(2026, 1, 1, 3, 0), // JST 12:00
        ),
        _log(
          id: 'b',
          logType: BabyLogType.diaper,
          loggedAt: DateTime.utc(2026, 1, 1, 1, 0), // JST 10:00
        ),
      ];
      await tester.pumpWidget(_wrap(BabyTimeline(logs: logs)));

      expect(find.text('タイムライン'), findsOneWidget);
      expect(find.byType(BabyTimelineItem), findsNWidgets(2));
      expect(find.text('ミルク 100ml'), findsOneWidget);
      expect(find.text('おむつ'), findsOneWidget);
    });
  });

  group('BabyTimelineItem', () {
    testWidgets('要約 + JST 時刻 + 種別アイコンを表示', (tester) async {
      await tester.pumpWidget(
        _wrap(
          BabyTimelineItem(
            log: _log(
              id: 'a',
              logType: BabyLogType.feeding,
              feedingType: FeedingType.bottle,
              amountMl: 120,
              loggedAt: DateTime.utc(2026, 1, 1, 3, 5), // JST 12:05
            ),
          ),
        ),
      );

      expect(find.text('ミルク 120ml'), findsOneWidget);
      expect(find.text('12:05'), findsOneWidget);
      expect(find.byIcon(LucideIcons.milk), findsOneWidget);
    });

    testWidgets('memo があれば補足行に表示', (tester) async {
      await tester.pumpWidget(
        _wrap(
          BabyTimelineItem(
            log: _log(
              id: 'm',
              logType: BabyLogType.memo,
              memo: 'よく寝た',
            ),
          ),
        ),
      );
      // summary と memo 補足の両方に出る (memo の summary も memo 文字列)。
      expect(find.text('よく寝た'), findsNWidgets(2));
    });

    testWidgets('onTap を渡すとタップでコールバックが発火', (tester) async {
      BabyLog? tapped;
      final log = _log(id: 'a', logType: BabyLogType.diaper);
      await tester.pumpWidget(
        _wrap(BabyTimelineItem(log: log, onTap: (l) => tapped = l)),
      );

      await tester.tap(find.byType(BabyTimelineItem));
      await tester.pump();
      expect(tapped?.id, 'a');
    });

    testWidgets('onTap 未指定 (PR1 デフォルト) はタップしても落ちない (no-op)', (tester) async {
      await tester.pumpWidget(
        _wrap(
          BabyTimelineItem(
            log: _log(id: 'a', logType: BabyLogType.diaper),
          ),
        ),
      );
      // タップしても例外が出ないこと。
      await tester.tap(find.byType(BabyTimelineItem));
      await tester.pump();
      expect(tester.takeException(), isNull);
    });

    testWidgets('行は最低 44px 高 (タッチターゲット)', (tester) async {
      await tester.pumpWidget(
        _wrap(
          BabyTimelineItem(
            log: _log(id: 'a', logType: BabyLogType.diaper),
          ),
        ),
      );
      final size = tester.getSize(find.byType(BabyTimelineItem));
      expect(size.height, greaterThanOrEqualTo(44));
    });
  });
}
