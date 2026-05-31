import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../widgets/glass_card.dart';
import '../data/baby_logs_notifier.dart';
import '../data/last_sleep_provider.dart';
import '../data/now_ticker_provider.dart';
import '../domain/baby_log.dart';
import 'baby_summary.dart';
import 'widgets/baby_date_nav.dart';
import 'widgets/baby_summary_bar.dart';
import 'widgets/baby_timeline.dart';

/// 育児ログ ダッシュボード。Next.js 原典 `baby-dashboard.tsx` の表示側を移植。
///
/// 表示構成 (縦): DateNav → SummaryBar → Timeline。
/// 書き込み系 (クイックアクション / ログ入力 / 授乳タイマー / 週間サマリー) は
/// 別 PR のため本 PR では描画しない。
///
/// データ:
/// - `babyLogsNotifierProvider` を `.when(data/loading/error)` で消費
///   (`.future` は await しない — doc コメント参照)。
/// - data 時に `deriveBabySummary` でサマリー導出。
/// - `lastSleepEndedAt` は **derived 優先**、無ければ `lastSleepEndedAtProvider`
///   をフォールバック (原典 `derivedLastSleepEndedAt ?? lastSleepEndedAt`)。
/// - `now` は `nowTickerProvider` (60s 周期) を watch。
class BabyDashboardPage extends ConsumerWidget {
  const BabyDashboardPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final logsAsync = ref.watch(babyLogsNotifierProvider);

    return Scaffold(
      appBar: AppBar(title: const Text('育児ログ')),
      body: SafeArea(
        child: logsAsync.when(
          // reload (日付変更 / auth 再計算) 時は前データを保持しつつ裏で更新する。
          // skipLoadingOnReload 既定 false だと reload のたびに全画面 spinner に
          // 戻り、原典 Next.js (前データを保持したまま setLogs) と乖離する
          // (PR #60 review M1)。初回 loading (データ未取得) では従来どおり spinner。
          skipLoadingOnReload: true,
          data: (logs) => _DashboardBody(logs: logs),
          loading: () => const Center(child: CircularProgressIndicator()),
          error: (error, _) => Center(
            child: Padding(
              padding: const EdgeInsets.all(24),
              child: _ErrorView(error: error),
            ),
          ),
        ),
      ),
    );
  }
}

/// data 分岐の本体。サマリー導出 + DateNav / SummaryBar / Timeline を縦に並べる。
class _DashboardBody extends ConsumerWidget {
  const _DashboardBody({required this.logs});

  final List<BabyLog> logs;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    // logs は `babyLogsNotifierProvider` が `logged_at` 降順で保つ前提。
    // deriveBabySummary は「最初 = 最新」を load-bearing に使うため、
    // この順序を崩す refactor をしないこと (原典 baby-dashboard.tsx L182-206)。
    final summary = deriveBabySummary(logs);

    // now は 60s ごとに更新。初回 emit 前は端末の現在時刻でフォールバック
    // (購読直後に経過が "---" にならないよう即値を出す)。
    final now = ref.watch(nowTickerProvider).value ?? DateTime.now();

    // lastSleepEndedAt: 原典 `derivedLastSleepEndedAt ?? lastSleepEndedAt`。
    // derived (logs 由来 / realtime reactive) を優先し、無ければ FutureProvider
    // のフォールバック値を使う (cross-day の起床経過用)。
    final fallbackLastSleep = ref.watch(lastSleepEndedAtProvider).value;
    final effectiveLastSleepEndedAt =
        summary.derivedLastSleepEndedAt ?? fallbackLastSleep;

    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 32),
      children: [
        const BabyDateNav(),
        const SizedBox(height: 16),
        BabySummaryBar(
          lastFeeding: summary.lastFeeding,
          diaperCount: summary.diaperCount,
          activeSleep: summary.activeSleep,
          lastSleepEndedAt: effectiveLastSleepEndedAt,
          now: now,
        ),
        const SizedBox(height: 16),
        BabyTimeline(logs: logs),
      ],
    );
  }
}

/// error 分岐の placeholder (既存実装を流用)。
class _ErrorView extends StatelessWidget {
  const _ErrorView({required this.error});

  final Object error;

  @override
  Widget build(BuildContext context) {
    return GlassCard(
      padding: const EdgeInsets.all(24),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Icon(Icons.error_outline, color: Colors.red),
          const SizedBox(height: 12),
          Text(
            '育児ログの読み込みに失敗しました。',
            style: Theme.of(context).textTheme.bodyLarge,
          ),
          const SizedBox(height: 8),
          Text(
            '$error',
            style: Theme.of(context).textTheme.bodySmall,
          ),
        ],
      ),
    );
  }
}
