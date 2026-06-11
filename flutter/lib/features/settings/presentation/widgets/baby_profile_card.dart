import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../../core/theme/colors.dart';
import '../../../../core/theme/radii.dart';
import '../../../../core/utils/jst_date.dart';
import '../../../../widgets/glass_card.dart';
import '../../data/settings_provider.dart';
import '../../data/settings_repository.dart';

/// 赤ちゃん情報カード。Next.js 原典 `baby-profile-card.tsx` の Flutter 移植。
///
/// - 名前 (任意) + 生年月日 (任意 / DatePicker — web `<input type="date">`)。
/// - DatePicker の選択範囲は stock_form_sheet と同じ 2000〜2100。web の
///   date input も未来日を許し、DB CHECK (`chk_baby_birth_date`:
///   birth <= CURRENT_DATE) が reject する — そのエラーは web action と同じく
///   「赤ちゃん情報の更新に失敗しました」へ丸めて表示する (web parity)。
/// - 成功: SnackBar「赤ちゃん情報を更新しました」+ `settingsProvider`
///   invalidate (web `router.refresh()` 相当)。
/// - 名前入力欄は uncontrolled 風 (web `defaultValue` 同様、refetch で props
///   が変わっても入力中のテキストは保持する)。生年月日はテキスト入力ではない
///   ため stickiness の対象外 — タブ再表示 refetch の新 props を
///   [didUpdateWidget] で再同期する (保存中 `_pending` を除く。IndexedStack
///   で State が dispose されないため initState だけでは相方の変更が届かない)。
class BabyProfileCard extends ConsumerStatefulWidget {
  const BabyProfileCard({
    required this.initialName,
    required this.initialBirthDate,
    super.key,
  });

  final String? initialName;

  /// "YYYY-MM-DD" (null = 未設定)。
  final String? initialBirthDate;

  @override
  ConsumerState<BabyProfileCard> createState() => _BabyProfileCardState();
}

class _BabyProfileCardState extends ConsumerState<BabyProfileCard> {
  late final TextEditingController _nameController;

  /// 生年月日 "YYYY-MM-DD" (null = 未設定)。
  String? _birthDate;

  bool _pending = false;

  @override
  void initState() {
    super.initState();
    _nameController = TextEditingController(text: widget.initialName ?? '');
    _birthDate = widget.initialBirthDate;
  }

  @override
  void didUpdateWidget(BabyProfileCard oldWidget) {
    super.didUpdateWidget(oldWidget);
    // 生年月日のみ新 props で再同期する (クラス doc 参照 — 名前は web
    // defaultValue parity の stickiness を保つため触らない)。
    if (!_pending && widget.initialBirthDate != oldWidget.initialBirthDate) {
      _birthDate = widget.initialBirthDate;
    }
  }

  @override
  void dispose() {
    _nameController.dispose();
    super.dispose();
  }

  /// stock_form_sheet `_pickExpiresAt` と同じ TZ 非依存の DatePicker 運用。
  Future<void> _pickBirthDate() async {
    // 初期値: 設定済みならその日、未設定なら JST の今日 (UTC 罠回避のため
    // formatJstDate の YMD を数値分解して構成する)。
    final p = (_birthDate ?? formatJstDate()).split('-');
    var initial = DateTime(int.parse(p[0]), int.parse(p[1]), int.parse(p[2]));
    final first = DateTime(2000);
    final last = DateTime(2100, 12, 31);
    // 範囲外の既存値でも showDatePicker の assert に倒さない防御。
    if (initial.isBefore(first)) initial = first;
    if (initial.isAfter(last)) initial = last;

    final picked = await showDatePicker(
      context: context,
      initialDate: initial,
      firstDate: first,
      lastDate: last,
    );
    if (picked == null || !mounted) return;
    // y/m/d の数値だけを使い "YYYY-MM-DD" に再構成する (TZ 非依存)。
    final ymd =
        '${picked.year.toString().padLeft(4, '0')}-'
        '${picked.month.toString().padLeft(2, '0')}-'
        '${picked.day.toString().padLeft(2, '0')}';
    setState(() => _birthDate = ymd);
  }

