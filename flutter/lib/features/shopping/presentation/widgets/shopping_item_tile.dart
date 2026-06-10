import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../../core/domain/item_category.dart';
import '../../../../core/theme/colors.dart';
import '../../../../core/theme/radii.dart';
import '../../data/shopping_repository.dart';
import '../../domain/shopping_item.dart';

/// 削除確認の自動解除までの時間 (原典 `shopping-item.tsx` の 3000ms と同一)。
const _kConfirmDeleteTimeout = Duration(seconds: 3);

/// 買い物アイテム 1 行。Next.js 原典 `shopping-item.tsx` の Flutter 移植。
///
/// - チェックボックスは 44px 以上のタッチターゲット (原典 `size-11`)。
/// - **楽観更新 + 失敗巻き戻し** (F2 `MealReactionsRow` の流儀):
///   タップで即座にローカル override (`_optimisticChecked`) を表示し、
///   `toggleItem` 失敗時は override を破棄して巻き戻し + SnackBar
///   (原典の rollback + `toast.error`)。成功時は override を保持したまま
///   realtime UPDATE がサーバ値で置き換えるのを待つ (`didUpdateWidget` で破棄)。
///   web は一覧 state 全体を書き換えるため即時にグループ間移動するが、
///   Flutter 版はタイル局所の楽観表示とし、移動は realtime 反映時に起こる
///   (意図的差異 — 一覧の正は `ShoppingItemsNotifier` の reducer に一本化)。
/// - チェック済みは行を 50% 透過 + 取り消し線 + チェック者名表示 (原典)。
/// - 削除は 2 タップ確認 (1 回目で destructive 表示、3 秒で自動解除 — 原典の
///   `confirmDelete`)。確定後は楽観的に行を隠し、失敗時は**復元** + SnackBar
///   (web は復元しないが、巻き戻す方が安全側 — 削除されていない行を
///   見えないままにしない)。
///
/// 在庫自動登録 (`autoStocked` toast) は stock 機能ごと Phase 2.5
/// (`ShoppingRepository.toggleItem` doc 参照) のため無し。
class ShoppingItemTile extends ConsumerStatefulWidget {
  const ShoppingItemTile({required this.item, this.checkedByName, super.key});

  final ShoppingItem item;

  /// チェックした人の表示名 (web の `memberMap.get(checked_by)`)。
  /// null なら名前行を出さない (原典と同一)。
  final String? checkedByName;

  @override
  ConsumerState<ShoppingItemTile> createState() => _ShoppingItemTileState();
}

class _ShoppingItemTileState extends ConsumerState<ShoppingItemTile> {
  /// 楽観更新中のチェック状態 override。null = サーバ値 (`item.isChecked`)。
  bool? _optimisticChecked;

  /// 楽観削除中 (行を隠す)。realtime DELETE 反映までの即時表示用。
  bool _optimisticDeleted = false;

  bool _pending = false;
  bool _confirmDelete = false;
  Timer? _confirmTimer;

  @override
  void didUpdateWidget(ShoppingItemTile oldWidget) {
    super.didUpdateWidget(oldWidget);
    // 新しいサーバ値が届いたら楽観 override を破棄 (realtime が正 —
    // `MealReactionsRow.didUpdateWidget` と同じ流儀)。
    if (widget.item != oldWidget.item) {
      _optimisticChecked = null;
      _optimisticDeleted = false;
    }
  }

  @override
  void dispose() {
    _confirmTimer?.cancel();
    super.dispose();
  }

  bool get _effectiveChecked => _optimisticChecked ?? widget.item.isChecked;

