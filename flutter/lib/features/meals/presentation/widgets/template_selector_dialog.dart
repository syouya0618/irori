import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../../core/theme/colors.dart';
import '../../../../core/theme/radii.dart';
import '../../data/meals_repository.dart';
import '../../domain/meal_template.dart';

/// テンプレート選択ダイアログを開き、選択された prefill を返す
/// (キャンセル / 失敗時は null)。
///
/// シグネチャは `showClearCheckedDialog(context, ref, ...)` と統一。
/// 裁定: `meal_templates` は Realtime publication 非対象のため、**open ごとに
/// [mealTemplatesProvider] を invalidate して refetch** する (こうせねば
/// 他端末・web で保存/削除したテンプレートが永遠に届かない)。
Future<MealTemplatePrefill?> showTemplateSelectorDialog(
  BuildContext context,
  WidgetRef ref,
) {
  ref.invalidate(mealTemplatesProvider);
  return showDialog<MealTemplatePrefill>(
    context: context,
    builder: (_) => const TemplateSelectorDialog(),
  );
}

/// テンプレート選択ダイアログ。Next.js 原典 `template-selector.tsx` の移植。
///
/// 文言は原典と同一:
/// - タイトル「テンプレートから作成」/ 説明「保存済みのテンプレートを選択してください」
/// - 空状態「テンプレートがまだありません」「献立を作成後「テンプレートとして保存」できます」
/// - 行 subtitle「食材 N品」/ 削除成功 toast「テンプレートを削除しました」
/// - loadTemplate 失敗「テンプレートが見つかりません。」(web は全失敗経路で
///   この文言に倒れるため、Dart も catch-all で同一文言)
/// - 削除失敗「テンプレートの削除に失敗しました。」(actions.ts と同一)
///
/// 原典との構造差:
/// - タブは本 PR では「テンプレート」1 枚のみ (PR-F が「在庫から提案」タブを
///   追加する前提の TabBar 構造だけ先に作る)。
/// - 一覧エラーは web の log + 空配列でなく error 表示 + 再試行
///   (`MealsRepository.getTemplates` doc の意図的差異)。
/// - 行内削除は web の `setTemplates(filter)` 相当としてローカル除去
///   ([_deletedIds]) し、一覧の refetch はしない。
class TemplateSelectorDialog extends ConsumerStatefulWidget {
  const TemplateSelectorDialog({super.key});

  @override
  ConsumerState<TemplateSelectorDialog> createState() =>
      _TemplateSelectorDialogState();
}

class _TemplateSelectorDialogState
    extends ConsumerState<TemplateSelectorDialog> {
  bool _pending = false;

  /// 行内削除済みの id (web の `setTemplates(prev.filter(...))` 相当の
  /// ローカル除去。次回 open 時は invalidate → refetch でサーバ状態に戻る)。
  final Set<String> _deletedIds = {};

  /// 行タップ: loadTemplate して prefill を結果として閉じる
  /// (原典 handleSelect — 成功時のみ close)。
  Future<void> _select(MealTemplate template) async {
    if (_pending) return;
    setState(() => _pending = true);

    final messenger = ScaffoldMessenger.of(context);
    final navigator = Navigator.of(context);

    try {
      final mutationContext = await ref.read(
        mealsMutationContextProvider.future,
      );
      final prefill = await ref
          .read(mealsRepositoryProvider)
          .loadTemplate(
            householdId: mutationContext.householdId,
            templateId: template.id,
          );
      if (!mounted) return;
      navigator.pop(prefill);
    } on Object catch (e, st) {
      // 握り潰さない (CLAUDE.md)。repository 側でも構造化ログ済み。
      debugPrint('TemplateSelectorDialog loadTemplate 失敗: $e\n$st');
      if (!mounted) return;
      messenger.showSnackBar(
        const SnackBar(content: Text('テンプレートが見つかりません。')),
      );
    } finally {
      if (mounted) setState(() => _pending = false);
    }
  }

  /// 行内ゴミ箱: 即削除 (原典 handleDelete — 確認ステップ無し)。
  Future<void> _delete(MealTemplate template) async {
    if (_pending) return;
    setState(() => _pending = true);

    final messenger = ScaffoldMessenger.of(context);

    try {
      final mutationContext = await ref.read(
        mealsMutationContextProvider.future,
      );
      await ref
          .read(mealsRepositoryProvider)
          .deleteTemplate(
            householdId: mutationContext.householdId,
            templateId: template.id,
          );
      if (!mounted) return;
      setState(() => _deletedIds.add(template.id));
      messenger.showSnackBar(
        const SnackBar(content: Text('テンプレートを削除しました')),
      );
    } on Object catch (e, st) {
      // 握り潰さない (CLAUDE.md)。repository 側でも構造化ログ済み。
      debugPrint('TemplateSelectorDialog deleteTemplate 失敗: $e\n$st');
      if (!mounted) return;
      messenger.showSnackBar(
        const SnackBar(content: Text('テンプレートの削除に失敗しました。')),
      );
    } finally {
      if (mounted) setState(() => _pending = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final templatesAsync = ref.watch(mealTemplatesProvider);

    return AlertDialog(
      title: const Text('テンプレートから作成'),
      content: SizedBox(
        width: double.maxFinite,
        // PR-F が「在庫から提案」タブを追加する前提の TabBar 構造
        // (length を 2 にして TabBarView 化するだけで拡張できる)。
        child: DefaultTabController(
          length: 1,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(
                '保存済みのテンプレートを選択してください',
                style: Theme.of(context).textTheme.bodySmall,
              ),
              const SizedBox(height: 12),
              const TabBar(tabs: [Tab(text: 'テンプレート')]),
              const SizedBox(height: 8),
              ConstrainedBox(
                constraints: BoxConstraints(
                  // 原典 `max-h-[75dvh]` 相当の上限 (AlertDialog の余白込み)。
                  maxHeight: MediaQuery.sizeOf(context).height * 0.45,
                ),
                child: templatesAsync.when(
                  data: (templates) => _TemplateList(
                    templates: [
                      for (final template in templates)
                        if (!_deletedIds.contains(template.id)) template,
                    ],
                    enabled: !_pending,
                    onSelect: _select,
                    onDelete: _delete,
                  ),
                  loading: () => const Padding(
                    padding: EdgeInsets.symmetric(vertical: 32),
                    child: Center(child: CircularProgressIndicator()),
                  ),
                  error: (error, _) => _TemplatesErrorView(error: error),
                ),
              ),
            ],
          ),
        ),
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
      ],
    );
  }
}

