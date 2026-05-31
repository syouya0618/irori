import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import '../../../core/supabase/supabase_providers.dart';
import '../domain/baby_log.dart';

/// 全 Supabase 呼び出しに付与するタイムアウト。
/// CLAUDE.md「外部API呼び出しにはタイムアウト設定必須」。
const _kQueryTimeout = Duration(seconds: 10);

/// `baby_logs` を取得した順 (全列) を取る共通 SELECT 文字列。
/// Next.js 版 (`baby/page.tsx`) と列を揃えつつ、Realtime payload との整合のため
/// `updated_at` も含める。
const _kBabyLogColumns =
    'id, household_id, log_type, logged_at, logged_by, feeding_type, '
    'amount_ml, diaper_type, ended_at, temperature, weight_g, height_cm, '
    'duration_min, memo, created_at, updated_at';

/// JST (Asia/Tokyo, UTC+9) 固定オフセット。
///
/// `new Date('YYYY-MM-DD')` 相当の UTC 罠を回避するため、日付境界は
/// 「JST の 00:00:00」を明示的に `+09:00` 付き ISO 文字列で表現する。
/// Postgres `timestamptz` 比較は timezone-aware なので、`+09:00` を付けた
/// 文字列を渡せば DB 側で正しく JST 日界として解釈される。
const _kJstOffset = Duration(hours: 9);

/// `baby_logs` テーブルへの読み取り専用アクセスを担うリポジトリ。
///
/// 書き込み (insert/update/delete) は後続 Issue。本 Issue (#49) は
/// ダッシュボード表示に必要な read 系 3 メソッドのみ提供する。
///
/// エラー方針 (CLAUDE.md):
/// - `PostgrestException` は plain object のため、code/message/details/hint を
///   構造化して `debugPrint` し、握り潰さず rethrow する。
class BabyRepository {
  BabyRepository(this._client);

  final SupabaseClient _client;

  /// JST の "YYYY-MM-DD" 日付について、その日 (00:00 JST) 〜 翌日 0:00 JST の
  /// 範囲の `[start, nextStart)` を `+09:00` 付き ISO 文字列で返す。
  ///
  /// 月跨ぎ・年跨ぎ境界を含む最もリスクの高い JST surface のため、
  /// `@visibleForTesting` で公開し rollover を直接テストする (PR #49 review)。
  @visibleForTesting
  static ({String start, String nextStart}) jstDayBounds(String dateJst) {
    // dateJst は呼び出し側で `formatJstDate` 等から得た正規な YYYY-MM-DD 前提。
    final parts = dateJst.split('-');
    if (parts.length != 3) {
      throw ArgumentError.value(dateJst, 'dateJst', 'YYYY-MM-DD 形式ではない');
    }
    final year = int.parse(parts[0]);
    final month = int.parse(parts[1]);
    final day = int.parse(parts[2]);
    // JST の壁時計 00:00 を UTC として組み立て、後で `+09:00` を明示する。
    final start = '${parts[0]}-${parts[1]}-${parts[2]}T00:00:00+09:00';
    final next = DateTime.utc(year, month, day).add(const Duration(days: 1));
    final nextStr = DateFormat('yyyy-MM-dd').format(next);
    return (start: start, nextStart: '${nextStr}T00:00:00+09:00');
  }

  /// 週間サマリーの PostgREST OR フィルタ文字列を組み立てる。
  /// `logged_at >= from` または (`log_type = sleep` かつ `ended_at >= from`)。
  /// 手組みの文字列は typo しやすいため `@visibleForTesting` で公開しテストする
  /// (PR #49 review)。
  @visibleForTesting
  static String weeklyOrFilter(String from) =>
      'logged_at.gte.$from,and(log_type.eq.sleep,ended_at.gte.$from)';

