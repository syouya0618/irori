import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../../core/theme/colors.dart';
import '../../../../core/theme/radii.dart';
import '../../../../core/utils/app_origin.dart';
import '../../../../widgets/glass_card.dart';
import '../../data/settings_repository.dart';

/// メンバー招待カード (issue #76)。Next.js 原典
/// `src/components/settings/invite-card.tsx` +
/// `settings/actions.ts:31-54` (`generateInvite`) の Flutter 移植。
///
/// 表示条件 (意図的差異): web は全 role に表示するが、Flutter は issue #76 の
/// 裁定で **owner のみ** [SettingsPage] 側が mount する (approval_card と同じ
/// ゲート流儀)。RLS `invitations_insert` は世帯一致のみ検証するため member でも
/// insert 自体は可能だが、UI 導線は owner に限定する。
///
/// リンク形式: `$origin/invite/<token>`。受け側 (`invite_page.dart` /
/// web `/invite/[token]`) は `get_invitation_by_token(invite_token)` に token
/// 生値を渡して照合するため、両者と同一形式。origin は web `getAppOrigin()`
/// 対応の [originProvider] (Flutter web 自身の配信 origin) を使う。
///
/// クリップボード: web `navigator.clipboard.writeText` → `Clipboard.setData`。
/// モバイル共有シート (share_plus) は新規依存追加が禁止のため移植しない
/// (意図的差異 — URL 入力欄の長押し選択 + コピーで代替できる)。
/// `_copied` の Check アイコンは web と同じく 2 秒で元に戻す (timer は
/// dispose で cancel — web の unmount cleanup 対応)。
class InviteCard extends ConsumerStatefulWidget {
  const InviteCard({super.key});

  @override
  ConsumerState<InviteCard> createState() => _InviteCardState();
}

class _InviteCardState extends ConsumerState<InviteCard> {
  /// 生成済み招待 URL (web `useState<string | null>(null)` の `inviteUrl`)。
  String? _inviteUrl;

  /// URL 表示欄 (readOnly) の controller。[_inviteUrl] と同時に更新する。
  final TextEditingController _urlController = TextEditingController();

  bool _copied = false;
  bool _generating = false;
  Timer? _copiedTimer;

  @override
  void dispose() {
    _copiedTimer?.cancel();
    _urlController.dispose();
    super.dispose();
  }

  /// web `handleGenerateInvite`。初回生成と「新しいリンクを生成」の両方が呼ぶ。
  Future<void> _generate() async {
    if (_generating) return;

    // messenger / origin は await 後に widget が破棄されると使えないため
    // 先に解決する (profile_card / signOut と同じ流儀)。
    final messenger = ScaffoldMessenger.of(context);
    final origin = ref.read(originProvider);
    setState(() => _generating = true);

    try {
      final ctx = await ref.read(settingsMutationContextProvider.future);
      final token = await ref
          .read(settingsRepositoryProvider)
          .createInvitation(householdId: ctx.householdId, userId: ctx.userId);

      if (!mounted) return;
      setState(() {
        _inviteUrl = '$origin/invite/$token';
        _urlController.text = _inviteUrl!;
      });
      // web: toast.success("招待リンクを生成しました")。
      messenger.showSnackBar(
        const SnackBar(content: Text('招待リンクを生成しました')),
      );
    } on Object catch (e, st) {
      // 握り潰さない (CLAUDE.md)。repository でも構造化ログ済み。token は
      // 失敗経路では未取得ゆえログに secret は乗らない。
      debugPrint('InviteCard createInvitation 失敗: $e\n$st');
      if (!mounted) return;
      // web: catch → toast.error("招待リンクの生成に失敗しました")。
      messenger.showSnackBar(
        const SnackBar(content: Text('招待リンクの生成に失敗しました')),
      );
    } finally {
      if (mounted) setState(() => _generating = false);
    }
  }