  Future<void> _save() async {
    if (_pending) return;

    final messenger = ScaffoldMessenger.of(context);
    setState(() => _pending = true);

    try {
      final ctx = await ref.read(settingsMutationContextProvider.future);
      // 名前の trim / 空→null は repository の責務 (web action と同じ位置)。
      await ref
          .read(settingsRepositoryProvider)
          .updateBabyProfile(
            householdId: ctx.householdId,
            babyName: _nameController.text,
            babyBirthDate: _birthDate,
          );

      if (!mounted) return;
      messenger.showSnackBar(
        const SnackBar(content: Text('赤ちゃん情報を更新しました')),
      );
      // web `router.refresh()` 相当 (baby ダッシュボードの月齢表示等が読む)。
      ref.invalidate(settingsProvider);
    } on ArgumentError catch (e) {
      // repository の入力検証 (文言は web と同一)。握り潰さない (CLAUDE.md)。
      debugPrint(
        'BabyProfileCard 入力検証エラー: ${e.name}=${e.invalidValue}: ${e.message}',
      );
      final message = e.message;
      if (!mounted) return;
      messenger.showSnackBar(
        SnackBar(
          content: Text(
            message is String && message.isNotEmpty
                ? message
                : '赤ちゃん情報の更新に失敗しました',
          ),
        ),
      );
    } on Object catch (e, st) {
      // DB CHECK (未来日) 等の PostgrestException もここで web と同じ文言へ
      // 丸める。握り潰さない (CLAUDE.md) — repository 側で構造化ログ済み。
      debugPrint('BabyProfileCard updateBabyProfile 失敗: $e\n$st');
      if (!mounted) return;
      messenger.showSnackBar(
        const SnackBar(content: Text('赤ちゃん情報の更新に失敗しました')),
      );
    } finally {
      if (mounted) setState(() => _pending = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final birthDate = _birthDate;
    return GlassCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Row(
            children: [
              Icon(LucideIcons.baby, size: 18, color: IroriColors.textPrimary),
              SizedBox(width: 8),
              Text(
                '赤ちゃん情報',
                style: TextStyle(
                  fontSize: 16,
                  fontWeight: FontWeight.w600,
                  color: IroriColors.textPrimary,
                ),
              ),
            ],
          ),
          const SizedBox(height: 16),
          const Text(
            '名前',
            style: TextStyle(
              fontSize: 14,
              fontWeight: FontWeight.w500,
              color: IroriColors.textPrimary,
            ),
          ),
          const SizedBox(height: 8),
          TextField(
            controller: _nameController,
            enabled: !_pending,
            decoration: InputDecoration(
              hintText: '赤ちゃんの名前',
              isDense: true,
              contentPadding: const EdgeInsets.symmetric(
                horizontal: 12,
                vertical: 12,
              ),
              border: OutlineInputBorder(
                borderRadius: BorderRadius.circular(IroriRadii.button),
              ),
            ),
          ),
          const SizedBox(height: 16),
          const Text(
            '生年月日',
            style: TextStyle(
              fontSize: 14,
              fontWeight: FontWeight.w500,
              color: IroriColors.textPrimary,
            ),
          ),
          const SizedBox(height: 8),
          Row(
            children: [
              Expanded(
                child: OutlinedButton.icon(
                  onPressed: _pending ? null : _pickBirthDate,
                  icon: const Icon(LucideIcons.calendar, size: 16),
                  label: Align(
                    alignment: Alignment.centerLeft,
                    child: Text(birthDate ?? '未設定'),
                  ),
                  style: OutlinedButton.styleFrom(
                    minimumSize: const Size(44, 44),
                    foregroundColor: birthDate == null
                        ? IroriColors.textMuted
                        : IroriColors.textPrimary,
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(IroriRadii.button),
                    ),
                  ),
                ),
              ),
              if (birthDate != null)
                IconButton(
                  icon: const Icon(LucideIcons.x, size: 16),
                  tooltip: '生年月日をクリア',
                  onPressed: _pending
                      ? null
                      : () => setState(() => _birthDate = null),
                  color: IroriColors.textMuted,
                  // 44x44 の最小タッチ領域 (CLAUDE.md)。
                  constraints: const BoxConstraints(
                    minWidth: 44,
                    minHeight: 44,
                  ),
                ),
            ],
          ),
          const SizedBox(height: 16),
          Align(
            alignment: Alignment.centerRight,
            child: FilledButton(
              onPressed: _pending ? null : _save,
              style: FilledButton.styleFrom(
                minimumSize: const Size(44, 44),
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(IroriRadii.button),
                ),
              ),
              child: _pending
                  ? const SizedBox(
                      width: 16,
                      height: 16,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Text('保存'),
            ),
          ),
        ],
      ),
    );
  }
}
