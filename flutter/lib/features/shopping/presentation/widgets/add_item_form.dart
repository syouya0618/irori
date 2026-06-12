import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../../core/domain/item_category.dart';
import '../../../../core/domain/store_type.dart';
import '../../../../core/theme/colors.dart';
import '../../../../core/theme/radii.dart';
import '../../../../widgets/category_icon.dart';
import '../../../../widgets/glass_card.dart';
import '../../data/shopping_repository.dart';

/// 購入履歴サジェスト検索のデバウンス
/// (web `add-item-form.tsx:56-58` の `setTimeout(..., 300)`)。
const _kSuggestionDebounce = Duration(milliseconds: 300);

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
/// - 名前入力には 300ms デバウンスの購入履歴サジェスト
///   ([ShoppingRepository.searchSuggestions] — web `fetchSuggestions` +
///   `getSuggestions` action)。行タップで name + 非 null の
///   category/storeType を反映して閉じる ([_selectSuggestion])。
///
/// **サジェストの意図的差異 (web `add-item-form.tsx` 比)**:
/// - ↑↓/Enter のキーボードナビ (web :113-130) と外側クリック close
///   (web :67-81) + 対のフォーカス復帰再表示 (web :144-146) はデスクトップ
///   固有のため移植しない。close 経路が「選択 / 追加成功 / 入力クリア」に
///   限られるため、web の `showSuggestions` 独立 state は持たず
///   `_suggestions.isNotEmpty` で表示を導出する (挙動同値)。
/// - ドロップダウンは overlay でなくインライン展開 ([_SuggestionList] doc)。
/// - stale 応答は世代カウンタ [_suggestionGeneration] で破棄
///   (web に無い改善 — Phase 2.5 計画で許可済み)。
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

  /// 購入履歴サジェスト (空 = 非表示。クラス doc の表示導出参照)。
  List<PurchaseSuggestion> _suggestions = const [];

  /// サジェスト検索のデバウンスタイマー (web `debounceRef`)。
  Timer? _suggestionDebounce;

  /// 進行中 fetch の世代。応答適用時に最新世代と一致しなければ破棄する
  /// (連打時に古い応答が新しい入力のサジェストを潰さないための stale 防止)。
  int _suggestionGeneration = 0;

  @override
  void dispose() {
    _suggestionDebounce?.cancel();
    _nameController.dispose();
    _quantityController.dispose();
    _nameFocus.dispose();
    super.dispose();
  }

  /// 名前入力の変化から 300ms 後にサジェスト検索を発火する
  /// (web `add-item-form.tsx:52-65` の useEffect デバウンス)。
  void _scheduleSuggestionsFetch() {
    _suggestionDebounce?.cancel();
    _suggestionDebounce = Timer(_kSuggestionDebounce, () {
      _fetchSuggestions(_nameController.text);
    });
  }

  /// 入力 [query] で購入履歴サジェストを取得する (web `fetchSuggestions`)。
  ///
  /// - 空 query (trim 後) はサジェストを閉じるのみで検索しない
  ///   (web :41-45 の早期 return — repository 側の早期 return と二重防御)。
  /// - 取得失敗は debugPrint + 空サジェストに縮退し、SnackBar は出さない
  ///   (web `getSuggestions` は全エラーを空に縮退する best-effort 仕様。
  ///   repository 内のエラーは構造化ログ済みで、ここの catch は
  ///   mutationContext 解決失敗 (未認証等) も含む防御線)。
  Future<void> _fetchSuggestions(String query) async {
    final generation = ++_suggestionGeneration;
    if (query.trim().isEmpty) {
      setState(() => _suggestions = const []);
      return;
    }

    try {
      final mutationContext = await ref.read(
        shoppingMutationContextProvider.future,
      );
      final results = await ref
          .read(shoppingRepositoryProvider)
          .searchSuggestions(
            householdId: mutationContext.householdId,
            query: query,
          );
      if (!mounted || generation != _suggestionGeneration) return;
      setState(() => _suggestions = results);
    } on Object catch (e, st) {
      debugPrint('AddItemForm サジェスト取得失敗: $e\n$st');
      if (!mounted || generation != _suggestionGeneration) return;
      setState(() => _suggestions = const []);
    }
  }

  /// サジェスト行タップ (web `selectSuggestion`)。
  ///
  /// name は常に反映し、category / storeType は**非 null のみ**反映する
  /// (web の falsy ガード `if (suggestion.category) setCategory(...)` —
  /// NULL 履歴行で現在の選択を破壊しない)。反映後はサジェストを閉じ、
  /// 入力へ再フォーカスする (web `inputRef.current?.focus()`)。
  ///
  /// 待機中のデバウンス cancel + 世代カウンタ進行で、選択直後に旧 fetch の
  /// 応答が届いてもドロップダウンを再表示させない (web は name 変更の
  /// useEffect で再検索 → 再表示されるが、本契約は「タップで閉じる」)。
  void _selectSuggestion(PurchaseSuggestion suggestion) {
    _suggestionDebounce?.cancel();
    _suggestionGeneration++;
    final category = suggestion.category;
    final storeType = suggestion.storeType;
    setState(() {
      _nameController.text = suggestion.name;
      _nameController.selection = TextSelection.collapsed(
        offset: suggestion.name.length,
      );
      if (category != null) _category = category;
      if (storeType != null) _storeType = storeType;
      _suggestions = const [];
    });
    _nameFocus.requestFocus();
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
      // サジェストも閉じる (web add-item-form.tsx:105-107)。controller の
      // clear() は onChanged を発火しないため明示的に閉じ、待機中のデバウンス
      // と進行中の fetch は cancel + 世代カウンタ進行で破棄する。
      _suggestionDebounce?.cancel();
      _suggestionGeneration++;
      setState(() {
        _nameController.clear();
        _quantityController.clear();
        _suggestions = const [];
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
                  // 追加ボタンの enabled/disabled 追従 + サジェスト検索の
                  // デバウンス開始。
                  onChanged: (_) {
                    setState(() {});
                    _scheduleSuggestionsFetch();
                  },
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
          if (_suggestions.isNotEmpty) ...[
            // web: mt-1 のドロップダウン (add-item-form.tsx:153-157)。
            const SizedBox(height: 4),
            _SuggestionList(
              suggestions: _suggestions,
              enabled: !_pending,
              onSelect: _selectSuggestion,
            ),
          ],
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

/// サジェストドロップダウン (web `add-item-form.tsx:153-175`)。
///
/// web は入力に absolute 重ね (z-50 の overlay) だが、Flutter 版はカード内の
/// インライン展開にする (OverlayEntry の位置追従管理を持ち込まない意図的
/// 差異 — モバイルでは下方向への押し出し表示が自然)。行の表示内容は web と
/// 同一 (アイテム名のみ・1 行 truncate)。
///
/// [enabled] は送信中 (`_pending`) の選択を防ぐ防御 (web は入力 disabled の
/// 間もサジェスト button 自体は活性のままだが、送信中のフォーム書き換えは
/// 防ぐ方が安全)。
class _SuggestionList extends StatelessWidget {
  const _SuggestionList({
    required this.suggestions,
    required this.enabled,
    required this.onSelect,
  });

  final List<PurchaseSuggestion> suggestions;
  final bool enabled;
  final ValueChanged<PurchaseSuggestion> onSelect;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: IroriColors.surface,
      clipBehavior: Clip.antiAlias,
      // web: rounded-lg + ring-1 ring-foreground/10 + bg-popover。
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(IroriRadii.button),
        side: const BorderSide(color: IroriColors.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          for (final suggestion in suggestions)
            InkWell(
              // 名前は repository 側で toLowerCase dedupe 済みのため
              // sibling key として一意 (web の key=`${name}-${idx}` 相当)。
              key: ValueKey('suggestion-${suggestion.name}'),
              onTap: enabled ? () => onSelect(suggestion) : null,
              child: Container(
                // 44px タッチターゲット (CLAUDE.md。web の py-2 より拡大)。
                constraints: const BoxConstraints(minHeight: 44),
                padding: const EdgeInsets.symmetric(
                  horizontal: 12,
                  vertical: 8,
                ),
                alignment: Alignment.centerLeft,
                child: Text(
                  suggestion.name,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    fontSize: 14,
                    color: IroriColors.textPrimary,
                  ),
                ),
              ),
            ),
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
