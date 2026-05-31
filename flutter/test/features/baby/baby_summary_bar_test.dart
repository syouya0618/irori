import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:irori/features/baby/domain/baby_log.dart';
import 'package:irori/features/baby/presentation/widgets/baby_summary_bar.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

BabyLog _log({
  required String id,
  required BabyLogType logType,
  DateTime? loggedAt,
}) {
  return BabyLog(
    id: id,
    householdId: 'hh-1',
    logType: logType,
    loggedAt: loggedAt ?? DateTime.utc(2026, 1, 1, 12),
    loggedBy: 'user-1',
    createdAt: DateTime.utc(2026, 1, 1, 12),
  );
}

Widget _harness(BabySummaryBar bar) => MaterialApp(home: Scaffold(body: bar));

void main() {
  testWidgets('全て空のときは各カラム "---"', (tester) async {
    await tester.pumpWidget(
      _harness(
        BabySummaryBar(
          lastFeeding: null,
          diaperCount: 0,
          activeSleep: null,
          lastSleepEndedAt: null,
          now: DateTime.utc(2026, 1, 1, 12),
        ),
      ),
    );

    expect(find.text('授乳'), findsOneWidget);
    expect(find.text('おむつ'), findsOneWidget);
    // 起きてる: activeSleep なし。
    expect(find.text('起きてる'), findsOneWidget);
    expect(find.text('---'), findsNWidgets(3));
  });

  testWidgets('授乳経過は「X前」表示', (tester) async {
    final now = DateTime.utc(2026, 1, 1, 13, 30);
    await tester.pumpWidget(
      _harness(
        BabySummaryBar(
          lastFeeding: _log(
            id: 'f',
            logType: BabyLogType.feeding,
            loggedAt: DateTime.utc(2026, 1, 1, 12, 0),
          ),
          diaperCount: 0,
          activeSleep: null,
          lastSleepEndedAt: null,
          now: now,
        ),
      ),
    );

    // 90 分前 = 1時間30分前
    expect(find.text('1時間30分前'), findsOneWidget);
  });

  testWidgets('おむつ回数は「N回」', (tester) async {
    await tester.pumpWidget(
      _harness(
        BabySummaryBar(
          lastFeeding: null,
          diaperCount: 3,
          activeSleep: null,
          lastSleepEndedAt: null,
          now: DateTime.utc(2026, 1, 1, 12),
        ),
      ),
    );
    expect(find.text('3回'), findsOneWidget);
  });

  testWidgets('睡眠中は Moon + 「睡眠中」 + 経過', (tester) async {
    final now = DateTime.utc(2026, 1, 1, 13, 0);
    await tester.pumpWidget(
      _harness(
        BabySummaryBar(
          lastFeeding: null,
          diaperCount: 0,
          activeSleep: _log(
            id: 's',
            logType: BabyLogType.sleep,
            loggedAt: DateTime.utc(2026, 1, 1, 12, 30),
          ),
          lastSleepEndedAt: null,
          now: now,
        ),
      ),
    );

    expect(find.text('睡眠中'), findsOneWidget);
    expect(find.byIcon(LucideIcons.moon), findsOneWidget);
    expect(find.text('30分'), findsOneWidget);
  });

  testWidgets('起きてる + 最終起床ありは Sun + 覚醒経過', (tester) async {
    final now = DateTime.utc(2026, 1, 1, 14, 0);
    await tester.pumpWidget(
      _harness(
        BabySummaryBar(
          lastFeeding: null,
          diaperCount: 0,
          activeSleep: null,
          lastSleepEndedAt: DateTime.utc(2026, 1, 1, 12, 0),
          now: now,
        ),
      ),
    );

    expect(find.text('起きてる'), findsOneWidget);
    expect(find.byIcon(LucideIcons.sun), findsOneWidget);
    expect(find.text('2時間'), findsOneWidget);
  });
}
