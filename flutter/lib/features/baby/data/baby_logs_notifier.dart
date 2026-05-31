import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import '../../../core/supabase/supabase_providers.dart';
import '../domain/baby_log.dart';
import 'baby_repository.dart';
import 'selected_baby_date_provider.dart';

/// 表示中の日付 (JST, `selectedBabyDateProvider`) の `baby_logs` を保持し、
/// Supabase Realtime で reactive 更新する `AsyncNotifier`。
///
/// 設計上の判断 (タスク仕様 / Riverpod 3.x):
/// - 設計書 Section 4 (line 408) の `StreamNotifier` サンプルは Riverpod 2.x の
///   古い API のため **不採用**。Riverpod 3.x の `AsyncNotifier<List<BabyLog>>` +
///   手動 Realtime channel subscribe で実装する。
/// - `build()` で `selectedBabyDateProvider` を watch し、その日のログを await して
///   初期 `AsyncData` を返す。selectedDate が変わると build() が再実行され
///   refetch される (Next.js 原典 baby-dashboard.tsx L151-179 の date refetch 相当)。
///   その後 Realtime payload を `_reduce()` で現在の state に畳み込む。
/// - channel は `ref.onDispose` で必ず `removeChannel` する (leak 防止)。
///
/// 週間サマリーや last-sleep は別 provider/別取得 (本 notifier の責務外)。
class BabyLogsNotifier extends AsyncNotifier<List<BabyLog>> {
  /// `build()` 時点の表示中日付 (JST, YYYY-MM-DD)。
  /// INSERT/UPDATE realtime event の selectedDate-window guard に使う
  /// (PR #49 review / #54)。
  String _dateJst = '';

  /// 初期化中 (build() の fetch 完了前) に届いた realtime payload のバッファ
  /// (#54 item2)。state==null の window で event を **破棄せず** 溜めておき、
  /// fetch 完了後に fetch 結果へ畳み込む。
  ///
  /// 同一インスタンスが date 変更で再 build される (Notifier は再利用される)
  /// ため、build() 先頭で必ずクリアする (advisor 指摘 #2: 前 date の stale payload
  /// が新 date の init window に漏れるのを防ぐ)。
  final List<PostgresChangePayload> _pendingDuringInit = [];

  /// build() の fetch が完了したか。完了後に届く payload は live 処理し、
  /// 未完了なら `_pendingDuringInit` に溜める判定に使う。
  bool _initialized = false;

  @override
  Future<List<BabyLog>> build() async {
    // build() の最初で init 状態をリセットする (Notifier インスタンス再利用対策)。
    _initialized = false;
    _pendingDuringInit.clear();

    final householdId = await ref.watch(currentHouseholdIdProvider.future);

    // 世帯未参加 (setup 未完了) なら空リスト。subscribe もしない。
    if (householdId == null) {
      return const [];
    }

    final repository = ref.watch(babyRepositoryProvider);
    final dateJst = ref.watch(selectedBabyDateProvider);
    _dateJst = dateJst;

    // subscribe を fetch より前に張る。
    //
    // 設計判断 (#54 item2): subscribe→fetch の window に届いた event は
    // state==null で live 処理できないが、**破棄せず** `_pendingDuringInit` に
    // バッファする。fetch 完了後にバッファを fetch 結果へ reducer で畳み込み、
    // dedup により重複を吸収する。これで「初期化中の取りこぼし」をゼロにする。
    //
    // selectedDate 変更で build() が再実行されると channel は前 build の
    // ref.onDispose で破棄→再 subscribe される (date 毎に再購読)。スコープ上
    // これを許容する。buffer は build() 先頭で clear 済みなので stale 混入なし。
    _subscribe(householdId);

    final logs = await repository.fetchLogsForDate(householdId, dateJst);

    // fetch 完了。バッファに溜まった init-window payload を畳み込む。
    final reduced = _drainPendingInto(logs);
    _initialized = true;
    return reduced;
  }

  /// 初期化中バッファ (`_pendingDuringInit`) を [base] に reducer で順次畳み込み、
  /// バッファを空にして結果を返す (#54 item2)。
  ///
  /// dedup (INSERT/UPDATE の id 重複チェック) により、fetch 結果に既に含まれる
  /// payload は安全に吸収される。降順不変条件は reducer 側の sorted insert が保つ。
  List<BabyLog> _drainPendingInto(List<BabyLog> base) {
    var acc = base;
    for (final payload in _pendingDuringInit) {
      try {
        acc = _applyPayload(acc, payload);
      } catch (e, st) {
        // 1 件のパース失敗で fetch 結果全体 (build) を AsyncError に倒さない。
        // 握り潰さず構造化ログし、その payload のみスキップする (CLAUDE.md)。
        debugPrint('BabyLogsNotifier init-buffer payload 処理失敗: $e\n$st');
      }
    }
    _pendingDuringInit.clear();
    return acc;
  }

