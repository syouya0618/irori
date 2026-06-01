import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import '../../../../core/theme/radii.dart';
import '../../data/baby_logs_notifier.dart';
import '../../data/baby_repository.dart';
import '../../data/baby_weekly_summary_provider.dart';
import '../../data/last_sleep_provider.dart';
import '../../domain/baby_log.dart';
import '../baby_display_utils.dart';

const _feedingOptions = [
  (value: FeedingType.breastLeft, label: '左'),
  (value: FeedingType.breastRight, label: '右'),
  (value: FeedingType.bottle, label: 'ミルク'),
  (value: FeedingType.solid, label: '離乳食'),
];

const _diaperOptions = [
  (value: DiaperType.pee, label: 'おしっこ'),
  (value: DiaperType.poop, label: 'うんち'),
  (value: DiaperType.both, label: '両方'),
];

/// 今日の育児ログを素早く記録する操作群。
///
/// Next.js 原典 `baby-quick-actions.tsx` の Flutter 移植。授乳タイマーは後続
/// scope のため、[onStartTimer] が未指定なら左右授乳も即時記録する。
class BabyQuickActions extends ConsumerStatefulWidget {
  const BabyQuickActions({
    required this.activeSleep,
    required this.now,
    required this.onCreateLog,
    this.onStartTimer,
    super.key,
  });

  final BabyLog? activeSleep;
  final DateTime now;
  final void Function(BabyLogType type) onCreateLog;
  final void Function(FeedingType type)? onStartTimer;

  @override
  ConsumerState<BabyQuickActions> createState() => _BabyQuickActionsState();
}

class _BabyQuickActionsState extends ConsumerState<BabyQuickActions> {
  bool _pending = false;

  Future<void> _run({
    required Future<void> Function(BabyMutationContext context) action,
    required String successMessage,
    required String errorMessage,
    bool refreshLastSleep = false,
    String Function(Object error)? mapError,
  }) async {
    if (_pending) return;
    setState(() => _pending = true);

    try {
      final mutationContext = await ref.read(
        babyMutationContextProvider.future,
      );
      await action(mutationContext);
      ref.invalidate(babyLogsNotifierProvider);
      // 週間チャートも自分の write を反映 (取りこぼし防止: babyLogsNotifierProvider
      // の invalidate と必ず同じ場所に並べる — baby_weekly_summary_provider 参照)。
      ref.invalidate(babyWeeklySummaryProvider);
      if (refreshLastSleep) {
        ref.invalidate(lastSleepEndedAtProvider);
      }
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(successMessage)),
      );
    } on Object catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(mapError?.call(e) ?? _messageFrom(e, errorMessage)),
        ),
      );
    } finally {
      if (mounted) setState(() => _pending = false);
    }
  }

  Future<void> _recordFeeding(FeedingType type) {
    return _run(
      action: (ctx) => ref
          .read(babyRepositoryProvider)
          .recordFeeding(
            householdId: ctx.householdId,
            userId: ctx.userId,
            feedingType: type,
          ),
      successMessage: '授乳を記録しました',
      errorMessage: '授乳の記録に失敗しました。',
    );
  }

  Future<void> _recordDiaper(DiaperType type) {
    return _run(
      action: (ctx) => ref
          .read(babyRepositoryProvider)
          .recordDiaper(
            householdId: ctx.householdId,
            userId: ctx.userId,
            diaperType: type,
          ),
      successMessage: 'おむつ交換を記録しました',
      errorMessage: 'おむつの記録に失敗しました。',
    );
  }

  Future<void> _toggleSleep() {
    final activeSleep = widget.activeSleep;
    if (activeSleep == null) {
      return _run(
        action: (ctx) => ref
            .read(babyRepositoryProvider)
            .startSleep(
              householdId: ctx.householdId,
              userId: ctx.userId,
            ),
        successMessage: 'おやすみなさい',
        errorMessage: '睡眠の記録に失敗しました。',
        refreshLastSleep: true,
        mapError: (e) {
          if (e is PostgrestException && e.code == '23505') {
            return '既に睡眠中のセッションがあります。';
          }
          return _messageFrom(e, '睡眠の記録に失敗しました。');
        },
      );
    }

    return _run(
      action: (ctx) => ref
          .read(babyRepositoryProvider)
          .endSleep(
            householdId: ctx.householdId,
            logId: activeSleep.id,
          ),
      successMessage:
          'おはよう！（${formatElapsedMinutes(minutesBetween(activeSleep.loggedAt, DateTime.now()))}）',
      errorMessage: 'アクティブな睡眠セッションが見つかりません。',
      refreshLastSleep: true,
    );
  }

  @override
  Widget build(BuildContext context) {
    final activeSleep = widget.activeSleep;
    final sleepElapsed = activeSleep == null
        ? null
        : minutesBetween(activeSleep.loggedAt, widget.now);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const _GroupLabel('授乳'),
        const SizedBox(height: 6),
        Row(
          children: [
            for (var i = 0; i < _feedingOptions.length; i++) ...[
              if (i > 0) const SizedBox(width: 6),
              Expanded(
                child: _ActionButton(
                  label: _feedingOptions[i].label,
                  background: _amberBg,
                  foreground: _amberFg,
                  disabled: _pending,
                  onPressed: () {
                    final type = _feedingOptions[i].value;
                    final startTimer = widget.onStartTimer;
                    if ((type == FeedingType.breastLeft ||
                            type == FeedingType.breastRight) &&
                        startTimer != null) {
                      startTimer(type);
                    } else {
                      _recordFeeding(type);
                    }
                  },
                ),
              ),
            ],
          ],
        ),
        const SizedBox(height: 12),
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const _GroupLabel('おむつ'),
                  const SizedBox(height: 6),
                  Row(
                    children: [
                      for (var i = 0; i < _diaperOptions.length; i++) ...[
                        if (i > 0) const SizedBox(width: 6),
                        Expanded(
                          child: _ActionButton(
                            label: _diaperOptions[i].label,
                            background: _skyBg,
                            foreground: _skyFg,
                            disabled: _pending,
                            onPressed: () => _recordDiaper(
                              _diaperOptions[i].value,
                            ),
                          ),
                        ),
                      ],
                    ],
                  ),
                ],
              ),
            ),
            const SizedBox(width: 12),
            SizedBox(
              width: 112,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const _GroupLabel('睡眠'),
                  const SizedBox(height: 6),
                  _ActionButton(
                    label: activeSleep == null
                        ? 'ねんね'
                        : sleepElapsed == null
                        ? '起こす'
                        : formatElapsedMinutes(sleepElapsed),
                    icon: activeSleep == null
                        ? LucideIcons.moon
                        : LucideIcons.sun,
                    background: activeSleep == null ? _emeraldBg : _violetBg,
                    foreground: activeSleep == null ? _emeraldFg : _violetFg,
                    disabled: _pending,
                    onPressed: _toggleSleep,
                  ),
                ],
              ),
            ),
          ],
        ),
        const SizedBox(height: 12),
        Row(
          children: [
            Expanded(
              child: _ActionButton(
                label: '体温',
                icon: LucideIcons.thermometer,
                background: _roseBg,
                foreground: _roseFg,
                disabled: _pending,
                onPressed: () => widget.onCreateLog(BabyLogType.temperature),
              ),
            ),
            const SizedBox(width: 6),
            Expanded(
              child: _ActionButton(
                label: '成長',
                icon: LucideIcons.ruler,
                background: _tealBg,
                foreground: _tealFg,
                disabled: _pending,
                onPressed: () => widget.onCreateLog(BabyLogType.growth),
              ),
            ),
            const SizedBox(width: 6),
            Expanded(
              child: _ActionButton(
                label: 'メモ',
                icon: LucideIcons.stickyNote,
                background: _grayBg,
                foreground: _grayFg,
                disabled: _pending,
                onPressed: () => widget.onCreateLog(BabyLogType.memo),
              ),
            ),
          ],
        ),
      ],
    );
  }
}

