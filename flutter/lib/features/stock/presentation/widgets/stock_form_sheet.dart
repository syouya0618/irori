import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../../core/domain/item_category.dart';
import '../../../../core/theme/colors.dart';
import '../../../../core/theme/radii.dart';
import '../../../../core/utils/jst_date.dart';
import '../../data/stock_repository.dart';
import '../../domain/stock_item.dart';
import '../stock_display_utils.dart';

/// 単位の選択肢。原典 `stock-form-sheet.tsx` の `STOCK_UNITS` と同一
/// (value "切" の表示ラベルだけ「切れ」— 原典と同じ)。
const List<({String value, String label})> stockUnits = [
  (value: '個', label: '個'),
  (value: 'パック', label: 'パック'),
  (value: '本', label: '本'),
  (value: '袋', label: '袋'),
  (value: '缶', label: '缶'),
  (value: '箱', label: '箱'),
  (value: '枚', label: '枚'),
  (value: '切', label: '切れ'),
  (value: 'g', label: 'g'),
  (value: 'kg', label: 'kg'),
  (value: 'ml', label: 'ml'),
  (value: 'L', label: 'L'),
];

/// 在庫の追加 / 編集 sheet を開く。
///
/// [existing] が null なら追加モード、非 null なら編集モード (既存値で埋める)。
/// シグネチャは `showMealFormSheet(context, ref, ...)` と統一。
Future<void> showStockFormSheet(
  BuildContext context,
  WidgetRef ref, {
  StockItem? existing,
}) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    builder: (_) => StockFormSheet(existing: existing),
  );
}

/// 在庫の追加 / 編集を行う bottom sheet。
///
/// Next.js 原典 `stock-form-sheet.tsx` の Flutter 移植。
/// 項目: アイテム名 (必須) / カテゴリ (全 15 値) / 数量 (小数可 — 原典
/// `step="0.1"` `inputMode="decimal"`) / 単位 (なし + 12 候補) / 賞味期限
/// (任意の DatePicker)。
///
/// 文言は原典 toast / ラベルと同一:
/// - 成功: 「在庫を追加しました」「在庫を更新しました」
/// - 名前未入力: 「アイテム名を入力してください」
/// - 失敗: 「在庫の追加に失敗しました」「在庫の更新に失敗しました」
///   (原典 `actions.ts` の汎用エラー)
///
/// repository の `ArgumentError` (入力検証) は `message` (web
/// `parseStockFormData` と同一のユーザー向け文言) を表示し、
/// `toString()` の "Invalid argument(s)..." を生で画面に漏らさない。
///
/// 一覧への反映は F5 realtime reducer に任せる (web と同じ —
/// INSERT/UPDATE payload を reducer が取り込む)。invalidate での
/// 全件 refetch はしない。
class StockFormSheet extends ConsumerStatefulWidget {
  const StockFormSheet({this.existing, super.key});

  /// 編集対象。null なら追加モード。
  final StockItem? existing;

  @override
  ConsumerState<StockFormSheet> createState() => _StockFormSheetState();
}

class _StockFormSheetState extends ConsumerState<StockFormSheet> {
  late final TextEditingController _nameController;
  late final TextEditingController _quantityController;
  late ItemCategory _category;

  /// 選択中の単位 ('' = なし。web の `useState("")` と同じ)。
  late String _unit;

  /// 賞味期限 "YYYY-MM-DD" (null = 未設定)。
  String? _expiresAt;

  bool _pending = false;

  bool get _isEditing => widget.existing != null;

  @override
  void initState() {
    super.initState();
    final existing = widget.existing;
    _nameController = TextEditingController(text: existing?.name ?? '');
    // 原典: `String(editingItem.quantity)` / 追加時は "1"。
    // num の文字列化は web の JS 書式に合わせる (2.0 → "2")。
    _quantityController = TextEditingController(
      text: existing == null ? '1' : formatStockQuantity(existing.quantity),
    );
    _category = existing?.category ?? ItemCategory.otherFood;
    _unit = existing?.unit ?? '';
    // 原典: `editingItem?.expires_at?.split("T")[0] ?? ""`。
    final rawExpiresAt = existing?.expiresAt;
    _expiresAt = (rawExpiresAt == null || rawExpiresAt.isEmpty)
        ? null
        : rawExpiresAt.split('T').first;
  }

  @override
  void dispose() {
    _nameController.dispose();
    _quantityController.dispose();
    super.dispose();
  }

  Future<void> _pickExpiresAt() async {
    // 初期値: 設定済みならその日、未設定なら JST の今日 (UTC 罠回避のため
    // formatJstDate の YMD を数値分解して構成する)。
    final p = (_expiresAt ?? formatJstDate()).split('-');
    var initial = DateTime(
      int.parse(p[0]),
      int.parse(p[1]),
      int.parse(p[2]),
    );
    final first = DateTime(2000);
    final last = DateTime(2100, 12, 31);
    // 範囲外の既存値でも showDatePicker の assert に倒さない防御。
    if (initial.isBefore(first)) initial = first;
    if (initial.isAfter(last)) initial = last;

    final picked = await showDatePicker(
      context: context,
      initialDate: initial,
      firstDate: first,
      lastDate: last,
    );
    if (picked == null || !mounted) return;
    // y/m/d の数値だけを使い "YYYY-MM-DD" に再構成する (TZ 非依存)。
    final ymd =
        '${picked.year.toString().padLeft(4, '0')}-'
        '${picked.month.toString().padLeft(2, '0')}-'
        '${picked.day.toString().padLeft(2, '0')}';
    setState(() => _expiresAt = ymd);
  }

