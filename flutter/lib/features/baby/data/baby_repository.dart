import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import '../../../core/supabase/supabase_providers.dart';
import '../../../core/utils/jst_date.dart';
import '../domain/baby_log.dart';
import '../domain/baby_report_aggregation.dart';

/// `formatJstDate` / `shiftYmd` は Phase 2 共有基盤 (F0) で
/// `core/utils/jst_date.dart` へ移設した。既存の import 元
/// (`selected_baby_date_provider.dart` / `baby_date_nav.dart` / 各テスト等) を
/// 壊さないための後方互換 re-export。新規コードは core 側を直接 import する。
export '../../../core/utils/jst_date.dart' show formatJstDate, shiftYmd;

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

/// `baby_logs.memo` のアプリ側上限。Next.js 版 `actions.ts` と同値。
const maxBabyLogMemoLength = 1000;

/// baby log mutation に必要な認証コンテキスト。
typedef BabyMutationContext = ({String householdId, String userId});

/// 育児レポートのヘッダに使う世帯 baby プロフィール。
///
/// 原典 `src/app/api/baby-report/route.ts:50` の SELECT 2 列
/// (`baby_name, baby_birth_date`) に対応。`babyBirthDate` は Postgres `date`
/// 列 → "YYYY-MM-DD" 文字列。null は「未設定」(縮退表示は呼び出し側の責務)。
typedef BabyReportProfile = ({String? babyName, String? babyBirthDate});

