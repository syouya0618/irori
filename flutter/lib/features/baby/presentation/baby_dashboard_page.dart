import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/theme/colors.dart';
import '../../../widgets/glass_card.dart';
import '../data/baby_logs_notifier.dart';
import '../domain/baby_log.dart';

/// 育児ログ ダッシュボードの shell (Issue #49)。
///
/// 本 Issue ではデータ層 + AsyncValue 3 分岐 (data/loading/error) の配線のみ。
/// 実 UI (タイムライン / クイックアクション / 週間サマリー) は後続 Issue で
/// 差し替える。ここでは取得済みログ件数のみを placeholder 表示する。
class BabyDashboardPage extends ConsumerWidget {
  const BabyDashboardPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final logsAsync = ref.watch(babyLogsNotifierProvider);

    return Scaffold(
      appBar: AppBar(title: const Text('育児ログ')),
      body: Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: logsAsync.when(
            data: (logs) => _DashboardBody(logs: logs),
            loading: () => const CircularProgressIndicator(),
            error: (error, stackTrace) => _ErrorView(error: error),
          ),
        ),
      ),
    );
  }
}

/// data 分岐の placeholder。取得した今日のログ件数を表示するだけ。
class _DashboardBody extends StatelessWidget {
  const _DashboardBody({required this.logs});

  final List<BabyLog> logs;

  @override
  Widget build(BuildContext context) {
    return GlassCard(
      padding: const EdgeInsets.all(24),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            '育児ログ',
            style: Theme.of(
              context,
            ).textTheme.headlineSmall?.copyWith(color: IroriColors.primary),
          ),
          const SizedBox(height: 12),
          Text(
            logs.isEmpty ? '今日の記録はまだありません。' : '今日の記録: ${logs.length} 件',
            style: Theme.of(context).textTheme.bodyLarge,
          ),
          const SizedBox(height: 8),
          Text(
            'ダッシュボードの UI は後続 Issue で実装予定です。',
            style: Theme.of(context).textTheme.bodySmall,
          ),
        ],
      ),
    );
  }
}

/// error 分岐の placeholder。
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