/// data 分岐: 一覧 or 空状態 (原典の `templates.length === 0` 分岐)。
class _TemplateList extends StatelessWidget {
  const _TemplateList({
    required this.templates,
    required this.enabled,
    required this.onSelect,
    required this.onDelete,
  });

  final List<MealTemplate> templates;
  final bool enabled;
  final ValueChanged<MealTemplate> onSelect;
  final ValueChanged<MealTemplate> onDelete;

  @override
  Widget build(BuildContext context) {
    if (templates.isEmpty) {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(
              LucideIcons.bookOpen,
              size: 32,
              color: IroriColors.textMuted.withValues(alpha: 0.4),
            ),
            const SizedBox(height: 8),
            Text(
              'テンプレートがまだありません',
              style: Theme.of(context).textTheme.bodySmall,
            ),
            const SizedBox(height: 4),
            Text(
              '献立を作成後「テンプレートとして保存」できます',
              textAlign: TextAlign.center,
              style: Theme.of(context).textTheme.bodySmall?.copyWith(
                fontSize: 11,
                color: IroriColors.textMuted.withValues(alpha: 0.7),
              ),
            ),
          ],
        ),
      );
    }

    return ListView(
      shrinkWrap: true,
      children: [
        for (final template in templates)
          ListTile(
            onTap: enabled ? () => onSelect(template) : null,
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(IroriRadii.button),
            ),
            contentPadding: const EdgeInsets.only(left: 12, right: 4),
            title: Text(
              template.title,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(
                fontSize: 14,
                fontWeight: FontWeight.w500,
              ),
            ),
            subtitle: Text(
              // 原典 getIngredientCount は非配列を 0 と数える — Dart は
              // 防御パース済みモデルの length がそれと等価。
              '食材 ${template.ingredients.length}品',
              style: const TextStyle(
                fontSize: 12,
                color: IroriColors.textMuted,
              ),
            ),
            trailing: IconButton(
              icon: const Icon(LucideIcons.trash2, size: 16),
              tooltip: 'テンプレートを削除',
              onPressed: enabled ? () => onDelete(template) : null,
              color: IroriColors.textMuted,
              // 44x44 の最小タッチ領域 (CLAUDE.md)。
              constraints: const BoxConstraints(minWidth: 44, minHeight: 44),
            ),
          ),
      ],
    );
  }
}

/// error 分岐。読み込み失敗の告知 + 再試行 (meals `_ErrorView` の流儀 —
/// getTemplates rethrow 裁定とセットの意図的差異 UI)。
class _TemplatesErrorView extends ConsumerWidget {
  const _TemplatesErrorView({required this.error});

  final Object error;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 16),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Icon(Icons.error_outline, color: IroriColors.error),
          const SizedBox(height: 12),
          Text(
            'テンプレートの読み込みに失敗しました。',
            style: Theme.of(context).textTheme.bodyLarge,
          ),
          const SizedBox(height: 8),
          Text('$error', style: Theme.of(context).textTheme.bodySmall),
          const SizedBox(height: 16),
          FilledButton.tonal(
            onPressed: () => ref.invalidate(mealTemplatesProvider),
            style: FilledButton.styleFrom(minimumSize: const Size(44, 44)),
            child: const Text('再試行'),
          ),
        ],
      ),
    );
  }
}
