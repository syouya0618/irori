import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import '../../../core/supabase/supabase_providers.dart';
import '../domain/shopping_item.dart';
import 'shopping_repository.dart';

/// 世帯の `shopping_items` 全件を保持し、Supabase Realtime で reactive 更新
/// する `AsyncNotifier` (`BabyLogsNotifier` と同系の **reducer 方式**)。
///
/// ## reducer は web インライン reducer と同一セマンティクス
///
/// Next.js 原典 `shopping-list.tsx` の Realtime ハンドラ (L108-145 相当) を
/// 1:1 移植する:
/// - INSERT: 既存 id ならスキップ (楽観更新との重複防止)、なければ**末尾に
///   追加** (web: `[...prev, newItem]`)。
/// - UPDATE: 同一 id を**置換のみ** (web: `prev.map(...)` — 未存在 id は
///   追加しない。baby の belongs/exists 4 遷移とは異なる)。
/// - DELETE: 同一 id を除外 (web: `prev.filter(...)`)。
///
/// ## 並び順 (sort_order) は web と同じ扱い
///
/// web の reducer は配列順を正としない (INSERT は単純 append)。表示時に
/// `groupedUnchecked` が category グループ内で `sort_order` 昇順に sort し、
/// チェック済みは `checked_at` 降順に sort する。Flutter 版も同じ責務分担と
/// し、**reducer 内では sort しない** (新規アイテムは最大 sort_order + 1 で
/// 採番されるため、append でも昇順不変条件は通常壊れない。表示順の最終確定は
/// F4 の UI 層が web 同様に行う)。
///
/// ## baby との差分
///
/// - 日付ウィンドウガード無し (shopping は世帯の全件を保持するため、
///   selectedDate に相当する絞り込みが無い)。
/// - channel topic は `shopping_items:$householdId` のみで一意
///   (build() の再実行トリガーが household の変化だけで、topic に日付/週を
///   含める必要が無い)。
///
/// subscribe→fetch 順 / `_pendingDuringInit` バッファ / `_applyPayload`
/// 静的純 reducer / `ref.onDispose` での channel 解放は baby と同一。
class ShoppingItemsNotifier extends AsyncNotifier<List<ShoppingItem>> {
  /// 初期化中 (build() の fetch 完了前) に届いた realtime payload のバッファ
  /// (baby #54 item2 と同じ)。state==null の window で event を **破棄せず**
  /// 溜めておき、fetch 完了後に fetch 結果へ畳み込む。
  ///
  /// 同一インスタンスが再 build される (Notifier は再利用される) ため、
  /// build() 先頭で必ずクリアする (前 build の stale payload 漏れ防止)。
  final List<PostgresChangePayload> _pendingDuringInit = [];

  /// build() の fetch が完了したか。完了後に届く payload は live 処理し、
  /// 未完了なら `_pendingDuringInit` に溜める判定に使う。
  bool _initialized = false;

  /// 直近 subscribe した channel topic (テスト検証用 —
  /// `RealtimeChannel.topic` は @internal で外から読めないため。
  /// `MealsWeekNotifier._channelTopic` と同じ seam)。
  String? _channelTopic;

  @override
  Future<List<ShoppingItem>> build() async {
    // build() の最初で init 状態をリセットする (Notifier インスタンス再利用対策)。
    _initialized = false;
    _pendingDuringInit.clear();

    final householdId = await ref.watch(currentHouseholdIdProvider.future);

    // 世帯未参加 (setup 未完了) なら空リスト。subscribe もしない。
    if (householdId == null) {
      return const [];
    }

    final repository = ref.watch(shoppingRepositoryProvider);

    // subscribe を fetch より前に張る (baby と同じ「取りこぼしゼロ」設計)。
    // subscribe→fetch の window に届いた event は `_pendingDuringInit` に
    // バッファされ、fetch 完了後に reducer で畳み込まれる (dedup が重複を吸収)。
    _subscribe(householdId);

    final items = await repository.fetchItems(householdId);

    // fetch 完了。バッファに溜まった init-window payload を畳み込む。
    final reduced = _drainPendingInto(items);
    _initialized = true;
    return reduced;
  }