  Future<void> _save() async {
    if (_pending) return;

    final messenger = ScaffoldMessenger.of(context);
    final navigator = Navigator.of(context);

    final name = _nameController.text.trim();
    if (name.isEmpty) {
      // 原典 handleSubmit のクライアント検証 (toast.error) と同一文言。
      messenger.showSnackBar(
        const SnackBar(content: Text('アイテム名を入力してください')),
      );
      return;
    }

    // 原典: `Number(quantity || "1") || 1` — 空・非数値は 1 に補完される。
    // 0 以下は web では falsy 補完 (0→1) されるが、Flutter は黙殺せず
    // repository の検証 (ArgumentError「数量は0より大きい値で入力してください」)
    // に委ねて表面化させる (F5 の方針 / CLAUDE.md falsy 衝突の罠)。
    final quantityText = _quantityController.text.trim();
    final quantity = quantityText.isEmpty
        ? 1
        : (num.tryParse(quantityText) ?? 1);

    setState(() => _pending = true);
    try {
      final ctx = await ref.read(stockMutationContextProvider.future);
      final repo = ref.read(stockRepositoryProvider);
      if (_isEditing) {
        await repo.updateItem(
          householdId: ctx.householdId,
          itemId: widget.existing!.id,
          name: name,
          category: _category,
          quantity: quantity,
          // '' は repository が null へ正規化する (web の `length > 0 ? v : null`)。
          unit: _unit,
          expiresAt: _expiresAt,
        );
      } else {
        await repo.addItem(
          householdId: ctx.householdId,
          userId: ctx.userId,
          name: name,
          category: _category,
          quantity: quantity,
          unit: _unit,
          expiresAt: _expiresAt,
        );
      }
      // 一覧反映は realtime reducer 任せ (web と同じ)。自分の削除のみ
      // 楽観更新 (stock_page.dart 側) で、追加/更新は INSERT/UPDATE payload
      // を待つ。
      if (!mounted) return;
      navigator.pop();
      messenger.showSnackBar(
        SnackBar(content: Text(_isEditing ? '在庫を更新しました' : '在庫を追加しました')),
      );
    } on ArgumentError catch (e) {
      // repository の入力検証。message は web `parseStockFormData` と同一の
      // ユーザー向け文言 (例: 「数量は0より大きい値で入力してください」)。
      // 握り潰さない (CLAUDE.md): どの引数が弾かれたかをログにも残す。
      debugPrint(
        'StockFormSheet 入力検証エラー: ${e.name}=${e.invalidValue}: ${e.message}',
      );
      final message = e.message;
      if (!mounted) return;
      messenger.showSnackBar(
        SnackBar(
          content: Text(
            message is String && message.isNotEmpty
                ? message
                : _genericErrorMessage,
          ),
        ),
      );
    } on Object catch (e, st) {
      // 握り潰さない (CLAUDE.md)。repository 側でも構造化ログ済み。
      debugPrint('StockFormSheet mutation 失敗: $e\n$st');
      if (!mounted) return;
      messenger.showSnackBar(SnackBar(content: Text(_genericErrorMessage)));
    } finally {
      if (mounted) setState(() => _pending = false);
    }
  }

  /// 原典 `actions.ts` の汎用エラー文言。
  String get _genericErrorMessage =>
      _isEditing ? '在庫の更新に失敗しました' : '在庫の追加に失敗しました';

