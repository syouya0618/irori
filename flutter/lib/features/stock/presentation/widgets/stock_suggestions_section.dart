import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../../core/domain/suggestions/types.dart';
import '../../../../core/theme/colors.dart';
import '../../../../core/theme/radii.dart';
import '../../../../widgets/glass_card.dart';
import '../../../meals/data/meals_repository.dart';
import '../../../meals/data/pending_template_prefill_provider.dart';
import '../../data/recipe_suggestions_provider.dart';

// Tailwind palette (web suggestion-card.tsx / stock-suggestions.tsx の配色。
// stock_page.dart の amber banner と同じ v3 hex pre-compute 流儀)。
const _emerald100 = Color(0xFFD1FAE5);
const _emerald700 = Color(0xFF047857);
const _amber100 = Color(0xFFFEF3C7);
const _amber700 = Color(0xFFB45309);
const _gray100 = Color(0xFFF3F4F6);
const _gray600 = Color(0xFF4B5563);
const _red100 = Color(0xFFFEE2E2);
const _red700 = Color(0xFFB91C1C);
const _red50 = Color(0xFFFEF2F2);
const _emerald50 = Color(0xFFECFDF5);

/// 初期表示件数 (web `INITIAL_VISIBLE = 5`)。
const _kInitialVisible = 5;

/// マッチ率 (0〜100) に応じたバッジ配色。
/// web `suggestion-card.tsx` `matchRateBadgeClass` の閾値と**同一**:
/// 80 以上 emerald-100/700、50 以上 amber-100/700、それ以外 gray-100/600。
({Color background, Color foreground}) matchRateBadgeColors(int matchPercent) {
  if (matchPercent >= 80) {
    return (background: _emerald100, foreground: _emerald700);
  }
  if (matchPercent >= 50) {
    return (background: _amber100, foreground: _amber700);
  }
  return (background: _gray100, foreground: _gray600);
}

/// マッチ食材チップの配色 (web: isExpiring → `bg-red-50 text-red-700`、
/// それ以外 → `bg-emerald-50 text-emerald-700`)。
({Color background, Color foreground}) matchedIngredientChipColors(
  bool isExpiring,
) {
  if (isExpiring) return (background: _red50, foreground: _red700);
  return (background: _emerald50, foreground: _emerald700);
}

/// 期限間近バッジ配色 (web: `bg-red-100 text-red-700`)。
const ({Color background, Color foreground}) expiringBadgeColors = (
  background: _red100,
  foreground: _red700,
);

/// マッチ率の % 表記 (web `Math.round(matchRate * 100)`)。
/// JS `Math.round` と Dart `round()` は正値で同値 (half away from zero)。
int matchPercentOf(RecipeSuggestion suggestion) =>
    (suggestion.scoreBreakdown.matchRate * 100).round();

/// 角丸 pill バッジ/チップ (web `rounded-full px-2 py-0.5 text-xs`)。
/// 提案タブ (`template_selector_dialog.dart`) からも再利用する。
class SuggestionPill extends StatelessWidget {
  const SuggestionPill({
    required this.text,
    required this.background,
    required this.foreground,
    this.fontWeight,
    this.dashedBorder = false,
    super.key,
  });

  final String text;
  final Color? background;
  final Color foreground;
  final FontWeight? fontWeight;

  /// web の不足チップ `border border-dashed border-border`。
  /// Flutter 標準に破線 border が無いため淡い実線で近似する
  /// (`meal_form_sheet.dart` の破線 empty ボタンと同じ裁定)。
  final bool dashedBorder;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      decoration: BoxDecoration(
        color: background,
        borderRadius: BorderRadius.circular(999),
        border: dashedBorder ? Border.all(color: IroriColors.border) : null,
      ),
      child: Text(
        text,
        style: TextStyle(
          fontSize: 12,
          color: foreground,
          fontWeight: fontWeight,
        ),
      ),
    );
  }
}

/// マッチ食材チップの並び (web suggestion-card.tsx のマッチ食材ブロック)。
/// 提案タブからも再利用する。
class MatchedIngredientChips extends StatelessWidget {
  const MatchedIngredientChips({required this.matched, super.key});

  final List<MatchedIngredient> matched;

  @override
  Widget build(BuildContext context) {
    return Wrap(
      spacing: 4,
      runSpacing: 4,
      children: [
        for (final ing in matched)
          SuggestionPill(
            text: ing.name,
            background: matchedIngredientChipColors(ing.isExpiring).background,
            foreground: matchedIngredientChipColors(ing.isExpiring).foreground,
          ),
      ],
    );
  }
}

