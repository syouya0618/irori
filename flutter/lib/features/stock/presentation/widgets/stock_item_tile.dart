import 'dart:async';

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../../core/theme/colors.dart';
import '../../../../core/theme/radii.dart';
import '../../domain/stock_item.dart';
import '../stock_display_utils.dart';

/// 在庫アイテム 1 行。Next.js 原典 `stock-item.tsx` の Flutter 移植。
///
/// 表示: 名前 (truncate) + 数量+単位 (web `{quantity}{unit ? \` \${unit}\` : ""}`
/// の書式 — `num` ゆえ 1.5 は "1.5"、2 は "2") + 期限バッジ
/// ([stockExpiryBadge] — 期限切れ/今日まで=赤、3日以内=アンバー、
/// 7日以内=イエロー、それ以外=muted の M/D) + 残日数バッジ
/// ([stockRemainingDaysBadge] — 消費レートベース「あとN日分」、PR-G)。
/// バッジ順は web の DOM 順と同じ「期限 → 残日数」。
///
/// 操作:
/// - 行タップ → [onEdit] (親が編集 sheet を開く)
/// - カートボタン → [onAddToShopping] (買い物リストへ手動追加。web
///   `handleAddToShopping` 相当 — repository 呼び出しと toast は親に委譲)
/// - 削除はワンタップ確認方式 (web `confirmDelete` + 3 秒タイマーと同一):
///   1 回目のタップで destructive 表示に変わり、3 秒以内の 2 回目で
///   [onDelete] を呼ぶ。3 秒経過で自動解除。
///
/// 意図的差異 (PR 本文にも明記):
/// - カテゴリバッジは出さない (一覧側がカテゴリ見出しでグループ表示するため
///   モバイル幅では冗長 — web は見出し+バッジの二重表示)
/// - web のアクションボタンは hover 出現 (モバイル幅は常時表示) だが、
///   Flutter はタッチ前提のため常時表示
class StockItemTile extends StatefulWidget {
  const StockItemTile({
    required this.item,
    required this.todayYmd,
    required this.onEdit,
    required this.onDelete,
    this.dailyRate,
    this.onAddToShopping,
    super.key,
  });

  final StockItem item;

  /// 期限分類の基準日 "YYYY-MM-DD"。親が `formatJstDate()` を 1 回だけ
  /// 計算して配る (`stock_expiry.dart` の設計方針 — テスト容易性)。
  final String todayYmd;

  /// このアイテムのカテゴリの日次消費レート。web `StockItem` の
  /// `dailyRate` prop と同じ「親が rates map から引いて配る」分担。
  /// null はレート未対応カテゴリ / 算出不能で、残日数バッジ非表示。
  final num? dailyRate;

  /// 行タップ時 (編集 sheet を開く)。
  final ValueChanged<StockItem> onEdit;

  /// 削除確定時 (確認 2 タップ目) のみ呼ばれる。
  final ValueChanged<StockItem> onDelete;

  /// カートボタンのタップ時 (買い物リストへ追加)。null ならボタン非表示
  /// (既存呼び出し側・テストの後方互換のため optional)。
  final ValueChanged<StockItem>? onAddToShopping;

  @override
  State<StockItemTile> createState() => _StockItemTileState();
}

class _StockItemTileState extends State<StockItemTile> {
  bool _confirmDelete = false;
  Timer? _confirmTimer;

  @override
  void dispose() {
    _confirmTimer?.cancel();
    super.dispose();
  }

  void _handleDelete() {
    if (!_confirmDelete) {
      // 1 回目: 確認状態に入る。web と同じ 3 秒で自動解除。
      _confirmTimer?.cancel();
      setState(() => _confirmDelete = true);
      _confirmTimer = Timer(const Duration(seconds: 3), () {
        if (mounted) setState(() => _confirmDelete = false);
      });
      return;
    }

    // 2 回目: 確定。実行は親 (楽観更新 + repository 呼び出し) に委譲する。
    _confirmTimer?.cancel();
    setState(() => _confirmDelete = false);
    widget.onDelete(widget.item);
  }

