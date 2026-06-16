import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../../core/theme/colors.dart';
import '../../../../core/theme/radii.dart';
import '../../../../widgets/glass_card.dart';
import '../../data/settings_provider.dart';
import '../../data/settings_repository.dart';

/// 承認待ちカード (owner のみ)。Next.js 原典 `approval-card.tsx` の Flutter 移植。
///
/// 表示条件 (web `settings-content.tsx:132-135`:
/// `role === "owner" && pendingUsers.length > 0`):
/// - owner ゲートは [SettingsPage] 側で `settings.role == 'owner'` の時のみ
///   本カードを mount することで担う。
/// - 承認待ち 0 件 / 読み込み中 / 取得失敗時は何も描画しない (web が card を
///   mount しない挙動の移植)。error は web の `logSupabaseError` 後
///   `pendingUsers=[]` と同じく log + 非表示で縮退する。
///
/// 表示時のみカード上に 16px の spacing を自前で持つ。これにより [SettingsPage]
/// 側に固定の `SizedBox` を置かずに済み、「owner だが承認待ち 0」のとき余分な
/// 隙間が出ない。
class ApprovalCard extends ConsumerWidget {
  const ApprovalCard({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final pendingAsync = ref.watch(pendingApprovalsProvider);
    return pendingAsync.when(
      skipLoadingOnReload: true,
      data: (users) {
        if (users.isEmpty) return const SizedBox.shrink();
        return Padding(
          padding: const EdgeInsets.only(top: 16),
          child: _ApprovalCardBody(users: users),
        );
      },
      loading: () => const SizedBox.shrink(),
      error: (error, stack) {
        // web parity: pendingError は log して card を非表示にする
        // (settings/page.tsx は logSupabaseError 後 pendingUsers=[])。
        debugPrint('ApprovalCard pendingApprovals error: $error\n$stack');
        return const SizedBox.shrink();
      },
    );
  }
}

class _ApprovalCardBody extends StatelessWidget {
  const _ApprovalCardBody({required this.users});

  final List<PendingUser> users;

  @override
  Widget build(BuildContext context) {
    return GlassCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              // web: <ShieldCheck size={18} /> 承認待ち。
              const Icon(
                LucideIcons.shieldCheck,
                size: 18,
                color: IroriColors.textPrimary,
              ),
              const SizedBox(width: 8),
              const Text(
                '承認待ち',
                style: TextStyle(
                  fontSize: 16,
                  fontWeight: FontWeight.w600,
                  color: IroriColors.textPrimary,
                ),
              ),
              const Spacer(),
              // web: 件数バッジ `bg-amber-500/10 text-amber-600`。
              // amber は本プロジェクトの warning トークン (yellow-500) へ写す。
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                decoration: BoxDecoration(
                  color: IroriColors.warning.withValues(alpha: 0.1),
                  borderRadius: BorderRadius.circular(IroriRadii.pill),
                ),
                child: Text(
                  '${users.length}',
                  style: const TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.w500,
                    color: IroriColors.warning,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          // web: CardContent の flex flex-col gap-3。
          // key: ValueKey(id) 必須 — _PendingUserRow は承認中フラグ (_approving) を
          // 持つ StatefulWidget。get_pending_approvals は ORDER BY 無し (migration
          // 20260408000002) ゆえ承認後 refetch で行順が変わりうる。key が無いと
          // Flutter は State を「位置」で reconcile し、承認中スピナーが別ユーザーへ
          // 化ける。web approval-card.tsx:37 の key={pendingUser.id} と
          // shopping_category_group.dart の ValueKey(id) と同じ流儀。
          for (var i = 0; i < users.length; i++) ...[
            if (i > 0) const SizedBox(height: 12),
            _PendingUserRow(key: ValueKey(users[i].id), user: users[i]),
          ],
        ],
      ),
    );
  }
}

