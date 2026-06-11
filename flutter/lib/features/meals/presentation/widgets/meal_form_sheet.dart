import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../../core/domain/item_category.dart';
import '../../../../core/theme/colors.dart';
import '../../../../core/theme/radii.dart';
import '../../data/meals_repository.dart';
import '../../data/meals_week_notifier.dart';
import '../../domain/meal.dart';
import '../../domain/meal_template.dart';
import '../meal_display_utils.dart';
import 'meal_ingredient_fields.dart';
import 'template_selector_dialog.dart';

/// 献立の追加 / 編集 sheet を開く。
///
/// [existing] が null なら追加モード ([date] / [mealType] が初期値)、
/// 非 null なら編集モード (既存値で埋める)。
/// [prefill] は追加モードのテンプレート初期値 (P2.5-F — 在庫タブ
/// 「献立に追加」経由。web `meal-week-view.tsx` の `prefilledFromTemplate`
/// → `formInitialData` 経路に相当し、[existing] とは併用しない)。
/// シグネチャは `showBabyFeedingTimer(context, ref, ...)` と統一
/// ([ref] は close 後の provider 操作を足す際の拡張点。現在は sheet 内部の
/// 自前 ref が invalidate まで担う)。
Future<void> showMealFormSheet(
  BuildContext context,
  WidgetRef ref, {
  required String date,
  required MealType mealType,
  Meal? existing,
  MealTemplatePrefill? prefill,
}) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    builder: (_) => MealFormSheet(
      defaultDate: date,
      defaultMealType: mealType,
      existing: existing,
      prefill: prefill,
    ),
  );
}

/// 献立の作成 / 編集 / 削除を行う bottom sheet。
///
/// Next.js 原典 `meal-form-sheet.tsx` の Flutter 移植。
/// 項目: メニュー名 (必須) / 食事タイプ (セグメント 4 種 — 原典 `MEAL_TYPES`
/// と同じく snack も選べる) / 日付 (原典 `<input type="date">` 相当の
/// DatePicker) / 外食 Switch / 食材リスト (追加・削除) /
/// テンプレート 2 ボタン (P2.5-E):
/// - 「テンプレートから作成」(常時) — 選択ダイアログ
///   ([showTemplateSelectorDialog]) を開き、選択された prefill で
///   メニュー名 + 食材リストを**置換**する (原典 handleTemplateSelect)。
/// - 「テンプレート保存」(編集時のみ — 原典 `isEditing &&`) — 表示中の
///   既存献立を `saveAsTemplate` し、sheet は閉じない。
///
/// 文言は原典 toast / ラベルと同一:
/// - 成功: 「献立を追加しました」「献立を更新しました」「献立を削除しました」
///   「テンプレートとして保存しました」
/// - 重複 (23505): 「この日時のメニューは既に登録されています。」
///   ([DuplicateMealException.message])
/// - テンプレート保存失敗: 「テンプレートの保存に失敗しました。」(actions.ts の
///   汎用文言。web の権限分岐文言は repository が PGRST116 throw に畳むため
///   出し分けない — `MealsRepository.saveAsTemplate` doc 参照)
class MealFormSheet extends ConsumerStatefulWidget {
  const MealFormSheet({
    required this.defaultDate,
    required this.defaultMealType,
    this.existing,
    this.prefill,
    super.key,
  });

  /// 追加モードの初期日付 "YYYY-MM-DD" (空スロットの日)。
  final String defaultDate;

  /// 追加モードの初期食事タイプ (空スロットの種別)。
  final MealType defaultMealType;

  /// 編集対象。null なら追加モード。
  final Meal? existing;

  /// 追加モードのテンプレート初期値 (P2.5-F)。[existing] が非 null の
  /// ときは無視する (web `formInitialData` は editingMeal 優先の三項分岐)。
  final MealTemplatePrefill? prefill;

  @override
  ConsumerState<MealFormSheet> createState() => _MealFormSheetState();
}

