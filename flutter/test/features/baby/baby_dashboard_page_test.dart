import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:irori/features/baby/data/baby_logs_notifier.dart';
import 'package:irori/features/baby/data/baby_repository.dart';
import 'package:irori/features/baby/data/last_sleep_provider.dart';
import 'package:irori/features/baby/data/now_ticker_provider.dart';
import 'package:irori/features/baby/data/selected_baby_date_provider.dart';
import 'package:irori/features/baby/domain/baby_log.dart';
import 'package:irori/features/baby/presentation/baby_dashboard_page.dart';
import 'package:irori/features/baby/presentation/widgets/baby_date_nav.dart';
import 'package:irori/features/baby/presentation/widgets/baby_summary_bar.dart';
import 'package:irori/features/baby/presentation/widgets/baby_timeline.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

BabyLog _log({
  required String id,
  required BabyLogType logType,
  DateTime? loggedAt,
  DateTime? endedAt,
  FeedingType? feedingType,
  int? amountMl,
}) {
  return BabyLog(
    id: id,
    householdId: 'hh-1',
    logType: logType,
    loggedAt: loggedAt ?? DateTime.utc(2026, 1, 1, 3, 0),
    loggedBy: 'user-1',
    feedingType: feedingType,
    amountMl: amountMl,
    endedAt: endedAt,
    createdAt: DateTime.utc(2026, 1, 1, 3, 0),
  );
}

/// 固定リストを返す AsyncNotifier (data 分岐用)。
class _FakeLogsNotifier extends BabyLogsNotifier {
  _FakeLogsNotifier(this._logs);

  final List<BabyLog> _logs;

  @override
  Future<List<BabyLog>> build() async => _logs;
}

/// build で throw する AsyncNotifier (error 分岐用)。
class _ErrorLogsNotifier extends BabyLogsNotifier {
  @override
  Future<List<BabyLog>> build() async => throw Exception('boom');
}

/// 完了しない build (loading 分岐用)。
class _LoadingLogsNotifier extends BabyLogsNotifier {
  @override
  Future<List<BabyLog>> build() {
    final c = Completer<List<BabyLog>>();
    return c.future; // 永遠に未完了 = loading のまま。
  }
}

/// selectedBabyDate を固定日に。
class _FixedDateNotifier extends SelectedBabyDateNotifier {
  _FixedDateNotifier(this._d);
  final String _d;
  @override
  String build() => _d;
}

Widget _harness({
  required BabyLogsNotifier Function() logsNotifier,
  String? selectedDate,
  DateTime? now,
  DateTime? lastSleepFallback,
}) {
  return ProviderScope(
    overrides: [
      babyLogsNotifierProvider.overrideWith(logsNotifier),
      selectedBabyDateProvider.overrideWith(
        () => _FixedDateNotifier(selectedDate ?? formatJstDate()),
      ),
      // now ticker を固定値の単発 Stream に差し替え (周期 Timer を回さない)。
      nowTickerProvider.overrideWith(
        (ref) => Stream.value(now ?? DateTime.utc(2026, 1, 1, 12)),
      ),
      lastSleepEndedAtProvider.overrideWith((ref) async => lastSleepFallback),
    ],
    child: const MaterialApp(home: BabyDashboardPage()),
  );
}