  Future<void> _handleToggle() async {
    if (_pending) return;

    final next = !_effectiveChecked;
    final messenger = ScaffoldMessenger.of(context);
    setState(() {
      _optimisticChecked = next;
      _pending = true;
    });

    try {
      final mutationContext = await ref.read(
        shoppingMutationContextProvider.future,
      );
      await ref
          .read(shoppingRepositoryProvider)
          .toggleItem(
            householdId: mutationContext.householdId,
            itemId: widget.item.id,
            isChecked: next,
            userId: mutationContext.userId,
          );
      // 成功時は楽観 override を保持したまま realtime UPDATE を待つ。
    } on Object catch (e, st) {
      // 握り潰さない (CLAUDE.md)。repository 側でも構造化ログ済み。
      debugPrint('ShoppingItemTile toggleItem 失敗: $e\n$st');
      if (!mounted) return;
      // 巻き戻し + エラー表示 (文言は web `toggleItem` action と同一)。
      setState(() => _optimisticChecked = null);
      messenger.showSnackBar(const SnackBar(content: Text('更新に失敗しました')));
    } finally {
      if (mounted) setState(() => _pending = false);
    }
  }

  Future<void> _handleDelete() async {
    if (_pending) return;

    // 1 タップ目: 確認状態に切り替え、3 秒で自動解除 (原典と同一)。
    if (!_confirmDelete) {
      _confirmTimer?.cancel();
      setState(() => _confirmDelete = true);
      _confirmTimer = Timer(_kConfirmDeleteTimeout, () {
        if (mounted) setState(() => _confirmDelete = false);
      });
      return;
    }

    // 2 タップ目: 楽観的に行を隠してから削除 (原典 `onOptimisticDelete`)。
    _confirmTimer?.cancel();
    final messenger = ScaffoldMessenger.of(context);
    setState(() {
      _confirmDelete = false;
      _optimisticDeleted = true;
      _pending = true;
    });

    try {
      final mutationContext = await ref.read(
        shoppingMutationContextProvider.future,
      );
      await ref
          .read(shoppingRepositoryProvider)
          .deleteItem(
            householdId: mutationContext.householdId,
            itemId: widget.item.id,
          );
      // 一覧からの除去は realtime DELETE (reducer) が確定する。
    } on Object catch (e, st) {
      debugPrint('ShoppingItemTile deleteItem 失敗: $e\n$st');
      if (!mounted) return;
      // 行を復元 + エラー表示 (文言は web `deleteItem` action と同一)。
      setState(() => _optimisticDeleted = false);
      messenger.showSnackBar(const SnackBar(content: Text('削除に失敗しました')));
    } finally {
      if (mounted) setState(() => _pending = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    // 楽観削除中は行を描画しない (realtime DELETE 反映までの即時表示)。
    if (_optimisticDeleted) return const SizedBox.shrink();

    final item = widget.item;
    final checked = _effectiveChecked;
    final badge = _categoryBadgeColors(item.category);

    return Opacity(
      // 原典: チェック済みは `opacity-50`。
      opacity: checked ? 0.5 : 1,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
        child: Row(
          children: [
            // チェックボックス (原典の aria-label 付き大タッチターゲット)。
            Semantics(
              label: checked ? '${item.name}のチェックを外す' : '${item.name}をチェック',
              child: Checkbox(
                value: checked,
                onChanged: _pending ? null : (_) => _handleToggle(),
                // 原典 `rounded-md` の角丸。
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(6),
                ),
              ),
            ),
            const SizedBox(width: 4),
            // アイテム情報 (名前 + 数量 + チェック者名)。
            Expanded(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Flexible(
                        child: Text(
                          item.name,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            fontSize: 14,
                            fontWeight: FontWeight.w500,
                            color: checked
                                ? IroriColors.textMuted
                                : IroriColors.textPrimary,
                            decoration: checked
                                ? TextDecoration.lineThrough
                                : null,
                          ),
                        ),
                      ),
                      if (item.quantity != null) ...[
                        const SizedBox(width: 8),
                        Text(
                          item.quantity!,
                          style: TextStyle(
                            fontSize: 12,
                            color: IroriColors.textMuted,
                            decoration: checked
                                ? TextDecoration.lineThrough
                                : null,
                          ),
                        ),
                      ],
                    ],
                  ),
                  if (checked && widget.checkedByName != null)
                    Text(
                      widget.checkedByName!,
                      style: const TextStyle(
                        fontSize: 10,
                        color: IroriColors.textMuted,
                      ),
                    ),
                ],
              ),
            ),
            const SizedBox(width: 8),
            // カテゴリーバッジ (原典 `getCategoryColor` の rounded-full バッジ)。
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
              decoration: BoxDecoration(
                color: badge.bg,
                borderRadius: BorderRadius.circular(IroriRadii.pill),
              ),
              child: Text(
                item.category.label,
                style: TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.w500,
                  color: badge.fg,
                ),
              ),
            ),
            // 削除ボタン (2 タップ確認。モバイルでは常時表示 — 原典
            // `max-sm:opacity-100` に対応)。
            IconButton(
              icon: const Icon(LucideIcons.trash2, size: 14),
              tooltip: _confirmDelete
                  ? '${item.name}を削除（確認）'
                  : '${item.name}を削除',
              onPressed: _pending ? null : _handleDelete,
              color: _confirmDelete
                  ? IroriColors.surface
                  : IroriColors.textMuted,
              style: _confirmDelete
                  ? IconButton.styleFrom(backgroundColor: IroriColors.error)
                  : null,
              // 44x44 の最小タッチ領域 (CLAUDE.md)。
              constraints: const BoxConstraints(minWidth: 44, minHeight: 44),
              padding: EdgeInsets.zero,
            ),
          ],
        ),
      ),
    );
  }
}

