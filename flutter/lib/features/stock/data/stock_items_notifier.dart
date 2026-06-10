import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import '../../../core/supabase/supabase_providers.dart';
import '../domain/stock_item.dart';
import 'stock_repository.dart';

/// 世帯の在庫一覧 (`stock_items`) を保持し、Supabase Realtime で reactive
/// 更新する `AsyncNotifier` (`BabyLogsNotifier` と同系の reducer 方式)。
///
/// ## reducer のセマンティクスは web `stock-list.tsx` のインライン reducer と同一
///
/// - INSERT: 同一 id が既存なら no-op (dedup)、なければ**末尾に append**
///   (web: `[...prev, newItem]`)。baby のような sorted insert はしない —
///   web の在庫 UI は表示時にカテゴリ + name でグルーピング/ソートし直す
///   ため、state の並び順 (fetch の name 昇順 + 末尾 append) を web と
///   揃えておけば表示は一致する。
/// - UPDATE: 同一 id を payload.new で**置換のみ** (web: `prev.map(...)`)。
///   id 不在なら no-op (baby の belongs/exists 4 遷移とは異なり追加しない)。
/// - DELETE: `payload.old.id` で filter。
///
/// baby との構造差: 在庫は日付 window が無い (世帯の全行が対象) ため、
/// selectedDate guard / 降順 sorted insert は持たない。
///
/// ## 初期化中バッファ (baby #54 item2 と同一の取りこぼしゼロ設計)
///
/// subscribe を fetch より前に張り、fetch 完了前に届いた payload は
/// `_pendingDuringInit` にバッファして fetch 結果へ畳み込む。
/// channel は `ref.onDispose` で必ず `removeChannel` する (leak 防止 —
/// web の unmount cleanup `supabase.removeChannel(channel)` に相当)。
class StockItemsNotifier extends AsyncNotifier<List<StockItem>> {
  /// 初期化中 (build() の fetch 完了前) に届いた realtime payload のバッファ。
  /// state==null の window で event を **破棄せず** 溜めておき、
  /// fetch 完了後に fetch 結果へ畳み込む (baby #54 item2 と同一設計)。
  ///
  /// 同一インスタンスが再 build される (Notifier は再利用される) ため、
  /// build() 先頭で必ずクリアする。
  final List<PostgresChangePayload> _pendingDuringInit = [];

  /// build() の fetch が完了したか。完了後に届く payload は live 処理し、
  /// 未完了なら `_pendingDuringInit` に溜める判定に使う。
  bool _initialized = false;

  /// 直近 subscribe した channel topic (テスト検証用 —
  /// `RealtimeChannel.topic` は @internal で外から読めないため。
  /// `MealsWeekNotifier._channelTopic` と同じ流儀)。
  String? _channelTopic;

  @override
  Future<List<StockItem>> build() async {
    // build() の最初で init 状態をリセットする (Notifier インスタンス再利用対策)。
    _initialized = false;
    _pendingDuringInit.clear();

    final householdId = await ref.watch(currentHouseholdIdProvider.future);

    // 世帯未参加 (setup 未完了) なら空リスト。subscribe もしない。
    if (householdId == null) {
      return const [];
    }

    final repository = ref.watch(stockRepositoryProvider);

    // subscribe を fetch より前に張る (取りこぼしゼロ設計 — baby と同一)。
    // subscribe→fetch の window に届いた event は `_pendingDuringInit` に
    // バッファし、fetch 完了後に reducer で畳み込む (dedup が重複を吸収する)。
    _subscribe(householdId);

    final items = await repository.fetchItems(householdId);

    // fetch 完了。バッファに溜まった init-window payload を畳み込む。
    final reduced = _drainPendingInto(items);
    _initialized = true;
    return reduced;
  }

  /// 初期化中バッファ (`_pendingDuringInit`) を [base] に reducer で順次畳み込み、
  /// バッファを空にして結果を返す (baby `_drainPendingInto` と同形)。
  List<StockItem> _drainPendingInto(List<StockItem> base) {
    var acc = base;
    for (final payload in _pendingDuringInit) {
      try {
        acc = _applyPayload(acc, payload);
      } catch (e, st) {
        // 1 件のパース失敗で fetch 結果全体 (build) を AsyncError に倒さない。
        // 握り潰さず構造化ログし、その payload のみスキップする (CLAUDE.md)。
        debugPrint('StockItemsNotifier init-buffer payload 処理失敗: $e\n$st');
      }
    }
    _pendingDuringInit.clear();
    return acc;
  }

