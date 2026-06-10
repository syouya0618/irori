import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../../core/theme/colors.dart';
import '../../data/shopping_repository.dart';

/// チェック済みクリアの確認ダイアログを開く。
///
/// シグネチャは `showMealFormSheet(context, ref, ...)` と統一
/// ([ref] は close 後の provider 操作を足す際の拡張点)。
/// [checkedCount] は表示中 (店舗フィルタ適用後) のチェック済み件数
/// (web の `checkedItems.length` — 削除自体は全店舗のチェック済みに及ぶ)。
Future<void> showClearCheckedDialog(
  BuildContext context,
  WidgetRef ref, {
  required int checkedCount,
}) {
  return showDialog<void>(
    context: context,
    builder: (_) => ClearCheckedDialog(checkedCount: checkedCount),
  );
}

/// チェック済みアイテムの一括削除確認ダイアログ。
/// Next.js 原典 `shopping-list.tsx` の clear Dialog を移植。
///
/// 文言は原典と同一:
/// - 説明: 「チェック済みのN件のアイテムを削除します。購入履歴に記録されます。
///   この操作は取り消せません。」
/// - 成功 toast: 「N件のアイテムを削除しました」(N はサーバが削除した実件数)
/// - 0 件エラー: [NoCheckedShoppingItemsException.message]
///   (「チェック済みのアイテムがありません」)。エラー時はダイアログを
///   閉じない (web は成功時のみ `setClearDialogOpen(false)`)。
///
/// 一覧からの除去は realtime DELETE (reducer) が反映する (web も同様)。
class ClearCheckedDialog extends ConsumerStatefulWidget {
  const ClearCheckedDialog({required this.checkedCount, super.key});

  /// 表示中のチェック済み件数 (確認文言用)。
  final int checkedCount;

  @override
  ConsumerState<ClearCheckedDialog> createState() => _ClearCheckedDialogState();
}

class _ClearCheckedDialogState extends ConsumerState<ClearCheckedDialog> {
  bool _pending = false;

  Future<void> _clear() async {
    if (_pending) return;
    setState(() => _pending = true);

    final messenger = ScaffoldMessenger.of(context);
    final navigator = Navigator.of(context);

    try {
      final mutationContext = await ref.read(
        shoppingMutationContextProvider.future,
      );
      final count = await ref
          .read(shoppingRepositoryProvider)
          .clearChecked(mutationContext.householdId);
      if (!mounted) return;
      navigator.pop();
      messenger.showSnackBar(SnackBar(content: Text('$count件のアイテムを削除しました')));
    } on NoCheckedShoppingItemsException {
      // 0 件は専用文言 (原典と同一)。ダイアログは開いたまま。
      if (!mounted) return;
      messenger.showSnackBar(
        const SnackBar(content: Text(NoCheckedShoppingItemsException.message)),
      );
    } on Object catch (e, st) {
      // 握り潰さない (CLAUDE.md)。repository 側でも構造化ログ済み。
      // web は取得失敗/削除失敗で別文言だが、repository は段階情報を持たない
      // 生例外を rethrow するため、削除系の文言に寄せる。
      debugPrint('ClearCheckedDialog clearChecked 失敗: $e\n$st');
      if (!mounted) return;
      messenger.showSnackBar(
        const SnackBar(content: Text('チェック済みアイテムの削除に失敗しました')),
      );
    } finally {
      if (mounted) setState(() => _pending = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('チェック済みアイテムを削除'),
      content: Text(
        'チェック済みの${widget.checkedCount}件のアイテムを削除します。'
        '購入履歴に記録されます。この操作は取り消せません。',
      ),
      actions: [
        TextButton(
          onPressed: _pending ? null : () => Navigator.of(context).pop(),
          style: TextButton.styleFrom(
            minimumSize: const Size(44, 44),
            foregroundColor: IroriColors.textPrimary,
          ),
          child: const Text('キャンセル'),
        ),
        // destructive ボタン (原典 `variant="destructive"`)。
        FilledButton.icon(
          onPressed: _pending ? null : _clear,
          style: FilledButton.styleFrom(
            minimumSize: const Size(44, 44),
            backgroundColor: IroriColors.error,
            foregroundColor: IroriColors.surface,
          ),
          icon: _pending
              ? const SizedBox.square(
                  dimension: 16,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              : const Icon(LucideIcons.trash2, size: 16),
          label: const Text('削除する'),
        ),
      ],
    );
  }
}
