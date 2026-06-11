import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/theme/colors.dart';
import '../../../core/utils/jst_date.dart';
import '../../../widgets/glass_card.dart';
import '../data/meals_repository.dart';
import '../data/meals_week_notifier.dart';
import '../data/pending_template_prefill_provider.dart';
import '../data/selected_week_start_provider.dart';
import '../domain/meal.dart';
import 'meal_display_utils.dart';
import 'widgets/meal_day_section.dart';
import 'widgets/meal_form_sheet.dart';
import 'widgets/meal_week_nav.dart';

/// 献立週ビュー。Next.js 原典 `meal-week-view.tsx` (+ `meals/page.tsx`) の
/// 表示側を移植。
///
/// 表示構成 (縦): WeekNav → (空週なら空状態) → 7 日分の DaySection。
/// 各日は朝・昼・夕の 3 スロット (snack は Phase 2.5)。
///
/// データ:
/// - `mealsWeekNotifierProvider` を `.when(data/loading/error)` で消費
///   (`.future` は await しない — notifier の doc コメント参照)。
/// - 週切替は `selectedWeekStartProvider` 経由。reload 中は
///   `skipLoadingOnReload: true` で前週データを保持する (baby と同じ流儀)。
/// - 書き込みは sheet (F2) → `MealsRepository`。成功時の一覧反映は
///   sheet 側の invalidate + F1 realtime refetch。
/// - 在庫タブ「献立に追加」(P2.5-F) は [pendingTemplatePrefillProvider] 経由で
///   届き、1 回だけ消費して sheet をプリフィル open する
///   (web `meal-week-view.tsx:66-100` の `?template=` 処理に相当)。
class MealsPage extends ConsumerWidget {
  const MealsPage({super.key});

  /// prefill を 1 回だけ取り出して sheet を開く (web: 今日 + dinner +
  /// prefill で open)。`consume()` が atomically null へ戻すため、listen と
  /// post-frame の二重経路・再 build でも 2 回目以降は no-op
  /// (web `hasProcessedUrlTemplate` ref + `router.replace` 相当)。
  void _consumePrefill(BuildContext context, WidgetRef ref) {
    final prefill = ref.read(pendingTemplatePrefillProvider.notifier).consume();
    if (prefill == null) return;
    showMealFormSheet(
      context,
      ref,
      date: formatJstDate(),
      mealType: MealType.dinner,
      prefill: prefill,
    );
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final mealsAsync = ref.watch(mealsWeekNotifierProvider);

    // ページ生存中 (IndexedStack で常駐) に在庫タブから積まれた prefill を
    // 消費する。listen は変化時のみ発火するため、本ページの初回 build より
    // 前に積まれていた分は post-frame で別途拾う (下)。
    ref.listen(pendingTemplatePrefillProvider, (_, next) {
      if (next == null) return;
      _consumePrefill(context, ref);
    });
    if (ref.read(pendingTemplatePrefillProvider) != null) {
      // build 中は Navigator 操作 (sheet open) ができないため初回 frame 後に
      // 消費する。複数回スケジュールされても consume() の 1 回消費保証で
      // 2 回目以降は no-op。
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (context.mounted) _consumePrefill(context, ref);
      });
    }

    return Scaffold(
      appBar: AppBar(title: const Text('献立')),
      body: SafeArea(
        child: mealsAsync.when(
          skipLoadingOnReload: true,
          data: (meals) => _WeekBody(meals: meals),
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

/// data 分岐の本体。週ナビ + 空状態 + 7 日分のセクション。
class _WeekBody extends ConsumerWidget {
  const _WeekBody({required this.meals});

  final List<Meal> meals;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final weekStart = ref.watch(selectedWeekStartProvider);
    final currentWeek = isCurrentWeekStart(weekStart);
    final todayYmd = formatJstDate();

    // リアクションの自分判定用。解決前 (loading window) は null のまま描画し、
    // 解決後に rebuild される (認証済み前提ゆえ error は実質起きない)。
    final currentUserId = ref.watch(mealsMutationContextProvider).value?.userId;

    // 原典 mealMap (`${date}:${meal_type}` キー)。UNIQUE 制約により重複なし。
    final mealMap = <String, Meal>{
      for (final meal in meals) '${meal.date}:${meal.mealType.name}': meal,
    };

    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 32),
      children: [
        const MealWeekNav(),
        const SizedBox(height: 12),
        // 原典: ロード中でなく今週で 1 件も無いときだけ空状態を出す。
        if (meals.isEmpty && currentWeek) ...[
          const GlassCard(
            padding: EdgeInsets.all(24),
            child: Text(
              '今週の献立はまだありません。タップして追加しましょう！',
              textAlign: TextAlign.center,
              style: TextStyle(fontSize: 13, color: IroriColors.textMuted),
            ),
          ),
          const SizedBox(height: 8),
        ],
        for (var i = 0; i < 7; i++) ...[
          if (i > 0) const SizedBox(height: 8),
          _daySection(
            context,
            ref,
            mealMap,
            shiftYmd(weekStart, i),
            todayYmd,
            currentUserId,
          ),
        ],
      ],
    );
  }

  Widget _daySection(
    BuildContext context,
    WidgetRef ref,
    Map<String, Meal> mealMap,
    String date,
    String todayYmd,
    String? currentUserId,
  ) {
    return MealDaySection(
      date: date,
      isToday: date == todayYmd,
      mealsByType: {
        for (final type in weekViewMealTypes)
          if (mealMap['$date:${type.name}'] != null)
            type: mealMap['$date:${type.name}']!,
      },
      currentUserId: currentUserId,
      onCreateSlot: (date, mealType) {
        showMealFormSheet(context, ref, date: date, mealType: mealType);
      },
      onEditMeal: (meal) {
        showMealFormSheet(
          context,
          ref,
          date: meal.date,
          mealType: meal.mealType,
          existing: meal,
        );
      },
    );
  }
}

/// error 分岐。読み込み失敗の告知 + 再試行ボタン (baby `_ErrorView` の流儀 +
/// refetch 再実行ボタン)。
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
            '献立の読み込みに失敗しました。',
            style: Theme.of(context).textTheme.bodyLarge,
          ),
          const SizedBox(height: 8),
          Text('$error', style: Theme.of(context).textTheme.bodySmall),
          const SizedBox(height: 16),
          FilledButton.tonal(
            onPressed: () => ref.invalidate(mealsWeekNotifierProvider),
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
