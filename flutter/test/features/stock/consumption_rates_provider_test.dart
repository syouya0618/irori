import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:irori/core/domain/item_category.dart';
import 'package:irori/core/supabase/supabase_providers.dart';
// formatJstDate / shiftYmd は baby_repository.dart の後方互換 re-export 経由
// (unnecessary_import 回避)。
import 'package:irori/features/baby/data/baby_repository.dart';
import 'package:irori/features/baby/domain/baby_log.dart';
import 'package:irori/features/stock/data/consumption_rates_provider.dart';

import '../../support/fake_supabase.dart';

/// `consumptionRatesProvider` (PR-G) のテスト。
///
/// web 原典 `stock/actions.ts` `getConsumptionRates`:
/// baby_logs (diaper/feeding, 直近 7 日) → `calculateDailyRate` →
/// `{ baby: diaperRate }`。

/// `fetchWeeklyLogs` を canned ログで差し替える fake
/// (`stock_page_test._FakeStockRepository` と同じ「必要メソッドのみ」流儀)。
class _FakeBabyRepository extends BabyRepository {
  _FakeBabyRepository(this.logs) : super(FakeSupabaseClient());

  final List<BabyLog> logs;
  int callCount = 0;
  String? lastHouseholdId;
  String? lastFrom;
  String? lastTo;

  @override
  Future<List<BabyLog>> fetchWeeklyLogs(
    String householdId,
    String from,
    String to,
  ) async {
    callCount++;
    lastHouseholdId = householdId;
    lastFrom = from;
    lastTo = to;
    return logs;
  }
}

BabyLog _log(BabyLogType type, String loggedAt) {
  return BabyLog(
    id: 'log-$type-$loggedAt',
    householdId: 'hh-1',
    logType: type,
    loggedAt: DateTime.parse(loggedAt),
    loggedBy: 'user-1',
    createdAt: DateTime.parse(loggedAt),
  );
}

({ProviderContainer container, _FakeBabyRepository repo}) _make({
  required String? householdId,
  List<BabyLog> logs = const [],
}) {
  final repo = _FakeBabyRepository(logs);
  final container = ProviderContainer(
    overrides: [
      currentHouseholdIdProvider.overrideWith((ref) async => householdId),
      babyRepositoryProvider.overrideWithValue(repo),
    ],
  );
  return (container: container, repo: repo);
}

void main() {
  // 実時刻基準の JST today (stock_page_test と同じ相対日付方式)。
  final today = formatJstDate();
  String jstNoon(String ymd) => '${ymd}T12:00:00+09:00';

  test('取得窓は from = (today-7)T00:00:00+09:00 / to = (today+1)T00:00:00+09:00 '
      '(web の TZ 無指定 gte より広い superset prefetch)', () async {
    final m = _make(householdId: 'hh-1');
    addTearDown(m.container.dispose);

    await m.container.read(consumptionRatesProvider.future);

    expect(m.repo.lastHouseholdId, 'hh-1');
    expect(m.repo.lastFrom, '${shiftYmd(today, -7)}T00:00:00+09:00');
    expect(m.repo.lastTo, '${shiftYmd(today, 1)}T00:00:00+09:00');
  });

  test('diaper レートは件数 ÷ ユニーク日数 (7 日窓・実データ日数が分母)', () async {
    final m = _make(
      householdId: 'hh-1',
      logs: [
        // 2 日間に 5 件 → 5/2 = 2.5。
        _log(BabyLogType.diaper, jstNoon(today)),
        _log(BabyLogType.diaper, jstNoon(today)),
        _log(BabyLogType.diaper, jstNoon(shiftYmd(today, -1))),
        _log(BabyLogType.diaper, jstNoon(shiftYmd(today, -1))),
        _log(BabyLogType.diaper, jstNoon(shiftYmd(today, -1))),
      ],
    );
    addTearDown(m.container.dispose);

    final rates = await m.container.read(consumptionRatesProvider.future);

    expect(rates, {ItemCategory.baby: 2.5});
  });

  test('同日複数件は分母 1 日として扱う', () async {
    final m = _make(
      householdId: 'hh-1',
      logs: [
        _log(BabyLogType.diaper, '${today}T08:00:00+09:00'),
        _log(BabyLogType.diaper, '${today}T12:00:00+09:00'),
        _log(BabyLogType.diaper, '${today}T20:00:00+09:00'),
        _log(BabyLogType.diaper, '${today}T23:00:00+09:00'),
      ],
    );
    addTearDown(m.container.dispose);

    final rates = await m.container.read(consumptionRatesProvider.future);

    expect(rates, {ItemCategory.baby: 4.0});
  });

  test('superset prefetch の窓外ログ (today-7) は JST 再フィルタで除外される', () async {
    // from は (today-7)T00:00:00+09:00 だが、calculateDailyRate の窓は
    // 半開区間 (today-7 < logDate <= today)。fetch されても today-7 当日の
    // ログはレートに入らない — web (TZ 無指定 gte) と結果同一の根拠。
    final m = _make(
      householdId: 'hh-1',
      logs: [
        _log(BabyLogType.diaper, jstNoon(shiftYmd(today, -7))), // 窓外
        _log(BabyLogType.diaper, jstNoon(shiftYmd(today, -7))), // 窓外
        _log(BabyLogType.diaper, jstNoon(shiftYmd(today, -7))), // 窓外
        _log(BabyLogType.diaper, jstNoon(shiftYmd(today, -6))), // 窓内
      ],
    );
    addTearDown(m.container.dispose);

    final rates = await m.container.read(consumptionRatesProvider.future);

    // 窓内 1 件 / 1 日 = 1.0 (窓外混入なら 4/2 = 2.0 になり検出される)。
    expect(rates, {ItemCategory.baby: 1.0});
  });

  test('feeding ログは diaper レートに混ざらない', () async {
    final m = _make(
      householdId: 'hh-1',
      logs: [
        _log(BabyLogType.feeding, jstNoon(today)),
        _log(BabyLogType.feeding, jstNoon(today)),
        _log(BabyLogType.diaper, jstNoon(today)),
      ],
    );
    addTearDown(m.container.dispose);

    final rates = await m.container.read(consumptionRatesProvider.future);

    expect(rates, {ItemCategory.baby: 1.0});
  });

  test('diaper ログ 0 件なら baby: null (バッジ非表示の根拠)', () async {
    final m = _make(
      householdId: 'hh-1',
      logs: [_log(BabyLogType.feeding, jstNoon(today))],
    );
    addTearDown(m.container.dispose);

    final rates = await m.container.read(consumptionRatesProvider.future);

    expect(rates.containsKey(ItemCategory.baby), isTrue);
    expect(rates[ItemCategory.baby], isNull);
  });

  test('世帯未参加 (householdId null) は空 map で fetch しない', () async {
    final m = _make(householdId: null);
    addTearDown(m.container.dispose);

    final rates = await m.container.read(consumptionRatesProvider.future);

    expect(rates, isEmpty);
    expect(m.repo.callCount, 0);
  });
}
