import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../../core/theme/colors.dart';
import '../../data/shopping_repository.dart';

/// 献立→買い物リスト生成の確認ダイアログを開く
/// (`showClearCheckedDialog` とシグネチャ統一)。
Future<void> showGenerateFromMealsDialog(BuildContext context, WidgetRef ref) {
  return showDialog<void>(
    context: context,
    builder: (_) => const GenerateFromMealsDialog(),
  );
}

/// 献立からの食材一括追加の確認ダイアログ。
/// Next.js 原典 `generate-from-meals.tsx` を `ClearCheckedDialog` の雛形で
/// 移植。
///
/// 原典との対応:
/// - open 時に `previewMealIngredients` で追加予定件数を取得
///   (`handleOpenChange` の preview fetch)。取得中はスピナー +「確認中...」。
/// - 説明文言は原典と同一:
///   - 0 件: 「今週の献立から追加できる食材がありません。献立を登録するか、
///     既にリストに追加済みでないか確認してください。」
///   - N 件: 「今週の献立からN件の食材を買い物リストに追加しますか？
///     （既にリストにある食材は除外されます）」— 既存重複の除外注記込み。
/// - 確定 disabled 条件も原典と同一:
///   `isPending || isLoadingPreview || previewCount === 0`。
/// - 成功 toast: 「N件の食材を追加しました」(N はサーバが insert した実件数)。
/// - **エラー時もダイアログを閉じる** (原典 `handleGenerate` は toast 後に
///   全分岐で `setOpen(false)`) — エラー時に開いたままにする
///   `ClearCheckedDialog` とは原典準拠で意図的に異なる。
///
/// 一覧への反映は realtime INSERT (reducer) が担う (web の
/// `revalidatePath("/shopping")` 相当)。
class GenerateFromMealsDialog extends ConsumerStatefulWidget {
  const GenerateFromMealsDialog({super.key});

  @override
  ConsumerState<GenerateFromMealsDialog> createState() =>
      _GenerateFromMealsDialogState();
}

class _GenerateFromMealsDialogState
    extends ConsumerState<GenerateFromMealsDialog> {
  /// preview 取得中 (原典 `isLoadingPreview`)。
  bool _loadingPreview = true;

  /// 追加実行中 (原典 `isPending`)。
  bool _pending = false;

  /// 追加予定件数 (原典 `previewCount`)。
  int _previewCount = 0;

  @override
  void initState() {
    super.initState();
    _loadPreview();
  }

  Future<void> _loadPreview() async {
    var count = 0;
    try {
      final mutationContext = await ref.read(
        shoppingMutationContextProvider.future,
      );
      count = await ref
          .read(shoppingRepositoryProvider)
          .previewMealIngredients(mutationContext.householdId);
    } on Object catch (e, st) {
      // web parity: preview 失敗は 0 件扱い (原典 `.catch(() =>
      // setPreviewCount(0))`)。repository 側は内部で 0 縮退済みのため、
      // ここに来るのは mutationContext (未認証/世帯未参加 StateError) のみ —
      // 握り潰さずログする (CLAUDE.md)。
      debugPrint('GenerateFromMealsDialog preview 失敗: $e\n$st');
    }
    if (!mounted) return;
    setState(() {
      _previewCount = count;
      _loadingPreview = false;
    });
  }

  Future<void> _generate() async {
    if (_pending) return;
    setState(() => _pending = true);

    final messenger = ScaffoldMessenger.of(context);
    final navigator = Navigator.of(context);

    String message;
    try {
      final mutationContext = await ref.read(
        shoppingMutationContextProvider.future,
      );
      final count = await ref
          .read(shoppingRepositoryProvider)
          .generateFromMeals(
            householdId: mutationContext.householdId,
            userId: mutationContext.userId,
          );
      message = '$count件の食材を追加しました';
    } on NoMealsThisWeekException {
      // preview 後に献立/食材/リストが変わった場合のレース (web も同様に
      // 確定時の error toast で扱う)。文言は web actions.ts と同一。
      message = NoMealsThisWeekException.message;
    } on NoIngredientsThisWeekException {
      message = NoIngredientsThisWeekException.message;
    } on NoNewIngredientsException {
      message = NoNewIngredientsException.message;
    } on Object catch (e, st) {
      // 握り潰さない (CLAUDE.md)。repository 側でも構造化ログ済み。
      // web は段階別文言 (献立/食材の取得失敗・追加失敗) だが、repository は
      // 段階情報を持たない生例外を rethrow するため、確定操作の文言に寄せる
      // (`ClearCheckedDialog` と同じ理由)。
      debugPrint('GenerateFromMealsDialog generateFromMeals 失敗: $e\n$st');
      message = '食材の追加に失敗しました';
    } finally {
      if (mounted) setState(() => _pending = false);
    }

    if (!mounted) return;
    // 成功・エラーとも close + SnackBar (原典の toast → `setOpen(false)`)。
    navigator.pop();
    messenger.showSnackBar(SnackBar(content: Text(message)));
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('献立から食材を追加'),
      content: _loadingPreview
          ? const Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                SizedBox.square(
                  dimension: 14,
                  child: CircularProgressIndicator(strokeWidth: 2),
                ),
                SizedBox(width: 8),
                Text('確認中...'),
              ],
            )
          : Text(
              _previewCount == 0
                  ? '今週の献立から追加できる食材がありません。'
                        '献立を登録するか、既にリストに追加済みでないか確認してください。'
                  : '今週の献立から$_previewCount件の食材を買い物リストに追加しますか？'
                        '（既にリストにある食材は除外されます）',
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
        FilledButton.icon(
          // 原典と同一の disabled 条件:
          // `isPending || isLoadingPreview || previewCount === 0`。
          onPressed: (_pending || _loadingPreview || _previewCount == 0)
              ? null
              : _generate,
          style: FilledButton.styleFrom(minimumSize: const Size(44, 44)),
          icon: _pending
              ? const SizedBox.square(
                  dimension: 16,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              : const Icon(LucideIcons.calendarDays, size: 16),
          label: const Text('追加する'),
        ),
      ],
    );
  }
}