/// カテゴリバッジの配色。web `categories.ts` の `getCategoryColor`
/// (Tailwind `bg-*-100 text-*-700` / gray は `text-gray-600`) を sRGB 化。
/// hex 値は Tailwind 既定パレット (`baby_quick_actions.dart` の
/// `_amberBg` 等と同じ換算規約)。
({Color bg, Color fg}) _categoryBadgeColors(ItemCategory category) {
  switch (category) {
    case ItemCategory.vegetable: // emerald-100 / emerald-700
      return (bg: const Color(0xFFD1FAE5), fg: const Color(0xFF047857));
    case ItemCategory.fruit: // orange-100 / orange-700
      return (bg: const Color(0xFFFFEDD5), fg: const Color(0xFFC2410C));
    case ItemCategory.meat: // red-100 / red-700
      return (bg: const Color(0xFFFEE2E2), fg: const Color(0xFFB91C1C));
    case ItemCategory.fish: // blue-100 / blue-700
      return (bg: const Color(0xFFDBEAFE), fg: const Color(0xFF1D4ED8));
    case ItemCategory.dairy: // violet-100 / violet-700
      return (bg: const Color(0xFFEDE9FE), fg: const Color(0xFF6D28D9));
    case ItemCategory.egg: // yellow-100 / yellow-700
    case ItemCategory.seasoning:
      return (bg: const Color(0xFFFEF9C3), fg: const Color(0xFFA16207));
    case ItemCategory.grain: // amber-100 / amber-700
      return (bg: const Color(0xFFFEF3C7), fg: const Color(0xFFB45309));
    case ItemCategory.frozen: // sky-100 / sky-700
      return (bg: const Color(0xFFE0F2FE), fg: const Color(0xFF0369A1));
    case ItemCategory.snackFood: // pink-100 / pink-700
    case ItemCategory.baby:
      return (bg: const Color(0xFFFCE7F3), fg: const Color(0xFFBE185D));
    case ItemCategory.cleaning: // cyan-100 / cyan-700
      return (bg: const Color(0xFFCFFAFE), fg: const Color(0xFF0E7490));
    case ItemCategory.hygiene: // teal-100 / teal-700
      return (bg: const Color(0xFFCCFBF1), fg: const Color(0xFF0F766E));
    case ItemCategory.otherFood: // gray-100 / gray-600
    case ItemCategory.otherDaily:
      return (bg: const Color(0xFFF3F4F6), fg: const Color(0xFF4B5563));
  }
}