  /// 指定 JST 日付 (YYYY-MM-DD) のログを `logged_at` 降順で取得。
  ///
  /// 日付ナビゲーション (#54) の基盤。`selectedBabyDate` で選んだ任意の日の
  /// ログ取得に使う。JST 日界 (`jstDayBounds`) で `[start, nextStart)` を切り、
  /// timeout / 構造化ログ / rethrow の防御は `fetchTodayLogs` と共通。
  Future<List<BabyLog>> fetchLogsForDate(
    String householdId,
    String dateJst,
  ) async {
    final bounds = jstDayBounds(dateJst);
    try {
      final rows = await _client
          .from('baby_logs')
          .select(_kBabyLogColumns)
          .eq('household_id', householdId)
          .gte('logged_at', bounds.start)
          .lt('logged_at', bounds.nextStart)
          .order('logged_at', ascending: false)
          .timeout(_kQueryTimeout);
      return rows.map(BabyLog.fromJson).toList();
    } on PostgrestException catch (e) {
      _logPostgrestError('fetchLogsForDate', e, householdId);
      rethrow;
    }
  }

  /// 指定 JST 日付 (YYYY-MM-DD) の今日のログを `logged_at` 降順で取得。
  ///
  /// `fetchLogsForDate` への委譲 (後方互換のため signature を維持)。
  /// 既存呼び出し側 (`BabyLogsNotifier` / 既存テスト) を壊さない。
  Future<List<BabyLog>> fetchTodayLogs(
    String householdId,
    String dateJst,
  ) => fetchLogsForDate(householdId, dateJst);

  /// 直近の「完了済み (ended_at != null)」睡眠セッションの終了時刻を取得。
  /// 完了済み睡眠が 1 件も無ければ null。
  ///
  /// `.maybeSingle()` は 0 行で null を返す (1 行なら Map)。row 数検証も兼ねる。
  Future<DateTime?> fetchLastSleep(String householdId) async {
    try {
      final row = await _client
          .from('baby_logs')
          .select('ended_at')
          .eq('household_id', householdId)
          .eq('log_type', 'sleep')
          .not('ended_at', 'is', null)
          .order('ended_at', ascending: false)
          .limit(1)
          .maybeSingle()
          .timeout(_kQueryTimeout);
      final endedAt = row?['ended_at'] as String?;
      if (endedAt == null) return null;
      return DateTime.parse(endedAt);
    } on PostgrestException catch (e) {
      _logPostgrestError('fetchLastSleep', e, householdId);
      rethrow;
    }
  }

  /// 週間サマリー用ログを取得。
  ///
  /// Next.js 版 (`baby/page.tsx`) の OR 条件を踏襲:
  /// `logged_at < to` かつ
  /// (`logged_at >= from` または (`log_type = sleep` かつ `ended_at >= from`))。
  /// 期間を跨ぐ睡眠 (開始は範囲前だが終了が範囲内) も拾う。
  ///
  /// [from] / [to] は `+09:00` 付き等の timestamptz 比較可能な ISO 文字列。
  Future<List<BabyLog>> fetchWeeklyLogs(
    String householdId,
    String from,
    String to,
  ) async {
    try {
      final rows = await _client
          .from('baby_logs')
          .select(_kBabyLogColumns)
          .eq('household_id', householdId)
          .lt('logged_at', to)
          .or(weeklyOrFilter(from))
          .order('logged_at', ascending: false)
          .timeout(_kQueryTimeout);
      return rows.map(BabyLog.fromJson).toList();
    } on PostgrestException catch (e) {
      _logPostgrestError('fetchWeeklyLogs', e, householdId);
      rethrow;
    }
  }

  /// `PostgrestException` を握り潰さず構造化ログする (CLAUDE.md)。
  /// householdId は識別子だが機密ではないため、調査用に出力する。
  void _logPostgrestError(
    String op,
    PostgrestException e,
    String householdId,
  ) {
    debugPrint(
      'BabyRepository.$op PostgrestException: '
      'code=${e.code} message=${e.message} '
      'details=${e.details} hint=${e.hint} householdId=$householdId',
    );
  }
}

/// `BabyRepository` の DI provider。
final babyRepositoryProvider = Provider<BabyRepository>((ref) {
  return BabyRepository(ref.watch(supabaseClientProvider));
});

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
  final parts = ymd.split('-');
  if (parts.length != 3 ||
      parts[0].length != 4 ||
      parts[1].length != 2 ||
      parts[2].length != 2) {
    throw ArgumentError.value(ymd, 'ymd', 'YYYY-MM-DD 形式ではない');
  }
  final year = int.parse(parts[0]);
  final month = int.parse(parts[1]);
  final day = int.parse(parts[2]);
  final shifted = DateTime.utc(year, month, day + days);
  return DateFormat('yyyy-MM-dd').format(shifted);
}