void main() {
  testWidgets('loading 分岐は CircularProgressIndicator', (tester) async {
    await tester.pumpWidget(_harness(logsNotifier: _LoadingLogsNotifier.new));
    await tester.pump(); // build microtask
    expect(find.byType(CircularProgressIndicator), findsOneWidget);
  });

  testWidgets('error 分岐はエラー表示', (tester) async {
    await tester.pumpWidget(_harness(logsNotifier: _ErrorLogsNotifier.new));
    await tester.pumpAndSettle();
    expect(find.text('育児ログの読み込みに失敗しました。'), findsOneWidget);
  });

  testWidgets('data 分岐は DateNav + SummaryBar + Timeline を縦に表示', (tester) async {
    await tester.pumpWidget(
      _harness(
        logsNotifier: () => _FakeLogsNotifier([
          _log(
            id: 'f',
            logType: BabyLogType.feeding,
            feedingType: FeedingType.bottle,
            amountMl: 100,
            loggedAt: DateTime.utc(2026, 1, 1, 3, 0),
          ),
        ]),
        selectedDate: formatJstDate(),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.byType(BabyDateNav), findsOneWidget);
    expect(find.byType(BabySummaryBar), findsOneWidget);
    expect(find.byType(BabyTimeline), findsOneWidget);
    // タイムラインに行が出る。
    expect(find.text('ミルク 100ml'), findsOneWidget);
  });

  testWidgets('data 分岐: 空ログは Timeline 空状態', (tester) async {
    await tester.pumpWidget(
      _harness(logsNotifier: () => _FakeLogsNotifier(const [])),
    );
    await tester.pumpAndSettle();

    expect(find.text('まだ記録がありません'), findsOneWidget);
    expect(find.byIcon(LucideIcons.baby), findsOneWidget);
  });

  testWidgets('サマリー: active sleep があれば「睡眠中」で経過表示', (tester) async {
    await tester.pumpWidget(
      _harness(
        logsNotifier: () => _FakeLogsNotifier([
          _log(
            id: 's',
            logType: BabyLogType.sleep,
            loggedAt: DateTime.utc(2026, 1, 1, 11, 30),
          ),
        ]),
        now: DateTime.utc(2026, 1, 1, 12, 0),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('睡眠中'), findsOneWidget);
    expect(find.text('30分'), findsOneWidget);
  });

  testWidgets(
    'lastSleepEndedAt: derived が無ければ fallback provider を使う (覚醒経過)',
    (tester) async {
      await tester.pumpWidget(
        _harness(
          // sleep ログ無し → derivedLastSleepEndedAt は null。
          logsNotifier: () => _FakeLogsNotifier([
            _log(id: 'd', logType: BabyLogType.diaper),
          ]),
          now: DateTime.utc(2026, 1, 1, 14, 0),
          lastSleepFallback: DateTime.utc(2026, 1, 1, 12, 0),
        ),
      );
      await tester.pumpAndSettle();

      // fallback (12:00) 起床 → now (14:00) = 2時間 の覚醒経過。
      expect(find.text('起きてる'), findsOneWidget);
      expect(find.text('2時間'), findsOneWidget);
    },
  );

  testWidgets(
    'lastSleepEndedAt: derived があれば fallback より優先される',
    (tester) async {
      await tester.pumpWidget(
        _harness(
          // 完了済み sleep (13:00 終了) → derived が優先される。
          logsNotifier: () => _FakeLogsNotifier([
            _log(
              id: 's',
              logType: BabyLogType.sleep,
              loggedAt: DateTime.utc(2026, 1, 1, 11, 0),
              endedAt: DateTime.utc(2026, 1, 1, 13, 0),
            ),
          ]),
          now: DateTime.utc(2026, 1, 1, 14, 0),
          // fallback は 09:00 だが derived(13:00) が勝つはず。
          lastSleepFallback: DateTime.utc(2026, 1, 1, 9, 0),
        ),
      );
      await tester.pumpAndSettle();

      // derived 13:00 起床 → now 14:00 = 1時間。
      expect(find.text('起きてる'), findsOneWidget);
      expect(find.text('1時間'), findsOneWidget);
    },
  );

  testWidgets(
    'now ticker の新 emit でサマリー経過が再計算・再描画される (60s 更新の wiring)',
    (tester) async {
      // ticker を手動制御 Stream に差し替え、emit で rebuild が走り経過が
      // 更新されることを検証する (advisor 指摘: 60s 更新 wiring の未検証を解消)。
      final controller = StreamController<DateTime>();
      addTearDown(controller.close);

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            babyLogsNotifierProvider.overrideWith(
              () => _FakeLogsNotifier([
                _log(
                  id: 's',
                  logType: BabyLogType.sleep,
                  loggedAt: DateTime.utc(2026, 1, 1, 12, 0),
                ),
              ]),
            ),
            selectedBabyDateProvider.overrideWith(
              () => _FixedDateNotifier(formatJstDate()),
            ),
            nowTickerProvider.overrideWith((ref) => controller.stream),
            lastSleepEndedAtProvider.overrideWith((ref) async => null),
          ],
          child: const MaterialApp(home: BabyDashboardPage()),
        ),
      );

      // 初回 emit: 12:30 → 睡眠 30分。
      controller.add(DateTime.utc(2026, 1, 1, 12, 30));
      await tester.pumpAndSettle();
      expect(find.text('睡眠中'), findsOneWidget);
      expect(find.text('30分'), findsOneWidget);

      // 次の tick: 13:00 → 睡眠 1時間 に更新される (rebuild 検証)。
      controller.add(DateTime.utc(2026, 1, 1, 13, 0));
      await tester.pumpAndSettle();
      expect(find.text('30分'), findsNothing);
      expect(find.text('1時間'), findsOneWidget);
    },
  );
}
