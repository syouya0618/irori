import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/domain/consumption_rate.dart';
import '../../../core/domain/item_category.dart';
import '../../../core/supabase/supabase_providers.dart';
// formatJstDate / shiftYmd は baby_repository.dart の後方互換 re-export 経由
// (unnecessary_import 回避 — 直接 import すると重複になる)。
import '../../baby/data/baby_repository.dart';
import '../../baby/domain/baby_log.dart';

/// 消耗品カテゴリごとの日次消費レート。
///
/// web 原典 `stock/actions.ts` `getConsumptionRates`: baby_logs
/// (diaper/feeding, 直近 7 日) → `calculateDailyRate` → `{ baby: diaperRate }`
/// を stock ページが残日数バッジに使う。現在は baby (おむつ) のみ対応。
///
/// 取得は `BabyRepository.fetchWeeklyLogs` を再利用する。web との差分は
/// すべて **superset prefetch** で、`calculateDailyRate` の JST 半開区間
/// `(today-7, today]` 再フィルタにより結果は web と同一:
/// - **窓**: from = `(today-7)T00:00:00+09:00` / to = `(today+1)T00:00:00+09:00`。
///   web の TZ 無指定 `gte("logged_at", `${weekAgo}T00:00:00`)` はセッション
///   TZ (UTC) 解釈 = `(today-7)T09:00:00+09:00` 以降・上限なしのため、
///   from は web より 9 時間広く、to は「JST 今日まで」を全て含む。
/// - **log_type**: web は `.in("log_type", ["diaper", "feeding"])` で絞るが、
///   `fetchWeeklyLogs` は全タイプ + 期間跨ぎ sleep の OR 条件を含む。
///   余分な行は `calculateDailyRate` の logType フィルタで落ちる。
/// - **limit**: web は本経路 limit 無し / `low-stock.ts` は limit(500) の
///   不一致がある。Flutter は両経路とも **limit 無しに統一**
///   (`StockRepository.autoAddLowStockItems` doc と対)。
///
/// 鮮度の限界 (`babyWeeklySummaryProvider` と同類 — 意図的):
/// realtime 非追従・日付跨ぎの自動再計算なし。provider が生きている間は
/// キャッシュされ、アプリ再起動 or invalidate で更新される。web も
/// ページ load 時 fetch のみのため、バッジ鮮度の要件は同水準。
final consumptionRatesProvider = FutureProvider<Map<ItemCategory, double?>>((
  ref,
) async {
  final householdId = await ref.watch(currentHouseholdIdProvider.future);
  if (householdId == null) return const {};

  final repository = ref.watch(babyRepositoryProvider);

  final now = DateTime.now();
  final today = formatJstDate(now);
  final from = '${shiftYmd(today, -7)}T00:00:00+09:00';
  final to = '${shiftYmd(today, 1)}T00:00:00+09:00';

  final logs = await repository.fetchWeeklyLogs(householdId, from, to);
  final inputs = [
    for (final log in logs)
      ConsumptionLogInput(logType: log.logType, loggedAt: log.loggedAt),
  ];
  final diaperRate = calculateDailyRate(inputs, BabyLogType.diaper, today: now);

  // web `getConsumptionRates` の `{ baby: diaperRate }` に対応。UI 消費用に
  // ItemCategory キーへ変換する (repository 内の生文字列キーとは役割が違う)。
  return {ItemCategory.baby: diaperRate};
});
