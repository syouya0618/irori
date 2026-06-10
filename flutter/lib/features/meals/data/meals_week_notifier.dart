import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import '../../../core/supabase/supabase_providers.dart';
import '../domain/meal.dart';
import 'meals_repository.dart';
import 'selected_week_start_provider.dart';

/// 表示中の週 (`selectedWeekStartProvider`) の献立を保持し、Supabase Realtime
/// で reactive 更新する `AsyncNotifier` (`BabyLogsNotifier` と同系の作り)。
///
/// ## Realtime は **refetch 方式** (baby の reducer 方式と異なる)
///
/// 週 select は nested (`meal_reactions` / `meal_ingredients`) を含むが、
/// realtime payload には親行の列しか来ないため、payload を state に畳み込む
/// reducer は構造的に不可能。payload は「何かが変わった」シグナルとして扱い、
/// 現在週を丸ごと refetch する — Next.js 原典 `meal-week-view.tsx` も同じ
/// refetch 方式 (`fetchMeals(weekStartRef.current)`)。
///
/// ## 購読は同一チャンネルに 2 テーブル
///
/// 1. `meals` — `household_id=eq.$householdId` でサーバ側 filter。
/// 2. `meal_reactions` — **filter 無し**。household_id 列が無いため
///    サーバ側 filter を指定できないが、Realtime は RLS で購読者が SELECT
///    できる行のみ配信するため、自世帯の meal に紐づく reaction だけが届く。
///    web 版は meal_reactions を購読しておらず「パートナーのリアクションが
///    リロードまで反映されない」既知の弱点があり、本購読はその解消を兼ねる。
///
/// `meal_ingredients` は購読しない (web 版と同じ範囲。自分の編集は F2 が
/// mutation 後に refetch し、パートナーの食材編集は meals 行の更新を伴う
/// 操作経由でしか起きない)。
///
/// ## 世代カウンタ
///
/// 週切替 (build 再実行) や連続 payload で fetch が並走したとき、
/// 古い fetch の遅延結果が新しい state を上書きしないよう、fetch 開始ごとに
/// `_generation` を増やし、完了時に最新世代でなければ結果を破棄する。
class MealsWeekNotifier extends AsyncNotifier<List<Meal>> {
  /// fetch 開始 (build / refetch) ごとに増える世代カウンタ。
  /// 完了時に値が進んでいたら、その fetch 結果は stale として破棄する。
  int _generation = 0;

  /// build() の初期 fetch が完了したか。完了前に届いた payload は
  /// `_refetchQueuedDuringInit` に畳む (並走 refetch を作らない)。
  bool _initialized = false;

  /// 初期 fetch 中に realtime payload が届いた印。fetch 完了後に
  /// もう 1 回 fetch し直してから返す (取りこぼしゼロ化)。
  bool _refetchQueuedDuringInit = false;

  /// 最終 dispose 後に channel teardown window で届く payload を捨てる印。
  /// build() 冒頭で false に戻る (rebuild は dispose ではない)。
  bool _disposed = false;

  /// refetch 用に保持する build() 時点のコンテキスト。
  String? _householdId;
  String? _weekStart;

  /// 直近 subscribe した channel topic (テスト検証用 —
  /// `RealtimeChannel.topic` は @internal で外から読めないため)。
  String? _channelTopic;

  @override
  Future<List<Meal>> build() async {
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

    final repository = ref.watch(mealsRepositoryProvider);
    final weekStart = ref.watch(selectedWeekStartProvider);
    _householdId = householdId;
    _weekStart = weekStart;

    // subscribe を fetch より前に張る (baby と同じ「取りこぼしゼロ」設計)。
    // subscribe→fetch の window に届いた payload は `_refetchQueuedDuringInit`
    // に畳まれ、下の while で fetch し直すことで結果に反映される。
    _subscribe(householdId, weekStart);

    var meals = await repository.fetchWeekMeals(householdId, weekStart);

    // 初期 fetch 中に payload が届いていた場合、その fetch 結果は既に古い
    // 可能性があるため、最新世代である間はもう一度 fetch してから返す
    // (baby の「初期化中バッファ → drain」の refetch 版。state への書き込みは
    // build の戻り値に一本化され、外部 refetch との競合が起きない)。
    while (generation == _generation && _refetchQueuedDuringInit) {
      _refetchQueuedDuringInit = false;
      meals = await repository.fetchWeekMeals(householdId, weekStart);
    }

    if (generation == _generation) {
      _initialized = true;
    }
    return meals;
  }

