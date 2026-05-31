import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'baby_repository.dart';

/// baby ダッシュボードで「表示中の日付」(YYYY-MM-DD, JST) を保持する Notifier。
///
/// Next.js 原典 (`baby-dashboard.tsx`) の `selectedDate` state に相当
/// (Issue #54 日付ナビゲーション)。デフォルトは今日 (JST)。
///
/// 日付演算はすべて `shiftYmd` (= `DateTime.utc` の数値分解) で行い、
/// `new DateTime('YYYY-MM-DD')` 由来の UTC 罠を避ける (CLAUDE.md)。
/// この値の変化で `BabyLogsNotifier.build()` が `ref.watch` 経由で再実行され、
/// 指定日のログを refetch する。
class SelectedBabyDateNotifier extends Notifier<String> {
  @override
  String build() => formatJstDate();

  /// 指定した YYYY-MM-DD (JST) を表示日に設定する。
  /// 形式不正は `shiftYmd` 同様に弾く (`ArgumentError`) — 握り潰さない。
  void setDate(String dateJst) {
    // 形式検証は shiftYmd と同じ規則。0 日シフトで形式チェックを兼ねる
    // (不正なら ArgumentError が伝播する)。
    final normalized = shiftYmd(dateJst, 0);
    state = normalized;
  }

  /// 前日へ移動。
  void goToPreviousDay() {
    state = shiftYmd(state, -1);
  }

  /// 翌日へ移動。
  void goToNextDay() {
    state = shiftYmd(state, 1);
  }

  /// 今日 (JST) へ戻す。
  void goToToday() {
    state = formatJstDate();
  }
}

/// 表示中の baby ログ日付 (YYYY-MM-DD, JST) provider。
final selectedBabyDateProvider =
    NotifierProvider<SelectedBabyDateNotifier, String>(
      SelectedBabyDateNotifier.new,
    );