/// 食材 1 行分のフォーム状態 (controller は本 State が破棄する)。
class _IngredientEntry {
  _IngredientEntry({
    String name = '',
    String quantity = '',
    ItemCategory? category,
  }) : nameController = TextEditingController(text: name),
       quantityController = TextEditingController(text: quantity),
       // 原典 addIngredient の既定カテゴリは `other_food`。
       category = category ?? ItemCategory.otherFood;

  final TextEditingController nameController;
  final TextEditingController quantityController;
  ItemCategory category;

  void dispose() {
    nameController.dispose();
    quantityController.dispose();
  }
}

class _MealFormSheetState extends ConsumerState<MealFormSheet> {
  late final TextEditingController _titleController;
  late MealType _mealType;
  late String _date;
  late bool _isEatingOut;
  late final List<_IngredientEntry> _ingredients;

  bool _pending = false;
  bool _deleteConfirm = false;

  bool get _isEditing => widget.existing != null;

  @override
  void initState() {
    super.initState();
    final existing = widget.existing;
    // 編集 > prefill > 空 の優先順 (web `formInitialData` の三項分岐と同形)。
    final prefill = existing == null ? widget.prefill : null;
    _titleController = TextEditingController(
      text: existing?.title ?? prefill?.title ?? '',
    );
    _mealType = existing?.mealType ?? widget.defaultMealType;
    _date = existing?.date ?? widget.defaultDate;
    _isEatingOut = existing?.isEatingOut ?? false;
    _ingredients = [
      for (final ing
          in existing?.ingredients ??
              prefill?.ingredients ??
              const <MealIngredient>[])
        _IngredientEntry(
          name: ing.name,
          quantity: ing.quantity ?? '',
          category: ing.category,
        ),
    ];
  }

  @override
  void dispose() {
    _titleController.dispose();
    for (final entry in _ingredients) {
      entry.dispose();
    }
    super.dispose();
  }

  void _addIngredient() {
    setState(() => _ingredients.add(_IngredientEntry()));
  }

  void _removeIngredient(int index) {
    setState(() {
      final removed = _ingredients.removeAt(index);
      removed.dispose();
    });
  }

  Future<void> _pickDate() async {
    final p = _date.split('-');
    final initial = DateTime(
      int.parse(p[0]),
      int.parse(p[1]),
      int.parse(p[2]),
    );
    final picked = await showDatePicker(
      context: context,
      initialDate: initial,
      firstDate: DateTime(2020),
      lastDate: DateTime(initial.year + 2, 12, 31),
    );
    if (picked == null || !mounted) return;
    // y/m/d の数値だけを使い "YYYY-MM-DD" に再構成する (TZ 非依存 — UTC 罠回避)。
    final ymd =
        '${picked.year.toString().padLeft(4, '0')}-'
        '${picked.month.toString().padLeft(2, '0')}-'
        '${picked.day.toString().padLeft(2, '0')}';
    setState(() => _date = ymd);
  }

  /// 原典 handleSubmit と同じ前処理: title を trim、名前が空の食材行は除外
  /// (insert される name は原典どおり raw 値)。
  List<MealIngredient> _validIngredients() {
    return [
      for (final entry in _ingredients)
        if (entry.nameController.text.trim().isNotEmpty)
          MealIngredient(
            name: entry.nameController.text,
            quantity: entry.quantityController.text,
            category: entry.category,
          ),
    ];
  }

  Future<void> _save() async {
    final title = _titleController.text.trim();
    if (title.isEmpty || _pending) return; // ボタン disabled の防御線

    final ingredients = _validIngredients();
    await _run(
      action: (ctx, repo) async {
        if (_isEditing) {
          await repo.updateMeal(
            householdId: ctx.householdId,
            mealId: widget.existing!.id,
            date: _date,
            mealType: _mealType,
            title: title,
            isEatingOut: _isEatingOut,
            ingredients: ingredients,
          );
        } else {
          await repo.createMeal(
            householdId: ctx.householdId,
            userId: ctx.userId,
            date: _date,
            mealType: _mealType,
            title: title,
            isEatingOut: _isEatingOut,
            ingredients: ingredients,
          );
        }
      },
      successMessage: _isEditing ? '献立を更新しました' : '献立を追加しました',
      // 原典 actions.ts の汎用エラー文言と同一。
      errorMessage: _isEditing ? '献立の更新に失敗しました。' : '献立の作成に失敗しました。もう一度お試しください。',
    );
  }

