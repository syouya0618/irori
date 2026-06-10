/// JST (Asia/Tokyo) に基づく日付ユーティリティ。
///
/// Next.js 原典 `src/lib/utils/date-jst.ts` / `src/lib/utils/date.ts` の
/// Flutter 移植。`new Date('YYYY-MM-DD')` の UTC 罠 (CLAUDE.md) を避けるため、
/// 日付は "YYYY-MM-DD" 文字列レベルで扱い、演算は `DateTime.utc` の数値分解で
/// 行う — 端末 OS のタイムゾーンに一切依存しない。
///
/// 設計方針:
/// - 全関数は純関数。`DateTime.now()` を内部で呼ばない
///   (現在時刻が要る `formatJstDate` のみ、テスト容易性のため引数で受ける)。
/// - 形式不正は握り潰さず `ArgumentError` に倒す (`shiftYmd` の既存規約)。
///
/// 元実装: `features/baby/data/baby_repository.dart` (PR #54 / #63)。
/// Phase 2 (献立・買い物・在庫) で共用するため core へ移設した。
library;

import 'package:intl/intl.dart';

/// JST (Asia/Tokyo, UTC+9) 固定オフセット。
///
/// 日本は夏時間が無いため固定値で正しい。日付境界は「JST の 00:00:00」を
/// 明示的に扱い、`timestamptz` 比較には `+09:00` 付き ISO 文字列を使う。
const _kJstOffset = Duration(hours: 9);

/// "YYYY-MM-DD" を数値分解する。タイムゾーン非依存。
///
/// 原典 `date-jst.ts` の `parseYmd` 相当。原典は失敗時 null を返すが、
/// Dart 側は `shiftYmd` の既存規約 (握り潰さず `ArgumentError`) に合わせる。
({int year, int month, int day}) _parseYmd(String ymd, String name) {
  final parts = ymd.split('-');
  if (parts.length != 3 ||
      parts[0].length != 4 ||
      parts[1].length != 2 ||
      parts[2].length != 2) {
    throw ArgumentError.value(ymd, name, 'YYYY-MM-DD 形式ではない');
  }
  return (
    year: int.parse(parts[0]),
    month: int.parse(parts[1]),
    day: int.parse(parts[2]),
  );
}

/// JST の現在日付 (YYYY-MM-DD) を返す。
///
/// `DateTime.now().toUtc()` に +9h して壁時計の日付を取り出すことで、
/// 端末の OS タイムゾーンに依存せず JST 日界を決定する
/// (CLAUDE.md「UTC 罠回避 / JST 計算は明示的に」)。
String formatJstDate([DateTime? now]) {
  final utc = (now ?? DateTime.now()).toUtc();
  final jst = utc.add(_kJstOffset);
  return DateFormat('yyyy-MM-dd').format(jst);
}

/// "YYYY-MM-DD" 文字列を指定日数シフトする。タイムゾーン非依存。
///
/// Next.js 原典 `src/lib/utils/date-jst.ts` の `shiftYmd` を移植
/// (`new Date(Date.UTC(y, m-1, d+days))` → `DateTime.utc(y, m, d+days)`)。
/// `DateTime.utc` は day overflow/underflow を月・年へ正規化するため、
/// 月跨ぎ・年跨ぎ・閏年が JS Date と同じ結果になる。
///
/// `new DateTime('YYYY-MM-DD')` (= `DateTime.parse`) を使わず数値分解する
/// ことで、端末 TZ に依存しない (CLAUDE.md「UTC 罠回避」)。
/// 入力が YYYY-MM-DD 形式でなければ `ArgumentError` を投げる (握り潰さない)。
String shiftYmd(String ymd, int days) {
  final p = _parseYmd(ymd, 'ymd');
  final shifted = DateTime.utc(p.year, p.month, p.day + days);
  return DateFormat('yyyy-MM-dd').format(shifted);
}

/// [ymd] が属する週の月曜日 (YYYY-MM-DD) を返す。週は月曜開始。
///
/// Next.js 原典 `src/lib/utils/date.ts` の `getMonday` と同一セマンティクス:
/// 日曜日は「前週末」扱いで 6 日戻る (`day === 0 ? -6 : 1 - day`)。
/// 原典は端末ローカル TZ の `Date` で演算するが、本実装は YMD 文字列 +
/// `DateTime.utc` で演算するため TZ 非依存 — 同じ YMD 入力に対し常に
/// 同じ YMD を返す (`DateTime.weekday` は月曜=1 .. 日曜=7)。
String weekStartMonday(String ymd) {
  final p = _parseYmd(ymd, 'ymd');
  final weekday = DateTime.utc(p.year, p.month, p.day).weekday;
  return shiftYmd(ymd, 1 - weekday);
}

/// 2 つの YYYY-MM-DD 文字列の日数差 (`toYmd - fromYmd`) を返す。
///
/// Next.js 原典 `src/lib/utils/date-jst.ts` の `daysBetweenYmd` と同じ
/// 符号規約: [toYmd] が未来なら正、過去なら負、同日は 0。
/// `daysFromTodayJst(target)` 相当は `daysBetweenYmd(formatJstDate(), target)`
/// で得る (期限切れ = 負、当日 = 0、未来 = 正)。
///
/// 両者を UTC 真夜中として差を取るため DST の影響を受けず、結果は常に
/// 整数日になる。原典はパース失敗で null を返すが、Dart 側は `shiftYmd` の
/// 既存規約に合わせ `ArgumentError` を投げる (握り潰さない)。
int daysBetweenYmd(String fromYmd, String toYmd) {
  final from = _parseYmd(fromYmd, 'fromYmd');
  final to = _parseYmd(toYmd, 'toYmd');
  final fromUtc = DateTime.utc(from.year, from.month, from.day);
  final toUtc = DateTime.utc(to.year, to.month, to.day);
  return toUtc.difference(fromUtc).inDays;
}
