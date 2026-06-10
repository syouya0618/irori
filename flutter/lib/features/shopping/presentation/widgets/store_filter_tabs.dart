import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/domain/store_type.dart';
import '../../../../core/theme/colors.dart';
import '../../../../core/theme/radii.dart';

/// 店舗フィルタの選択状態 (null = 「全て」)。
///
/// web `shopping-list.tsx` の `storeFilter` state (`StoreType | "all"`) に
/// 相当する。Dart では sentinel 文字列 `"all"` の代わりに null を使う。
/// page (AppBar の件数表示) と body (一覧) の両方が参照するため、
/// `selectedWeekStartProvider` と同じ Notifier provider として持つ
/// (タブ切替で `ShoppingPage` が再構築されても選択を保持する —
/// `IndexedStack` のブランチ状態保持と整合)。
class ShoppingStoreFilterNotifier extends Notifier<StoreType?> {
  @override
  StoreType? build() => null;

  /// タブ選択 (null = 全て)。web `setStoreFilter` 相当。
  void select(StoreType? store) {
    state = store;
  }
}

/// 買い物リストの店舗フィルタ provider。
final shoppingStoreFilterProvider =
    NotifierProvider<ShoppingStoreFilterNotifier, StoreType?>(
      ShoppingStoreFilterNotifier.new,
    );

/// 店舗フィルタタブ。web `shopping-list.tsx` の `storeTabs`
/// (「全て」 + `allStores` 5 種) を移植。
///
/// web は shadcn Tabs (TabsList の横スクロール) で、TabsContent は全タブ
/// 同一中身 (フィルタで切替) のため、Flutter 版はタブバーのみ移植し
/// 一覧側が [shoppingStoreFilterProvider] でフィルタする。
class StoreFilterTabs extends ConsumerWidget {
  const StoreFilterTabs({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final selected = ref.watch(shoppingStoreFilterProvider);
    final notifier = ref.read(shoppingStoreFilterProvider.notifier);

    return Container(
      padding: const EdgeInsets.all(3),
      decoration: BoxDecoration(
        // shadcn TabsList の `bg-muted` 相当。
        color: IroriColors.muted,
        borderRadius: BorderRadius.circular(IroriRadii.button),
      ),
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        child: Row(
          children: [
            // web storeTabs: { value: "all", label: "全て" } が先頭。
            _StoreTab(
              label: '全て',
              isSelected: selected == null,
              onTap: () => notifier.select(null),
            ),
            for (final store in StoreType.displayOrder)
              _StoreTab(
                label: store.label,
                isSelected: selected == store,
                onTap: () => notifier.select(store),
              ),
          ],
        ),
      ),
    );
  }
}

/// タブ 1 つ。選択中は白背景 (shadcn TabsTrigger の `data-state=active` 相当)。
class _StoreTab extends StatelessWidget {
  const _StoreTab({
    required this.label,
    required this.isSelected,
    required this.onTap,
  });

  final String label;
  final bool isSelected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      selected: isSelected,
      child: TextButton(
        onPressed: onTap,
        style: TextButton.styleFrom(
          // 44px 最小タッチターゲット (CLAUDE.md)。
          minimumSize: const Size(44, 44),
          padding: const EdgeInsets.symmetric(horizontal: 12),
          backgroundColor: isSelected
              ? IroriColors.surface
              : Colors.transparent,
          foregroundColor: isSelected
              ? IroriColors.textPrimary
              : IroriColors.textMuted,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(IroriRadii.button - 2),
          ),
        ),
        child: Text(
          label,
          // web TabsTrigger の `text-xs`。
          style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600),
        ),
      ),
    );
  }
}
