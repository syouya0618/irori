/// baby ダッシュボード表示専用の純粋ユーティリティ群。
///
/// Next.js 原典の翻訳:
/// - `src/lib/utils/baby-log-labels.ts` (ラベル / 経過時間 / 分差)
/// - `src/lib/utils/date-jst.ts` の `formatTimeJst`
/// - `src/components/baby/baby-date-nav.tsx` の `formatDateLabel`
/// - `src/components/baby/baby-timeline-item.tsx` の `getLogSummary`
///
/// すべて副作用なしの純粋関数として切り出し、単体テストで網羅する
/// (タスク TDD 方針 / advisor 指摘: summary・日付ラベルは port が黙って
/// 乖離しやすい高リスク箇所)。
library;

import 'package:intl/intl.dart';

import '../domain/baby_log.dart';

/// JST (Asia/Tokyo, UTC+9) 固定オフセット。
///
/// `baby_repository.dart` の `_kJstOffset` と同一の流儀。端末 TZ に依存せず
/// JST 壁時計を得るため、UTC へ正規化してから +9h する
/// (CLAUDE.md「`new Date('YYYY-MM-DD')` UTC 罠回避」)。
const _kJstOffset = Duration(hours: 9);

/// `BabyLogType` の日本語ラベル。原典 `logTypeLabels` と一致。
String babyLogTypeLabel(BabyLogType type) {
  switch (type) {
    case BabyLogType.feeding:
      return '授乳';
    case BabyLogType.diaper:
      return 'おむつ';
    case BabyLogType.sleep:
      return '睡眠';
    case BabyLogType.temperature:
      return '体温';
    case BabyLogType.growth:
      return '成長記録';
    case BabyLogType.memo:
      return 'メモ';
  }
}

/// `FeedingType` の日本語ラベル。原典 `feedingTypeLabels` と一致。
String feedingTypeLabel(FeedingType type) {
  switch (type) {
    case FeedingType.breastLeft:
      return '左';
    case FeedingType.breastRight:
      return '右';
    case FeedingType.bottle:
      return 'ミルク';
    case FeedingType.solid:
      return '離乳食';
  }
}

/// `DiaperType` の日本語ラベル。原典 `diaperTypeLabels` と一致。
String diaperTypeLabel(DiaperType type) {
  switch (type) {
    case DiaperType.pee:
      return 'おしっこ';
    case DiaperType.poop:
      return 'うんち';
    case DiaperType.both:
      return '両方';
  }
}

/// 経過分を "X分" / "X時間" / "X時間Y分" に整形する。原典 `formatElapsedMinutes`。
///
/// 原典同様、負値の特別扱いはしない (pass-through)。`minutesBetween` の
/// clock skew で負になりうるが、原典の挙動を忠実に再現する (advisor 指摘 #4)。
String formatElapsedMinutes(int minutes) {
  if (minutes < 60) return '$minutes分';
  final h = minutes ~/ 60;
  final m = minutes % 60;
  return m > 0 ? '$h時間$m分' : '$h時間';
}

/// 2 つの時刻の分差 (to - from) を四捨五入で返す。原典 `minutesBetween`。
///
/// 原典は ISO 文字列を受けるが、Flutter 側は `DateTime` を直接受ける。
/// `Duration.inMinutes` は切り捨てのため、原典の `Math.round` に合わせ
/// ミリ秒差から手動で四捨五入する。
int minutesBetween(DateTime from, DateTime to) {
  final diffMs = to.difference(from).inMilliseconds;
  return (diffMs / 60000).round();
}

/// JST の "HH:mm" を返す。原典 `formatTimeJst`。
///
/// `baby_repository.dart` 同様、UTC 正規化 + 固定 +9h で端末 TZ 非依存にする
/// (`DateFormat('HH:mm')` を JST 壁時計の DateTime に適用)。
String formatTimeJst(DateTime dateTime) {
  final jst = dateTime.toUtc().add(_kJstOffset);
  return DateFormat('HH:mm').format(jst);
}

/// "YYYY-MM-DD" (JST) を "今日" / "昨日" / "M/D（曜）" に整形する。
/// 原典 `formatDateLabel` (`baby-date-nav.tsx`)。
///
/// - [todayYmd] を**渡す**と「今日」基準をその日に固定する (純粋・決定的)。
///   ウィジェット (`BabyDateNav`) は必ず `formatJstDate()` を渡す。時刻非依存
///   テストも常に [todayYmd] を渡すこと。省略時は内部で `formatJstDate()` を
///   使うが、その経路は現在時刻依存になる (CLAUDE.md「検証可能性」)。
/// - 曜日は原典の `["日","月","火","水","木","金","土"]` 配列を踏襲。
///   原典は `Date.UTC(y,m-1,d).getUTCDay()` (Sun=0..Sat=6) を使うが、
///   Dart の `DateTime.weekday` は Mon=1..Sun=7 のため、`% 7` で
///   Sun=0..Sat=6 に変換してから配列を引く (advisor 指摘 #3: index mapping)。
String formatBabyDateLabel(String ymd, {String? todayYmd}) {
  final today = todayYmd ?? _todayJst();
  final diff = _daysBetweenYmd(today, ymd);
  if (diff == 0) return '今日';
  if (diff == -1) return '昨日';

  final parts = ymd.split('-');
  final y = int.parse(parts[0]);
  final m = int.parse(parts[1]);
  final d = int.parse(parts[2]);
  // DateTime.utc で TZ 非依存に曜日を求める (原典 Date.UTC と同義)。
  final dt = DateTime.utc(y, m, d);
  // Dart weekday: Mon=1..Sun=7 → `% 7` で Sun=0,Mon=1,..,Sat=6。
  final weekdayIndex = dt.weekday % 7;
  const weekdays = ['日', '月', '火', '水', '木', '金', '土'];
  return '$m/$d（${weekdays[weekdayIndex]}）';
}

