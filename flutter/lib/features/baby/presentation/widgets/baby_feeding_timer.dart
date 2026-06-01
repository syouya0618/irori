import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/theme/colors.dart';
import '../../../../core/theme/radii.dart';
import '../../data/baby_logs_notifier.dart';
import '../../data/baby_repository.dart';
import '../../data/baby_weekly_summary_provider.dart';
import '../../data/feeding_timer_store.dart';
import '../../domain/baby_log.dart';

/// 授乳タイマーを modal bottom sheet で開く。原典 `feeding-timer.tsx` の
/// `<Sheet open={timerOpen}>` 相当。
///
/// 停止 (記録) / キャンセルボタンは sheet 自身が保存をクリアして閉じる。
/// スワイプで閉じた場合 (result == null) は原典 `handleOpenChange` 同様に
/// **cancel 扱い**で保存を破棄する。
Future<void> showBabyFeedingTimer(
  BuildContext context,
  WidgetRef ref, {
  required FeedingType initialType,
}) async {
  final result = await showModalBottomSheet<_FeedingTimerResult>(
    context: context,
    isScrollControlled: true,
    showDragHandle: true,
    builder: (_) => BabyFeedingTimerSheet(initialType: initialType),
  );

  // スワイプ dismiss (明示操作でない閉じ方) は原典同様 cancel 扱い → 保存破棄。
  if (result == null) {
    await ref.read(feedingTimerStoreProvider).clear();
  }
}

enum _FeedingTimerResult { recorded, cancelled }

/// 授乳タイマー本体。原典 `FeedingTimer`。
///
/// 設計:
/// - 経過は **clock からの差分** (`now - startedAt`) で算出 (tick の累積ではない)。
///   ブラウザのタブ throttle に強く、原典 `(now - startedAt)/1000` と一致する。
/// - [clock] は現在時刻のソース。テストで固定時刻を注入する seam
///   (codebase 慣習: `formatBabyDateLabel(todayYmd:)` / `reduceForTest` と同流儀)。
/// - 開いた時点で [feedingTimerStoreProvider] に非 stale (< 2h) の保存があれば
///   復元、無ければ新規開始して保存する (端末リロード跨ぎの中断復元)。
/// - 1s ごとに `setState` で再描画 (`Timer.periodic`、`dispose` で cancel)。
/// - 停止で `BabyRepository.recordFeeding(durationMin:)` を呼び、保存をクリアして
///   閉じる。`babyLogsNotifierProvider` / `babyWeeklySummaryProvider` を invalidate。
class BabyFeedingTimerSheet extends ConsumerStatefulWidget {
  const BabyFeedingTimerSheet({
    required this.initialType,
    this.clock,
    this.onClose,
    super.key,
  });

  final FeedingType initialType;

  /// 現在時刻のソース (テスト seam)。省略時は `DateTime.now`。
  @visibleForTesting
  final DateTime Function()? clock;

  /// 閉じたことを通知するフック (テスト seam)。省略時は `Navigator.pop(result)`。
  /// 指定時は pop せず本コールバックのみ呼ぶ (直接 pump するテスト用)。
  @visibleForTesting
  final VoidCallback? onClose;

  @override
  ConsumerState<BabyFeedingTimerSheet> createState() =>
      _BabyFeedingTimerSheetState();
}

class _BabyFeedingTimerSheetState extends ConsumerState<BabyFeedingTimerSheet> {
  /// 原典 `MAX_TIMER_AGE_MS = 2 * 60 * 60 * 1000` (2時間で stale 扱い)。
  static const _maxTimerAge = Duration(hours: 2);

  late FeedingType _type;
  DateTime? _startedAt;
  Timer? _ticker;
  bool _saving = false;

  DateTime _now() => (widget.clock ?? DateTime.now)();

  @override
  void initState() {
    super.initState();
    _type = widget.initialType;
    _restoreOrStart();
  }

  @override
  void dispose() {
    _ticker?.cancel();
    super.dispose();
  }

