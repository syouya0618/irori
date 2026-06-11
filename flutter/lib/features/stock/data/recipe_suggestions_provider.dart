import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/domain/suggestions/ranking.dart';
import '../../../core/domain/suggestions/types.dart';
import '../../../core/supabase/supabase_providers.dart';
import '../../meals/data/meals_repository.dart';
import '../../meals/domain/meal.dart';
import '../../meals/domain/meal_template.dart';
import '../domain/stock_item.dart';
import 'stock_items_notifier.dart';

/// 在庫マッチングのレシピ提案 (PR P2.5-F)。
///
/// Next.js 原典の対応:
/// - データ取得・整形 = `recipe-suggestion-queries.ts:23-83`
///   (`fetchRecipeSuggestions`)
/// - 在庫変化への再計算 = `stock-suggestions.tsx:44-75`
///   (1000ms デバウンス + キャンセルフラグの stale 防御)
///
/// ## 在庫の唯一のソースは [stockItemsNotifierProvider]
///
/// web は `getCachedStockItems` (React cache の同一リクエスト内重複排除) で
/// 在庫クエリを 1 回に畳む。Flutter の等価実装は「realtime 維持済みの
/// [stockItemsNotifierProvider] state を読む」こと — 本 provider が在庫の
/// select を別途発行してはならない (発行すると web の cache 契約と乖離し、
/// realtime event ごとのクエリも 2 本 → 3 本に増える)。
///
/// ## 1000ms デバウンス + 世代ガード (p25plan risks の必須要件)
///
/// `stockItemsNotifier` は realtime event ごとに state を更新するため、素朴に
/// `ref.watch` で再 fetch すると買い物チェック連打で templates/reactions の
/// select が event ごとに 2 本走るクエリストームになる。web と同じく:
/// - 在庫変化は [kStockChangeDebounce] (1000ms) デバウンスして 1 回に畳む
/// - fetch 完了時に世代カウンタを照合し、古い fetch 結果は破棄する
///   (web の `cancelled` フラグ相当 — タブ切替え中の古い結果上書き防止)
///
/// ## 再計算と build の重複防止 (Flutter 固有の構造防御)
///
/// 再計算は `state =` の手動設定で行うが、AsyncNotifier は build の返り値
/// future が解決した時点でも state を設定するため、build 中に再計算が完了
/// すると古い build 結果が後勝ちで上書きする経路がある。これを
/// [_liveRecomputeEnabled] で構造的に排除する: build の初回計算が終わるまで
/// 再計算はスケジュールせず ([_pendingRecompute] に記録)、build 完了時に
/// まとめて 1 回のデバウンス再計算に畳む。
///
/// ## エラー方針
///
/// - 初回 build の fetch 失敗: rethrow → AsyncError (既存 fetch 系規約。
///   web は SSR で空配列に倒すが、Flutter は error 表示 + 再試行を出す
///   意図的差異 — `MealsRepository.getTemplates` の rethrow 裁定と同系)
/// - 再計算の fetch 失敗: 前回データを保持して構造化ログ (web parity:
///   `stock-suggestions.tsx:61-63` は古い提案を保持して toast のみ。
///   Flutter はデータ層から toast を出せないためログに代える)
class RecipeSuggestionsNotifier extends AsyncNotifier<List<RecipeSuggestion>> {
  /// 在庫変化 → 再計算のデバウンス幅。web `stock-suggestions.tsx:67` の
  /// `setTimeout(..., 1000)` と同値 (テストで pin)。
  static const Duration kStockChangeDebounce = Duration(milliseconds: 1000);

  /// テスト用のデバウンス幅 override (既定は [kStockChangeDebounce])。
  @visibleForTesting
  Duration debugDebounceDuration = kStockChangeDebounce;

  Timer? _debounceTimer;

  /// 世代カウンタ。build 開始・再計算開始・dispose で進め、fetch 完了時に
  /// 照合して古い結果を破棄する (web の `cancelled` フラグ相当)。
  int _generation = 0;

  String? _householdId;

  /// build の初回計算が完了し、live 再計算 (デバウンス) へ移行したか。
  bool _liveRecomputeEnabled = false;

  /// build の初回計算中に在庫変化が届いたか (完了時に 1 回へ畳む)。
  bool _pendingRecompute = false;