  /// 初期化中バッファ (`_pendingDuringInit`) を [base] に reducer で順次
  /// 畳み込み、バッファを空にして結果を返す (baby `_drainPendingInto` と同形)。
  List<ShoppingItem> _drainPendingInto(List<ShoppingItem> base) {
    var acc = base;
    for (final payload in _pendingDuringInit) {
      try {
        acc = _applyPayload(acc, payload);
      } catch (e, st) {
        // 1 件のパース失敗で fetch 結果全体 (build) を AsyncError に倒さない。
        // 握り潰さず構造化ログし、その payload のみスキップする (CLAUDE.md)。
        debugPrint('ShoppingItemsNotifier init-buffer payload 処理失敗: $e\n$st');
      }
    }
    _pendingDuringInit.clear();
    return acc;
  }

  void _subscribe(String householdId) {
    final client = ref.watch(supabaseClientProvider);
    // channel topic は householdId で一意にする。build() の再実行トリガーは
    // household の変化のみで、旧 build の teardown window (removeChannel →
    // unsubscribe は async) と新 build の subscribe が重なっても、household が
    // 違えば topic が違い衝突しない (baby/meals の topic 一意化と同じ理由)。
    final topic = 'shopping_items:$householdId';
    _channelTopic = topic;
    final channel = client
        .channel(topic)
        .onPostgresChanges(
          event: PostgresChangeEvent.all,
          schema: 'public',
          table: 'shopping_items',
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
      debugPrint('ShoppingItemsNotifier realtime payload 処理失敗: $e\n$st');
    }
  }

  /// 単一 payload を [current] へ reducer で適用する純粋関数。
  /// live 処理 (`_onRealtimePayload`) と init buffer drain (`_drainPendingInto`)
  /// で**同一ロジック**を共有する (baby `_applyPayload` と同形)。
  ///
  /// パース失敗時は throw しうる。呼び出し側がそれぞれ try/catch して握り潰さず
  /// ログする。
  List<ShoppingItem> _applyPayload(
    List<ShoppingItem> current,
    PostgresChangePayload p,
  ) {
    switch (p.eventType) {
      case PostgresChangeEvent.insert:
        return _reduceInsert(current, ShoppingItem.fromJson(p.newRecord));
      case PostgresChangeEvent.update:
        return _reduceUpdate(current, ShoppingItem.fromJson(p.newRecord));
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

  /// INSERT: 同一 id が既存なら何もしない (web「楽観更新との重複防止」)。
  /// なければ**末尾に追加** (web: `[...prev, newItem]` — sort はしない。
  /// クラス doc「並び順は web と同じ扱い」参照)。
  static List<ShoppingItem> _reduceInsert(
    List<ShoppingItem> current,
    ShoppingItem item,
  ) {
    if (current.any((i) => i.id == item.id)) return current;
    return [...current, item];
  }

  /// UPDATE: 同一 id を置換する (web: `prev.map(...)`)。
  /// 未存在 id は**追加しない** (web の map は要素を増やさない — noop)。
  static List<ShoppingItem> _reduceUpdate(
    List<ShoppingItem> current,
    ShoppingItem item,
  ) {
    return [
      for (final i in current)
        if (i.id == item.id) item else i,
    ];
  }

  /// DELETE: 同一 id を除外する (web: `prev.filter(...)`)。
  static List<ShoppingItem> _reduceDelete(
    List<ShoppingItem> current,
    String id,
  ) {
    return [
      for (final i in current)
        if (i.id != id) i,
    ];
  }

  /// テスト/手動リフレッシュ用に reducer を公開 (純粋関数なので副作用なし)。
  /// `BabyLogsNotifier.reduceForTest` と同名規約 (日付ガード引数は無し)。
  @visibleForTesting
  static List<ShoppingItem> reduceForTest(
    List<ShoppingItem> current,
    PostgresChangeEvent event, {
    ShoppingItem? item,
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

/// 世帯の買い物アイテム一覧 provider。
///
/// 注意 (`babyLogsNotifierProvider` と同じ): `build()` が例外を throw すると
/// `.future` が pending のまま残る場合がある (state は AsyncError へ正しく
/// 遷移する)。消費側は必ず `ref.watch(shoppingItemsNotifierProvider).when(...)`
/// で **state 経由**で読み、`await provider.future` を新たに導入しないこと。
final shoppingItemsNotifierProvider =
    AsyncNotifierProvider<ShoppingItemsNotifier, List<ShoppingItem>>(
      ShoppingItemsNotifier.new,
    );