  Future<void> _delete() async {
    final existing = widget.existing;
    if (existing == null) return;
    await _run(
      action: (ctx, repo) => repo.deleteMeal(
        householdId: ctx.householdId,
        mealId: existing.id,
      ),
      successMessage: '献立を削除しました',
      errorMessage: '献立の削除に失敗しました。',
    );
  }

  /// 「テンプレートから作成」: 選択ダイアログを開き、選択された prefill で
  /// メニュー名 + 食材リストを置換する (原典 handleTemplateSelect は
  /// `setTitle` + `setIngredients` の全置換)。
  Future<void> _openTemplateSelector() async {
    if (_pending) return;
    final prefill = await showTemplateSelectorDialog(context, ref);
    if (prefill == null || !mounted) return;

    setState(() {
      _titleController.text = prefill.title;
      for (final entry in _ingredients) {
        entry.dispose();
      }
      _ingredients
        ..clear()
        ..addAll([
          for (final ing in prefill.ingredients)
            _IngredientEntry(
              name: ing.name,
              quantity: ing.quantity ?? '',
              category: ing.category,
            ),
        ]);
    });
  }

  /// 「テンプレート保存」(編集時のみ): 既存献立をテンプレート化する。
  /// 原典 handleSaveAsTemplate と同じく **sheet は閉じない** ため、
  /// [_run] (成功時 pop) は使わない。一覧の template_id リンク反映は
  /// meals の realtime UPDATE → 週 notifier の refetch で届く
  /// (web の revalidatePath("/meals") 相当)。
  Future<void> _saveAsTemplate() async {
    final existing = widget.existing;
    if (existing == null || _pending) return;
    setState(() => _pending = true);

    final messenger = ScaffoldMessenger.of(context);

    try {
      final mutationContext = await ref.read(
        mealsMutationContextProvider.future,
      );
      await ref
          .read(mealsRepositoryProvider)
          .saveAsTemplate(
            householdId: mutationContext.householdId,
            userId: mutationContext.userId,
            mealId: existing.id,
          );
      if (!mounted) return;
      messenger.showSnackBar(
        const SnackBar(content: Text('テンプレートとして保存しました')),
      );
    } on Object catch (e, st) {
      // 握り潰さない (CLAUDE.md)。repository 側でも構造化ログ済み。
      debugPrint('MealFormSheet saveAsTemplate 失敗: $e\n$st');
      if (!mounted) return;
      messenger.showSnackBar(
        const SnackBar(content: Text('テンプレートの保存に失敗しました。')),
      );
    } finally {
      if (mounted) setState(() => _pending = false);
    }
  }

