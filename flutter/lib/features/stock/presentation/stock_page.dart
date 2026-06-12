import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../core/domain/item_category.dart';
import '../../../core/theme/colors.dart';
import '../../../core/theme/radii.dart';
import '../../../core/utils/jst_date.dart';
import '../../../widgets/category_icon.dart';
import '../../../widgets/glass_card.dart';
import '../data/consumption_rates_provider.dart';
import '../data/low_stock_check_store.dart';
import '../data/stock_items_notifier.dart';
import '../data/stock_repository.dart';
import '../domain/stock_item.dart';
import 'stock_display_utils.dart';
import 'widgets/stock_form_sheet.dart';
import 'widgets/stock_item_tile.dart';
import 'widgets/stock_suggestions_section.dart';

// Tailwind palette (web `stock-list.tsx` 期限間近バナーの配色トーン)。
const _amberBannerBg = Color(0xFFFFFBEB); // amber-50
const _amberBannerFg = Color(0xFFB45309); // amber-700

/// 在庫一覧。Next.js 原典 `stock-list.tsx` (+ `stock/page.tsx`) の表示側を
/// 移植。
///
/// 表示構成 (縦): 期限間近バナー (対象 0 件なら非表示) → おすすめ献立
/// section (P2.5-F、web `stock-list.tsx:191-205` と同じ並び) → カテゴリ別
/// グループ (見出し: アイコン + ラベル + 件数 / 中身: glass カードに
/// 区切り線付きの行)。AppBar に「在庫」+ 件数 + 追加ボタン。
///
/// データ:
/// - `stockItemsNotifierProvider` を `.when(data/loading/error)` で消費
///   (`.future` は await しない — notifier の doc コメント参照)。
/// - 書き込みは sheet (`showStockFormSheet`) → `StockRepository`。一覧反映は
///   F5 realtime reducer 任せ。削除のみ web `handleOptimisticDelete` と同じ
///   楽観更新で即時除外し、失敗時は invalidate でサーバ実体へ復元する。
/// - レシピ提案は `recipeSuggestionsProvider` (在庫 realtime 変化に 1000ms
///   デバウンスで追従) — `StockSuggestionsSection` が消費する。
/// - 残日数バッジは `consumptionRatesProvider` (PR-G)。loading / error 中は
///   バッジ非表示に degrade する (web も rates 取得失敗時は `rates: {}` で
///   バッジ無し表示 — 同じ縮退)。
/// - 低在庫自動追加 (PR-G) は data 初回到達時 (`_StockBody.initState`) に
///   `LowStockAutoAddRunner` 経由で 1 回だけ発火 (30 分スロットル付き)。
///   web は mount ごと発火だが、Flutter のタブは IndexedStack で生存し続ける
///   ため「初回 build のみ」(裁定済み — PR 本文参照)。
class StockPage extends ConsumerWidget {
  const StockPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final itemsAsync = ref.watch(stockItemsNotifierProvider);
    // reload 中は直前データの件数を保つ (AsyncValue.value は前回値を返す)。
    // 初回 loading / error 中は件数を出さない (web は SSR 初期値があるため常時
    // 表示だが、Flutter は data 到着までヘッダーをタイトルのみにする)。
    final count = itemsAsync.value?.length;