  @override
  Widget build(BuildContext context) {
    final title = _isEditing ? '在庫を編集' : '在庫を追加';
    final description = _isEditing ? '在庫情報を更新します' : '冷蔵庫・冷凍庫・パントリーの在庫を記録します';

    // 既存データの unit が候補に無い場合も選択肢に足して値を保持する
    // (編集保存で既存値を破壊しない — CLAUDE.md)。
    final unitOptions = [
      (value: '', label: 'なし'),
      ...stockUnits,
      if (_unit.isNotEmpty && !stockUnits.any((u) => u.value == _unit))
        (value: _unit, label: _unit),
    ];

    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
      child: ConstrainedBox(
        constraints: BoxConstraints(
          maxHeight: MediaQuery.sizeOf(context).height * 0.85,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(24, 20, 24, 12),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(title, style: Theme.of(context).textTheme.titleLarge),
                  const SizedBox(height: 4),
                  Text(
                    description,
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                ],
              ),
            ),
            Flexible(
              child: SingleChildScrollView(
                padding: const EdgeInsets.fromLTRB(24, 0, 24, 12),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    const _Label('アイテム名'),
                    TextField(
                      controller: _nameController,
                      enabled: !_pending,
                      autofocus: true,
                      autocorrect: false,
                      decoration: const InputDecoration(
                        hintText: '例: 牛乳、豚バラ肉',
                        border: OutlineInputBorder(),
                      ),
                    ),
                    const SizedBox(height: 16),
                    const _Label('カテゴリ'),
                    DropdownButtonFormField<ItemCategory>(
                      initialValue: _category,
                      isExpanded: true,
                      decoration: const InputDecoration(
                        border: OutlineInputBorder(),
                        contentPadding: EdgeInsets.symmetric(
                          horizontal: 12,
                          vertical: 12,
                        ),
                      ),
                      items: [
                        for (final c in ItemCategory.displayOrder)
                          DropdownMenuItem(
                            value: c,
                            child: Text(
                              c.label,
                              style: const TextStyle(fontSize: 14),
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
                    const SizedBox(height: 16),
                    Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.stretch,
                            children: [
                              const _Label('数量'),
                              TextField(
                                controller: _quantityController,
                                enabled: !_pending,
                                // 原典 `inputMode="decimal" step="0.1"` 相当。
                                keyboardType:
                                    const TextInputType.numberWithOptions(
                                      decimal: true,
                                    ),
                                decoration: const InputDecoration(
                                  border: OutlineInputBorder(),
                                ),
                              ),
                            ],
                          ),
                        ),
                        const SizedBox(width: 12),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.stretch,
                            children: [
                              const _Label('単位'),
                              DropdownButtonFormField<String>(
                                initialValue: _unit,
                                isExpanded: true,
                                decoration: const InputDecoration(
                                  border: OutlineInputBorder(),
                                  contentPadding: EdgeInsets.symmetric(
                                    horizontal: 12,
                                    vertical: 12,
                                  ),
                                ),
                                items: [
                                  for (final u in unitOptions)
                                    DropdownMenuItem(
                                      value: u.value,
                                      child: Text(
                                        u.label,
                                        style: const TextStyle(fontSize: 14),
                                      ),
                                    ),
                                ],
                                onChanged: _pending
                                    ? null
                                    : (value) {
                                        setState(() => _unit = value ?? '');
                                      },
                              ),
                            ],
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 16),
                    const _Label('賞味期限'),
                    Row(
                      children: [
                        Expanded(
                          child: OutlinedButton.icon(
                            onPressed: _pending ? null : _pickExpiresAt,
                            icon: const Icon(LucideIcons.calendar, size: 16),
                            // 原典 `<input type="date">` の値 (YYYY-MM-DD) を
                            // そのまま表示。未設定は単位 Select と同じ「選択」。
                            label: Text(_expiresAt ?? '選択'),
                            style: OutlinedButton.styleFrom(
                              minimumSize: const Size.fromHeight(44),
                              alignment: Alignment.centerLeft,
                              foregroundColor: _expiresAt == null
                                  ? IroriColors.textMuted
                                  : IroriColors.textPrimary,
                              shape: RoundedRectangleBorder(
                                borderRadius: BorderRadius.circular(
                                  IroriRadii.button,
                                ),
                              ),
                            ),
                          ),
                        ),
                        if (_expiresAt != null) ...[
                          const SizedBox(width: 4),
                          IconButton(
                            onPressed: _pending
                                ? null
                                : () => setState(() => _expiresAt = null),
                            icon: const Icon(LucideIcons.x, size: 16),
                            tooltip: '賞味期限をクリア',
                            color: IroriColors.textMuted,
                            constraints: const BoxConstraints(
                              minWidth: 44,
                              minHeight: 44,
                            ),
                            padding: EdgeInsets.zero,
                          ),
                        ],
                      ],
                    ),
                  ],
                ),
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(24, 8, 24, 24),
              child: Row(
                children: [
                  Expanded(
                    child: OutlinedButton(
                      onPressed: _pending
                          ? null
                          : () => Navigator.of(context).pop(),
                      style: OutlinedButton.styleFrom(
                        minimumSize: const Size.fromHeight(44),
                        shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(
                            IroriRadii.button,
                          ),
                        ),
                      ),
                      child: const Text('キャンセル'),
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: FilledButton(
                      // 原典: 名前空でもボタンは有効で、submit 時に toast を出す
                      // (meals の disabled 方式とは異なる — web の在庫仕様)。
                      onPressed: _pending ? null : _save,
                      style: FilledButton.styleFrom(
                        minimumSize: const Size.fromHeight(44),
                        shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(
                            IroriRadii.button,
                          ),
                        ),
                      ),
                      child: _pending
                          ? Row(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                const SizedBox.square(
                                  dimension: 20,
                                  child: CircularProgressIndicator(
                                    strokeWidth: 2,
                                  ),
                                ),
                                const SizedBox(width: 8),
                                Text(_isEditing ? '更新' : '追加'),
                              ],
                            )
                          : Text(_isEditing ? '更新' : '追加'),
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _Label extends StatelessWidget {
  const _Label(this.text);

  final String text;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Text(text, style: Theme.of(context).textTheme.labelLarge),
    );
  }
}