  Future<void> _run({
    required Future<void> Function(
      MealsMutationContext context,
      MealsRepository repo,
    )
    action,
    required String successMessage,
    required String errorMessage,
  }) async {
    if (_pending) return;
    setState(() => _pending = true);

    final messenger = ScaffoldMessenger.of(context);
    final navigator = Navigator.of(context);

    try {
      final mutationContext = await ref.read(
        mealsMutationContextProvider.future,
      );
      final repo = ref.read(mealsRepositoryProvider);
      await action(mutationContext, repo);
      // 一覧反映は F1 の realtime refetch でも届くが、自分の操作の体感速度の
      // ため明示的に refetch を蹴る (notifier に公開 refetch API は無いため
      // invalidate — baby form sheet と同じ流儀)。
      ref.invalidate(mealsWeekNotifierProvider);
      if (!mounted) return;
      navigator.pop();
      messenger.showSnackBar(SnackBar(content: Text(successMessage)));
    } on DuplicateMealException {
      // UNIQUE(household, date, meal_type) 違反は専用文言 (原典と同一)。
      if (!mounted) return;
      messenger.showSnackBar(
        const SnackBar(content: Text(DuplicateMealException.message)),
      );
    } on Object catch (e, st) {
      // 握り潰さない (CLAUDE.md)。repository 側でも構造化ログ済み。
      debugPrint('MealFormSheet mutation 失敗: $e\n$st');
      if (!mounted) return;
      messenger.showSnackBar(SnackBar(content: Text(errorMessage)));
    } finally {
      if (mounted) setState(() => _pending = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final title = _isEditing ? '献立を編集' : '献立を追加';
    final description = _isEditing ? '内容を変更して保存してください' : 'メニューと食材を入力してください';
    final canSave = !_pending && _titleController.text.trim().isNotEmpty;

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
                    // テンプレート 2 ボタン (原典 "Template button" 行 —
                    // 保存ボタンは編集時のみ)。
                    Wrap(
                      spacing: 8,
                      runSpacing: 8,
                      children: [
                        OutlinedButton.icon(
                          onPressed: _pending ? null : _openTemplateSelector,
                          icon: const Icon(LucideIcons.bookOpen, size: 14),
                          label: const Text('テンプレートから作成'),
                          style: OutlinedButton.styleFrom(
                            minimumSize: const Size(44, 44),
                            foregroundColor: IroriColors.textPrimary,
                            shape: RoundedRectangleBorder(
                              borderRadius: BorderRadius.circular(
                                IroriRadii.button,
                              ),
                            ),
                          ),
                        ),
                        if (_isEditing)
                          OutlinedButton.icon(
                            onPressed: _pending ? null : _saveAsTemplate,
                            icon: const Icon(LucideIcons.bookMarked, size: 14),
                            label: const Text('テンプレート保存'),
                            style: OutlinedButton.styleFrom(
                              minimumSize: const Size(44, 44),
                              foregroundColor: IroriColors.textPrimary,
                              shape: RoundedRectangleBorder(
                                borderRadius: BorderRadius.circular(
                                  IroriRadii.button,
                                ),
                              ),
                            ),
                          ),
                      ],
                    ),
                    const SizedBox(height: 16),
                    const _Label('メニュー名'),
                    TextField(
                      controller: _titleController,
                      enabled: !_pending,
                      autocorrect: false,
                      decoration: const InputDecoration(
                        hintText: '例: カレーライス',
                        border: OutlineInputBorder(),
                      ),
                      // 保存ボタンの enabled/disabled を追従させる。
                      onChanged: (_) => setState(() {}),
                    ),
                    const SizedBox(height: 16),
                    const _Label('食事タイプ'),
                    SegmentedButton<MealType>(
                      selected: {_mealType},
                      onSelectionChanged: _pending
                          ? null
                          : (selected) {
                              setState(() => _mealType = selected.single);
                            },
                      segments: [
                        for (final type in MealType.values)
                          ButtonSegment(
                            value: type,
                            label: Text(mealTypeLabel(type)),
                          ),
                      ],
                    ),
                    const SizedBox(height: 16),
                    const _Label('日付'),
                    OutlinedButton.icon(
                      onPressed: _pending ? null : _pickDate,
                      icon: const Icon(LucideIcons.calendar, size: 16),
                      label: Text(formatMealDayHeader(_date)),
                      style: OutlinedButton.styleFrom(
                        minimumSize: const Size.fromHeight(44),
                        alignment: Alignment.centerLeft,
                        foregroundColor: IroriColors.textPrimary,
                        shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(
                            IroriRadii.button,
                          ),
                        ),
                      ),
                    ),
                    const SizedBox(height: 16),
                    // 外食トグル (原典 `bg-muted/50 p-3 rounded-lg` の行)。
                    Container(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 12,
                        vertical: 4,
                      ),
                      decoration: BoxDecoration(
                        color: IroriColors.muted.withValues(alpha: 0.5),
                        borderRadius: BorderRadius.circular(IroriRadii.button),
                      ),
                      child: Row(
                        mainAxisAlignment: MainAxisAlignment.spaceBetween,
                        children: [
                          Text(
                            '外食',
                            style: Theme.of(context).textTheme.labelLarge,
                          ),
                          Switch(
                            value: _isEatingOut,
                            onChanged: _pending
                                ? null
                                : (checked) {
                                    setState(() => _isEatingOut = checked);
                                  },
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(height: 16),
                    Row(
                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                      children: [
                        const _Label('食材', bottomPadding: 0),
                        TextButton.icon(
                          onPressed: _pending ? null : _addIngredient,
                          icon: const Icon(LucideIcons.plus, size: 14),
                          label: const Text('追加'),
                          style: TextButton.styleFrom(
                            minimumSize: const Size(44, 44),
                            foregroundColor: IroriColors.primary,
                          ),
                        ),
                      ],
                    ),
                    if (_ingredients.isEmpty)
                      // 原典の破線 empty ボタン相当 (淡い実線 border で近似)。
                      OutlinedButton.icon(
                        onPressed: _pending ? null : _addIngredient,
                        icon: const Icon(LucideIcons.plus, size: 16),
                        label: const Text('食材を追加'),
                        style: OutlinedButton.styleFrom(
                          minimumSize: const Size.fromHeight(48),
                          foregroundColor: IroriColors.textMuted,
                          side: BorderSide(
                            color: IroriColors.border.withValues(alpha: 0.6),
                          ),
                          shape: RoundedRectangleBorder(
                            borderRadius: BorderRadius.circular(
                              IroriRadii.button,
                            ),
                          ),
                        ),
                      )
                    else
                      Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          for (var i = 0; i < _ingredients.length; i++) ...[
                            if (i > 0) const SizedBox(height: 8),
                            MealIngredientFields(
                              nameController: _ingredients[i].nameController,
                              quantityController:
                                  _ingredients[i].quantityController,
                              category: _ingredients[i].category,
                              enabled: !_pending,
                              onCategoryChanged: (category) {
                                setState(
                                  () => _ingredients[i].category = category,
                                );
                              },
                              onRemove: () => _removeIngredient(i),
                            ),
                          ],
                        ],
                      ),
                    if (_isEditing) ...[
                      const SizedBox(height: 8),
                      const Divider(),
                      if (_deleteConfirm)
                        Row(
                          children: [
                            const Expanded(
                              child: Text(
                                '本当に削除しますか？',
                                style: TextStyle(color: IroriColors.error),
                              ),
                            ),
                            TextButton(
                              onPressed: _pending
                                  ? null
                                  : () => setState(
                                      () => _deleteConfirm = false,
                                    ),
                              child: const Text('キャンセル'),
                            ),
                            FilledButton.tonal(
                              onPressed: _pending ? null : _delete,
                              child: const Text('削除する'),
                            ),
                          ],
                        )
                      else
                        TextButton.icon(
                          onPressed: _pending
                              ? null
                              : () => setState(() => _deleteConfirm = true),
                          icon: const Icon(LucideIcons.trash2, size: 16),
                          label: const Text('この献立を削除'),
                          style: TextButton.styleFrom(
                            foregroundColor: IroriColors.error,
                          ),
                        ),
                    ],
                  ],
                ),
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(24, 8, 24, 24),
              child: FilledButton(
                onPressed: canSave ? _save : null,
                style: FilledButton.styleFrom(
                  minimumSize: const Size.fromHeight(44),
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(IroriRadii.button),
                  ),
                ),
                child: _pending
                    ? Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          const SizedBox.square(
                            dimension: 20,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          ),
                          const SizedBox(width: 8),
                          Text(_isEditing ? '更新中...' : '追加中...'),
                        ],
                      )
                    : Text(_isEditing ? '更新する' : '追加する'),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _Label extends StatelessWidget {
  const _Label(this.text, {this.bottomPadding = 8});

  final String text;
  final double bottomPadding;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.only(bottom: bottomPadding),
      child: Text(text, style: Theme.of(context).textTheme.labelLarge),
    );
  }
}
