import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../../core/domain/item_category.dart';
import '../../../../core/theme/colors.dart';
import '../../../../core/theme/radii.dart';
import '../../../../widgets/glass_card.dart';
import '../../data/settings_repository.dart';

/// トグル可能なカテゴリ (web `AUTO_STOCK_OPTIONS` と同一の 4 値 + 表示順)。
/// ラベルは `ItemCategory.label` (web `getCategoryLabel` と一致)。
const _kAutoStockOptions = [
  ItemCategory.baby,
  ItemCategory.cleaning,
  ItemCategory.hygiene,
  ItemCategory.otherDaily,
];

/// 在庫自動追加カード。Next.js 原典 `auto-stock-card.tsx` の Flutter 移植。
///
/// 楽観更新 + 失敗ロールバック (原典 `handleToggle` / :43-51 の流儀):
/// タップで即時にトグルを反映し、失敗時は `initialCategories` prop へ
/// 巻き戻す (web の `setSelected(new Set(initialCategories))` 対応 —
/// 直前状態ではなく props 由来の値へ戻る quirk ごと移植する)。
/// didUpdateWidget 再同期により props は「直近に観測したサーバ値」を指す
/// ため、rollback 先は web の「mount 時 props」より stale が縮小する
/// (意図的差異)。
///
/// タブ再表示 refetch (`AppShell` のタップ契機 invalidate) の新 props は
/// [didUpdateWidget] で再同期する — IndexedStack で State が dispose され
/// ないため、initState だけでは相方の変更がアプリ再起動まで見えず、全量
/// 配列 PUT ゆえ lost-update の窓も広がる。保存中 (`_pending`) は楽観
/// 選択を優先する。
///
/// 選択値は DB 文字列 (`Set<String>`) のまま保持する。enum 経由にすると
/// DB 上の未知値が黙って書き換わり、web (string[] を素通し) と乖離するため
/// (`HouseholdSettings.autoStockCategories` の doc 参照)。
class AutoStockCategoriesCard extends ConsumerStatefulWidget {
  const AutoStockCategoriesCard({required this.initialCategories, super.key});

  final List<String> initialCategories;

  @override
  ConsumerState<AutoStockCategoriesCard> createState() =>
      _AutoStockCategoriesCardState();
}

class _AutoStockCategoriesCardState
    extends ConsumerState<AutoStockCategoriesCard> {
  late Set<String> _selected;
  bool _pending = false;

  @override
  void initState() {
    super.initState();
    _selected = Set.of(widget.initialCategories);
  }

  @override
  void didUpdateWidget(AutoStockCategoriesCard oldWidget) {
    super.didUpdateWidget(oldWidget);
    // タブ再表示 refetch の新 props を反映する (クラス doc 参照)。比較は
    // 内容ベース (listEquals) — refetch は毎回新 List インスタンスを返す
    // ため、同一内容の identity 差で「保存成功直後の楽観値」を stale な
    // 並走 fetch 結果で巻き戻さない。保存応答待ちの間も上書きしない。
    if (!_pending &&
        !listEquals(widget.initialCategories, oldWidget.initialCategories)) {
      _selected = Set.of(widget.initialCategories);
    }
  }

  Future<void> _toggle(String category) async {
    if (_pending) return;

    final messenger = ScaffoldMessenger.of(context);
    // web: `const next = new Set(selected)` → toggle → 楽観反映。
    // Dart の Set リテラル/Set.of は挿入順保持 (LinkedHashSet) のため、
    // `toList()` の並びも web の `[...next]` (挿入順) と一致する。
    final next = Set.of(_selected);
    if (!next.add(category)) {
      next.remove(category);
    }
    setState(() {
      _selected = next;
      _pending = true;
    });

    try {
      final ctx = await ref.read(settingsMutationContextProvider.future);
      await ref
          .read(settingsRepositoryProvider)
          .updateAutoStockCategories(
            householdId: ctx.householdId,
            categories: next.toList(),
          );
      // 成功時は無通知 (web も toast 無し)。
    } on Object catch (e, st) {
      // 握り潰さない (CLAUDE.md)。repository 側でも構造化ログ済み。
      debugPrint(
        'AutoStockCategoriesCard updateAutoStockCategories 失敗: $e\n$st',
      );
      if (!mounted) return;
      // web: toast.error + setSelected(new Set(initialCategories))。
      setState(() => _selected = Set.of(widget.initialCategories));
      final message = e is ArgumentError ? e.message : null;
      messenger.showSnackBar(
        SnackBar(
          content: Text(
            message is String && message.isNotEmpty ? message : '設定の更新に失敗しました',
          ),
        ),
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
              Icon(
                LucideIcons.package,
                size: 18,
                color: IroriColors.textPrimary,
              ),
              SizedBox(width: 8),
              Text(
                '在庫自動追加',
                style: TextStyle(
                  fontSize: 16,
                  fontWeight: FontWeight.w600,
                  color: IroriColors.textPrimary,
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          const Text(
            '買い物リストでチェックした時に、以下のカテゴリは在庫に自動追加されます。'
            '残日数の自動計算は育児ログ連動のベビー用品のみ対応しています。',
            style: TextStyle(fontSize: 12, color: IroriColors.textMuted),
          ),
          const SizedBox(height: 12),
          // 原典: `grid grid-cols-2 gap-2` (4 値固定の 2x2)。
          for (var row = 0; row < _kAutoStockOptions.length; row += 2) ...[
            if (row > 0) const SizedBox(height: 8),
            Row(
              children: [
                Expanded(child: _buildChip(_kAutoStockOptions[row])),
                const SizedBox(width: 8),
                Expanded(child: _buildChip(_kAutoStockOptions[row + 1])),
              ],
            ),
          ],
        ],
      ),
    );
  }

  Widget _buildChip(ItemCategory category) {
    final active = _selected.contains(category.dbValue);
    return InkWell(
      onTap: _pending ? null : () => _toggle(category.dbValue),
      borderRadius: BorderRadius.circular(IroriRadii.button),
      child: Container(
        // 原典 `min-h-11` = 44px タッチターゲット。
        constraints: const BoxConstraints(minHeight: 44),
        alignment: Alignment.center,
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        decoration: BoxDecoration(
          // 原典: ON = bg-primary/10 + ring-primary/20、OFF = bg-muted/50。
          color: active
              ? IroriColors.primary.withValues(alpha: 0.1)
              : IroriColors.muted.withValues(alpha: 0.5),
          borderRadius: BorderRadius.circular(IroriRadii.button),
          border: active
              ? Border.all(color: IroriColors.primary.withValues(alpha: 0.2))
              : null,
        ),
        child: Text(
          category.label,
          style: TextStyle(
            fontSize: 14,
            fontWeight: FontWeight.w500,
            color: active ? IroriColors.primary : IroriColors.textMuted,
          ),
        ),
      ),
    );
  }
}