/// 承認待ちユーザー 1 行 (web `PendingUserRow`)。承認ボタンの保存中状態を
/// 行ごとに持つため [ConsumerStatefulWidget]。
class _PendingUserRow extends ConsumerStatefulWidget {
  const _PendingUserRow({super.key, required this.user});

  final PendingUser user;

  @override
  ConsumerState<_PendingUserRow> createState() => _PendingUserRowState();
}

class _PendingUserRowState extends ConsumerState<_PendingUserRow> {
  bool _approving = false;

  Future<void> _approve() async {
    if (_approving) return;

    // ref / messenger は await 後に widget が破棄されると使えないため先に解決する
    // (auto_stock_card / signOut と同じ流儀)。
    final messenger = ScaffoldMessenger.of(context);
    final user = widget.user;
    setState(() => _approving = true);

    try {
      await ref.read(settingsRepositoryProvider).approveUser(user.id);
      // await 後・ref 使用前に mounted を確認する (Riverpod 公式 FAQ の正準パターン:
      // await → mounted 確認 → ref 使用)。await 中に widget が破棄された後の ref 使用は
      // unsafe ゆえ先にゲートする。in-flight 中に unmount された場合 invalidate を skip
      // するが、AppShell の設定タブ再表示で settingsProvider が再評価され
      // pendingApprovalsProvider が追随する安全網がある。
      if (!mounted) return;
      // web: router.refresh() で承認待ち一覧を再取得 → provider invalidate で対応。
      ref.invalidate(pendingApprovalsProvider);
      // web: toast.success(`${user.email} を承認しました`)。
      messenger.showSnackBar(
        SnackBar(content: Text('${user.email} を承認しました')),
      );
    } on Object catch (e, st) {
      // 握り潰さない (CLAUDE.md)。repository でも構造化ログ済み。
      debugPrint('ApprovalCard approveUser 失敗: $e\n$st');
      if (!mounted) return;
      // web: toast.error(result.error)。「Only owners」は repository が
      // ArgumentError('承認権限がありません') へ写す。それ以外は汎用文言。
      final message = e is ArgumentError ? e.message : null;
      messenger.showSnackBar(
        SnackBar(
          content: Text(
            message is String && message.isNotEmpty ? message : '承認に失敗しました',
          ),
        ),
      );
    } finally {
      if (mounted) setState(() => _approving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final user = widget.user;
    // web: `user.display_name || user.email` を主表示、display_name があれば
    // email を副表示する。
    final primaryText = user.displayName.isNotEmpty
        ? user.displayName
        : user.email;

    return Row(
      children: [
        // web: rounded-full bg-muted の丸アイコン + UserPlus。
        Container(
          width: 36,
          height: 36,
          decoration: const BoxDecoration(
            color: IroriColors.muted,
            shape: BoxShape.circle,
          ),
          alignment: Alignment.center,
          child: const Icon(
            LucideIcons.userPlus,
            size: 16,
            color: IroriColors.textMuted,
          ),
        ),
        const SizedBox(width: 12),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                primaryText,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(
                  fontSize: 14,
                  fontWeight: FontWeight.w500,
                  color: IroriColors.textPrimary,
                ),
              ),
              if (user.displayName.isNotEmpty)
                Text(
                  user.email,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    fontSize: 12,
                    color: IroriColors.textMuted,
                  ),
                ),
            ],
          ),
        ),
        const SizedBox(width: 12),
        // web: Button size sm (primary)。保存中は spinner。44px タッチターゲット。
        FilledButton(
          onPressed: _approving ? null : _approve,
          style: FilledButton.styleFrom(
            minimumSize: const Size(64, 44),
            padding: const EdgeInsets.symmetric(horizontal: 16),
          ),
          child: _approving
              ? const SizedBox(
                  width: 14,
                  height: 14,
                  child: CircularProgressIndicator(
                    strokeWidth: 2,
                    valueColor: AlwaysStoppedAnimation<Color>(
                      IroriColors.surface,
                    ),
                  ),
                )
              : const Text('承認'),
        ),
      ],
    );
  }
}
