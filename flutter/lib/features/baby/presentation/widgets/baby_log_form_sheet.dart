import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/baby_logs_notifier.dart';
import '../../data/baby_repository.dart';
import '../../data/last_sleep_provider.dart';
import '../../domain/baby_log.dart';
import '../baby_display_utils.dart';

Future<void> showBabyLogFormSheet(
  BuildContext context, {
  BabyLog? log,
  BabyLogType? createLogType,
}) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    builder: (_) => BabyLogFormSheet(log: log, createLogType: createLogType),
  );
}

/// 育児ログの作成 / 編集 / 削除を行う bottom sheet。
///
/// Next.js 原典 `baby-log-form-sheet.tsx` の Flutter 移植。時刻編集は原典 UI に
/// 存在しないため今回も実装しない。
class BabyLogFormSheet extends ConsumerStatefulWidget {
  const BabyLogFormSheet({
    this.log,
    this.createLogType,
    super.key,
  }) : assert(log != null || createLogType != null);

  final BabyLog? log;
  final BabyLogType? createLogType;

  @override
  ConsumerState<BabyLogFormSheet> createState() => _BabyLogFormSheetState();
}

class _BabyLogFormSheetState extends ConsumerState<BabyLogFormSheet> {
  final _formKey = GlobalKey<FormState>();
  late FeedingType _feedingType;
  late DiaperType _diaperType;
  late final TextEditingController _amountMlController;
  late final TextEditingController _temperatureController;
  late final TextEditingController _weightGController;
  late final TextEditingController _heightCmController;
  late final TextEditingController _memoController;

  bool _pending = false;
  bool _deleteConfirm = false;

  bool get _isCreateMode => widget.log == null;
  BabyLogType get _logType => widget.log?.logType ?? widget.createLogType!;

  @override
  void initState() {
    super.initState();
    final log = widget.log;
    _feedingType = log?.feedingType ?? FeedingType.bottle;
    _diaperType = log?.diaperType ?? DiaperType.pee;
    _amountMlController = TextEditingController(
      text: log?.amountMl?.toString() ?? '',
    );
    _temperatureController = TextEditingController(
      text: log?.temperature?.toString() ?? '',
    );
    _weightGController = TextEditingController(
      text: log?.weightG?.toString() ?? '',
    );
    _heightCmController = TextEditingController(
      text: log?.heightCm?.toString() ?? '',
    );
    _memoController = TextEditingController(text: log?.memo ?? '');
  }

  @override
  void dispose() {
    _amountMlController.dispose();
    _temperatureController.dispose();
    _weightGController.dispose();
    _heightCmController.dispose();
    _memoController.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final form = _formKey.currentState;
    if (form == null || !form.validate()) return;

    if (_isCreateMode) {
      await _create();
    } else {
      await _update();
    }
  }

  Future<void> _create() async {
    final memo = _memoController.text;
    await _run(
      action: (ctx, repo) async {
        switch (_logType) {
          case BabyLogType.feeding:
            await repo.recordFeeding(
              householdId: ctx.householdId,
              userId: ctx.userId,
              feedingType: _feedingType,
              amountMl: _allowsAmountMl(_feedingType)
                  ? _parseOptionalInt(_amountMlController.text)
                  : null,
              memo: memo,
            );
            break;
          case BabyLogType.diaper:
            await repo.recordDiaper(
              householdId: ctx.householdId,
              userId: ctx.userId,
              diaperType: _diaperType,
              memo: memo,
            );
            break;
          case BabyLogType.sleep:
            await repo.startSleep(
              householdId: ctx.householdId,
              userId: ctx.userId,
            );
            break;
          case BabyLogType.temperature:
            await repo.recordTemperature(
              householdId: ctx.householdId,
              userId: ctx.userId,
              temperature: _parseRequiredDouble(_temperatureController.text),
              memo: memo,
            );
            break;
          case BabyLogType.growth:
            await repo.recordGrowth(
              householdId: ctx.householdId,
              userId: ctx.userId,
              weightG: _parseOptionalInt(_weightGController.text),
              heightCm: _parseOptionalDouble(_heightCmController.text),
              memo: memo,
            );
            break;
          case BabyLogType.memo:
            await repo.recordMemo(
              householdId: ctx.householdId,
              userId: ctx.userId,
              memo: memo,
            );
            break;
        }
      },
      successMessage: '記録しました',
      errorMessage: '記録に失敗しました。',
      refreshLastSleep: _logType == BabyLogType.sleep,
    );
  }