  void _subscribe(String householdId) {
    final client = ref.watch(supabaseClientProvider);
    // channel topic を householdId + selectedDate で一意にする (advisor #2)。
    //
    // selectedDate 変更で build() が再実行されると、旧 build の ref.onDispose で
    // `removeChannel(旧channel)` が走る (Riverpod は recompute 前に dispose を発火)
    // が、`removeChannel`→`unsubscribe()` は **async** で、新 build の同期 `_subscribe`
    // が走る時点では旧 channel の unsubscribe が未完了な window がありうる。
    // realtime_client の `channel()` は topic で dedup せず常に新 instance を
    // append する (確認済み: realtime_client 2.7.3 realtime_client.dart L173-184)
    // ため、topic を date 込みで一意にしておけば、旧/新が同一 topic で衝突せず
    // 各々独立に teardown/subscribe される。callback は常に最新 `_dateJst` を読む。
    final channel = client
        .channel('baby_logs:$householdId:$_dateJst')
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
    // 初期化 (build() の fetch) 完了前に届いた event は **破棄せず**
    // `_pendingDuringInit` に溜める (#54 item2)。fetch 完了後に drain される。
    // Riverpod 3.x で `valueOrNull` は廃止 → nullable な `value` を使う。
    final current = state.value;
    if (!_initialized || current == null) {
      _pendingDuringInit.add(payload);
      return;
    }

    try {
      state = AsyncData(_applyPayload(current, payload));
    } catch (e, st) {
      // payload パース失敗を握り潰さない (CLAUDE.md)。
      // state は壊さず (現状維持)、ログのみ出す。
      debugPrint('BabyLogsNotifier realtime payload 処理失敗: $e\n$st');
    }
  }

  /// 単一 payload を [current] へ reducer で適用する純粋関数。
  /// live 処理 (`_onRealtimePayload`) と init buffer drain (`_drainPendingInto`)
  /// で**同一ロジック**を共有し、両経路で降順不変条件・dedup を一致させる。
  ///
  /// パース失敗時は throw しうる。呼び出し側がそれぞれ try/catch して握り潰さず
  /// ログする (live = `_onRealtimePayload`、drain = `_drainPendingInto`)。
  List<BabyLog> _applyPayload(List<BabyLog> current, PostgresChangePayload p) {
    switch (p.eventType) {
      case PostgresChangeEvent.insert:
        return _reduceInsert(current, BabyLog.fromJson(p.newRecord), _dateJst);
      case PostgresChangeEvent.update:
        return _reduceUpdate(current, BabyLog.fromJson(p.newRecord), _dateJst);
      case PostgresChangeEvent.delete:
        // DELETE payload は PK のみ (oldRecord に id)。
        final id = p.oldRecord['id'] as String?;
        if (id == null) return current;
        return _reduceDelete(current, id);
      case PostgresChangeEvent.all:
        // `.all` は購読指定用の値で、実際の payload には来ない。
        return current;
    }
  }

  /// INSERT: selectedDate (JST) 範囲外のログは無視する。同一 id が既存なら何も
  /// しない (重複防止)。なければ `logged_at` 降順を維持する位置へ挿入する。
  ///
  /// [dateJst] は `build()` 時点の表示中日付 (YYYY-MM-DD)。cross-client realtime で
  /// 別日のログが selectedDate list に漏れるのを防ぐ (PR #49 review / #54)。
  ///
  /// 原典 (baby-dashboard.tsx L106-109) は単純 prepend だが、buffer drain
  /// (初期化中 event) と live event の双方で「fetch 結果と同じ降順不変条件」を
  /// 保つため、降順ソート挿入で実装する (advisor 指摘 #3)。
  static List<BabyLog> _reduceInsert(
    List<BabyLog> current,
    BabyLog log,
    String dateJst,
  ) {
    if (formatJstDate(log.loggedAt) != dateJst) return current;
    if (current.any((l) => l.id == log.id)) return current;
    return _insertDescending(current, log);
  }