  @override
  Widget build(BuildContext context) {
    final item = widget.item;
    final onAddToShopping = widget.onAddToShopping;
    final unit = item.unit;
    // web: `{item.quantity}{item.unit ? ` ${item.unit}` : ""}`
    final quantityLabel = (unit == null || unit.isEmpty)
        ? formatStockQuantity(item.quantity)
        : '${formatStockQuantity(item.quantity)} $unit';
    final badge = stockExpiryBadge(widget.todayYmd, item.expiresAt);
    final remainingBadge = stockRemainingDaysBadge(
      item.quantity,
      widget.dailyRate,
    );

    return ConstrainedBox(
      // 44px タッチターゲット (CLAUDE.md / 原典 `min-h-11`)。
      constraints: const BoxConstraints(minHeight: 44),
      child: Row(
        children: [
          Expanded(
            child: InkWell(
              onTap: () => widget.onEdit(item),
              child: Padding(
                padding: const EdgeInsets.fromLTRB(12, 8, 8, 8),
                child: Row(
                  children: [
                    Expanded(
                      child: Row(
                        children: [
                          Flexible(
                            child: Text(
                              item.name,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: const TextStyle(
                                fontSize: 14,
                                fontWeight: FontWeight.w500,
                                color: IroriColors.textPrimary,
                              ),
                            ),
                          ),
                          const SizedBox(width: 8),
                          Text(
                            quantityLabel,
                            style: const TextStyle(
                              fontSize: 12,
                              color: IroriColors.textMuted,
                            ),
                          ),
                        ],
                      ),
                    ),
                    if (badge != null) ...[
                      const SizedBox(width: 8),
                      _BadgePill(
                        badge: badge,
                        badgeKey: const Key('stockExpiryBadge'),
                      ),
                    ],
                    // 残日数バッジ (消費ペースベース) — web の DOM 順どおり
                    // 期限バッジの後。
                    if (remainingBadge != null) ...[
                      const SizedBox(width: 8),
                      _BadgePill(
                        badge: remainingBadge,
                        badgeKey: const Key('stockRemainingDaysBadge'),
                      ),
                    ],
                  ],
                ),
              ),
            ),
          ),
          // 買い物リストに追加 (web: ShoppingCart ghost ボタン)。
          if (onAddToShopping != null)
            IconButton(
              onPressed: () => onAddToShopping(item),
              icon: const Icon(LucideIcons.shoppingCart, size: 16),
              // web の aria-label と同文言。
              tooltip: '${item.name}を買い物リストに追加',
              style: IconButton.styleFrom(
                foregroundColor: IroriColors.textMuted,
              ),
              // 44x44 の最小タッチ領域 (CLAUDE.md)。
              constraints: const BoxConstraints(minWidth: 44, minHeight: 44),
              padding: EdgeInsets.zero,
            ),
          // 削除 (web: ghost → confirm で destructive)。
          IconButton(
            onPressed: _handleDelete,
            icon: const Icon(LucideIcons.trash2, size: 16),
            tooltip: _confirmDelete ? '${item.name}を削除（確認）' : '${item.name}を削除',
            style: _confirmDelete
                ? IconButton.styleFrom(
                    backgroundColor: IroriColors.error,
                    foregroundColor: Colors.white,
                  )
                : IconButton.styleFrom(foregroundColor: IroriColors.textMuted),
            // 44x44 の最小タッチ領域 (CLAUDE.md)。
            constraints: const BoxConstraints(minWidth: 44, minHeight: 44),
            padding: EdgeInsets.zero,
          ),
          const SizedBox(width: 4),
        ],
      ),
    );
  }
}

/// バッジ pill (web: `rounded-full px-2 py-0.5 text-xs font-medium`)。
/// 期限バッジ・残日数バッジで共用 (旧 `_ExpiryBadge` — PR-G で key を
/// パラメータ化。同一 Row 内に 2 個並ぶため固定 key だと duplicate key に
/// なる)。`background` null (normal) は pill 背景なしのプレーン表示。
class _BadgePill extends StatelessWidget {
  const _BadgePill({required this.badge, required this.badgeKey});

  final StockExpiryBadge badge;

  /// テスト識別用の key (`stockExpiryBadge` / `stockRemainingDaysBadge`)。
  final Key badgeKey;

  @override
  Widget build(BuildContext context) {
    return Container(
      key: badgeKey,
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      decoration: badge.background == null
          ? null
          : BoxDecoration(
              color: badge.background,
              borderRadius: BorderRadius.circular(IroriRadii.pill),
            ),
      child: Text(
        badge.label,
        style: TextStyle(
          fontSize: 12,
          fontWeight: FontWeight.w500,
          color: badge.foreground,
        ),
      ),
    );
  }
}