  @override
  Future<List<RecipeSuggestion>> build() async {
    // 再 build (ダイアログ open の invalidate / 認証変化) で旧 build の
    // debounce と in-flight fetch を無効化する (Notifier インスタンスは
    // 再利用されるためフィールドを必ずリセットする)。
    _debounceTimer?.cancel();
    _debounceTimer = null;
    _generation++;
    _liveRecomputeEnabled = false;
    _pendingRecompute = false;
    _householdId = null;

    ref.onDispose(() {
      _debounceTimer?.cancel();
      _debounceTimer = null;
      // dispose 後に完了する in-flight fetch を世代ガードで確実に破棄する
      // (破棄しないと dispose 済み notifier への state 設定で throw する)。
      _generation++;
    });

    final householdId = await ref.watch(currentHouseholdIdProvider.future);
    if (householdId == null) return const [];
    _householdId = householdId;

    // build が初回在庫の到着を待つ間だけ非 null (listener が complete する)。
    Completer<List<StockItem>>? stockWaiter;

    // 在庫 state の変化を listen する。`stockItemsNotifierProvider` の doc
    // 規約により `.future` は await しない — 初回値は現 state か listener
    // 経由で受け取る。listen は購読を張るため、在庫タブ未訪問でも
    // stock notifier の初期化 (subscribe + fetch) が始まる。
    ref.listen(stockItemsNotifierProvider, (previous, next) {
      final waiter = stockWaiter;
      if (waiter != null && !waiter.isCompleted) {
        // build が初回在庫を待っている window: デバウンスせず build へ渡す
        // (在庫の「変化」ではなく初期データの到着 — web の SSR 初期計算相当)。
        final items = next.value;
        if (items != null) {
          waiter.complete(items);
        } else if (next.hasError) {
          waiter.completeError(next.error!, next.stackTrace);
        }
        return;
      }
      // loading/error への遷移では再計算しない (データ変化のみが対象)。
      if (next.value == null) return;
      if (!_liveRecomputeEnabled) {
        // build の初回計算がまだ in-flight。完了時に 1 回へ畳む
        // (ここで直接スケジュールすると再計算と build 結果が後勝ち競合する)。
        _pendingRecompute = true;
        return;
      }
      _scheduleRecompute();
    });

    final stockState = ref.read(stockItemsNotifierProvider);
    final List<StockItem> initialStock;
    final stockNow = stockState.value;
    if (stockNow != null) {
      initialStock = stockNow;
    } else if (stockState.hasError) {
      // 在庫 fetch 失敗時は提案も計算不能 (web `fetchRecipeSuggestions` は
      // stockResult.error でエラーに倒す)。在庫側の自動 retry 復帰後は
      // realtime data 到着 → 本 provider も Riverpod retry で復帰する。
      Error.throwWithStackTrace(
        stockState.error!,
        stockState.stackTrace ?? StackTrace.current,
      );
    } else {
      final waiter = stockWaiter = Completer<List<StockItem>>();
      initialStock = await waiter.future;
    }

    try {
      return await _fetchAndRank(householdId, initialStock);
    } finally {
      // 成功・失敗どちらでも live 再計算へ移行する (失敗時もここを通さねば
      // 在庫変化での自己回復経路が死ぬ)。初回計算中に届いた在庫変化は
      // ここで 1 回のデバウンス再計算に畳む。
      _liveRecomputeEnabled = true;
      if (_pendingRecompute) {
        _pendingRecompute = false;
        _scheduleRecompute();
      }
    }
  }

  /// 在庫変化をデバウンスして再計算を予約する (web `debounceRef` 相当 —
  /// 窓内の連続 event は最後の 1 回に畳まれる)。
  void _scheduleRecompute() {
    _debounceTimer?.cancel();
    _debounceTimer = Timer(debugDebounceDuration, () {
      _debounceTimer = null;
      _recomputeNow();
    });
  }

