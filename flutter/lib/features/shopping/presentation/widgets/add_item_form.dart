import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../../core/domain/item_category.dart';
import '../../../../core/domain/store_type.dart';
import '../../../../core/theme/colors.dart';
import '../../../../widgets/category_icon.dart';
import '../../../../widgets/glass_card.dart';
import '../../data/shopping_repository.dart';

/// アイテム追加フォーム。Next.js 原典 `add-item-form.tsx` の Flutter 移植。
///
/// - メイン行: 名前入力 (必須) + 追加ボタン + オプション開閉ボタン。
/// - 展開オプション: カテゴリ / 購入先 (既定は web と同じ
///   `other_food` / `supermarket`) + **数量** (web のフォームには無いが、
///   `addItem` action が受ける `quantity` の入力点として Flutter 版で追加 —
///   意図的差異)。
/// - 成功で名前/数量をクリアし入力へ再フォーカス (web: `setName("")` +
///   `inputRef.current?.focus()`。カテゴリ/購入先の選択は維持)。
///   一覧への反映は realtime INSERT (reducer) に任せる (web も同様)。
/// - 失敗は SnackBar「アイテムの追加に失敗しました」(web `addItem` と同一文言)。
///
/// 購入履歴サジェスト (`getSuggestions`) は Phase 2.5
/// (`ShoppingRepository` クラス doc 参照) のため無し。
class AddItemForm extends ConsumerStatefulWidget {
  const AddItemForm({super.key});

  @override
  ConsumerState<AddItemForm> createState() => _AddItemFormState();
}

class _AddItemFormState extends ConsumerState<AddItemForm> {
  final _nameController = TextEditingController();
  final _quantityController = TextEditingController();
  final _nameFocus = FocusNode();

  // 既定値は web フォームと同一 (`other_food` / `supermarket`)。
  ItemCategory _category = ItemCategory.otherFood;
  StoreType _storeType = StoreType.supermarket;

  bool _showOptions = false;
  bool _pending = false;