/// 在庫タブ上部の「おすすめ献立」折りたたみ section。
///
/// Next.js 原典 `stock-suggestions.tsx` の移植。文言は原典と同一:
/// - ヘッダ「おすすめ献立」+ 件数 + 更新スピナー (再計算中)
/// - 空状態「おすすめ献立がまだありません」
///   「献立を作成してテンプレート保存すると、在庫に合った提案が表示されます」
/// - 「もっと見る（残りN件）」/「閉じる」(5 件超のとき)
/// - 「献立に追加」→ web は `/meals?template=ID` 遷移。Flutter は
///   `loadTemplate` の結果を [pendingTemplatePrefillProvider] に積み、
///   献立タブへ切替える (`MealsPage` が 1 回だけ消費して sheet を開く)。
///
/// 原典との構造差 (SSR 初期データが無い Flutter 固有の状態):
/// - 初回 loading は小スピナー、初回エラーはコンパクトな再試行行を出す
///   (web は SSR 失敗時に空配列でレンダリングするため UI 上区別不能 —
///   既存 fetch 系の rethrow 裁定に合わせた意図的差異)。
class StockSuggestionsSection extends ConsumerStatefulWidget {
  const StockSuggestionsSection({super.key});

  @override
  ConsumerState<StockSuggestionsSection> createState() =>
      _StockSuggestionsSectionState();
}

class _StockSuggestionsSectionState
    extends ConsumerState<StockSuggestionsSection> {
  bool _isExpanded = true; // 原典 useState(true)
  bool _showAll = false; // 原典 useState(false)
  bool _pending = false; // 「献立に追加」の多重タップ防止

  /// 「献立に追加」(原典 handleAddToMeal)。web は URL パラメータ遷移だが、
  /// Flutter は loadTemplate → prefill provider → 献立タブ切替。
  Future<void> _addToMeal(RecipeSuggestion suggestion) async {
    if (_pending) return;
    setState(() => _pending = true);

    final messenger = ScaffoldMessenger.of(context);

    try {
      final mutationContext = await ref.read(
        mealsMutationContextProvider.future,
      );
      final prefill = await ref
          .read(mealsRepositoryProvider)
          .loadTemplate(
            householdId: mutationContext.householdId,
            templateId: suggestion.templateId,
          );
      if (!mounted) return;
      ref.read(pendingTemplatePrefillProvider.notifier).set(prefill);
      // 献立タブへ (web router.push('/meals?...') 相当)。Router 外
      // (widget test ハーネス等) では遷移をスキップする。
      GoRouter.maybeOf(context)?.go('/meals');
    } on Object catch (e, st) {
      // 握り潰さない (CLAUDE.md)。repository 側でも構造化ログ済み。
      debugPrint('StockSuggestionsSection loadTemplate 失敗: $e\n$st');
      if (!mounted) return;
      // web loadTemplate は全失敗経路でこの文言 (template_selector_dialog と
      // 同じ catch-all)。
      messenger.showSnackBar(
        const SnackBar(content: Text('テンプレートが見つかりません。')),
      );
    } finally {
      if (mounted) setState(() => _pending = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final suggestionsAsync = ref.watch(recipeSuggestionsProvider);
    // 再計算中は前回データ保持の AsyncLoading (provider doc)。
    final suggestions = suggestionsAsync.value;
    final isRefreshing = suggestionsAsync.isLoading && suggestions != null;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _SectionHeader(
          isExpanded: _isExpanded,
          count: suggestions?.length ?? 0,
          isRefreshing: isRefreshing,
          onTap: () => setState(() => _isExpanded = !_isExpanded),
        ),
        if (_isExpanded) ...[
          const SizedBox(height: 8),
          if (suggestions == null)
            suggestionsAsync.hasError
                ? _CompactErrorRow(
                    onRetry: () => ref.invalidate(recipeSuggestionsProvider),
                  )
                : const Padding(
                    padding: EdgeInsets.symmetric(vertical: 16),
                    child: Center(
                      child: SizedBox.square(
                        dimension: 20,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      ),
                    ),
                  )
          else if (suggestions.isEmpty)
            const _EmptySuggestions()
          else ...[
            for (final suggestion
                in _showAll
                    ? suggestions
                    : suggestions.take(_kInitialVisible)) ...[
              _SuggestionCard(
                suggestion: suggestion,
                enabled: !_pending,
                onAddToMeal: _addToMeal,
              ),
              const SizedBox(height: 8),
            ],
            if (suggestions.length > _kInitialVisible)
              TextButton(
                onPressed: () => setState(() => _showAll = !_showAll),
                style: TextButton.styleFrom(
                  minimumSize: const Size.fromHeight(44),
                  foregroundColor: IroriColors.textPrimary,
                ),
                child: Text(
                  _showAll
                      ? '閉じる'
                      : 'もっと見る（残り${suggestions.length - _kInitialVisible}件）',
                ),
              ),
          ],
        ],
      ],
    );
  }
}

/// セクションヘッダー (原典: chevron + Sparkles + ラベル + 件数 + スピナー)。
class _SectionHeader extends StatelessWidget {
  const _SectionHeader({
    required this.isExpanded,
    required this.count,
    required this.isRefreshing,
    required this.onTap,
  });

