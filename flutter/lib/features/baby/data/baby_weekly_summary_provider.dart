import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import '../../../core/supabase/supabase_providers.dart';
import '../domain/baby_weekly_summary.dart';
import 'baby_repository.dart';

/// `baby_weekly:$householdId:$seq` の topic 一意化に使う単調増加カウンタ。
///
/// build 再実行 (世帯変更) や own-write invalidate による resubscribe の際、
/// 旧 channel の `removeChannel`→`unsubscribe()` は **async** で、新 build の同期
/// `_subscribe` が走る時点では旧 channel の teardown が未完了な window がありうる。
/// realtime_client の `channel()` は topic で dedup せず常に新 instance を append
/// する (`MealsWeekNotifier._subscribe` の確認済みコメント参照) ため、旧/新が
/// 同一 topic だと衝突しうる。**インスタンス跨ぎでも**衝突しないよう、topic を
/// module-level の単調カウンタで globally 一意化する (instance-level だと full
/// dispose→再生成の teardown window で `...:0` 同士が衝突しうる)。
int _babyWeeklyChannelSeq = 0;

/// 直近 7 日 (JST, 今日含む) の週間サマリーを供給する `AsyncNotifier`
/// (`MealsWeekNotifier` と同系の作り)。
///
/// ## cross-client Realtime は **refetch 方式** (baby ログの reducer 方式と異なる)
///
/// 週間サマリーは `baby_logs` の日別集計であり、Realtime payload (単一行) からは
/// 週全体を畳み込めない (別日のログ 1 件が届いても、その日の feeding/diaper 回数や
/// 日跨ぎ睡眠の overlap を payload だけからは再計算できない)。ゆえに payload は
/// 「週内の何かが変わった」シグナルとして扱い、現在の週窓を丸ごと **refetch** する
/// (`MealsWeekNotifier` と同じ refetch 方式。Next.js 原典 `baby-dashboard.tsx` も
/// weekly logs を Realtime 購読して逐次更新する設計)。
///
/// これにより **今日以外** (週内の過去日) への cross-client 書き込みも操作なしで
/// チャートへ反映される (旧 FutureProvider 実装は今日ログ変化への piggyback のみで、
/// INSERT/UPDATE が反映されず DELETE だけ漏れ通る不整合があった)。
///
/// ## own-write は追加で invalidate (即時フィードバック)
///
/// 自分の write (quick-actions / form-sheet / feeding-timer) は、DB echo が
/// Realtime で戻るまでの遅延を待たず即座に反映するため、write 成功直後に
/// `ref.invalidate(babyWeeklySummaryProvider)` する。必ず
/// `babyLogsNotifierProvider` の invalidate と同じ場所に並べ、取りこぼしを
/// `grep "invalidate(babyLogsNotifierProvider"` で機械検証できるようにする
/// (CLAUDE.md「検証可能性を担保」)。invalidate は build を再実行し resubscribe を
/// 伴うが、topic は単調カウンタで一意化されるため teardown window で衝突しない。
///
/// ## 世代カウンタ / 初期化中バッファ
///
/// `MealsWeekNotifier` と同一: build 再実行や連続 payload で fetch が並走したとき、
/// 古い fetch の遅延結果が新しい state を上書きしないよう `_generation` でガードし、
/// 初期 fetch 完了前に届いた payload は `_refetchQueuedDuringInit` に畳んで完了後に
/// 1 回だけ fetch し直す (取りこぼしゼロ)。
///
/// 世帯未参加なら空リスト (fetch も subscribe もしない)。`fetchWeeklyLogs` は
/// timeout / 構造化ログ / rethrow を内蔵するため、初期 fetch の error は AsyncError
/// として UI へ伝播する。live refetch の失敗は現状維持 (下記 `_refetch` 参照)。
class BabyWeeklySummaryNotifier
    extends AsyncNotifier<List<BabyWeeklySummaryDay>> {
  /// fetch 開始 (build / refetch) ごとに増える世代カウンタ。
  /// 完了時に値が進んでいたら、その fetch 結果は stale として破棄する。
  int _generation = 0;

  /// build() の初期 fetch が完了したか。完了前に届いた payload / own-write は
  /// `_refetchQueuedDuringInit` に畳む (並走 refetch を作らない)。
  bool _initialized = false;

  /// 初期 fetch 中に refetch シグナル (payload / own-write) が届いた印。
  /// fetch 完了後にもう 1 回 fetch し直してから返す (取りこぼしゼロ化)。
  bool _refetchQueuedDuringInit = false;

  /// 最終 dispose 後に channel teardown window で届く payload を捨てる印。
  /// build() 冒頭で false に戻る (rebuild は dispose ではない)。
  bool _disposed = false;

  /// refetch 用に保持する build() 時点の世帯 id。
  String? _householdId;

  /// 直近 subscribe した channel topic (テスト検証用 —
  /// `RealtimeChannel.topic` は @internal で外から読めないため)。
  String? _channelTopic;

  @override
  Future<List<BabyWeeklySummaryDay>> build() async {
    // Notifier インスタンスは再利用されるため、build() 冒頭で必ずリセット。
    _initialized = false;
    _refetchQueuedDuringInit = false;
    _disposed = false;
    final generation = ++_generation;

    final householdId = await ref.watch(currentHouseholdIdProvider.future);

    // 世帯未参加 (setup 未完了) なら空リスト。subscribe もしない。
    if (householdId == null) {
      return const [];
    }
    _householdId = householdId;

    // subscribe を fetch より前に張る (baby ログと同じ「取りこぼしゼロ」設計)。
    // subscribe→fetch の window に届いた payload は `_refetchQueuedDuringInit`
    // に畳まれ、下の while で fetch し直すことで結果に反映される。
    _subscribe(householdId);

    var days = await _fetchWindow(householdId);

    // 初期 fetch 中に payload が届いていた場合、その fetch 結果は既に古い
    // 可能性があるため、最新世代である間はもう一度 fetch してから返す
    // (baby ログの「初期化中バッファ → drain」の refetch 版。state への書き込みは
    // build の戻り値に一本化され、外部 refetch との競合が起きない)。
    while (generation == _generation && _refetchQueuedDuringInit) {
      _refetchQueuedDuringInit = false;
      days = await _fetchWindow(householdId);
    }

    if (generation == _generation) {
      _initialized = true;
    }
    return days;
  }

  /// 現在の週窓 (JST [today-6, today]) を取得して日別集計にする純粋 fetch。
  ///
  /// build / refetch の双方から呼ばれる。世代カウンタや state は触らない
  /// (呼び出し側がガードする) — bump を混ぜると build の drain while ループの
  /// `generation == _generation` ガードが壊れる。
  Future<List<BabyWeeklySummaryDay>> _fetchWindow(String householdId) async {
    final repository = ref.read(babyRepositoryProvider);

    // 原典 weekly window: [today-6, today] を JST 日界で切る。
    // from = 7 日前の JST 00:00、to = 翌日の JST 00:00 (exclusive upper bound)。
    final today = formatJstDate();
    final from = '${shiftYmd(today, -6)}T00:00:00+09:00';
    final to = '${shiftYmd(today, 1)}T00:00:00+09:00';

    final logs = await repository.fetchWeeklyLogs(householdId, from, to);
    return buildBabyWeeklySummary(logs, today);
  }

  void _subscribe(String householdId) {
    final client = ref.watch(supabaseClientProvider);
    // channel topic を household + 単調カウンタで一意化する
    // (`_babyWeeklyChannelSeq` の doc 参照: resubscribe の teardown window で
    // 旧/新 channel が同一 topic だと衝突するため)。
    final seq = _babyWeeklyChannelSeq++;
    final topic = 'baby_weekly:$householdId:$seq';
    _channelTopic = topic;
    final channel = client
        .channel(topic)
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
      // 破棄時に channel を確実に解放 (leak 防止)。teardown は async のため、
      // 完了までの window に届く payload は `_disposed` で捨てる
      // (rebuild の場合は直後の build() 冒頭で false に戻り、新 build が
      //  どのみち全窓 fetch するため取りこぼしは起きない)。
      _disposed = true;
      client.removeChannel(channel);
    });
  }

  /// Realtime payload は「週内の何かが変わった」シグナルとして扱い、payload の
  /// 中身は使わず週窓を refetch する (weekly は payload から reduce 不能)。
  void _onRealtimePayload(PostgresChangePayload payload) => _refetchOrQueue();

  /// 週窓を再取得して state を置き換える (realtime payload 経路の内部処理)。
  /// own-write の即時反映は own-write サイトの `ref.invalidate` → build() 再実行が担う。
  ///
  /// 初期 fetch 完了前は並走 refetch させず「完了後に 1 回 fetch し直す」フラグのみ
  /// 立てる (build() の while が消費する)。dispose 後は捨てる。
  void _refetchOrQueue() {
    if (_disposed) return;
    if (!_initialized) {
      _refetchQueuedDuringInit = true;
      return;
    }
    unawaited(_refetch());
  }

  /// 週窓の再取得本体。失敗時は表示中のデータを AsyncError で吹き飛ばさず、
  /// ログのみ出して現状維持する (background refresh の失敗で週間チャート全体を
  /// 落とさない。repository 側でも構造化ログ済み)。
  Future<void> _refetch() async {
    if (_disposed) return;
    final householdId = _householdId;
    if (householdId == null) return;

    final generation = ++_generation;
    try {
      final days = await _fetchWindow(householdId);
      if (_disposed || generation != _generation) {
        // build 再実行や後発 refetch が始まっていたら stale 破棄。
        return;
      }
      state = AsyncData(days);
    } catch (e, st) {
      // 握り潰さない (CLAUDE.md): ログのみ出し、確定表示は現状維持
      // (background refresh の失敗で週間チャートを落とさない)。
      debugPrint('BabyWeeklySummaryNotifier refetch 失敗: $e\n$st');
    }
  }

  /// テスト専用: realtime payload を `_onRealtimePayload` に直接流す seam
  /// (`MealsWeekNotifier.debugHandlePayload` と同形)。実 Supabase channel を
  /// 張らずに「初期化中フラグ → build 内 refetch → live refetch」のタイミング挙動を
  /// 検証する hook。
  @visibleForTesting
  void debugHandlePayload(PostgresChangePayload payload) =>
      _onRealtimePayload(payload);

  /// テスト専用: build() の初期 fetch が完了し live 処理へ移行したか。
  @visibleForTesting
  bool get debugInitialized => _initialized;

  /// テスト専用: 初期化中に届いた refetch シグナルによる待機フラグ。
  @visibleForTesting
  bool get debugRefetchQueued => _refetchQueuedDuringInit;

  /// テスト専用: 現在の世代カウンタ値。
  @visibleForTesting
  int get debugGeneration => _generation;

  /// テスト専用: 直近 subscribe した channel topic
  /// (household + 単調カウンタでの一意化を検証する)。
  @visibleForTesting
  String? get debugChannelTopic => _channelTopic;
}

/// 直近 7 日 (JST, 今日含む) の週間サマリー provider。
///
/// 注意 (`babyLogsNotifierProvider` と同じ): `build()` が例外を throw すると
/// `.future` が pending のまま残る場合がある (state は AsyncError へ正しく遷移
/// する)。消費側は必ず `ref.watch(babyWeeklySummaryProvider).when(...)` で
/// **state 経由**で読み、`await provider.future` を新たに導入しないこと。
final babyWeeklySummaryProvider =
    AsyncNotifierProvider<
      BabyWeeklySummaryNotifier,
      List<BabyWeeklySummaryDay>
    >(BabyWeeklySummaryNotifier.new);