  @override
  void dispose() {
    _nameController.dispose();
    _quantityController.dispose();
    _nameFocus.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    final name = _nameController.text.trim();
    if (name.isEmpty || _pending) return; // ボタン disabled の防御線

    setState(() => _pending = true);
    final messenger = ScaffoldMessenger.of(context);
    // 数量は trim + 空なら null (web `quantity || null` と同じ正規化)。
    final quantity = _quantityController.text.trim();

    try {
      final mutationContext = await ref.read(
        shoppingMutationContextProvider.future,
      );
      await ref
          .read(shoppingRepositoryProvider)
          .addItem(
            householdId: mutationContext.householdId,
            userId: mutationContext.userId,
            name: name,
            quantity: quantity.isEmpty ? null : quantity,
            category: _category,
            storeType: _storeType,
          );
      if (!mounted) return;
      // 成功で入力クリア (カテゴリ/購入先の選択は維持 — web と同一)。
      setState(() {
        _nameController.clear();
        _quantityController.clear();
      });
      _nameFocus.requestFocus();
    } on Object catch (e, st) {
      // 握り潰さない (CLAUDE.md)。repository 側でも構造化ログ済み。
      debugPrint('AddItemForm addItem 失敗: $e\n$st');
      if (!mounted) return;
      messenger.showSnackBar(SnackBar(content: Text(_errorMessage(e))));
    } finally {
      if (mounted) setState(() => _pending = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final canSubmit = !_pending && _nameController.text.trim().isNotEmpty;

    return GlassCard(
      padding: const EdgeInsets.all(12),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Expanded(
                child: TextField(
                  controller: _nameController,
                  focusNode: _nameFocus,
                  enabled: !_pending,
                  autocorrect: false,
                  decoration: const InputDecoration(
                    hintText: 'アイテムを追加...',
                    isDense: true,
                    border: OutlineInputBorder(),
                  ),
                  style: const TextStyle(fontSize: 16),
                  // 追加ボタンの enabled/disabled を追従させる。
                  onChanged: (_) => setState(() {}),
                  onSubmitted: (_) => _submit(),
                  textInputAction: TextInputAction.done,
                ),
              ),
              const SizedBox(width: 8),
              // 追加 (原典 aria-label「追加」の Plus ボタン)。
              IconButton.filled(
                icon: const Icon(LucideIcons.plus, size: 18),
                tooltip: '追加',
                onPressed: canSubmit ? _submit : null,
                // 44x44 の最小タッチ領域 (CLAUDE.md)。
                constraints: const BoxConstraints(minWidth: 44, minHeight: 44),
                padding: EdgeInsets.zero,
              ),
              // オプション開閉 (原典 aria-label と同一文言の tooltip)。
              IconButton(
                icon: Icon(
                  _showOptions
                      ? LucideIcons.chevronUp
                      : LucideIcons.chevronDown,
                  size: 18,
                ),
                tooltip: _showOptions ? 'オプションを閉じる' : 'オプションを開く',
                onPressed: () => setState(() => _showOptions = !_showOptions),
                color: IroriColors.textMuted,
                constraints: const BoxConstraints(minWidth: 44, minHeight: 44),
                padding: EdgeInsets.zero,
              ),
            ],
          ),
          if (_showOptions) ...[
            const SizedBox(height: 12),
            Divider(
              height: 1,
              thickness: 1,
              color: IroriColors.border.withValues(alpha: 0.5),
            ),
            const SizedBox(height: 12),
            Row(
              children: [
                Expanded(
                  child: _LabeledField(
                    label: 'カテゴリ:',
                    child: DropdownButtonFormField<ItemCategory>(
                      initialValue: _category,
                      isDense: true,
                      isExpanded: true,
                      decoration: const InputDecoration(
                        isDense: true,
                        border: OutlineInputBorder(),
                        contentPadding: EdgeInsets.symmetric(
                          horizontal: 8,
                          vertical: 8,
                        ),
                      ),
                      items: [
                        // 原典 `allCategories` (displayOrder 順の全 15 値)。
                        for (final c in ItemCategory.displayOrder)
                          DropdownMenuItem(
                            value: c,
                            child: Row(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                Icon(
                                  categoryIcon(c),
                                  size: 14,
                                  color: IroriColors.textMuted,
                                ),
                                const SizedBox(width: 4),
                                Flexible(
                                  child: Text(
                                    c.label,
                                    overflow: TextOverflow.ellipsis,
                                    style: const TextStyle(fontSize: 12),
                                  ),
                                ),
                              ],
                            ),
                          ),
                      ],
                      onChanged: _pending
                          ? null
                          : (value) {
                              if (value != null) {
                                setState(() => _category = value);
                              }
                            },
                    ),
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: _LabeledField(
                    label: '購入先:',
                    child: DropdownButtonFormField<StoreType>(
                      initialValue: _storeType,
                      isDense: true,
                      isExpanded: true,
                      decoration: const InputDecoration(
                        isDense: true,
                        border: OutlineInputBorder(),
                        contentPadding: EdgeInsets.symmetric(
                          horizontal: 8,
                          vertical: 8,
                        ),
                      ),
                      items: [
                        // 原典 `allStores` (displayOrder 順の全 5 値)。
                        for (final s in StoreType.displayOrder)
                          DropdownMenuItem(
                            value: s,
                            child: Text(
                              s.label,
                              overflow: TextOverflow.ellipsis,
                              style: const TextStyle(fontSize: 12),
                            ),
                          ),
                      ],
                      onChanged: _pending
                          ? null
                          : (value) {
                              if (value != null) {
                                setState(() => _storeType = value);
                              }
                            },
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 8),
            _LabeledField(
              label: '数量:',
              child: TextField(
                controller: _quantityController,
                enabled: !_pending,
                decoration: const InputDecoration(
                  hintText: '例: 2個',
                  isDense: true,
                  border: OutlineInputBorder(),
                ),
                style: const TextStyle(fontSize: 13),
              ),
            ),
          ],
        ],
      ),
    );
  }
}

/// 「ラベル: フィールド」の横並び (原典の `text-xs text-muted-foreground`
/// ラベル + Select 行に対応)。
class _LabeledField extends StatelessWidget {
  const _LabeledField({required this.label, required this.child});

  final String label;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Text(
          label,
          style: const TextStyle(fontSize: 12, color: IroriColors.textMuted),
        ),
        const SizedBox(width: 6),
        Expanded(child: child),
      ],
    );
  }
}

/// エラー文言 (web `addItem` action の分岐に対応):
/// - 入力エラー (`ArgumentError` — 「アイテム名を入力してください」) は
///   message をそのまま表示。
/// - その他は汎用文言。
String _errorMessage(Object error) {
  if (error is ArgumentError) {
    final message = error.message;
    if (message != null) return message.toString();
  }
  return 'アイテムの追加に失敗しました';
}