  final bool isExpanded;
  final int count;
  final bool isRefreshing;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(IroriRadii.button),
      child: ConstrainedBox(
        // 44px タッチターゲット (CLAUDE.md / 原典 min-h-11)。
        constraints: const BoxConstraints(minHeight: 44),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 8),
          child: Row(
            children: [
              Icon(
                isExpanded ? LucideIcons.chevronDown : LucideIcons.chevronRight,
                size: 16,
                color: IroriColors.textMuted,
              ),
              const SizedBox(width: 8),
              const Icon(
                LucideIcons.sparkles,
                size: 16,
                color: IroriColors.primary,
              ),
              const SizedBox(width: 8),
              const Text(
                'おすすめ献立',
                style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600),
              ),
              if (count > 0) ...[
                const SizedBox(width: 8),
                Text(
                  '$count件',
                  style: const TextStyle(
                    fontSize: 12,
                    color: IroriColors.textMuted,
                  ),
                ),
              ],
              if (isRefreshing) ...[
                const Spacer(),
                const SizedBox.square(
                  dimension: 14,
                  child: CircularProgressIndicator(
                    strokeWidth: 2,
                    color: IroriColors.textMuted,
                  ),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

/// 空状態 (原典の Lightbulb + 2 行コピー)。
class _EmptySuggestions extends StatelessWidget {
  const _EmptySuggestions();

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(24),
      decoration: BoxDecoration(
        // 原典 `bg-muted/30`。
        color: IroriColors.muted.withValues(alpha: 0.3),
        borderRadius: BorderRadius.circular(IroriRadii.card),
      ),
      child: Column(
        children: [
          Icon(
            LucideIcons.lightbulb,
            size: 32,
            color: IroriColors.textMuted.withValues(alpha: 0.4),
          ),
          const SizedBox(height: 8),
          const Text(
            'おすすめ献立がまだありません',
            style: TextStyle(fontSize: 14, color: IroriColors.textMuted),
          ),
          const SizedBox(height: 4),
          Text(
            '献立を作成してテンプレート保存すると、在庫に合った提案が表示されます',
            textAlign: TextAlign.center,
            style: TextStyle(
              fontSize: 12,
              color: IroriColors.textMuted.withValues(alpha: 0.7),
            ),
          ),
        ],
      ),
    );
  }
}

/// 初回 fetch 失敗のコンパクトな再試行行 (Flutter 固有 — クラス doc 参照)。
class _CompactErrorRow extends StatelessWidget {
  const _CompactErrorRow({required this.onRetry});

  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        const Icon(Icons.error_outline, size: 16, color: IroriColors.error),
        const SizedBox(width: 8),
        const Expanded(
          child: Text(
            'レシピ提案の取得に失敗しました',
            style: TextStyle(fontSize: 12, color: IroriColors.textMuted),
          ),
        ),
        TextButton(
          onPressed: onRetry,
          style: TextButton.styleFrom(
            minimumSize: const Size(44, 44),
            foregroundColor: IroriColors.textPrimary,
          ),
          child: const Text('再試行'),
        ),
      ],
    );
  }
}

/// 提案カード 1 枚 (原典 `suggestion-card.tsx`)。
class _SuggestionCard extends StatelessWidget {
  const _SuggestionCard({
    required this.suggestion,
    required this.enabled,
    required this.onAddToMeal,
  });

  final RecipeSuggestion suggestion;
  final bool enabled;
  final ValueChanged<RecipeSuggestion> onAddToMeal;

  @override
  Widget build(BuildContext context) {
    final matchPercent = matchPercentOf(suggestion);
    final badge = matchRateBadgeColors(matchPercent);

    return GlassCard(
      padding: const EdgeInsets.all(12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          // ヘッダー: タイトル + マッチ率 + 期限間近。
          Text(
            suggestion.title,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600),
          ),
          const SizedBox(height: 4),
          Wrap(
            spacing: 6,
            runSpacing: 4,
            children: [
              SuggestionPill(
                text: '$matchPercent%マッチ',
                background: badge.background,
                foreground: badge.foreground,
                fontWeight: FontWeight.w500,
              ),
              if (suggestion.hasExpiringStock)
                const SuggestionPill(
                  text: '期限間近',
                  background: _red100,
                  foreground: _red700,
                  fontWeight: FontWeight.w500,
                ),
            ],
          ),
          if (suggestion.matchedIngredients.isNotEmpty) ...[
            const SizedBox(height: 8),
            MatchedIngredientChips(matched: suggestion.matchedIngredients),
          ],
          if (suggestion.missingIngredients.isNotEmpty) ...[
            const SizedBox(height: 8),
            Wrap(
              spacing: 4,
              runSpacing: 4,
              crossAxisAlignment: WrapCrossAlignment.center,
              children: [
                const Text(
                  '不足:',
                  style: TextStyle(
                    fontSize: 12,
                    color: IroriColors.textMuted,
                  ),
                ),
                for (final ing in suggestion.missingIngredients)
                  SuggestionPill(
                    text: ing.name,
                    background: null,
                    foreground: IroriColors.textMuted,
                    dashedBorder: true,
                  ),
              ],
            ),
          ],
          const SizedBox(height: 12),
          OutlinedButton.icon(
            onPressed: enabled ? () => onAddToMeal(suggestion) : null,
            icon: const Icon(LucideIcons.plus, size: 14),
            label: const Text('献立に追加'),
            style: OutlinedButton.styleFrom(
              minimumSize: const Size.fromHeight(44),
              foregroundColor: IroriColors.textPrimary,
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(IroriRadii.button),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