  void _subscribe(String householdId) {
    final client = ref.watch(supabaseClientProvider);
    // topic は householdId で一意化する (F5 仕様)。stock は baby/meals と
    // 異なり日付・週の状態を持たず、build() 再実行は householdId の変化
    // (login/logout) 時のみ → 同一 topic の旧/新 channel が teardown window
    // で重なる経路は auth 遷移時に限られる (web も固定 topic "stock" で
    // 同条件を許容している)。
    final topic = 'stock_items:$householdId';
    _channelTopic = topic;
    final channel = client
        .channel(topic)
        .onPostgresChanges(
          event: PostgresChangeEvent.all,
          schema: 'public',
          table: 'stock_items',
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
    // `_pendingDuringInit` に溜める。fetch 完了後に drain される。
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
      debugPrint('StockItemsNotifier realtime payload 処理失敗: $e\n$st');
    }
  }

  /// 単一 payload を [current] へ reducer で適用する純粋関数。
  /// live 処理 (`_onRealtimePayload`) と init buffer drain (`_drainPendingInto`)
  /// で**同一ロジック**を共有する (baby `_applyPayload` と同形)。
  ///
  /// パース失敗時は throw しうる。呼び出し側がそれぞれ try/catch して握り潰さず
  /// ログする。
  List<StockItem> _applyPayload(
    List<StockItem> current,
    PostgresChangePayload p,
  ) {
    switch (p.eventType) {
      case PostgresChangeEvent.insert:
        return _reduceInsert(current, StockItem.fromJson(p.newRecord));
      case PostgresChangeEvent.update:
        return _reduceUpdate(current, StockItem.fromJson(p.newRecord));
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

  /// INSERT: 同一 id が既存なら何もしない (重複防止)。なければ末尾に追加する
  /// (web stock-list.tsx L94-97: `prev.some(...) ? prev : [...prev, newItem]`)。
  static List<StockItem> _reduceInsert(
    List<StockItem> current,
    StockItem item,
  ) {
    if (current.any((i) => i.id == item.id)) return current;
    return [...current, item];
  }

  /// UPDATE: 同一 id を置換する (web stock-list.tsx L100-102:
  /// `prev.map((i) => i.id === updated.id ? updated : i)`)。
  /// id 不在なら結果的に no-op (web の map と同じ)。
  static List<StockItem> _reduceUpdate(
    List<StockItem> current,
    StockItem item,
  ) {
    return [
      for (final i in current)
        if (i.id == item.id) item else i,
    ];
  }

  /// DELETE: 同一 id を除外する (web stock-list.tsx L105:
  /// `prev.filter((i) => i.id !== deleted.id)`)。
  static List<StockItem> _reduceDelete(List<StockItem> current, String id) {
    return [
      for (final i in current)
        if (i.id != id) i,
    ];
  }

  /// テスト/手動リフレッシュ用に reducer を公開 (純粋関数なので副作用なし)。
  /// `BabyLogsNotifier.reduceForTest` と同名規約。
  @visibleForTesting
  static List<StockItem> reduceForTest(
    List<StockItem> current,
    PostgresChangeEvent event, {
    StockItem? item,
    String? deletedId,
  }) {
    switch (event) {
      case PostgresChangeEvent.insert:
        return _reduceInsert(current, item!);
      case PostgresChangeEvent.update:
        return _reduceUpdate(current, item!);
      case PostgresChangeEvent.delete:
        return _reduceDelete(current, deletedId!);
      case PostgresChangeEvent.all:
        return current;
    }
  }

  /// テスト専用: realtime payload を `_onRealtimePayload` に直接流す seam
  /// (`BabyLogsNotifier.debugHandlePayload` と同名規約)。実 Supabase channel を
  /// 張らずに「初期化中バッファ → fetch 後 drain → live 反映」のタイミング
  /// 挙動を検証する hook。
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

  /// テスト専用: 直近 subscribe した channel topic
  /// (`MealsWeekNotifier.debugChannelTopic` と同名規約)。
  @visibleForTesting
  String? get debugChannelTopic => _channelTopic;
}

/// 世帯の在庫一覧 provider。
///
/// 注意 (`babyLogsNotifierProvider` と同じ): `build()` が例外を throw すると
/// `.future` が pending のまま残る場合がある (state は AsyncError へ正しく
/// 遷移する)。消費側は必ず `ref.watch(stockItemsNotifierProvider).when(...)`
/// で **state 経由**で読み、`await provider.future` を新たに導入しないこと。
final stockItemsNotifierProvider =
    AsyncNotifierProvider<StockItemsNotifier, List<StockItem>>(
      StockItemsNotifier.new,
    );