    return Scaffold(
      appBar: AppBar(
        // web ヘッダー: h1「在庫」+ 件数 (text-sm text-muted-foreground)。
        title: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Text('在庫'),
            if (count != null) ...[
              const SizedBox(width: 8),
              Text(
                '$count件',
                style: const TextStyle(
                  fontSize: 14,
                  fontWeight: FontWeight.normal,
                  color: IroriColors.textMuted,
                ),
              ),
            ],
          ],
        ),
        actions: [
          Padding(
            padding: const EdgeInsets.only(right: 16),
            child: FilledButton.icon(
              onPressed: () => showStockFormSheet(context, ref),
              icon: const Icon(LucideIcons.plus, size: 16),
              label: const Text('追加'),
              style: FilledButton.styleFrom(
                // 44px タッチターゲット (CLAUDE.md — web の size sm より大きい)。
                minimumSize: const Size(44, 44),
                padding: const EdgeInsets.symmetric(horizontal: 12),
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(IroriRadii.button),
                ),
              ),
            ),
          ),
        ],
      ),
      body: SafeArea(
        child: itemsAsync.when(
          skipLoadingOnReload: true,
          data: (items) => _StockBody(items: items),
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

/// data 分岐の本体。バナー + カテゴリ別グループ or 空状態。
///
/// `ConsumerStatefulWidget` なのは低在庫自動追加の発火点 (initState) を
/// 持つため。data 更新 (realtime 反映等) では同型 widget の再 build に
/// なるため initState は走り直さない = 「data 初回到達時に 1 回だけ」。
class _StockBody extends ConsumerStatefulWidget {
  const _StockBody({required this.items});

  final List<StockItem> items;

  @override
  ConsumerState<_StockBody> createState() => _StockBodyState();
}

class _StockBodyState extends ConsumerState<_StockBody> {
  @override
  void initState() {
    super.initState();
    // 低在庫自動チェック (web stock-list.tsx:117-133 の useEffect [] 相当)。
    // initState 中は provider 変更や SnackBar が安全でないため frame 後に回す。
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _runLowStockAutoAdd();
    });
  }

  /// 低在庫の自動追加を 30 分スロットル付きで実行し、追加があれば toast。
  ///
  /// best-effort 機能のため、いかなる失敗 (未認証 / store 不調 等) も
  /// ページ表示には影響させない — 構造化ログのみ (web も
  /// `if (result.error) return` で無通知)。
  Future<void> _runLowStockAutoAdd() async {
    if (!mounted) return;
    final messenger = ScaffoldMessenger.of(context);

    try {
      final result = await ref.read(lowStockAutoAddRunnerProvider).runIfDue();
      // null = スロットル内 skip。error 非 null は web 同様無通知
      // (タイムスタンプ未記録で次回再試行 — runner doc 参照)。
      if (!mounted || result == null || result.error != null) return;
      if (result.addedItems.isEmpty) return;

      // web stock-list.tsx:127-130 の toast.success(message, {description})。
      messenger.showSnackBar(
        SnackBar(
          content: Text(
            '在庫が少ない${result.addedItems.length}件を買い物リストに追加しました\n'
            '${result.addedItems.join('、')}',
          ),
        ),
      );
    } on Object catch (e, st) {
      // 握り潰さない (CLAUDE.md)。repository / runner 側でも構造化ログ済み。
      debugPrint('StockPage lowStockAutoAdd 失敗: $e\n$st');
    }
  }

  @override
  Widget build(BuildContext context) {
    final items = widget.items;
    final todayYmd = formatJstDate();
    final grouped = groupStockItems(items);
    final expiringCount = countExpiringStockItems(todayYmd, items);
    // 残日数バッジ用の消費レート (web page.tsx は SSR で常時渡すが、
    // Flutter は loading / error 中 null → バッジ非表示に degrade)。
    final rates = ref.watch(consumptionRatesProvider).value;

    // 原典の空状態 (`grouped.length === 0`)。web はこの場合も提案 section を
    // 上に出す (stock-list.tsx:202-205 — section 自身が空コピーを表示する)。
    if (grouped.isEmpty) {
      return ListView(
        padding: const EdgeInsets.fromLTRB(16, 16, 16, 32),
        children: [
          const StockSuggestionsSection(),
          // 原典 `min-h-[40dvh]` の中央寄せブロック相当。
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 48),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const Icon(
                  LucideIcons.package,
                  size: 48,
                  // 原典 `text-muted-foreground/30`。
                  color: Color(0x4D475569),
                ),
                const SizedBox(height: 12),
                const Text(
                  '在庫が登録されていません',
                  style: TextStyle(fontSize: 14, color: IroriColors.textMuted),
                ),
                const SizedBox(height: 12),
                OutlinedButton.icon(
                  onPressed: () => showStockFormSheet(context, ref),
                  icon: const Icon(LucideIcons.plus, size: 16),
                  label: const Text('最初のアイテムを追加'),
                  style: OutlinedButton.styleFrom(
                    minimumSize: const Size(44, 44),
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(IroriRadii.button),
                    ),
                  ),
                ),
              ],
            ),
          ),
        ],
      );
    }

    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 32),
      children: [
        // 期限切れアラート (原典: `expiringCount > 0` のときだけ表示)。
        if (expiringCount > 0)
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
            decoration: BoxDecoration(
              color: _amberBannerBg,
              borderRadius: BorderRadius.circular(IroriRadii.button),
            ),
            child: Row(
              children: [
                const Icon(
                  LucideIcons.triangleAlert,
                  size: 16,
                  color: _amberBannerFg,
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    '$expiringCount件のアイテムが期限切れ間近です',
                    style: const TextStyle(
                      fontSize: 14,
                      color: _amberBannerFg,
                    ),
                  ),
                ),
              ],
            ),
          ),
        // おすすめ献立 section (web stock-list.tsx:202-205 — バナーの下、
        // アイテム一覧の上)。
        if (expiringCount > 0) const SizedBox(height: 12),
        const StockSuggestionsSection(),
        for (final (category, categoryItems) in grouped) ...[
          _CategoryHeader(category: category, count: categoryItems.length),
          GlassCard(
            padding: EdgeInsets.zero,
            child: Column(
              children: [
                for (var i = 0; i < categoryItems.length; i++) ...[
                  // 原典 `divide-y divide-border/30`。
                  if (i > 0)
                    Divider(
                      height: 1,
                      thickness: 1,
                      color: IroriColors.border.withValues(alpha: 0.3),
                    ),
                  StockItemTile(
                    item: categoryItems[i],
                    todayYmd: todayYmd,
                    // web: `dailyRate={consumptionRates[item.category] ?? null}`
                    dailyRate: rates?[categoryItems[i].category],
                    onEdit: (item) =>
                        showStockFormSheet(context, ref, existing: item),
                    onDelete: (item) => _deleteItem(context, ref, item),
                    onAddToShopping: (item) =>
                        _addToShoppingList(context, ref, item),
                  ),
                ],
              ],
            ),
          ),
        ],
      ],
    );
  }

  /// 削除の実行。web `stock-item.tsx` `handleDelete` (確認後) と同じ流れ:
  /// 1. 楽観更新で一覧から即時除外 (web `onOptimisticDelete`)
  /// 2. repository へ delete (成功時の他クライアント反映は realtime DELETE)
  /// 3. 失敗時は文言表示 (web toast と同一) — web は rollback しないが、
  ///    Flutter は invalidate の refetch でサーバ実体へ復元する
  ///    (楽観削除しっぱなしで実データと乖離させない)。
  Future<void> _deleteItem(
    BuildContext context,
    WidgetRef ref,
    StockItem item,
  ) async {
    final messenger = ScaffoldMessenger.of(context);

    ref.read(stockItemsNotifierProvider.notifier).removeItemOptimistic(item.id);

    try {
      final ctx = await ref.read(stockMutationContextProvider.future);
      await ref
          .read(stockRepositoryProvider)
          .deleteItem(householdId: ctx.householdId, itemId: item.id);
    } on Object catch (e, st) {
      // 握り潰さない (CLAUDE.md)。repository 側でも構造化ログ済み。
      debugPrint('StockPage deleteItem 失敗: $e\n$st');
      ref.invalidate(stockItemsNotifierProvider);
      messenger.showSnackBar(const SnackBar(content: Text('削除に失敗しました')));
    }
  }

  /// 買い物リストへの手動追加。web `stock-item.tsx` `handleAddToShopping`:
  /// - 成功: 「{name}を買い物リストに追加しました」(web :120)
  /// - 重複: 「既に買い物リストにあります」(repository の型付き例外 →
  ///   web は action の error 文字列)
  /// - その他失敗: 「買い物リストへの追加に失敗しました」— web は fetch 失敗
  ///   (「在庫アイテムが見つかりません」) と insert 失敗で文言が分かれるが、
  ///   Flutter は generic catch で後者に縮退する (意図的差異 — PR 本文)。
  ///
  /// 一覧への反映は web の revalidatePath 相当が realtime reducer
  /// (shopping タブ側) のため、ここでは何もしない。
  Future<void> _addToShoppingList(
    BuildContext context,
    WidgetRef ref,
    StockItem item,
  ) async {
    final messenger = ScaffoldMessenger.of(context);

    try {
      final ctx = await ref.read(stockMutationContextProvider.future);
      await ref
          .read(stockRepositoryProvider)
          .addToShoppingList(
            householdId: ctx.householdId,
            userId: ctx.userId,
            itemId: item.id,
          );
      messenger.showSnackBar(
        SnackBar(content: Text('${item.name}を買い物リストに追加しました')),
      );
    } on DuplicateShoppingItemException {
      messenger.showSnackBar(
        const SnackBar(content: Text(DuplicateShoppingItemException.message)),
      );
    } on Object catch (e, st) {
      // 握り潰さない (CLAUDE.md)。repository 側でも構造化ログ済み。
      debugPrint('StockPage addToShoppingList 失敗: $e\n$st');
      messenger.showSnackBar(
        const SnackBar(content: Text('買い物リストへの追加に失敗しました')),
      );
    }
  }
}

