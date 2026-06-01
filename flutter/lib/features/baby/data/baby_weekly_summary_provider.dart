import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/supabase/supabase_providers.dart';
import '../domain/baby_weekly_summary.dart';
import 'baby_repository.dart';

/// 直近 7 日 (JST, 今日含む) の週間サマリーを供給する provider。
///
/// 原典 `baby-dashboard.tsx` は weekly logs を Realtime 購読して逐次更新するが、
/// 本 Flutter 移植 (PR2) では **FutureProvider** にし、更新は 2 経路で行う:
/// 1. **自分の write 成功後 invalidate** (quick-actions / form-sheet /
///    feeding-timer)。必ず `babyLogsNotifierProvider` の invalidate と同じ場所に
///    並べ、取りこぼしを `grep "invalidate(babyLogsNotifierProvider"` で機械検証
///    できるようにする (CLAUDE.md「検証可能性を担保」)。
/// 2. **今日ログの変化に追従** — `BabyDashboardPage` が
///    `ref.listen(babyLogsNotifierProvider, ...)` で本 provider を invalidate する。
///    `babyLogsNotifierProvider` は Realtime 反映されるため、配偶者の **今日** の
///    書き込みもチャートへ反映される。
///
/// 残る限界: **今日以外** (週内の過去日) への cross-client 書き込みは、本人が
/// 何か書く / 画面を再構築するまで反映されぬ。週全日の cross-client realtime 化は
/// follow-up Issue。
///
/// 世帯未参加なら空リスト (fetch しない)。`fetchWeeklyLogs` は timeout / 構造化
/// ログ / rethrow を内蔵するため、error は AsyncError として UI へ伝播する。
final babyWeeklySummaryProvider = FutureProvider<List<BabyWeeklySummaryDay>>((
  ref,
) async {
  final householdId = await ref.watch(currentHouseholdIdProvider.future);
  if (householdId == null) return const [];

  final repository = ref.watch(babyRepositoryProvider);

  // 原典 weekly window: [today-6, today] を JST 日界で切る。
  // from = 7 日前の JST 00:00、to = 翌日の JST 00:00 (exclusive upper bound)。
  final today = formatJstDate();
  final from = '${shiftYmd(today, -6)}T00:00:00+09:00';
  final to = '${shiftYmd(today, 1)}T00:00:00+09:00';

  final logs = await repository.fetchWeeklyLogs(householdId, from, to);
  return buildBabyWeeklySummary(logs, today);
});