class _GroupLabel extends StatelessWidget {
  const _GroupLabel(this.label);

  final String label;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 4),
      child: Text(
        label,
        style: const TextStyle(
          fontSize: 12,
          fontWeight: FontWeight.w600,
          color: Color(0xFF475569),
        ),
      ),
    );
  }
}

class _ActionButton extends StatelessWidget {
  const _ActionButton({
    required this.label,
    required this.background,
    required this.foreground,
    required this.onPressed,
    this.icon,
    this.disabled = false,
  });

  final String label;
  final IconData? icon;
  final Color background;
  final Color foreground;
  final VoidCallback onPressed;
  final bool disabled;

  @override
  Widget build(BuildContext context) {
    return TextButton(
      onPressed: disabled ? null : onPressed,
      style: TextButton.styleFrom(
        minimumSize: const Size.fromHeight(44),
        padding: const EdgeInsets.symmetric(horizontal: 8),
        foregroundColor: foreground,
        backgroundColor: background,
        disabledForegroundColor: foreground.withValues(alpha: 0.4),
        disabledBackgroundColor: background.withValues(alpha: 0.55),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(IroriRadii.button),
        ),
      ),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.center,
        mainAxisSize: MainAxisSize.min,
        children: [
          if (icon != null) ...[
            Icon(icon, size: 16),
            const SizedBox(width: 4),
          ],
          Flexible(
            child: Text(
              label,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600),
            ),
          ),
        ],
      ),
    );
  }
}

String _messageFrom(Object error, String fallback) {
  if (error is ArgumentError) {
    final message = error.message;
    if (message != null) return message.toString();
  }
  return fallback;
}

const _amberBg = Color(0xFFFEF3C7);
const _amberFg = Color(0xFFB45309);
const _skyBg = Color(0xFFE0F2FE);
const _skyFg = Color(0xFF0369A1);
const _violetBg = Color(0xFFEDE9FE);
const _violetFg = Color(0xFF6D28D9);
const _emeraldBg = Color(0xFFD1FAE5);
const _emeraldFg = Color(0xFF047857);
const _roseBg = Color(0xFFFFE4E6);
const _roseFg = Color(0xFFBE123C);
const _tealBg = Color(0xFFCCFBF1);
const _tealFg = Color(0xFF0F766E);
const _grayBg = Color(0xFFF3F4F6);
const _grayFg = Color(0xFF4B5563);