/// カテゴリ見出し (原典: アイコン 14px + ラベル + 件数、muted)。
class _CategoryHeader extends StatelessWidget {
  const _CategoryHeader({required this.category, required this.count});

  final ItemCategory category;
  final int count;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(4, 12, 4, 4),
      child: Row(
        children: [
          Icon(categoryIcon(category), size: 14, color: IroriColors.textMuted),
          const SizedBox(width: 8),
          Text(
            category.label,
            style: const TextStyle(
              fontSize: 12,
              fontWeight: FontWeight.w600,
              color: IroriColors.textMuted,
            ),
          ),
          const SizedBox(width: 8),
          Text(
            '$count',
            style: const TextStyle(
              fontSize: 12,
              color: IroriColors.textMuted,
            ),
          ),
        ],
      ),
    );
  }
}

/// error 分岐。読み込み失敗の告知 + 再試行ボタン (meals `_ErrorView` と同形)。
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
            '在庫の読み込みに失敗しました。',
            style: Theme.of(context).textTheme.bodyLarge,
          ),
          const SizedBox(height: 8),
          Text('$error', style: Theme.of(context).textTheme.bodySmall),
          const SizedBox(height: 16),
          FilledButton.tonal(
            onPressed: () => ref.invalidate(stockItemsNotifierProvider),
            style: FilledButton.styleFrom(
              minimumSize: const Size(44, 44),
            ),
            child: const Text('再試行'),
          ),
        ],
      ),
    );
  }
}
