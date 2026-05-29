import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import '../../../core/supabase/supabase_providers.dart';
import '../domain/baby_log.dart';
import 'baby_repository.dart';

/// 今日 (JST) の `baby_logs` を保持し、Supabase Realtime で reactive 更新する
/// `AsyncNotifier`。
///
/// 設計上の判断 (タスク仕様 / Riverpod 3.x):
/// - 設計書 Section 4 (line 408) の `StreamNotifier` サンプルは Riverpod 2.x の
///   古い API のため **不採用**。Riverpod 3.x の `AsyncNotifier<List<BabyLog>>` +
///   手動 Realtime channel subscribe で実装する。
/// - `build()` で「今日のログ」を await し、初期 `AsyncData` を返す。
///   その後 Realtime payload を `_reduce()` で現在の state に畳み込む。
/// - channel は `ref.onDispose` で必ず `removeChannel` する (leak 防止)。
///
/// `build()` が今日固定なのは仕様通り (日付ナビゲーションは後続 Issue)。
/// 週間サマリーや last-sleep は別 provider/別取得 (本 notifier の責務外)。
class BabyLogsNotifier extends AsyncNotifier<List<BabyLog>> {
  /// `build()` 時点の今日 (JST) 日付 (YYYY-MM-DD)。
  /// INSERT realtime event の today-window guard に使う (PR #49 review / #54)。
  String _dateJst = '';

  @override
  Future<List<BabyLog>> build() async {
    final householdId = await ref.watch(currentHouseholdIdProvider.future);

    // 世帯未参加 (setup 未完了) なら空リスト。subscribe もしない。
    if (householdId == null) {
      return const [];
    }

    final repository = ref.watch(babyRepositoryProvider);
    final dateJst = formatJstDate();
    _dateJst = dateJst;

    // subscribe を fetch より前に張る。
    // 注意: build() 実行中 state は AsyncLoading (value == null) なので、
    // subscribe→fetch の window に届いた event は `_onRealtimePayload` の
    // early-return で **破棄される** (重複排除ではない)。fetch 結果が唯一の
    // baseline となる。この短い window での取りこぼしは本データ層 + placeholder
    // UI の段階では許容する (厳密化が必要なら fetch 後に再取得 or バッファリング)。
    // それでも subscribe を先に張るのは、fetch 完了「後」に届く event を
    // 確実に拾うため (fetch 後に張ると、その間の event を恒久的に逃す)。
    _subscribe(householdId);

    final logs = await repository.fetchTodayLogs(householdId, dateJst);
    return logs;
  }

  void _subscribe(String householdId) {
    final client = ref.watch(supabaseClientProvider);
    final channel = client
        .channel('baby_logs:$householdId')
        .onPostgresChanges(
          event: PostgresChangeEvent.all,
          schema: 'public',
          table: 'baby_logs',
          filter: PostgresChangeFilter(
            type: PostgresChangeFilterType.eq,
            column: 'household_id',
            value: householdId,
          ),
          callback: _onRealtimePayload,
        )
        .subscribe();

    ref.onDispose(() {
      // 破棄時に channel を確実に解放 (CLAUDE.md / leak 防止)。
      client.removeChannel(channel);
    });
  }

  void _onRealtimePayload(PostgresChangePayload payload) {
    // state がまだ data でない (loading/error) 間に届いた event は無視する
    // (この window の event は破棄され、build() の fetch 結果が baseline となる。
    //  詳細は build() の subscribe 周りのコメント参照)。
    // Riverpod 3.x で `valueOrNull` は廃止 → nullable な `value` を使う。
    final current = state.value;
    if (current == null) return;

    try {
      switch (payload.eventType) {
        case PostgresChangeEvent.insert:
          final log = BabyLog.fromJson(payload.newRecord);
          state = AsyncData(_reduceInsert(current, log, _dateJst));
        case PostgresChangeEvent.update:
          final log = BabyLog.fromJson(payload.newRecord);
          state = AsyncData(_reduceUpdate(current, log));
        case PostgresChangeEvent.delete:
          // DELETE payload は PK のみ (oldRecord に id)。
          final id = payload.oldRecord['id'] as String?;
          if (id != null) {
            state = AsyncData(_reduceDelete(current, id));
          }
        case PostgresChangeEvent.all:
          // `.all` は購読指定用の値で、実際の payload には来ない。
          break;
      }
    } catch (e, st) {
      // payload パース失敗を握り潰さない (CLAUDE.md)。
      // state は壊さず (現状維持)、ログのみ出す。
      debugPrint('BabyLogsNotifier realtime payload 処理失敗: $e\n$st');
    }
  }

  /// INSERT: 今日 (JST) 範囲外のログは無視する。同一 id が既存なら何もしない
  /// (重複防止)。なければ先頭に追加 (取得順が `logged_at` 降順なので、今日の
  /// ログは先頭で良い)。
  ///
  /// [dateJst] は `build()` 時点の今日 (YYYY-MM-DD)。cross-client realtime で
  /// 過去日/未来日のログが today list に漏れるのを防ぐ (PR #49 review)。
  static List<BabyLog> _reduceInsert(
    List<BabyLog> current,
    BabyLog log,
    String dateJst,
  ) {
    if (formatJstDate(log.loggedAt) != dateJst) return current;
    if (current.any((l) => l.id == log.id)) return current;
    return [log, ...current];
  }

  /// UPDATE: 同一 id を置換。存在しなければ何もしない。
  ///
  /// TODO(#54): 現状は exists→replace のみ。Next.js 原典 (baby-dashboard.tsx) は
  /// selectedDate window で 4 遷移 (belongs&!exists→add / !belongs&exists→remove)
  /// を処理する。selectedDate ナビゲーション概念と共に baby realtime hardening で対応。
  static List<BabyLog> _reduceUpdate(List<BabyLog> current, BabyLog log) {
    if (!current.any((l) => l.id == log.id)) return current;
    return [
      for (final l in current)
        if (l.id == log.id) log else l,
    ];
  }

  /// DELETE: 同一 id を除外。
  static List<BabyLog> _reduceDelete(List<BabyLog> current, String id) {
    return [
      for (final l in current)
        if (l.id != id) l,
    ];
  }

  /// テスト/手動リフレッシュ用に reducer を公開 (純粋関数なので副作用なし)。
  /// [dateJst] は INSERT の today-window guard 用 (省略時は空文字 = 全て範囲外扱い)。
  @visibleForTesting
  static List<BabyLog> reduceForTest(
    List<BabyLog> current,
    PostgresChangeEvent event, {
    BabyLog? log,
    String? deletedId,
    String dateJst = '',
  }) {
    switch (event) {
      case PostgresChangeEvent.insert:
        return _reduceInsert(current, log!, dateJst);
      case PostgresChangeEvent.update:
        return _reduceUpdate(current, log!);
      case PostgresChangeEvent.delete:
        return _reduceDelete(current, deletedId!);
      case PostgresChangeEvent.all:
        return current;
    }
  }
}

/// 今日 (JST) の baby ログ一覧 provider。
///
/// 注意 (PR #49 review / #54): `build()` が例外を throw すると
/// `babyLogsNotifierProvider.future` は pending のままになる (state は AsyncError
/// へ正しく遷移する)。消費側は `ref.watch(babyLogsNotifierProvider).when(error: ...)`
/// で state を読むこと。`await ref.read(babyLogsNotifierProvider.future)` は
/// error 時に hang するため避ける (恒久対応は #54)。
final babyLogsNotifierProvider =
    AsyncNotifierProvider<BabyLogsNotifier, List<BabyLog>>(
      BabyLogsNotifier.new,
    );