  void _subscribe(String householdId, String weekStart) {
    final client = ref.watch(supabaseClientProvider);
    // channel topic を householdId + 週で一意にする (baby_logs_notifier と
    // 同じ理由: removeChannel → unsubscribe は async で、週切替の旧 channel
    // teardown 完了前に新 build の subscribe が走る window があり、
    // realtime_client は topic で dedup しないため同一 topic だと旧/新が
    // 衝突しうる。週を含めれば各々独立に teardown/subscribe される)。
    final topic = 'meals:$householdId:$weekStart';
    _channelTopic = topic;
    final channel = client
        .channel(topic)
        .onPostgresChanges(
          event: PostgresChangeEvent.all,
          schema: 'public',
          table: 'meals',
          filter: PostgresChangeFilter(
            type: PostgresChangeFilterType.eq,
            column: 'household_id',
            value: householdId,
          ),
          callback: _onRealtimePayload,
        )
        .onPostgresChanges(
          event: PostgresChangeEvent.all,
          schema: 'public',
          table: 'meal_reactions',
          // filter 無し: meal_reactions に household_id 列が無いため。
          // RLS が購読可視行を自世帯分に絞るゆえ安全 (クラス doc 参照)。
          callback: _onRealtimePayload,
        )
        .subscribe();

    ref.onDispose(() {
      // 破棄時に channel を確実に解放 (leak 防止)。teardown は async のため、
      // 完了までの window に届く payload は `_disposed` で捨てる
      // (rebuild の場合は直後の build() 冒頭で false に戻り、新 build が
      //  どのみち全件 fetch するため取りこぼしは起きない)。
      _disposed = true;
      client.removeChannel(channel);
    });
  }

  void _onRealtimePayload(PostgresChangePayload payload) {
    if (_disposed) return;
    if (!_initialized) {
      // 初期 fetch 完了前は refetch を並走させず「完了後に 1 回 fetch し直す」
      // フラグのみ立てる (build() の while が消費する)。
      _refetchQueuedDuringInit = true;
      return;
    }
    unawaited(_refetch());
  }

  /// 現在週を再取得して state を置き換える (live payload 経路)。
  ///
  /// 失敗時は表示中のデータを AsyncError で吹き飛ばさず、ログのみ出して
  /// 現状維持する (background refresh の失敗で週ビュー全体を落とさない。
  /// repository 側でも構造化ログ済み)。
  Future<void> _refetch() async {
    if (_disposed) return;
    final householdId = _householdId;
    final weekStart = _weekStart;
    if (householdId == null || weekStart == null) return;

    final repository = ref.read(mealsRepositoryProvider);
    final generation = ++_generation;
    try {
      final meals = await repository.fetchWeekMeals(householdId, weekStart);
      if (_disposed || generation != _generation) {
        // 週切替 (build 再実行) や後発 refetch が始まっていたら stale 破棄。
        return;
      }
      state = AsyncData(meals);
    } catch (e, st) {
      // 握り潰さない (CLAUDE.md): 経路識別つきでログし、state は現状維持。
      debugPrint('MealsWeekNotifier refetch 失敗: $e\n$st');
    }
  }

  /// テスト専用: realtime payload を `_onRealtimePayload` に直接流す seam
  /// (`BabyLogsNotifier.debugHandlePayload` と同形)。実 Supabase channel を
  /// 張らずに「初期化中フラグ → build 内 refetch → live refetch」の
  /// タイミング挙動を検証する hook。
  @visibleForTesting
  void debugHandlePayload(PostgresChangePayload payload) =>
      _onRealtimePayload(payload);

  /// テスト専用: build() の初期 fetch が完了し live 処理へ移行したか。
  @visibleForTesting
  bool get debugInitialized => _initialized;

  /// テスト専用: 初期化中に届いた payload による refetch 待ちフラグ。
  @visibleForTesting
  bool get debugRefetchQueued => _refetchQueuedDuringInit;

  /// テスト専用: 現在の世代カウンタ値。
  @visibleForTesting
  int get debugGeneration => _generation;

  /// テスト専用: 直近 subscribe した channel topic
  /// (household + 週での一意化を検証する)。
  @visibleForTesting
  String? get debugChannelTopic => _channelTopic;
}

/// 表示中の週 (`selectedWeekStartProvider`) の献立一覧 provider。
///
/// 注意 (`babyLogsNotifierProvider` と同じ): `build()` が例外を throw すると
/// `.future` が pending のまま残る場合がある (state は AsyncError へ正しく
/// 遷移する)。消費側は必ず `ref.watch(mealsWeekNotifierProvider).when(...)`
/// で **state 経由**で読み、`await provider.future` を新たに導入しないこと。
final mealsWeekNotifierProvider =
    AsyncNotifierProvider<MealsWeekNotifier, List<Meal>>(MealsWeekNotifier.new);
