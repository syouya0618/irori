import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../core/domain/item_category.dart';
import '../../../core/domain/store_type.dart';
import '../../../core/theme/colors.dart';
import '../../../core/theme/radii.dart';
import '../../../widgets/glass_card.dart';
import '../data/household_members_provider.dart';
import '../data/shopping_items_notifier.dart';
import '../domain/shopping_item.dart';
import 'widgets/add_item_form.dart';
import 'widgets/clear_checked_dialog.dart';
import 'widgets/generate_from_meals_dialog.dart';
import 'widgets/shopping_category_group.dart';
import 'widgets/store_filter_tabs.dart';

/// 買い物リスト画面。Next.js 原典 `shopping/page.tsx` + `shopping-list.tsx`
/// の表示側を移植。
///
/// 表示構成 (縦): 追加フォーム → 店舗フィルタタブ → (空状態) →
/// カテゴリ別グループ (未チェック) → チェック済み折りたたみ →
/// アクション行 (献立から追加 / チェック済みクリア)。
///
/// データ:
/// - `shoppingItemsNotifierProvider` を `.when(data/loading/error)` で消費
///   (`.future` は await しない — notifier の doc コメント参照)。reload 中は
///   `skipLoadingOnReload: true` で前データを保持 (meals / baby と同じ流儀)。
/// - 店舗フィルタは `shoppingStoreFilterProvider` (null = 全て)。
/// - チェック者名は `householdMembersProvider` (web の memberMap)。
/// - 書き込みは各 widget → `ShoppingRepository`。一覧反映は realtime
///   reducer に任せ、自分の操作は widget 局所の楽観更新 (tile / form 参照)。
class ShoppingPage extends ConsumerWidget {
  const ShoppingPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final itemsAsync = ref.watch(shoppingItemsNotifierProvider);
    final storeFilter = ref.watch(shoppingStoreFilterProvider);

    // 件数表示 (web ヘッダー「残り N / M 件」— 店舗フィルタ適用後)。
    // データ未到達 (初回 loading / error) の間は出さない。
    String? countLabel;
    final loadedItems = itemsAsync.value;
    if (loadedItems != null) {
      final filtered = _applyStoreFilter(loadedItems, storeFilter);
      final remaining = filtered.where((i) => !i.isChecked).length;
      countLabel = '残り $remaining / ${filtered.length} 件';
    }

    return Scaffold(
      appBar: AppBar(
        title: const Text('買い物リスト'),
        actions: [
          if (countLabel != null)
            Padding(
              padding: const EdgeInsets.only(right: 16),
              child: Center(
                child: Text(
                  countLabel,
                  style: const TextStyle(
                    fontSize: 13,
                    color: IroriColors.textMuted,
                  ),
                ),
              ),
            ),
        ],
      ),
      body: SafeArea(
        child: itemsAsync.when(
          skipLoadingOnReload: true,
          data: (items) => _ShoppingBody(items: items),
          loading: () => const Center(child: CircularProgressIndicator()),
          error: (error, _) => Center(
            child: Padding(
              padding: const EdgeInsets.all(24),
              child: _ErrorView(error: error),
            ),
          ),
        ),
      ),
    );
  }
}

/// data 分岐の本体。フィルタ・グループ化は web `shopping-list.tsx` の
/// useMemo 群 (`filteredItems` / `uncheckedItems` / `checkedItems` /
/// `groupedUnchecked`) と同一セマンティクス。
class _ShoppingBody extends ConsumerWidget {
  const _ShoppingBody({required this.items});

  final List<ShoppingItem> items;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final storeFilter = ref.watch(shoppingStoreFilterProvider);

    // チェック者の表示名 map (web の memberMap)。解決前 (loading window) と
    // 取得失敗時は空 map で縮退 — web も members 取得失敗時は空配列で描画継続
    // (provider 側で構造化ログ済み)。
    final members =
        ref.watch(householdMembersProvider).value ?? const <HouseholdMember>[];
    final memberNames = {for (final m in members) m.id: m.displayName};

    final filtered = _applyStoreFilter(items, storeFilter);
    final unchecked = [
      for (final i in filtered)
        if (!i.isChecked) i,
    ];
    // チェック済みは checked_at 降順 (web の localeCompare 降順 — null 末尾)。
    final checked = [
      for (final i in filtered)
        if (i.isChecked) i,
    ]..sort(_compareCheckedAtDesc);

    // カテゴリーごとにグループ化 (F0 displayOrder 順・グループ内 sort_order
    // 昇順 — web `groupedUnchecked`)。
    final byCategory = <ItemCategory, List<ShoppingItem>>{};
    for (final item in unchecked) {
      byCategory.putIfAbsent(item.category, () => []).add(item);
    }
    final grouped = <(ItemCategory, List<ShoppingItem>)>[];
    for (final category in ItemCategory.displayOrder) {
      final list = byCategory[category];
      if (list == null) continue;
      list.sort((a, b) => a.sortOrder.compareTo(b.sortOrder));
      grouped.add((category, list));
    }