  /// 保存があれば復元、無ければ新規開始。原典の open effect 相当。
  Future<void> _restoreOrStart() async {
    final store = ref.read(feedingTimerStoreProvider);
    final now = _now();

    FeedingTimerState? saved;
    try {
      saved = await store.load();
    } on Object catch (e) {
      // load 失敗は握り潰さずログ。新規開始にフォールバック。
      debugPrint('FeedingTimer restore 失敗: $e');
      saved = null;
    }
    if (!mounted) return;

    // 原典: `Date.now() - saved.startedAt < MAX_TIMER_AGE_MS` なら復元。
    // 条件をインライン化して `saved` の null 昇格を効かせる。
    if (saved != null && now.difference(saved.startedAt) < _maxTimerAge) {
      _startedAt = saved.startedAt;
      _type = saved.feedingType;
    } else {
      if (saved != null) {
        await store.clear(); // stale を破棄。
      }
      _startedAt = now;
      await store.save((startedAt: now, feedingType: _type));
    }
    if (!mounted) return;

    setState(() {});
    _startTicker();
  }

  void _startTicker() {
    _ticker?.cancel();
    _ticker = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted) setState(() {});
    });
  }

  /// 経過時間。clock からの差分。負値は 0 にクランプ (原典 `Math.max(0, ...)`)。
  Duration get _elapsed {
    final started = _startedAt;
    if (started == null) return Duration.zero;
    final diff = _now().difference(started);
    return diff.isNegative ? Duration.zero : diff;
  }

  Future<void> _changeType(FeedingType type) async {
    setState(() => _type = type);
    final started = _startedAt;
    if (started != null) {
      // 型変更を保存に反映 (復元時に正しい左右を出す)。
      await ref.read(feedingTimerStoreProvider).save((
        startedAt: started,
        feedingType: type,
      ));
    }
  }

  Future<void> _handleStop() async {
    if (_saving || _startedAt == null) return;
    setState(() => _saving = true);

    // 原典 `duration = Math.max(1, elapsedMinutes)` (下限 1)。さらに上限 180 に
    // クランプする: DB CHECK 制約 (`duration_min BETWEEN 0 AND 180`) と
    // repository の `_validateDurationMin` が 180 超を reject するため。原典も
    // 181 分以上は DB CHECK 違反で記録失敗する (actions.ts → toast.error) ので、
    // クランプは「失敗させず 180 で記録する」救済であり、データ汚染にはならぬ。
    final elapsedMin = (_elapsed.inSeconds / 60).round();
    final duration = elapsedMin.clamp(1, 180);

    try {
      final ctx = await ref.read(babyMutationContextProvider.future);
      await ref
          .read(babyRepositoryProvider)
          .recordFeeding(
            householdId: ctx.householdId,
            userId: ctx.userId,
            feedingType: _type,
            durationMin: duration,
          );
      await ref.read(feedingTimerStoreProvider).clear();
      // 自分の write を today timeline と週間チャートへ反映。
      ref.invalidate(babyLogsNotifierProvider);
      ref.invalidate(babyWeeklySummaryProvider);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('授乳を記録しました（$duration分）')),
      );
      _close(_FeedingTimerResult.recorded);
    } on Object catch (e) {
      if (!mounted) return;
      setState(() => _saving = false);
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(_messageFrom(e, '授乳の記録に失敗しました。'))),
      );
    }
  }

  Future<void> _handleCancel() async {
    if (_saving) return;
    await ref.read(feedingTimerStoreProvider).clear();
    if (!mounted) return;
    _close(_FeedingTimerResult.cancelled);
  }

  void _close(_FeedingTimerResult result) {
    final onClose = widget.onClose;
    if (onClose != null) {
      onClose();
      return;
    }
    Navigator.of(context).pop(result);
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.only(
        bottom: MediaQuery.of(context).viewInsets.bottom,
      ),
      child: SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 4, 20, 24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Text(
                '授乳タイマー',
                style: TextStyle(
                  fontSize: 18,
                  fontWeight: FontWeight.w600,
                  color: IroriColors.textPrimary,
                ),
              ),
              const SizedBox(height: 4),
              const Text(
                '停止すると授乳時間が記録されます',
                style: TextStyle(fontSize: 13, color: IroriColors.textMuted),
              ),
              const SizedBox(height: 24),
              // 左右切替。
              Row(
                children: [
                  Expanded(
                    child: _SegmentButton(
                      label: '左',
                      selected: _type == FeedingType.breastLeft,
                      onTap: _saving
                          ? null
                          : () => _changeType(FeedingType.breastLeft),
                    ),
                  ),
                  const SizedBox(width: 6),
                  Expanded(
                    child: _SegmentButton(
                      label: '右',
                      selected: _type == FeedingType.breastRight,
                      onTap: _saving
                          ? null
                          : () => _changeType(FeedingType.breastRight),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 24),
              // 経過時間 (MM:SS)。
              Text(
                _formatTimer(_elapsed),
                style: const TextStyle(
                  fontSize: 48,
                  fontWeight: FontWeight.bold,
                  color: IroriColors.textPrimary,
                  fontFeatures: [FontFeature.tabularFigures()],
                ),
              ),
              const SizedBox(height: 24),
              // 停止して記録。
              SizedBox(
                width: double.infinity,
                child: FilledButton(
                  onPressed: _saving ? null : _handleStop,
                  style: FilledButton.styleFrom(
                    minimumSize: const Size.fromHeight(56),
                    backgroundColor: IroriColors.primary,
                    foregroundColor: Colors.white,
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(IroriRadii.card),
                    ),
                  ),
                  child: _saving
                      ? const Row(
                          mainAxisAlignment: MainAxisAlignment.center,
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            SizedBox(
                              width: 18,
                              height: 18,
                              child: CircularProgressIndicator(
                                strokeWidth: 2,
                                color: Colors.white,
                              ),
                            ),
                            SizedBox(width: 8),
                            Text(
                              '記録中...',
                              style: TextStyle(
                                fontSize: 16,
                                fontWeight: FontWeight.w600,
                              ),
                            ),
                          ],
                        )
                      : const Text(
                          '停止して記録',
                          style: TextStyle(
                            fontSize: 16,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                ),
              ),
              const SizedBox(height: 8),
              TextButton(
                onPressed: _saving ? null : _handleCancel,
                child: const Text(
                  'キャンセル（記録しない）',
                  style: TextStyle(fontSize: 13, color: IroriColors.textMuted),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// 左右切替セグメント。選択時は primary、非選択は薄グレー。
class _SegmentButton extends StatelessWidget {
  const _SegmentButton({
    required this.label,
    required this.selected,
    required this.onTap,
  });

  final String label;
  final bool selected;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: selected ? IroriColors.primary : const Color(0xFFF3F4F6),
      borderRadius: BorderRadius.circular(IroriRadii.button),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(IroriRadii.button),
        child: Container(
          height: 44,
          alignment: Alignment.center,
          child: Text(
            label,
            style: TextStyle(
              fontSize: 15,
              fontWeight: FontWeight.w600,
              color: selected ? Colors.white : const Color(0xFF4B5563),
            ),
          ),
        ),
      ),
    );
  }
}

/// 秒を "MM:SS" に整形する。原典 `formatTimer`。
String _formatTimer(Duration elapsed) {
  final totalSeconds = elapsed.inSeconds;
  final m = (totalSeconds ~/ 60).toString().padLeft(2, '0');
  final s = (totalSeconds % 60).toString().padLeft(2, '0');
  return '$m:$s';
}

/// `BabyQuickActions._messageFrom` と同流儀。ArgumentError のメッセージを拾う。
String _messageFrom(Object error, String fallback) {
  if (error is ArgumentError) {
    final message = error.message;
    if (message != null) return message.toString();
  }
  return fallback;
}