  Future<void> _update() async {
    final log = widget.log;
    if (log == null) return;
    final memo = _memoController.text;

    await _run(
      action: (ctx, repo) async {
        switch (log.logType) {
          case BabyLogType.feeding:
            await repo.updateFeeding(
              householdId: ctx.householdId,
              logId: log.id,
              feedingType: _feedingType,
              amountMl: _allowsAmountMl(_feedingType)
                  ? _parseOptionalInt(_amountMlController.text)
                  : null,
              memo: memo,
            );
            break;
          case BabyLogType.diaper:
            await repo.updateDiaper(
              householdId: ctx.householdId,
              logId: log.id,
              diaperType: _diaperType,
              memo: memo,
            );
            break;
          case BabyLogType.temperature:
            await repo.updateTemperature(
              householdId: ctx.householdId,
              logId: log.id,
              temperature: _parseRequiredDouble(_temperatureController.text),
              memo: memo,
            );
            break;
          case BabyLogType.growth:
            await repo.updateGrowth(
              householdId: ctx.householdId,
              logId: log.id,
              weightG: _parseOptionalInt(_weightGController.text),
              heightCm: _parseOptionalDouble(_heightCmController.text),
              memo: memo,
            );
            break;
          case BabyLogType.sleep:
          case BabyLogType.memo:
            await repo.updateLogMemo(
              householdId: ctx.householdId,
              logId: log.id,
              memo: memo,
            );
            break;
        }
      },
      successMessage: 'ログを更新しました',
      errorMessage: 'ログの更新に失敗しました。',
      refreshLastSleep: log.logType == BabyLogType.sleep,
    );
  }

  Future<void> _delete() async {
    final log = widget.log;
    if (log == null) return;

    await _run(
      action: (ctx, repo) => repo.deleteLog(
        householdId: ctx.householdId,
        logId: log.id,
      ),
      successMessage: 'ログを削除しました',
      errorMessage: 'ログの削除に失敗しました。',
      refreshLastSleep: log.logType == BabyLogType.sleep,
    );
  }