  /// 現時点の在庫 state で提案を再計算し、state を更新する。
  Future<void> _recomputeNow() async {
    final householdId = _householdId;
    if (householdId == null) return;
    final stock = ref.read(stockItemsNotifierProvider).value;
    if (stock == null) return;

    final generation = ++_generation;
    // web `setIsRefreshing(true)` 相当: AsyncLoading を設定すると Riverpod 3 の
    // element 側 (`asyncTransition`) が前回値を自動で引き継ぐため、UI は
    // `isLoading && hasValue` で更新スピナーを出しつつ前回の提案を表示できる
    // (`copyWithPrevious` は @internal のため直接は呼ばない)。
    state = const AsyncLoading<List<RecipeSuggestion>>();
    try {
      final data = await _fetchAndRank(householdId, stock);
      // 世代ガード: この fetch 中に新しい再計算 / 再 build / dispose が
      // 起きていたら古い結果を破棄する (web `if (cancelled) return`)。
      if (generation != _generation) return;
      state = AsyncData(data);
    } on Object catch (e, st) {
      if (generation != _generation) return;
      // 握り潰さない (CLAUDE.md)。repository 側でも構造化ログ済み。
      debugPrint('RecipeSuggestionsNotifier 再計算失敗: $e\n$st');
      final previous = state.value;
      if (previous != null) {
        // web parity: 古い提案を保持する (stock-suggestions.tsx:61-63 は
        // toast のみでリストを保つ)。loading を解いて spinner を止める。
        state = AsyncData(previous);
      } else {
        // 保持できる前回データが無い (初回 build 失敗直後の再計算など) は
        // error 表示に倒し、再試行導線を維持する。
        state = AsyncError<List<RecipeSuggestion>>(e, st);
      }
    }
  }

  /// templates / reactions を並列 fetch し、reactionMap 集約 → 入力型変換 →
  /// `rankSuggestions` (P2.5-A) でランクする。
  /// web `fetchRecipeSuggestions` の整形部 (:46-80) の 1:1 移植。
  Future<List<RecipeSuggestion>> _fetchAndRank(
    String householdId,
    List<StockItem> stockItems,
  ) async {
    final repo = ref.read(mealsRepositoryProvider);
    // web `Promise.all` 相当の並列 fetch (在庫は引数で受け取り済み)。
    final results = await Future.wait<Object>([
      repo.getTemplates(householdId),
      repo.fetchTemplateReactions(householdId),
    ]);
    final templates = results[0] as List<MealTemplate>;
    final reactionRows = results[1] as List<TemplateReactionRow>;

    // reactionMap 集約 (web :58-66)。template_id null 行は skip —
    // `.not(...)` で DB 側除外済みでも防御を残す (web :60 と同一)。
    final reactionMap = <String, List<MealReaction>>{};
    for (final row in reactionRows) {
      final templateId = row.templateId;
      if (templateId == null) continue;
      (reactionMap[templateId] ??= []).addAll(row.reactions);
    }

    // web :68-78 の TemplateInput 変換。ingredients 非配列は
    // `mealTemplateIngredientsFromJson` が既に空リストへ倒しており
    // (web の `Array.isArray ? ... : []` と等価)、空リストは
    // `rankSuggestions` 内で matchRate 0 → 除外される。
    final templateInputs = [
      for (final template in templates)
        TemplateInput(
          id: template.id,
          title: template.title,
          ingredients: [
            for (final ing in template.ingredients)
              TemplateIngredient(
                name: ing.name,
                // TemplateIngredient.quantity は非 null (web 型と同形)。
                // DB の null quantity は表示・マッチングに使われないため
                // 空文字へ正規化する (挙動中立)。
                quantity: ing.quantity ?? '',
                category: ing.category,
              ),
          ],
          reactionHistory: reactionMap[template.id] ?? const [],
        ),
    ];

    final stockInputs = [
      for (final item in stockItems)
        StockItemInput(
          id: item.id,
          name: item.name,
          category: item.category,
          expiresAt: item.expiresAt,
        ),
    ];

    return rankSuggestions(templateInputs, stockInputs);
  }
}

/// 在庫マッチングのレシピ提案 provider。
///
/// 消費側:
/// - 在庫タブの折りたたみ section (`StockSuggestionsSection`)
/// - テンプレート選択ダイアログの「在庫から提案」タブ
///   (open ごとに `ref.invalidate` — `mealTemplatesProvider` と同じ裁定で、
///   Realtime 非対象の templates/reactions を open 時に refetch する)
///
/// 注意 (`stockItemsNotifierProvider` と同じ): 消費側は
/// `ref.watch(...).when(...)` で state 経由で読むこと。再計算中は
/// 前回データ保持の AsyncLoading になるため、`value` で直前の提案を
/// 表示しつつ `isLoading && hasValue` で更新スピナーを出せる。
final recipeSuggestionsProvider =
    AsyncNotifierProvider<RecipeSuggestionsNotifier, List<RecipeSuggestion>>(
      RecipeSuggestionsNotifier.new,
    );
