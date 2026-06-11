import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../../core/theme/colors.dart';
import '../../../../core/theme/radii.dart';
import '../../../../widgets/glass_card.dart';
import '../../data/settings_provider.dart';
import '../../data/settings_repository.dart';

/// プロフィールカード。Next.js 原典 `profile-card.tsx` の Flutter 移植。
///
/// - アバタープレースホルダー + 表示名/email の現在値 + 表示名フォーム。
/// - 保存ボタンは **入力が空 (trim 後) の間 disabled** — web の
///   `<Input required>` (ブラウザ標準の空 submit ブロック) の Flutter 対応。
/// - 成功: SnackBar「プロフィールを更新しました」+ `settingsProvider`
///   invalidate (web `router.refresh()` 相当)。
/// - 失敗: repository の `ArgumentError` は message
///   (web action と同一文言)、その他は「プロフィールの更新に失敗しました」
///   (web action のエラー文言)。
///
/// 入力欄は uncontrolled 風 (web `defaultValue` 同様、refetch で props が
/// 変わっても入力中のテキストは保持する)。
class ProfileCard extends ConsumerStatefulWidget {
  const ProfileCard({
    required this.displayName,
    required this.email,
    super.key,
  });

  final String displayName;
  final String email;

  @override
  ConsumerState<ProfileCard> createState() => _ProfileCardState();
}

class _ProfileCardState extends ConsumerState<ProfileCard> {
  late final TextEditingController _controller;
  bool _pending = false;

  @override
  void initState() {
    super.initState();
    _controller = TextEditingController(text: widget.displayName);
    // 空入力で保存ボタンを disabled にするため、変更のたび再評価する。
    _controller.addListener(_onTextChanged);
  }

  void _onTextChanged() {
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  bool get _canSave => !_pending && _controller.text.trim().isNotEmpty;

  Future<void> _save() async {
    if (!_canSave) return;

    final messenger = ScaffoldMessenger.of(context);
    setState(() => _pending = true);

    try {
      final ctx = await ref.read(settingsMutationContextProvider.future);
      // trim は repository の責務 (空 reject も同層 — web action と同じ位置)。
      await ref
          .read(settingsRepositoryProvider)
          .updateDisplayName(userId: ctx.userId, displayName: _controller.text);

      if (!mounted) return;
      messenger.showSnackBar(
        const SnackBar(content: Text('プロフィールを更新しました')),
      );
      // web `router.refresh()` 相当: バンドルを再取得して表示を確定する。
      ref.invalidate(settingsProvider);
    } on ArgumentError catch (e) {
      // repository の入力検証 (文言は web と同一)。握り潰さない (CLAUDE.md)。
      debugPrint(
        'ProfileCard 入力検証エラー: ${e.name}=${e.invalidValue}: ${e.message}',
      );
      final message = e.message;
      if (!mounted) return;
      messenger.showSnackBar(
        SnackBar(
          content: Text(
            message is String && message.isNotEmpty
                ? message
                : 'プロフィールの更新に失敗しました',
          ),
        ),
      );
    } on Object catch (e, st) {
      // 握り潰さない (CLAUDE.md)。repository 側でも構造化ログ済み。
      debugPrint('ProfileCard updateDisplayName 失敗: $e\n$st');
      if (!mounted) return;
      messenger.showSnackBar(
        const SnackBar(content: Text('プロフィールの更新に失敗しました')),
      );
    } finally {
      if (mounted) setState(() => _pending = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return GlassCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Row(
            children: [
              Icon(LucideIcons.user, size: 18, color: IroriColors.textPrimary),
              SizedBox(width: 8),
              Text(
                'プロフィール',
                style: TextStyle(
                  fontSize: 16,
                  fontWeight: FontWeight.w600,
                  color: IroriColors.textPrimary,
                ),
              ),
            ],
          ),
          const SizedBox(height: 16),
          // アバタープレースホルダー (原典 size-14 circle + User icon)。
          Row(
            children: [
              Container(
                width: 56,
                height: 56,
                decoration: BoxDecoration(
                  color: IroriColors.primary.withValues(alpha: 0.1),
                  shape: BoxShape.circle,
                ),
                child: const Icon(
                  LucideIcons.user,
                  size: 28,
                  color: IroriColors.primary,
                ),
              ),
              const SizedBox(width: 16),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      // 原典: `profile.displayName || "未設定"`。
                      widget.displayName.isEmpty ? '未設定' : widget.displayName,
                      style: const TextStyle(
                        fontSize: 14,
                        fontWeight: FontWeight.w500,
                        color: IroriColors.textPrimary,
                      ),
                      overflow: TextOverflow.ellipsis,
                    ),
                    const SizedBox(height: 2),
                    Text(
                      widget.email,
                      style: const TextStyle(
                        fontSize: 12,
                        color: IroriColors.textMuted,
                      ),
                      overflow: TextOverflow.ellipsis,
                    ),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: 16),
          const Divider(height: 1, color: IroriColors.border),
          const SizedBox(height: 16),
          const Text(
            '表示名',
            style: TextStyle(
              fontSize: 14,
              fontWeight: FontWeight.w500,
              color: IroriColors.textPrimary,
            ),
          ),
          const SizedBox(height: 8),
          TextField(
            controller: _controller,
            enabled: !_pending,
            decoration: InputDecoration(
              hintText: '表示名を入力',
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
          Align(
            alignment: Alignment.centerRight,
            child: FilledButton(
              onPressed: _canSave ? _save : null,
              style: FilledButton.styleFrom(
                // 44px タッチターゲット (CLAUDE.md)。
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