/// write 系 UI が使う最小コンテキスト。
///
/// Next.js 版 `getAuthContext()` と同じ役割を Flutter/Riverpod 側で担う。
/// 世帯未参加・未認証は握り潰さず `StateError` に倒し、呼び出し側が
/// user-facing error に変換する。
final babyMutationContextProvider = FutureProvider<BabyMutationContext>((
  ref,
) async {
  final client = ref.watch(supabaseClientProvider);
  final householdId = await ref.watch(currentHouseholdIdProvider.future);
  if (householdId == null) {
    throw StateError('babyMutationContextProvider: 世帯未参加状態で記録を要求した');
  }

  final user = client.auth.currentUser;
  if (user == null) {
    throw StateError('babyMutationContextProvider: 未認証状態で記録を要求した');
  }

  return (householdId: householdId, userId: user.id);
});

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

  /// 授乳を記録する。
  Future<void> recordFeeding({
    required String householdId,
    required String userId,
    required FeedingType feedingType,
    int? amountMl,
    int? durationMin,
    String? memo,
  }) async {
    _validateMemo(memo);
    _validateAmountMl(amountMl);
    _validateDurationMin(durationMin);

    await _insertLog('recordFeeding', householdId, {
      'household_id': householdId,
      'log_type': _logTypeValue(BabyLogType.feeding),
      'logged_by': userId,
      'feeding_type': _feedingTypeValue(feedingType),
      'amount_ml': _allowsAmountMl(feedingType) ? amountMl : null,
      'duration_min': durationMin,
      'memo': _nullableMemo(memo),
    });
  }

  /// おむつ交換を記録する。
  Future<void> recordDiaper({
    required String householdId,
    required String userId,
    required DiaperType diaperType,
    String? memo,
  }) async {
    _validateMemo(memo);

    await _insertLog('recordDiaper', householdId, {
      'household_id': householdId,
      'log_type': _logTypeValue(BabyLogType.diaper),
      'logged_by': userId,
      'diaper_type': _diaperTypeValue(diaperType),
      'memo': _nullableMemo(memo),
    });
  }

  /// 睡眠セッションを開始する。
  Future<void> startSleep({
    required String householdId,
    required String userId,
  }) async {
    await _insertLog('startSleep', householdId, {
      'household_id': householdId,
      'log_type': _logTypeValue(BabyLogType.sleep),
      'logged_by': userId,
    });
  }

  /// 進行中の睡眠セッションを終了する。
  ///
  /// `ended_at IS NULL` を filter に入れ、既に終了済みのログを誤って上書きしない。
  /// `.select('id').single()` で「対象が無い」ケースを PostgREST error として
  /// 検出し、UI 側で「アクティブな睡眠セッションが見つからない」に変換できる。
  Future<void> endSleep({
    required String householdId,
    required String logId,
    DateTime? endedAt,
  }) async {
    final at = (endedAt ?? DateTime.now()).toUtc().toIso8601String();
    try {
      await _client
          .from('baby_logs')
          .update({'ended_at': at})
          .eq('id', logId)
          .eq('household_id', householdId)
          .isFilter('ended_at', null)
          .select('id')
          .single()
          .timeout(_kQueryTimeout);
    } on Object catch (e, st) {
      _logMutationError('endSleep', e, st, householdId);
      rethrow;
    }
  }

  /// 体温を記録する。
  Future<void> recordTemperature({
    required String householdId,
    required String userId,
    required double temperature,
    String? memo,
  }) async {
    _validateTemperature(temperature);
    _validateMemo(memo);

    await _insertLog('recordTemperature', householdId, {
      'household_id': householdId,
      'log_type': _logTypeValue(BabyLogType.temperature),
      'logged_by': userId,
      'temperature': temperature,
      'memo': _nullableMemo(memo),
    });
  }

  /// 成長記録を追加する。
  Future<void> recordGrowth({
    required String householdId,
    required String userId,
    int? weightG,
    double? heightCm,
    String? memo,
  }) async {
    _validateGrowth(weightG: weightG, heightCm: heightCm);
    _validateMemo(memo);

    await _insertLog('recordGrowth', householdId, {
      'household_id': householdId,
      'log_type': _logTypeValue(BabyLogType.growth),
      'logged_by': userId,
      'weight_g': weightG,
      'height_cm': heightCm,
      'memo': _nullableMemo(memo),
    });
  }

  /// メモを記録する。
  Future<void> recordMemo({
    required String householdId,
    required String userId,
    required String memo,
  }) async {
    final trimmed = memo.trim();
    if (trimmed.isEmpty) {
      throw ArgumentError.value(memo, 'memo', 'メモを入力してください');
    }
    _validateMemo(trimmed);

    await _insertLog('recordMemo', householdId, {
      'household_id': householdId,
      'log_type': _logTypeValue(BabyLogType.memo),
      'logged_by': userId,
      'memo': trimmed,
    });
  }

  /// 授乳ログを更新する。
  Future<void> updateFeeding({
    required String householdId,
    required String logId,
    required FeedingType feedingType,
    int? amountMl,
    String? memo,
  }) async {
    _validateAmountMl(amountMl);
    _validateMemo(memo);

    await _updateLog('updateFeeding', householdId, logId, {
      'feeding_type': _feedingTypeValue(feedingType),
      'amount_ml': _allowsAmountMl(feedingType) ? amountMl : null,
      'memo': _nullableMemo(memo),
    });
  }

  /// おむつログを更新する。
  Future<void> updateDiaper({
    required String householdId,
    required String logId,
    required DiaperType diaperType,
    String? memo,
  }) async {
    _validateMemo(memo);

    await _updateLog('updateDiaper', householdId, logId, {
      'diaper_type': _diaperTypeValue(diaperType),
      'memo': _nullableMemo(memo),
    });
  }

  /// 体温ログを更新する。
  Future<void> updateTemperature({
    required String householdId,
    required String logId,
    required double temperature,
    String? memo,
  }) async {
    _validateTemperature(temperature);
    _validateMemo(memo);

    await _updateLog('updateTemperature', householdId, logId, {
      'temperature': temperature,
      'memo': _nullableMemo(memo),
    });
  }

  /// 成長ログを更新する。
  Future<void> updateGrowth({
    required String householdId,
    required String logId,
    int? weightG,
    double? heightCm,
    String? memo,
  }) async {
    _validateGrowth(weightG: weightG, heightCm: heightCm);
    _validateMemo(memo);

    await _updateLog('updateGrowth', householdId, logId, {
      'weight_g': weightG,
      'height_cm': heightCm,
      'memo': _nullableMemo(memo),
    });
  }

  /// sleep / memo など型固有フィールドを持たないログのメモのみを更新する。
  Future<void> updateLogMemo({
    required String householdId,
    required String logId,
    String? memo,
  }) async {
    _validateMemo(memo);

    await _updateLog('updateLogMemo', householdId, logId, {
      'memo': _nullableMemo(memo),
    });
  }

  /// ログを削除する。
  Future<void> deleteLog({
    required String householdId,
    required String logId,
  }) async {
    try {
      await _client
          .from('baby_logs')
          .delete()
          .eq('id', logId)
          .eq('household_id', householdId)
          .timeout(_kQueryTimeout);
    } on Object catch (e, st) {
      _logMutationError('deleteLog', e, st, householdId);
      rethrow;
    }
  }

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

  /// 育児レポート用 SELECT 列 (9 列)。原典 `route.ts:55-57` と同一。
  ///
  /// `AggregationLogInput` が必要とする最小列のみ取り、3 ヶ月分
  /// (上限 5000 行) の転送量を抑える。手組み文字列の typo 防止のため
  /// `weeklyOrFilter` と同様 `@visibleForTesting` で公開しテストで固定する。
  @visibleForTesting
  static const babyReportColumns =
      'log_type, logged_at, feeding_type, amount_ml, diaper_type, ended_at, '
      'temperature, weight_g, height_cm';

  /// 育児レポート対象期間の全ログを `logged_at` 昇順で取得する。
  ///
  /// 原典 `src/app/api/baby-report/route.ts:54-62` と同一のクエリ仕様:
  /// - `household_id` filter
  /// - JST 日界の半開区間
  ///   `[{startDate}T00:00:00+09:00, {shiftYmd(endDate, 1)}T00:00:00+09:00)`
  ///   — endDate **当日を含む** (上限は翌日 0:00 JST)
  /// - `order('logged_at', ascending: true)` / `limit(5000)`
  ///
  /// [startDate] / [endDate] は "YYYY-MM-DD" (JST)。`babyReportDateRange`
  /// (`baby_report_period.dart`) で得る。
  Future<List<AggregationLogInput>> fetchReportLogs(
    String householdId,
    String startDate,
    String endDate,
  ) async {
    try {
      final rows = await _client
          .from('baby_logs')
          .select(babyReportColumns)
          .eq('household_id', householdId)
          .gte('logged_at', '${startDate}T00:00:00+09:00')
          .lt('logged_at', '${shiftYmd(endDate, 1)}T00:00:00+09:00')
          .order('logged_at', ascending: true)
          .limit(5000)
          .timeout(_kQueryTimeout);
      return rows.map(AggregationLogInput.fromJson).toList();
    } on PostgrestException catch (e) {
      _logPostgrestError('fetchReportLogs', e, householdId);
      rethrow;
    }
  }

  /// 育児レポートのヘッダ用世帯プロフィールを取得する。
  ///
  /// 原典 `route.ts:48-52` と同一: `households` から
  /// `baby_name, baby_birth_date` を `.single()` で取得。0 行 / 複数行は
  /// `PostgrestException` (原典は 500 へ倒す `route.ts:65-67`)。
  /// `|| "未設定"` / age 計算の縮退 (`route.ts:69-71`) は PDF 生成側
  /// (Phase 2.6-2) の責務のため、ここでは null をそのまま返す。
  Future<BabyReportProfile> fetchBabyReportProfile(String householdId) async {
    try {
      final row = await _client
          .from('households')
          .select('baby_name, baby_birth_date')
          .eq('id', householdId)
          .single()
          .timeout(_kQueryTimeout);
      return (
        babyName: row['baby_name'] as String?,
        babyBirthDate: row['baby_birth_date'] as String?,
      );
    } on PostgrestException catch (e) {
      _logPostgrestError('fetchBabyReportProfile', e, householdId);
      rethrow;
    }
  }

  Future<void> _insertLog(
    String op,
    String householdId,
    Map<String, dynamic> row,
  ) async {
    try {
      await _client.from('baby_logs').insert(row).timeout(_kQueryTimeout);
    } on Object catch (e, st) {
      _logMutationError(op, e, st, householdId);
      rethrow;
    }
  }

  Future<void> _updateLog(
    String op,
    String householdId,
    String logId,
    Map<String, dynamic> values,
  ) async {
    try {
      // `.update()` は 0 行更新でも error null (CLAUDE.md gotcha)。logId が
      // 他 household / 既削除で対象 0 行のとき silent success になるのを防ぐため、
      // `.select('id').single()` で行数を検証する (endSleep と同じ防御)。
      await _client
          .from('baby_logs')
          .update(values)
          .eq('id', logId)
          .eq('household_id', householdId)
          .select('id')
          .single()
          .timeout(_kQueryTimeout);
    } on Object catch (e, st) {
      _logMutationError(op, e, st, householdId);
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

  void _logMutationError(
    String op,
    Object error,
    StackTrace stackTrace,
    String householdId,
  ) {
    if (error is PostgrestException) {
      _logPostgrestError(op, error, householdId);
      return;
    }
    debugPrint(
      'BabyRepository.$op error: $error\n$stackTrace householdId=$householdId',
    );
  }
}

/// `BabyRepository` の DI provider。
final babyRepositoryProvider = Provider<BabyRepository>((ref) {
  return BabyRepository(ref.watch(supabaseClientProvider));
});

bool _allowsAmountMl(FeedingType type) {
  return type == FeedingType.bottle || type == FeedingType.solid;
}

String? _nullableMemo(String? memo) {
  if (memo == null || memo.isEmpty) return null;
  return memo;
}

void _validateMemo(String? memo) {
  if (memo != null && memo.length > maxBabyLogMemoLength) {
    throw ArgumentError.value(
      memo,
      'memo',
      'メモは$maxBabyLogMemoLength文字以内で入力してください',
    );
  }
}

void _validateAmountMl(int? amountMl) {
  if (amountMl == null) return;
  if (amountMl < 0 || amountMl > 999) {
    throw ArgumentError.value(amountMl, 'amountMl', '0〜999mlで入力してください');
  }
}

void _validateDurationMin(int? durationMin) {
  if (durationMin == null) return;
  if (durationMin < 0 || durationMin > 180) {
    throw ArgumentError.value(durationMin, 'durationMin', '0〜180分で入力してください');
  }
}

void _validateTemperature(double temperature) {
  if (temperature < 34.0 || temperature > 42.0) {
    throw ArgumentError.value(
      temperature,
      'temperature',
      '34.0〜42.0℃で入力してください',
    );
  }
}

void _validateGrowth({int? weightG, double? heightCm}) {
  final hasWeight = weightG != null;
  final hasHeight = heightCm != null;
  if (!hasWeight && !hasHeight) {
    throw ArgumentError('体重または身長を入力してください');
  }
  if (weightG != null && (weightG < 0 || weightG > 30000)) {
    throw ArgumentError.value(weightG, 'weightG', '0〜30000gで入力してください');
  }
  if (heightCm != null && (heightCm < 0.0 || heightCm > 150.0)) {
    throw ArgumentError.value(heightCm, 'heightCm', '0〜150cmで入力してください');
  }
}

String _logTypeValue(BabyLogType type) {
  switch (type) {
    case BabyLogType.feeding:
      return 'feeding';
    case BabyLogType.diaper:
      return 'diaper';
    case BabyLogType.sleep:
      return 'sleep';
    case BabyLogType.temperature:
      return 'temperature';
    case BabyLogType.growth:
      return 'growth';
    case BabyLogType.memo:
      return 'memo';
  }
}

String _feedingTypeValue(FeedingType type) {
  switch (type) {
    case FeedingType.breastLeft:
      return 'breast_left';
    case FeedingType.breastRight:
      return 'breast_right';
    case FeedingType.bottle:
      return 'bottle';
    case FeedingType.solid:
      return 'solid';
  }
}

String _diaperTypeValue(DiaperType type) {
  switch (type) {
    case DiaperType.pee:
      return 'pee';
    case DiaperType.poop:
      return 'poop';
    case DiaperType.both:
      return 'both';
  }
}
