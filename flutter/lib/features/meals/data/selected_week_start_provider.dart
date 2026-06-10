import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/utils/jst_date.dart';

/// 献立画面で「表示中の週」(その週の月曜の YYYY-MM-DD, JST) を保持する
/// Notifier。Next.js 原典 `meal-week-view.tsx` の `weekStart` state +
/// `goToPreviousWeek` / `goToNextWeek` / `goToCurrentWeek` に相当する。
///
/// 日付演算はすべて F0 の `jst_date.dart` (YMD 文字列 + `DateTime.utc` の
/// 数値分解) で行い、`new Date('YYYY-MM-DD')` 由来の UTC 罠を避ける
/// (CLAUDE.md)。この値の変化で `MealsWeekNotifier.build()` が `ref.watch`
/// 経由で再実行され、表示週の献立を refetch する
/// (`selectedBabyDateProvider` と同じ作り)。
class SelectedWeekStartNotifier extends Notifier<String> {
  @override
  String build() => weekStartMonday(formatJstDate());

  /// 前週へ (原典 `addDays(weekStart, -7)`)。
  void previousWeek() {
    state = shiftYmd(state, -7);
  }

  /// 翌週へ (原典 `addDays(weekStart, 7)`)。
  void nextWeek() {
    state = shiftYmd(state, 7);
  }

  /// 今週 (JST 今日を含む週の月曜) へ戻す (原典 `getMonday(new Date())`)。
  void goToCurrentWeek() {
    state = weekStartMonday(formatJstDate());
  }
}

/// 表示中の献立週の月曜 (YYYY-MM-DD, JST) provider。
final selectedWeekStartProvider =
    NotifierProvider<SelectedWeekStartNotifier, String>(
      SelectedWeekStartNotifier.new,
    );

/// [weekStartYmd] が「今日 (JST) を含む週」の月曜か。
///
/// 原典 `meal-week-view.tsx` の `isCurrentWeek` (「今週へ戻る」ボタンの
/// 表示制御) に相当する純関数。F2 の UI で使う想定で provider 外に置く。
/// [now] はテスト容易性のための注入点 (`formatJstDate` と同じ規約)。
bool isCurrentWeekStart(String weekStartYmd, [DateTime? now]) =>
    weekStartYmd == weekStartMonday(formatJstDate(now));