  /// web `handleCopy`。
  Future<void> _copy() async {
    final url = _inviteUrl;
    if (url == null) return;

    final messenger = ScaffoldMessenger.of(context);
    try {
      await Clipboard.setData(ClipboardData(text: url));
      if (!mounted) return;
      _copiedTimer?.cancel();
      setState(() => _copied = true);
      // web: toast.success("コピーしました")。
      messenger.showSnackBar(const SnackBar(content: Text('コピーしました')));
      // web: setTimeout(() => setCopied(false), 2000)。
      _copiedTimer = Timer(const Duration(seconds: 2), () {
        if (mounted) setState(() => _copied = false);
      });
    } on Object catch (e, st) {
      // 握り潰さない (CLAUDE.md)。URL は secret (token) を含むためログには
      // 例外情報のみ出す。
      debugPrint('InviteCard clipboard copy 失敗: $e\n$st');
      if (!mounted) return;
      // web: toast.error("コピーに失敗しました")。
      messenger.showSnackBar(
        const SnackBar(content: Text('コピーに失敗しました')),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    return GlassCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              // web: <Link2 size={18} /> メンバー招待。
              Icon(
                LucideIcons.link2,
                size: 18,
                color: context.colors.textPrimary,
              ),
              SizedBox(width: 8),
              Text(
                'メンバー招待',
                style: TextStyle(
                  fontSize: 16,
                  fontWeight: FontWeight.w600,
                  color: context.colors.textPrimary,
                ),
              ),
            ],
          ),
          const SizedBox(height: 16),
          // web: text-sm text-muted-foreground。
          Text(
            '招待リンクを共有して、家族をこの世帯に招待できます。リンクは7日間有効です。',
            style: TextStyle(fontSize: 14, color: context.colors.textMuted),
          ),
          const SizedBox(height: 16),
          if (_inviteUrl != null)
            _buildUrlSection()
          else
            _buildGenerateButton(),
        ],
      ),
    );
  }

  /// URL 表示 + コピー + 再生成 (web の `inviteUrl ? ...` 分岐)。
  Widget _buildUrlSection() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Expanded(
              // web: <Input value={inviteUrl} readOnly className="text-xs" />。
              child: TextField(
                controller: _urlController,
                readOnly: true,
                style: TextStyle(
                  fontSize: 12,
                  color: context.colors.textPrimary,
                ),
                decoration: InputDecoration(
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
            ),
            const SizedBox(width: 8),
            // web: variant outline size icon-lg + aria-label。
            IconButton.outlined(
              onPressed: _copy,
              tooltip: '招待リンクをコピー',
              icon: Icon(
                _copied ? LucideIcons.check : LucideIcons.clipboardCopy,
                size: 16,
                color: context.colors.textPrimary,
              ),
              // 44px タッチターゲット (CLAUDE.md)。
              constraints: const BoxConstraints(minWidth: 44, minHeight: 44),
              style: IconButton.styleFrom(
                side: BorderSide(color: context.colors.border),
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(IroriRadii.button),
                ),
              ),
            ),
          ],
        ),
        const SizedBox(height: 8),
        // web: variant ghost size sm「新しいリンクを生成」(self-start)。
        TextButton(
          onPressed: _generating ? null : _generate,
          style: TextButton.styleFrom(
            foregroundColor: context.colors.textPrimary,
            // 44px タッチターゲット (CLAUDE.md — web の sm より Flutter 規約優先)。
            minimumSize: const Size(44, 44),
          ),
          child: const Text('新しいリンクを生成'),
        ),
      ],
    );
  }

  /// 初回生成ボタン (web の `: <Button variant="outline" size="lg">` 分岐)。
  Widget _buildGenerateButton() {
    return SizedBox(
      width: double.infinity,
      child: OutlinedButton.icon(
        onPressed: _generating ? null : _generate,
        icon: _generating
            ? const SizedBox(
                width: 16,
                height: 16,
                child: CircularProgressIndicator(strokeWidth: 2),
              )
            : const Icon(LucideIcons.link2, size: 16),
        label: const Text('招待リンクを生成'),
        style: OutlinedButton.styleFrom(
          foregroundColor: context.colors.textPrimary,
          side: BorderSide(color: context.colors.border),
          // 44px タッチターゲット (CLAUDE.md / web size lg)。
          minimumSize: const Size.fromHeight(44),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(IroriRadii.button),
          ),
        ),
      ),
    );
  }
}