/// タイムライン 1 行の要約文字列。原典 `getLogSummary` を忠実に移植。
String getLogSummary(BabyLog log) {
  switch (log.logType) {
    case BabyLogType.feeding:
      final ft = log.feedingType;
      if (ft == null) return '授乳';
      final parts = <String>[feedingTypeLabel(ft)];
      // 原典は `if (log.amount_ml)` = falsy 判定。0ml は表示しない挙動を維持。
      if (log.amountMl != null && log.amountMl != 0) {
        parts.add('${log.amountMl}ml');
      }
      if (log.durationMin != null && log.durationMin != 0) {
        parts.add('${log.durationMin}分');
      }
      return parts.join(' ');
    case BabyLogType.diaper:
      final dt = log.diaperType;
      return dt != null ? diaperTypeLabel(dt) : 'おむつ';
    case BabyLogType.sleep:
      final endedAt = log.endedAt;
      if (endedAt != null) {
        return formatElapsedMinutes(minutesBetween(log.loggedAt, endedAt));
      }
      return '睡眠中...';
    case BabyLogType.temperature:
      final t = log.temperature;
      return t != null ? '${_formatNumberJsLike(t)}℃' : '体温';
    case BabyLogType.growth:
      final parts = <String>[];
      if (log.weightG != null) parts.add('${log.weightG}g');
      if (log.heightCm != null) {
        parts.add('${_formatNumberJsLike(log.heightCm!)}cm');
      }
      return parts.isNotEmpty ? parts.join(' / ') : '成長記録';
    case BabyLogType.memo:
      final memo = log.memo;
      if (memo == null || memo.isEmpty) return 'メモ';
      // 原典 `memo.slice(0, 20)` 相当。Dart の substring で範囲ガード。
      return memo.length > 20 ? memo.substring(0, 20) : memo;
  }
}

/// `double` を JS の `${number}` (= `Number.prototype.toString`) 相当で文字列化。
///
/// 原典 `getLogSummary` は `${log.temperature}℃` / `${log.height_cm}cm` のように
/// JS number をテンプレートに埋める。JS は `(37.0).toString() === "37"` で
/// 整数値の trailing `.0` を落とすが、Dart の `double.toString()` は `"37.0"` を
/// 残す (検証済み: 37.0→"37.0", 58.0→"58.0")。これを揃えないと whole-number の
/// 体温/身長で `37.0℃` vs `37℃` の silent な表示乖離が出る (advisor 指摘 #4)。
///
/// 整数なら小数点以下を落とし、そうでなければ通常の `toString()`。
/// (Postgres numeric は有効桁を保つため任意精度小数になりうるが、原典 JS の
/// `${n}` も同じく `toString()` 既定挙動でレンダリングするので一致する。)
String _formatNumberJsLike(double value) {
  if (value == value.truncateToDouble() && value.isFinite) {
    return value.toInt().toString();
  }
  return value.toString();
}

/// 今日 (JST) の "YYYY-MM-DD"。`baby_repository.dart` の `formatJstDate` と同義
/// (このファイル内で完結させ循環依存を避ける)。
String _todayJst() {
  final jst = DateTime.now().toUtc().add(_kJstOffset);
  return DateFormat('yyyy-MM-dd').format(jst);
}

/// 2 つの YYYY-MM-DD の日数差 (to - from)。TZ 非依存。
/// 原典 `daysBetweenYmd` (`date-jst.ts`) を `DateTime.utc` で移植。
int _daysBetweenYmd(String fromYmd, String toYmd) {
  final f = fromYmd.split('-');
  final t = toYmd.split('-');
  final fromMs = DateTime.utc(
    int.parse(f[0]),
    int.parse(f[1]),
    int.parse(f[2]),
  ).millisecondsSinceEpoch;
  final toMs = DateTime.utc(
    int.parse(t[0]),
    int.parse(t[1]),
    int.parse(t[2]),
  ).millisecondsSinceEpoch;
  return ((toMs - fromMs) / Duration.millisecondsPerDay).round();
}
