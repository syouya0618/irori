import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../widgets/glass_card.dart';
import '../data/baby_logs_notifier.dart';
import '../data/baby_repository.dart';
import '../data/baby_weekly_summary_provider.dart';
import '../data/last_sleep_provider.dart';
import '../data/now_ticker_provider.dart';
import '../data/selected_baby_date_provider.dart';
import '../domain/baby_log.dart';
import 'baby_summary.dart';
import 'widgets/baby_date_nav.dart';
import 'widgets/baby_feeding_timer.dart';
import 'widgets/baby_log_form_sheet.dart';
import 'widgets/baby_quick_actions.dart';
import 'widgets/baby_summary_bar.dart';
import 'widgets/baby_timeline.dart';
import 'widgets/baby_weekly_summary.dart';

/// 育児ログ ダッシュボード。Next.js 原典 `baby-dashboard.tsx` の表示側を移植。
///
/// 表示構成 (縦): DateNav → SummaryBar → QuickActions(今日のみ) →
/// WeeklySummary → Timeline。授乳タイマーは QuickActions の左右授乳ボタンから
/// `showBabyFeedingTimer` で開く (#61)。
///
/// データ:
/// - `babyLogsNotifierProvider` を `.when(data/loading/error)` で消費
///   (`.future` は await しない — doc コメント参照)。
/// - 週間サマリーは `babyWeeklySummaryProvider` (FutureProvider) を `.when` で消費。
/// - data 時に `deriveBabySummary` でサマリー導出。
/// - `lastSleepEndedAt` は **derived 優先**、無ければ `lastSleepEndedAtProvider`
///   をフォールバック (原典 `derivedLastSleepEndedAt ?? lastSleepEndedAt`)。
/// - `now` は `nowTickerProvider` (60s 周期) を watch。
class BabyDashboardPage extends ConsumerWidget {
  const BabyDashboardPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final logsAsync = ref.watch(babyLogsNotifierProvider);

    // 週間チャートは自前の cross-client realtime を張らない代わりに、
    // **realtime 反映される今日ログ** (`babyLogsNotifierProvider`) の変化に追従して
    // 再取得する。これで配偶者の今日の書き込みもタイムライン経由でチャートへ
    // 反映され、「今日タイムラインには出るが週間バーは古い」整合崩れを防ぐ
    // (週全日の cross-client realtime は follow-up)。own write も含め二重
    // invalidate になるが Riverpod が rebuild を coalesce するため実害なし。
    ref.listen(babyLogsNotifierProvider, (_, _) {
      ref.invalidate(babyWeeklySummaryProvider);
    });

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
    final selectedDate = ref.watch(selectedBabyDateProvider);
    final isToday = selectedDate == formatJstDate();

    // now は 60s ごとに更新。初回 emit 前は端末の現在時刻でフォールバック
    // (購読直後に経過が "---" にならないよう即値を出す)。
    final now = ref.watch(nowTickerProvider).value ?? DateTime.now();

    // lastSleepEndedAt: 原典 `derivedLastSleepEndedAt ?? lastSleepEndedAt`。
    // derived (logs 由来 / realtime reactive) を優先し、無ければ FutureProvider
    // のフォールバック値を使う (cross-day の起床経過用)。
    final fallbackLastSleep = ref.watch(lastSleepEndedAtProvider).value;
    final effectiveLastSleepEndedAt =
        summary.derivedLastSleepEndedAt ?? fallbackLastSleep;

    // 週間サマリー (直近7日)。FutureProvider を `.when` で消費。
    // loading は無描画 (data 到着でカードが現れる)、error は muted な一行で告知
    // (今日のタイムライン読み込みは独立しており、週間チャート失敗で page を壊さない)。
    final weeklyAsync = ref.watch(babyWeeklySummaryProvider);

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
        if (isToday) ...[
          BabyQuickActions(
            activeSleep: summary.activeSleep,
            now: now,
            onCreateLog: (type) {
              showBabyLogFormSheet(context, createLogType: type);
            },
            onStartTimer: (type) {
              showBabyFeedingTimer(context, ref, initialType: type);
            },
          ),
          const SizedBox(height: 16),
        ],
        weeklyAsync.when(
          skipLoadingOnReload: true,
          data: (days) => days.isEmpty
              ? const SizedBox.shrink()
              : Padding(
                  padding: const EdgeInsets.only(bottom: 16),
                  child: BabyWeeklySummary(days: days),
                ),
          loading: () => const SizedBox.shrink(),
          error: (error, _) => const Padding(
            padding: EdgeInsets.only(bottom: 16, left: 4),
            child: Text(
              '週間サマリーを読み込めませんでした',
              style: TextStyle(fontSize: 12, color: Color(0xFF475569)),
            ),
          ),
        ),
        BabyTimeline(
          logs: logs,
          onItemTap: (log) {
            showBabyLogFormSheet(context, log: log);
          },
        ),
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
