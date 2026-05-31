import '../domain/baby_log.dart';

/// `deriveBabySummary` の結果。Next.js 原典 `baby-dashboard.tsx` L182-206 の
/// `useMemo` 戻り値 (`activeSleep`/`lastFeeding`/`diaperCount`/
/// `derivedLastSleepEndedAt`) に 1:1 対応する。
class BabySummary {
  const BabySummary({
    required this.activeSleep,
    required this.lastFeeding,
    required this.diaperCount,
    required this.derivedLastSleepEndedAt,
  });

  /// 進行中 (ended_at == null) の最初の睡眠ログ。なければ null。
  final BabyLog? activeSleep;

  /// 最初の授乳ログ。なければ null。
  final BabyLog? lastFeeding;

  /// おむつログの件数。
  final int diaperCount;

  /// 完了済み (ended_at != null) の最初の睡眠の終了時刻。なければ null。
  final DateTime? derivedLastSleepEndedAt;
}

/// 表示中日付のログ一覧からサマリーを 1 パスで導出する純粋関数。
///
/// 原典 (`baby-dashboard.tsx` L182-206) の単一ループを忠実に移植:
/// - [logs] は `logged_at` 降順前提 (`babyLogsNotifierProvider` がそう保つ)。
///   よって「最初に見つかった = 最新」。
/// - `activeSleep`: 最初の (= 最新の) sleep かつ ended_at == null。
/// - `derivedLastSleepEndedAt`: 最初の (= 最新の) sleep かつ ended_at != null。
/// - `lastFeeding`: 最初の (= 最新の) feeding。
/// - `diaperCount`: diaper ログの総数。
///
/// 副作用なし。advisor 指摘 #1: port が黙って乖離しやすい最高リスク箇所のため
/// pure 関数として切り出し、単体テストで網羅する。
BabySummary deriveBabySummary(List<BabyLog> logs) {
  BabyLog? activeSleep;
  BabyLog? lastFeeding;
  DateTime? derivedLastSleepEndedAt;
  var diaperCount = 0;

  for (final l in logs) {
    if (activeSleep == null &&
        l.logType == BabyLogType.sleep &&
        l.endedAt == null) {
      activeSleep = l;
    }
    if (derivedLastSleepEndedAt == null &&
        l.logType == BabyLogType.sleep &&
        l.endedAt != null) {
      derivedLastSleepEndedAt = l.endedAt;
    }
    if (lastFeeding == null && l.logType == BabyLogType.feeding) {
      lastFeeding = l;
    }
    if (l.logType == BabyLogType.diaper) diaperCount++;
  }

  return BabySummary(
    activeSleep: activeSleep,
    lastFeeding: lastFeeding,
    diaperCount: diaperCount,
    derivedLastSleepEndedAt: derivedLastSleepEndedAt,
  );
}