  /// `logged_at` 降順を維持しつつ [log] を挿入する。
  /// 同一タイムスタンプの場合は新規を「前」に置く (原典の prepend 互換)。
  static List<BabyLog> _insertDescending(List<BabyLog> current, BabyLog log) {
    final result = <BabyLog>[];
    var inserted = false;
    for (final l in current) {
      // 新規が既存より新しい OR 同時刻なら、既存の前に挿入する
      // (`!isBefore` = newer-or-equal)。
      if (!inserted && !log.loggedAt.isBefore(l.loggedAt)) {
        result.add(log);
        inserted = true;
      }
      result.add(l);
    }
    if (!inserted) result.add(log);
    return result;
  }

  /// UPDATE: selectedDate window の 4 遷移 (Next.js 原典 baby-dashboard.tsx
  /// L123-136 / #54)。
  /// - belongs = `formatJstDate(log.loggedAt) == dateJst`
  /// - exists  = current に同 id
  ///
  /// | belongs | exists | 動作          |
  /// |---------|--------|---------------|
  /// |  true   |  true  | 置換          |
  /// |  true   | false  | 降順挿入で追加 |
  /// | false   |  true  | 除外          |
  /// | false   | false  | noop          |
  static List<BabyLog> _reduceUpdate(
    List<BabyLog> current,
    BabyLog log,
    String dateJst,
  ) {
    final belongs = formatJstDate(log.loggedAt) == dateJst;
    final exists = current.any((l) => l.id == log.id);

    if (belongs && exists) {
      return [
        for (final l in current)
          if (l.id == log.id) log else l,
      ];
    }
    if (belongs && !exists) {
      return _insertDescending(current, log);
    }
    if (!belongs && exists) {
      return [
        for (final l in current)
          if (l.id != log.id) l,
      ];
    }
    // !belongs && !exists
    return current;
  }

  /// DELETE: 同一 id を除外。
  static List<BabyLog> _reduceDelete(List<BabyLog> current, String id) {
    return [
      for (final l in current)
        if (l.id != id) l,
    ];
  }

  /// テスト/手動リフレッシュ用に reducer を公開 (純粋関数なので副作用なし)。
  /// [dateJst] は INSERT/UPDATE の selectedDate-window guard 用
  /// (省略時は空文字 = 全て範囲外扱い)。
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
        return _reduceUpdate(current, log!, dateJst);
      case PostgresChangeEvent.delete:
        return _reduceDelete(current, deletedId!);
      case PostgresChangeEvent.all:
        return current;
    }
  }

  /// テスト専用: realtime payload を `_onRealtimePayload` に直接流す seam。
  /// 実 Supabase channel を張らずに「初期化中バッファ → fetch 後 drain → live 反映」
  /// のタイミング挙動を検証する hook (#54 item2 / PR #60 review C2)。
  @visibleForTesting
  void debugHandlePayload(PostgresChangePayload payload) =>
      _onRealtimePayload(payload);

  /// テスト専用: build() の fetch が完了し live 処理へ移行したか
  /// (false の間に届いた payload は `_pendingDuringInit` に溜まる)。
  @visibleForTesting
  bool get debugInitialized => _initialized;

  /// テスト専用: 初期化中バッファに溜まっている payload 件数。
  @visibleForTesting
  int get debugPendingCount => _pendingDuringInit.length;
}

/// 表示中の日付 (JST, `selectedBabyDateProvider`) の baby ログ一覧 provider。
///
/// 注意 (#54 item3 / future-hang): `build()` が例外を throw すると、観測上
/// `babyLogsNotifierProvider.future` が pending のまま残る場合がある
/// (state は AsyncError へ正しく遷移する)。
///
/// **方針 (PR1)**: 消費側は必ず
/// `ref.watch(babyLogsNotifierProvider).when(error: ...)` で **state 経由**で読む。
/// `await ref.read(babyLogsNotifierProvider.future)` は error 時に hang しうるため
/// **新たに導入しないこと**。UI 層 (後続タスク) も `.future` を await せず
/// `AsyncValue` の when/maybeWhen を使う。
///
/// 回帰防止のテスト (`fetch が PostgrestException を投げると AsyncError になる`)
/// が `.future` を await せず bounded loop で state の AsyncError 遷移を検証する。
final babyLogsNotifierProvider =
    AsyncNotifierProvider<BabyLogsNotifier, List<BabyLog>>(
      BabyLogsNotifier.new,
    );