    // ListView (lazy) ではなく SingleChildScrollView を使う: チェック済み
    // 折りたたみ (_CheckedSection) とタイルの楽観 state がビューポート外への
    // スクロールで破棄されないようにする (web は全 DOM を保持するため同挙動。
    // 買い物リストは世帯規模で件数が小さく、非 lazy でも frame budget 内)。
    return SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 32),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const AddItemForm(),
          const SizedBox(height: 12),
          const StoreFilterTabs(),
          if (unchecked.isEmpty && checked.isEmpty)
            // 原典 `min-h-[30dvh]` の中央寄せ空状態。
            const SizedBox(
              height: 240,
              child: Center(
                child: Text(
                  'アイテムがありません',
                  style: TextStyle(fontSize: 13, color: IroriColors.textMuted),
                ),
              ),
            )
          else ...[
            if (unchecked.isEmpty)
              // 全件チェック済み (原典 `min-h-20`)。
              const SizedBox(
                height: 80,
                child: Center(
                  child: Text(
                    '全てチェック済みです',
                    style: TextStyle(
                      fontSize: 13,
                      color: IroriColors.textMuted,
                    ),
                  ),
                ),
              ),
            for (final (category, categoryItems) in grouped)
              ShoppingCategoryGroup(
                category: category,
                items: categoryItems,
                memberNames: memberNames,
              ),
            if (checked.isNotEmpty) ...[
              const SizedBox(height: 16),
              _CheckedSection(items: checked, memberNames: memberNames),
            ],
          ],
          const SizedBox(height: 16),
          // アクション行 (原典 shopping-list.tsx:347-349 の
          // `flex items-center gap-2` — 両ボタン flex-1 の横並び)。
          Row(
            children: [
              // 献立から追加 (原典 GenerateFromMeals の trigger。disabled
              // 条件なし — 0 件判定はダイアログ内の preview が担う)。
              Expanded(
                child: OutlinedButton.icon(
                  onPressed: () => showGenerateFromMealsDialog(context, ref),
                  icon: const Icon(LucideIcons.calendarDays, size: 16),
                  label: const Text('献立から追加'),
                  style: OutlinedButton.styleFrom(
                    minimumSize: const Size.fromHeight(44),
                    foregroundColor: IroriColors.textPrimary,
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(IroriRadii.button),
                    ),
                  ),
                ),
              ),
              const SizedBox(width: 8),
              // チェック済みクリア (原典の Dialog trigger ボタン。disabled
              // 条件も同一: 表示中のチェック済みが 0 件なら押せない)。
              Expanded(
                child: OutlinedButton.icon(
                  onPressed: checked.isEmpty
                      ? null
                      : () => showClearCheckedDialog(
                          context,
                          ref,
                          checkedCount: checked.length,
                        ),
                  icon: const Icon(LucideIcons.trash2, size: 16),
                  label: const Text('チェック済みを削除'),
                  style: OutlinedButton.styleFrom(
                    minimumSize: const Size.fromHeight(44),
                    foregroundColor: IroriColors.textPrimary,
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(IroriRadii.button),
                    ),
                  ),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

/// チェック済みセクション (折りたたみ)。原典 `shopping-list.tsx` の
/// `checkedExpanded` ブロックを移植 (初期状態は折りたたみ)。
class _CheckedSection extends StatefulWidget {
  const _CheckedSection({required this.items, required this.memberNames});

  /// チェック済みアイテム (checked_at 降順 sort 済み)。
  final List<ShoppingItem> items;

  final Map<String, String> memberNames;

  @override
  State<_CheckedSection> createState() => _CheckedSectionState();
}

class _CheckedSectionState extends State<_CheckedSection> {
  bool _expanded = false;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        TextButton.icon(
          onPressed: () => setState(() => _expanded = !_expanded),
          icon: Icon(
            _expanded ? LucideIcons.chevronDown : LucideIcons.chevronRight,
            size: 16,
          ),
          label: Text('チェック済み (${widget.items.length}件)'),
          style: TextButton.styleFrom(
            minimumSize: const Size.fromHeight(44),
            alignment: Alignment.centerLeft,
            foregroundColor: IroriColors.textMuted,
            textStyle: const TextStyle(
              fontSize: 14,
              fontWeight: FontWeight.w500,
            ),
          ),
        ),
        if (_expanded) ...[
          const SizedBox(height: 4),
          GlassCard(
            padding: const EdgeInsets.symmetric(vertical: 4),
            child: ShoppingTileList(
              items: widget.items,
              memberNames: widget.memberNames,
            ),
          ),
        ],
      ],
    );
  }
}

/// error 分岐。読み込み失敗の告知 + 再試行 (meals `_ErrorView` と同形)。
class _ErrorView extends ConsumerWidget {
  const _ErrorView({required this.error});

  final Object error;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return GlassCard(
      padding: const EdgeInsets.all(24),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Icon(Icons.error_outline, color: IroriColors.error),
          const SizedBox(height: 12),
          Text(
            '買い物リストの読み込みに失敗しました。',
            style: Theme.of(context).textTheme.bodyLarge,
          ),
          const SizedBox(height: 8),
          Text('$error', style: Theme.of(context).textTheme.bodySmall),
          const SizedBox(height: 16),
          FilledButton.tonal(
            onPressed: () => ref.invalidate(shoppingItemsNotifierProvider),
            style: FilledButton.styleFrom(minimumSize: const Size(44, 44)),
            child: const Text('再試行'),
          ),
        ],
      ),
    );
  }
}

/// 店舗フィルタを適用 (web `filteredItems` useMemo)。null = 全て。
List<ShoppingItem> _applyStoreFilter(
  List<ShoppingItem> items,
  StoreType? filter,
) {
  if (filter == null) return items;
  return [
    for (final item in items)
      if (item.storeType == filter) item,
  ];
}

/// チェック済みの表示順: `checked_at` 降順。web の
/// `(b.checked_at ?? "").localeCompare(a.checked_at ?? "")` と同一
/// セマンティクス (null は空文字扱い = 降順の末尾)。
int _compareCheckedAtDesc(ShoppingItem a, ShoppingItem b) {
  final aAt = a.checkedAt;
  final bAt = b.checkedAt;
  if (aAt == null && bAt == null) return 0;
  if (aAt == null) return 1;
  if (bAt == null) return -1;
  return bAt.compareTo(aAt);
}
