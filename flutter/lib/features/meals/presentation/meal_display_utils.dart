/// 献立 UI の表示用ラベル・日付フォーマッタ。
///
/// Next.js 原典:
/// - `src/lib/utils/meal-types.ts` (MEAL_TYPE_LABELS / MEAL_TYPE_SHORT_LABELS)
/// - `src/components/meals/meal-week-view.tsx`
///   (DAY_NAMES / formatDayHeader / formatWeekRange / WEEK_VIEW_MEAL_TYPES)
///
/// 日付は `core/utils/jst_date.dart` と同じく "YYYY-MM-DD" 文字列のまま扱い、
/// 演算は `DateTime.utc` の数値分解で行う (UTC 罠回避 / CLAUDE.md)。
library;

import '../../../core/utils/jst_date.dart';
import '../domain/meal.dart';

/// 週ビューに表示する 3 食。原典 `WEEK_VIEW_MEAL_TYPES`
/// (「週ビューは snack を除く3食のみ表示する」)。snack スロットは Phase 2.5。
const List<MealType> weekViewMealTypes = [
  MealType.breakfast,
  MealType.lunch,
  MealType.dinner,
];

/// 食事タイプの日本語ラベル。原典 `MEAL_TYPE_LABELS` と同一文言。
String mealTypeLabel(MealType type) {
  switch (type) {
    case MealType.breakfast:
      return '朝食';
    case MealType.lunch:
      return '昼食';
    case MealType.dinner:
      return '夕食';
    case MealType.snack:
      return '間食';
  }
}

/// 食事タイプの短縮ラベル。原典 `MEAL_TYPE_SHORT_LABELS` と同一文言。
String mealTypeShortLabel(MealType type) {
  switch (type) {
    case MealType.breakfast:
      return '朝';
    case MealType.lunch:
      return '昼';
    case MealType.dinner:
      return '夕';
    case MealType.snack:
      return '間';
  }
}

/// 原典 `DAY_NAMES` (月曜始まり)。
const List<String> _dayNames = ['月', '火', '水', '木', '金', '土', '日'];

/// "YYYY-MM-DD" を数値分解する (`jst_date.dart` の private `_parseYmd` と
/// 同じ規約 — 形式不正は握り潰さず `ArgumentError`)。
({int year, int month, int day}) _parseYmd(String ymd) {
  final parts = ymd.split('-');
  if (parts.length != 3 ||
      parts[0].length != 4 ||
      parts[1].length != 2 ||
      parts[2].length != 2) {
    throw ArgumentError.value(ymd, 'ymd', 'YYYY-MM-DD 形式ではない');
  }
  return (
    year: int.parse(parts[0]),
    month: int.parse(parts[1]),
    day: int.parse(parts[2]),
  );
}

/// 日見出し「6/8（月）」。原典 `formatDayHeader`
/// (`Intl.DateTimeFormat("ja-JP", { month: "numeric", day: "numeric" })`
/// = "6/8" + 全角括弧の曜日)。
String formatMealDayHeader(String ymd) {
  final p = _parseYmd(ymd);
  final weekday = DateTime.utc(p.year, p.month, p.day).weekday; // 月=1..日=7
  return '${p.month}/${p.day}（${_dayNames[weekday - 1]}）';
}

/// 週範囲「6月8日〜6月14日」。原典 `formatWeekRange`
/// (`Intl.DateTimeFormat("ja-JP", { month: "long", day: "numeric" })` を
/// 波ダッシュ U+301C で連結 — 原典の `〜` と同一コードポイント)。
String formatWeekRange(String weekStartYmd) {
  final start = _parseYmd(weekStartYmd);
  final end = _parseYmd(shiftYmd(weekStartYmd, 6));
  return '${start.month}月${start.day}日〜${end.month}月${end.day}日';
}
