/// 消耗品の消費レート算出 (純関数)。
///
/// Next.js 原典 `src/lib/domain/consumption-rate.ts` の移植 (Phase 2.5 PR-A)。
/// おむつ等の消耗品在庫の「あと N 日分」推定 (PR-G の残日数バッジ /
/// 低在庫自動追加) が消費する。
///
/// 意図的差異 (web parity の例外):
/// - `calculateMilkDailyMl` は移植しない — web 側に UI 消費者が存在しない
///   死にコード (grep 検証済: 定義 + `index.ts` re-export + テストのみ)。
///   ミルク残量機能が企画された時に移植する (Phase 2.5 計画の deferred)。
/// - それに伴い [ConsumptionLogInput] の `amount_ml` も省く (参照者が
///   `calculateMilkDailyMl` のみのため)。
library;

import '../../features/baby/domain/baby_log.dart' show BabyLogType;
import '../utils/jst_date.dart';

/// 消耗品レート算出の入力となるログの最小型。原典 `ConsumptionLogInput`。
///
/// 原典の `logged_at: string (ISO 8601)` は Dart では [DateTime] で受ける
/// (`BabyLog.loggedAt` が既に [DateTime] のため変換レスで渡せる。JST 日付化は
/// `formatJstDate` が UTC 変換込みで行う — instant として等価)。
class ConsumptionLogInput {
  const ConsumptionLogInput({required this.logType, required this.loggedAt});

  final BabyLogType logType;
  final DateTime loggedAt;
}

/// レート算出の設定。原典 `ConsumptionRateConfig`。
class ConsumptionRateConfig {
  const ConsumptionRateConfig({this.windowDays = 7});

  /// 計算対象の日数 (デフォルト 7 日)。
  final int windowDays;
}

/// 原典 `DEFAULT_RATE_CONFIG` (Dart 命名規約により lowerCamelCase)。
///
/// 値 (windowDays: 7) は `consumption_rate_test.dart` で web と同値である
/// ことを assert している。
const ConsumptionRateConfig defaultRateConfig = ConsumptionRateConfig();

/// ウィンドウ内のログを絞り込む。原典 `filterLogsInWindow`。
///
/// JST 日付文字列で半開区間 `(cutoff, today]` を判定する (YYYY-MM-DD の
/// 辞書順比較 = 時系列順)。呼び出し側 (PR-G) が DB から広めの期間を
/// prefetch しても、ここで JST 窓に再フィルタされるため結果は web と同一。
List<ConsumptionLogInput> _filterLogsInWindow(
  List<ConsumptionLogInput> logs,
  BabyLogType logType,
  DateTime today,
  ConsumptionRateConfig config,
) {
  final todayStr = formatJstDate(today);
  final cutoffStr = shiftYmd(todayStr, -config.windowDays);

  return [
    for (final log in logs)
      if (log.logType == logType)
        if (_isInRange(formatJstDate(log.loggedAt), cutoffStr, todayStr)) log,
  ];
}

/// `cutoff < logDate <= today` (原典の文字列比較 `>` / `<=` と同じ)。
bool _isInRange(String logDate, String cutoffStr, String todayStr) {
  return logDate.compareTo(cutoffStr) > 0 && logDate.compareTo(todayStr) <= 0;
}

/// ログ群からユニークな日付 (JST) 数をカウント。原典 `countUniqueDays`。
int _countUniqueDays(List<ConsumptionLogInput> logs) {
  return {for (final log in logs) formatJstDate(log.loggedAt)}.length;
}

/// 指定ログタイプの 1 日あたりの回数を算出する (過去 windowDays 日間)。
/// おむつ交換回数の算出に使用。
///
/// 実データがある日数を分母に使う (7 日窓でも 3 日分のデータなら ÷3)。
/// ログ 0 件の場合は null。
///
/// 原典 `calculateDailyRate`。[today] 省略時は現在時刻
/// (原典 `today: Date = new Date()`)。
double? calculateDailyRate(
  List<ConsumptionLogInput> logs,
  BabyLogType logType, {
  DateTime? today,
  ConsumptionRateConfig config = defaultRateConfig,
}) {
  final filtered = _filterLogsInWindow(
    logs,
    logType,
    today ?? DateTime.now(),
    config,
  );

  if (filtered.isEmpty) return null;

  final uniqueDays = _countUniqueDays(filtered);
  // filtered が非空なら uniqueDays >= 1 だが、原典の 0 割ガードを忠実に保つ。
  if (uniqueDays == 0) return null;

  return filtered.length / uniqueDays;
}

/// 在庫数量と日次消費レートから残日数を算出。
///
/// 戻り値は残日数 (小数切り捨て)。[dailyRate] が null または 0 以下の場合は
/// null。
///
/// **戻り値 0 は「今日切れ」の有効値** — null (レート算出不能) と意味が
/// 異なるため、利用側は `remaining == null` で判定すること。`remaining == 0`
/// を「無し」扱いする falsy 風判定を書くと、残 0 日の在庫が残日数バッジ・
/// 低在庫自動追加から漏れる (Phase 2.5 計画の risks / CLAUDE.md「数値の
/// デフォルト値 0 は falsy 判定と衝突」)。
///
/// 原典 `estimateRemainingDays`。[stockQuantity] は `StockItem.quantity` が
/// num (値保存 tolerant パーサ) のため num で受け、小数在庫も
/// JS `Math.floor` と同じ床計算になる。
int? estimateRemainingDays(num stockQuantity, num? dailyRate) {
  if (dailyRate == null || dailyRate <= 0) return null;
  if (stockQuantity <= 0) return 0;
  return (stockQuantity / dailyRate).floor();
}
