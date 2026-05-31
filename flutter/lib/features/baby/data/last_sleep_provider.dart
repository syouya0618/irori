import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/supabase/supabase_providers.dart';
import 'baby_repository.dart';

/// 直近の「完了済み睡眠」終了時刻を取得する FutureProvider。
///
/// Next.js 原典 (`baby/page.tsx` → `baby-dashboard.tsx` の `lastSleepEndedAt`
/// server prop) のフォールバック相当。ダッシュボードでは
/// `deriveBabySummary().derivedLastSleepEndedAt ?? <この値>` の **後者** として
/// 使う (logs 由来が優先、cross-day の起床経過のためのフォールバック)。
///
/// 世帯未参加なら null。`fetchLastSleep` は完了済み睡眠が無ければ null を返す。
final lastSleepEndedAtProvider = FutureProvider<DateTime?>((ref) async {
  final householdId = await ref.watch(currentHouseholdIdProvider.future);
  if (householdId == null) return null;
  final repository = ref.watch(babyRepositoryProvider);
  return repository.fetchLastSleep(householdId);
});