  Future<void> _run({
    required Future<void> Function(
      BabyMutationContext context,
      BabyRepository repo,
    )
    action,
    required String successMessage,
    required String errorMessage,
    bool refreshLastSleep = false,
  }) async {
    if (_pending) return;
    setState(() => _pending = true);

    final messenger = ScaffoldMessenger.of(context);
    final navigator = Navigator.of(context);

    try {
      final mutationContext = await ref.read(
        babyMutationContextProvider.future,
      );
      final repo = ref.read(babyRepositoryProvider);
      await action(mutationContext, repo);
      ref.invalidate(babyLogsNotifierProvider);
      if (refreshLastSleep) {
        ref.invalidate(lastSleepEndedAtProvider);
      }
      if (!mounted) return;
      navigator.pop();
      messenger.showSnackBar(SnackBar(content: Text(successMessage)));
    } on Object catch (e) {
      if (!mounted) return;
      messenger.showSnackBar(
        SnackBar(content: Text(_messageFrom(e, errorMessage))),
      );
    } finally {
      if (mounted) setState(() => _pending = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final logType = _logType;
    final title = _isCreateMode
        ? '${babyLogTypeLabel(logType)}を記録'
        : '${babyLogTypeLabel(logType)}を編集';
    final description = widget.log == null
        ? null
        : '${formatTimeJst(widget.log!.loggedAt)} の記録を変更できます';

    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
      child: ConstrainedBox(
        constraints: BoxConstraints(
          maxHeight: MediaQuery.sizeOf(context).height * 0.85,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(24, 20, 24, 12),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(title, style: Theme.of(context).textTheme.titleLarge),
                  if (description != null) ...[
                    const SizedBox(height: 4),
                    Text(
                      description,
                      style: Theme.of(context).textTheme.bodySmall,
                    ),
                  ],
                ],
              ),
            ),
            Flexible(
              child: SingleChildScrollView(
                padding: const EdgeInsets.fromLTRB(24, 0, 24, 12),
                child: Form(
                  key: _formKey,
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      if (logType == BabyLogType.feeding) ...[
                        const _Label('種類'),
                        _FeedingSegments(
                          value: _feedingType,
                          enabled: !_pending,
                          onChanged: (value) {
                            setState(() => _feedingType = value);
                          },
                        ),
                        if (_allowsAmountMl(_feedingType)) ...[
                          const SizedBox(height: 16),
                          _NumberField(
                            controller: _amountMlController,
                            label: '量 (ml)',
                            placeholder: '例: 80',
                            inputFormatters: [
                              FilteringTextInputFormatter.digitsOnly,
                            ],
                            validator: (value) => _optionalIntRangeError(
                              value,
                              min: 0,
                              max: 999,
                              message: '量は0〜999mlで入力してください',
                            ),
                            enabled: !_pending,
                          ),
                        ],
                      ],
                      if (logType == BabyLogType.diaper) ...[
                        const _Label('種類'),
                        _DiaperSegments(
                          value: _diaperType,
                          enabled: !_pending,
                          onChanged: (value) {
                            setState(() => _diaperType = value);
                          },
                        ),
                      ],
                      if (logType == BabyLogType.temperature)
                        _NumberField(
                          controller: _temperatureController,
                          label: '体温 (℃)',
                          placeholder: '例: 36.5',
                          decimal: true,
                          validator: (value) {
                            final parsed = _parseOptionalDouble(value ?? '');
                            if (parsed == null) return '体温を入力してください';
                            if (parsed < 34.0 || parsed > 42.0) {
                              return '体温は34.0〜42.0の範囲で入力してください';
                            }
                            return null;
                          },
                          enabled: !_pending,
                        ),
                      if (logType == BabyLogType.growth) ...[
                        _NumberField(
                          controller: _weightGController,
                          label: '体重 (g)',
                          placeholder: '例: 4500',
                          inputFormatters: [
                            FilteringTextInputFormatter.digitsOnly,
                          ],
                          validator: (value) => _optionalIntRangeError(
                            value,
                            min: 0,
                            max: 30000,
                            message: '体重は0〜30000gで入力してください',
                          ),
                          enabled: !_pending,
                        ),
                        const SizedBox(height: 16),
                        _NumberField(
                          controller: _heightCmController,
                          label: '身長 (cm)',
                          placeholder: '例: 55.0',
                          decimal: true,
                          validator: (value) => _optionalDoubleRangeError(
                            value,
                            min: 0,
                            max: 150,
                            message: '身長は0〜150cmで入力してください',
                          ),
                          enabled: !_pending,
                        ),
                      ],
                      if (logType != BabyLogType.feeding &&
                          logType != BabyLogType.diaper &&
                          logType != BabyLogType.temperature &&
                          logType != BabyLogType.growth)
                        const SizedBox.shrink(),
                      const SizedBox(height: 16),
                      TextFormField(
                        controller: _memoController,
                        enabled: !_pending,
                        maxLength: maxBabyLogMemoLength,
                        decoration: InputDecoration(
                          labelText: 'メモ',
                          hintText: logType == BabyLogType.memo
                              ? 'メモを入力'
                              : '任意のメモ',
                          border: const OutlineInputBorder(),
                        ),
                        validator: (value) {
                          final memo = value ?? '';
                          if (logType == BabyLogType.memo &&
                              _isCreateMode &&
                              memo.trim().isEmpty) {
                            return 'メモを入力してください';
                          }
                          if (memo.length > maxBabyLogMemoLength) {
                            return 'メモは$maxBabyLogMemoLength文字以内で入力してください';
                          }
                          return null;
                        },
                      ),
                      if (!_isCreateMode && widget.log != null) ...[
                        const SizedBox(height: 8),
                        const Divider(),
                        if (_deleteConfirm)
                          Row(
                            children: [
                              const Expanded(
                                child: Text(
                                  '本当に削除しますか？',
                                  style: TextStyle(color: Colors.red),
                                ),
                              ),
                              TextButton(
                                onPressed: _pending
                                    ? null
                                    : () => setState(
                                        () => _deleteConfirm = false,
                                      ),
                                child: const Text('キャンセル'),
                              ),
                              FilledButton.tonal(
                                onPressed: _pending ? null : _delete,
                                child: const Text('削除する'),
                              ),
                            ],
                          )
                        else
                          TextButton.icon(
                            onPressed: _pending
                                ? null
                                : () => setState(() => _deleteConfirm = true),
                            icon: const Icon(Icons.delete_outline),
                            label: const Text('この記録を削除'),
                            style: TextButton.styleFrom(
                              foregroundColor: Colors.red,
                            ),
                          ),
                      ],
                    ],
                  ),
                ),
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(24, 8, 24, 24),
              child: FilledButton(
                onPressed: _pending ? null : _save,
                style: FilledButton.styleFrom(
                  minimumSize: const Size.fromHeight(44),
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(12),
                  ),
                ),
                child: _pending
                    ? const SizedBox.square(
                        dimension: 20,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : Text(_isCreateMode ? '記録する' : '更新する'),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _Label extends StatelessWidget {
  const _Label(this.text);

  final String text;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Text(text, style: Theme.of(context).textTheme.labelLarge),
    );
  }
}

class _FeedingSegments extends StatelessWidget {
  const _FeedingSegments({
    required this.value,
    required this.enabled,
    required this.onChanged,
  });

  final FeedingType value;
  final bool enabled;
  final ValueChanged<FeedingType> onChanged;

  @override
  Widget build(BuildContext context) {
    return SegmentedButton<FeedingType>(
      selected: {value},
      onSelectionChanged: enabled
          ? (selected) => onChanged(selected.single)
          : null,
      segments: [
        for (final type in FeedingType.values)
          ButtonSegment(value: type, label: Text(feedingTypeLabel(type))),
      ],
    );
  }
}

class _DiaperSegments extends StatelessWidget {
  const _DiaperSegments({
    required this.value,
    required this.enabled,
    required this.onChanged,
  });

  final DiaperType value;
  final bool enabled;
  final ValueChanged<DiaperType> onChanged;

  @override
  Widget build(BuildContext context) {
    return SegmentedButton<DiaperType>(
      selected: {value},
      onSelectionChanged: enabled
          ? (selected) => onChanged(selected.single)
          : null,
      segments: [
        for (final type in DiaperType.values)
          ButtonSegment(value: type, label: Text(diaperTypeLabel(type))),
      ],
    );
  }
}

class _NumberField extends StatelessWidget {
  const _NumberField({
    required this.controller,
    required this.label,
    required this.placeholder,
    required this.validator,
    required this.enabled,
    this.decimal = false,
    this.inputFormatters,
  });

  final TextEditingController controller;
  final String label;
  final String placeholder;
  final FormFieldValidator<String> validator;
  final bool enabled;
  final bool decimal;
  final List<TextInputFormatter>? inputFormatters;

  @override
  Widget build(BuildContext context) {
    return TextFormField(
      controller: controller,
      enabled: enabled,
      keyboardType: TextInputType.numberWithOptions(decimal: decimal),
      inputFormatters: inputFormatters,
      decoration: InputDecoration(
        labelText: label,
        hintText: placeholder,
        border: const OutlineInputBorder(),
      ),
      validator: validator,
    );
  }
}

bool _allowsAmountMl(FeedingType type) {
  return type == FeedingType.bottle || type == FeedingType.solid;
}

int? _parseOptionalInt(String value) {
  final trimmed = value.trim();
  if (trimmed.isEmpty) return null;
  return int.tryParse(trimmed);
}

double? _parseOptionalDouble(String value) {
  final trimmed = value.trim();
  if (trimmed.isEmpty) return null;
  return double.tryParse(trimmed);
}

double _parseRequiredDouble(String value) {
  final parsed = _parseOptionalDouble(value);
  if (parsed == null) {
    throw ArgumentError.value(value, 'value', '数値を入力してください');
  }
  return parsed;
}

String? _optionalIntRangeError(
  String? value, {
  required int min,
  required int max,
  required String message,
}) {
  final text = value?.trim() ?? '';
  if (text.isEmpty) return null;
  final parsed = int.tryParse(text);
  if (parsed == null || parsed < min || parsed > max) return message;
  return null;
}

String? _optionalDoubleRangeError(
  String? value, {
  required double min,
  required double max,
  required String message,
}) {
  final text = value?.trim() ?? '';
  if (text.isEmpty) return null;
  final parsed = double.tryParse(text);
  if (parsed == null || parsed < min || parsed > max) return message;
  return null;
}

String _messageFrom(Object error, String fallback) {
  if (error is ArgumentError) {
    final message = error.message;
    if (message != null) return message.toString();
  }
  return fallback;
}
