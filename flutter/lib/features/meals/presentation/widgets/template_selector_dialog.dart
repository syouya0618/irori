import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../../core/domain/suggestions/types.dart';
import '../../../../core/theme/colors.dart';
import '../../../../core/theme/radii.dart';
import '../../../stock/data/recipe_suggestions_provider.dart';
import '../../../stock/presentation/widgets/stock_suggestions_section.dart'
    show
        MatchedIngredientChips,
        SuggestionPill,
        expiringBadgeColors,
        matchPercentOf,
        matchRateBadgeColors;
import '../../data/meals_repository.dart';
import '../../domain/meal_template.dart';

/// テンプレート選択ダイアログを開き、選択された prefill を返す
/// (キャンセル / 失敗時は null)。
///
/// シグネチャは `showClearCheckedDialog(context, ref, ...)` と統一。
/// 裁定: `meal_templates` / 提案の元データ (templates + reactions) はいずれも
/// Realtime publication 非対象のため、**open ごとに [mealTemplatesProvider] と
/// [recipeSuggestionsProvider] を invalidate して refetch** する (こうせねば
/// 他端末・web で保存/削除したテンプレートやリアクションが永遠に届かない。
/// web の per-open fetch (`hasLoaded` リセット) と同等)。
Future<MealTemplatePrefill?> showTemplateSelectorDialog(
  BuildContext context,
  WidgetRef ref,
) {
  ref.invalidate(mealTemplatesProvider);
  ref.invalidate(recipeSuggestionsProvider);
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
/// - 一覧エラーは web の log + 空配列でなく error 表示 + 再試行
///   (`MealsRepository.getTemplates` doc の意図的差異)。
/// - 行内削除は web の `setTemplates(filter)` 相当としてローカル除去
///   ([_deletedIds]) し、一覧の refetch はしない。
/// - タブ切替は `TabBar` + index 分岐 (`TabBarView` は shrink-wrap 不可で
///   ダイアログの可変高と相性が悪い)。「在庫から提案」タブの中身はタブが
///   active になって初めて build され、そこで [recipeSuggestionsProvider] を
///   read する (web `SuggestionListInDialog` の `isActive` lazy fetch 相当)。
class TemplateSelectorDialog extends ConsumerStatefulWidget {
  const TemplateSelectorDialog({super.key});

  @override
  ConsumerState<TemplateSelectorDialog> createState() =>
      _TemplateSelectorDialogState();
}

class _TemplateSelectorDialogState extends ConsumerState<TemplateSelectorDialog>
    with SingleTickerProviderStateMixin {
  bool _pending = false;

  /// 行内削除済みの id (web の `setTemplates(prev.filter(...))` 相当の
  /// ローカル除去。次回 open 時は invalidate → refetch でサーバ状態に戻る)。
  final Set<String> _deletedIds = {};

  /// タブ (0 = テンプレート / 1 = 在庫から提案)。web `activeTab` state 相当。
  late final TabController _tabController;

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 2, vsync: this)
      // index 変化で説明文 + 表示タブを切り替える (タップ時は index が即時
      // 更新されるため、説明文の切替も即時)。
      ..addListener(() => setState(() {}));
  }

  @override
  void dispose() {
    _tabController.dispose();
    super.dispose();
  }

  /// loadTemplate して prefill を結果として閉じる (原典 handleSelect /
  /// handleSuggestionSelect — 成功時のみ close)。テンプレート行と提案行の
  /// 両タブが共用する。
  Future<void> _selectByTemplateId(String templateId) async {
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
            templateId: templateId,
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

  /// テンプレート一覧の行タップ。
  Future<void> _select(MealTemplate template) =>
      _selectByTemplateId(template.id);

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
    final isTemplatesTab = _tabController.index == 0;

    return AlertDialog(
      title: const Text('テンプレートから作成'),
      content: SizedBox(
        width: double.maxFinite,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              // 原典 DialogDescription の activeTab 三項分岐と同一文言。
              isTemplatesTab ? '保存済みのテンプレートを選択してください' : '在庫に合ったおすすめ献立を選択してください',
              style: Theme.of(context).textTheme.bodySmall,
            ),
            const SizedBox(height: 12),
            TabBar(
              controller: _tabController,
              tabs: const [
                Tab(text: 'テンプレート'),
                Tab(text: '在庫から提案'),
              ],
            ),
            const SizedBox(height: 8),
            ConstrainedBox(
              constraints: BoxConstraints(
                // 原典 `max-h-[75dvh]` 相当の上限 (AlertDialog の余白込み)。
                maxHeight: MediaQuery.sizeOf(context).height * 0.45,
              ),
              // index 分岐 (クラス doc 参照): 提案タブは active になって
              // 初めて build され、provider read が走る。
              child: isTemplatesTab
                  ? templatesAsync.when(
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
                    )
                  : _SuggestionsTab(
                      enabled: !_pending,
                      onSelect: _selectByTemplateId,
                    ),
            ),
          ],
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

/// 「在庫から提案」タブ (原典 `suggestion-list-in-dialog.tsx`)。
///
/// 文言は原典と同一:
/// - 空状態「おすすめ献立がありません」「在庫に合うテンプレートが見つかりませんでした」
/// - 行: title + {p}% バッジ (matchRateBadgeClass と同閾値) + 期限間近 +
///   マッチ食材チップ。不足チップ・「献立に追加」ボタンは出さない
///   (行タップ = 選択)。
///
/// loading は web の per-open スピナーに対応 (open 時の invalidate で
/// 前回値なしの AsyncLoading になる)。error は web の toast + 空状態でなく
/// error 表示 + 再試行 (`_TemplatesErrorView` と同じ rethrow 裁定の UI)。
class _SuggestionsTab extends ConsumerWidget {
  const _SuggestionsTab({required this.enabled, required this.onSelect});

  final bool enabled;
  final ValueChanged<String> onSelect;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final suggestionsAsync = ref.watch(recipeSuggestionsProvider);

    return suggestionsAsync.when(
      data: (suggestions) {
        if (suggestions.isEmpty) {
          return Padding(
            padding: const EdgeInsets.symmetric(vertical: 32),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(
                  LucideIcons.lightbulb,
                  size: 32,
                  color: IroriColors.textMuted.withValues(alpha: 0.4),
                ),
                const SizedBox(height: 8),
                Text(
                  'おすすめ献立がありません',
                  style: Theme.of(context).textTheme.bodySmall,
                ),
                const SizedBox(height: 4),
                Text(
                  '在庫に合うテンプレートが見つかりませんでした',
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
            for (final suggestion in suggestions)
              _SuggestionRow(
                suggestion: suggestion,
                enabled: enabled,
                onSelect: onSelect,
              ),
          ],
        );
      },
      loading: () => const Padding(
        padding: EdgeInsets.symmetric(vertical: 32),
        child: Center(child: CircularProgressIndicator()),
      ),
      error: (error, _) => _SuggestionsErrorView(error: error),
    );
  }
}

/// 提案行 1 件 (原典 suggestion-list-in-dialog.tsx の role="button" 行)。
class _SuggestionRow extends StatelessWidget {
  const _SuggestionRow({
    required this.suggestion,
    required this.enabled,
    required this.onSelect,
  });

  final RecipeSuggestion suggestion;
  final bool enabled;
  final ValueChanged<String> onSelect;

  @override
  Widget build(BuildContext context) {
    final matchPercent = matchPercentOf(suggestion);
    final badge = matchRateBadgeColors(matchPercent);

    return InkWell(
      onTap: enabled ? () => onSelect(suggestion.templateId) : null,
      borderRadius: BorderRadius.circular(IroriRadii.button),
      child: ConstrainedBox(
        // 44px タッチターゲット (CLAUDE.md)。
        constraints: const BoxConstraints(minHeight: 44),
        child: Padding(
          padding: const EdgeInsets.all(12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Expanded(
                    child: Text(
                      suggestion.title,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                        fontSize: 14,
                        fontWeight: FontWeight.w500,
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  SuggestionPill(
                    text: '$matchPercent%',
                    background: badge.background,
                    foreground: badge.foreground,
                    fontWeight: FontWeight.w500,
                  ),
                  if (suggestion.hasExpiringStock) ...[
                    const SizedBox(width: 4),
                    SuggestionPill(
                      text: '期限間近',
                      background: expiringBadgeColors.background,
                      foreground: expiringBadgeColors.foreground,
                      fontWeight: FontWeight.w500,
                    ),
                  ],
                ],
              ),
              if (suggestion.matchedIngredients.isNotEmpty) ...[
                const SizedBox(height: 8),
                MatchedIngredientChips(
                  matched: suggestion.matchedIngredients,
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

/// 提案タブの error 分岐 (`_TemplatesErrorView` と同形)。
class _SuggestionsErrorView extends ConsumerWidget {
  const _SuggestionsErrorView({required this.error});

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
            'レシピ提案の取得に失敗しました',
            style: Theme.of(context).textTheme.bodyLarge,
          ),
          const SizedBox(height: 8),
          Text('$error', style: Theme.of(context).textTheme.bodySmall),
          const SizedBox(height: 16),
          FilledButton.tonal(
            onPressed: () => ref.invalidate(recipeSuggestionsProvider),
            style: FilledButton.styleFrom(minimumSize: const Size(44, 44)),
            child: const Text('再試行'),
          ),
        ],
      ),
    );
  }
}
