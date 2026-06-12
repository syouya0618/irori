import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import '../../../core/domain/consumption_rate.dart';
import '../../../core/domain/item_category.dart';
import '../../../core/supabase/supabase_providers.dart';
import '../../../core/utils/jst_date.dart';
import '../../baby/domain/baby_log.dart' show BabyLogType;
import '../domain/stock_item.dart';

/// 全 Supabase 呼び出しに付与するタイムアウト。
/// CLAUDE.md「外部API呼び出しにはタイムアウト設定必須」。
const _kQueryTimeout = Duration(seconds: 10);

/// 在庫一覧を取る SELECT 文字列。
///
/// Next.js 版 `cached-queries.ts` (`getCachedStockItems`) の select
/// (`id, name, category, quantity, unit, expires_at, created_by, created_at,
/// updated_at`) に **`household_id` を追加**したもの。web 一覧 select は
/// household_id を含まないが、Flutter 版 `StockItem` は `stock_items.Row` と
/// 1:1 (F5 仕様 — realtime payload は全列を含むため fetch/realtime で同一
/// モデルを使う) であり、required な `householdId` を fetch 行でも埋めるために
/// 追加する (意図的差異 — PR 本文に明記)。
const _kStockItemColumns =
    'id, household_id, name, category, quantity, unit, expires_at, '
    'created_by, created_at, updated_at';

/// stock mutation に必要な認証コンテキスト。
typedef StockMutationContext = ({String householdId, String userId});

/// 在庫アイテムが既に買い物リストにあるとき ([StockRepository.addToShoppingList])。
/// web `stock/actions.ts` の「既に買い物リストにあります」分岐を型付き例外に
/// 変換し、UI が [message] をそのまま表示できるようにする
/// (`NoCheckedShoppingItemsException` / `DuplicateMealException` と同じ流儀)。
class DuplicateShoppingItemException implements Exception {
  const DuplicateShoppingItemException();

  /// web `stock/actions.ts:139` と同一文言。
  static const String message = '既に買い物リストにあります';

  @override
  String toString() => message;
}

/// [StockRepository.autoAddLowStockItems] の戻り値。web `low-stock.ts` の
/// `{ error, addedItems }` と 1:1。
///
/// - read 失敗 / 対象カテゴリなし / 低在庫なし / 全件重複: `error: null` +
///   空 [addedItems] (web low-stock.ts:53-61 — **read 失敗でも error は null**)
/// - insert 失敗のみ `error` 非 null — 呼び出し側 (`LowStockAutoAddRunner`)
///   はこの時だけスロットルのタイムスタンプを記録せず次回再試行する
///   (web stock-list.tsx の `if (result.error) return` parity)。
typedef AutoAddLowStockResult = ({String? error, List<String> addedItems});

/// write 系 UI が使う最小コンテキスト
/// (`babyMutationContextProvider` / `mealsMutationContextProvider` と同形)。
///
/// Next.js 版 `getAuthContext()` と同じ役割。世帯未参加・未認証は握り潰さず
/// `StateError` に倒し、呼び出し側が user-facing error に変換する。
final stockMutationContextProvider = FutureProvider<StockMutationContext>((
  ref,
) async {
  final client = ref.watch(supabaseClientProvider);
  final householdId = await ref.watch(currentHouseholdIdProvider.future);
  if (householdId == null) {
    throw StateError('stockMutationContextProvider: 世帯未参加状態で記録を要求した');
  }

  final user = client.auth.currentUser;
  if (user == null) {
    throw StateError('stockMutationContextProvider: 未認証状態で記録を要求した');
  }

  return (householdId: householdId, userId: user.id);
});

/// `stock_items` テーブルへのアクセスを担うリポジトリ。
///
/// Next.js 版 `cached-queries.ts` (read) + `stock/actions.ts` (write) の
/// セマンティクスを 1:1 で移植する。`parseStockFormData` 相当の入力検証は
/// `BabyRepository` の `_validate*` 流儀で repository 内 `ArgumentError` に
/// 倒す (web はフォーム由来の stringly 入力をパース時に弾く/既定値補完するが、
/// Flutter は型付き引数のため検証のみ移植し、暗黙の補完はしない)。
///
/// web stock 機能との対応 (Phase 2.5):
/// - `addToShoppingList` / `checkAndAutoAddLowStock` 相当は本リポジトリの
///   [addToShoppingList] / [autoAddLowStockItems] (PR-G。発火スロットルは
///   `low_stock_check_store.dart` の `LowStockAutoAddRunner`)。
/// - `getConsumptionRates` 相当は `consumption_rates_provider.dart` (PR-G)。
/// - `getRecipeSuggestions` / `getStockSuggestions` は別 PR スコープ —
///   本リポジトリには含めない。
///
/// エラー方針 (CLAUDE.md / `BabyRepository` と同形):
/// - `PostgrestException` は plain object のため、code/message/details/hint を
///   構造化して `debugPrint` し、握り潰さず rethrow する。
class StockRepository {
  StockRepository(this._client);

  final SupabaseClient _client;

  /// 世帯の在庫一覧を `name` 昇順で取得。
  ///
  /// web `getCachedStockItems` の `.eq("household_id").order("name")` と同一
  /// (supabase-js の `.order("name")` は既定 **ascending**。supabase-dart の
  /// `order()` は既定 descending のため明示する — `MealsRepository` と同じ注意)。
  Future<List<StockItem>> fetchItems(String householdId) async {
    try {
      final rows = await _client
          .from('stock_items')
          .select(_kStockItemColumns)
          .eq('household_id', householdId)
          .order('name', ascending: true)
          .timeout(_kQueryTimeout);
      return rows.map(StockItem.fromJson).toList();
    } on PostgrestException catch (e) {
      _logPostgrestError('fetchItems', e, 'householdId=$householdId');
      rethrow;
    }
  }

  /// 在庫アイテムを追加する。
  ///
  /// web `addStockItem` の insert 行
  /// (`{household_id, ...parsed, created_by}`) と同一の列構成。
  /// [category] / [quantity] の既定値は web `parseStockFormData` の
  /// `|| "other_food"` / `|| 1` に対応する。
  Future<void> addItem({
    required String householdId,
    required String userId,
    required String name,
    ItemCategory category = ItemCategory.otherFood,
    num quantity = 1,
    String? unit,
    String? expiresAt,
  }) async {
    final trimmedName = _validatedName(name);
    _validateQuantity(quantity);
    final normalizedExpiresAt = _emptyToNull(expiresAt);
    _validateExpiresAt(normalizedExpiresAt);

    try {
      await _client
          .from('stock_items')
          .insert({
            'household_id': householdId,
            'name': trimmedName,
            'category': category.dbValue,
            'quantity': quantity,
            'unit': _emptyToNull(unit),
            'expires_at': normalizedExpiresAt,
            'created_by': userId,
          })
          .timeout(_kQueryTimeout);
    } on Object catch (e, st) {
      _logMutationError('addItem', e, st, 'householdId=$householdId');
      rethrow;
    }
  }

  /// 在庫アイテムを更新する。
  ///
  /// web `updateStockItem` と同じく parsed 5 列
  /// (`name, category, quantity, unit, expires_at`) を household スコープ付き
  /// で update する。web は素の update だが、Flutter 版は
  /// `.select('id').single()` の行数検証を足す (`BabyRepository._updateLog` と
  /// 同形 / CLAUDE.md「`.update()` は 0 行更新でも error: null」)。対象 0 行
  /// (他世帯 or 既削除) は PGRST116 で throw される。
  Future<void> updateItem({
    required String householdId,
    required String itemId,
    required String name,
    ItemCategory category = ItemCategory.otherFood,
    num quantity = 1,
    String? unit,
    String? expiresAt,
  }) async {
    final trimmedName = _validatedName(name);
    _validateQuantity(quantity);
    final normalizedExpiresAt = _emptyToNull(expiresAt);
    _validateExpiresAt(normalizedExpiresAt);

    try {
      await _client
          .from('stock_items')
          .update({
            'name': trimmedName,
            'category': category.dbValue,
            'quantity': quantity,
            'unit': _emptyToNull(unit),
            'expires_at': normalizedExpiresAt,
          })
          .eq('id', itemId)
          .eq('household_id', householdId)
          .select('id')
          .single()
          .timeout(_kQueryTimeout);
    } on Object catch (e, st) {
      _logMutationError(
        'updateItem',
        e,
        st,
        'householdId=$householdId itemId=$itemId',
      );
      rethrow;
    }
  }

  /// 在庫アイテムを削除する。
  ///
  /// web `deleteStockItem` と同一: household スコープ付き delete。
  /// web 同様、行数検証はしない (削除は冪等で、0 行 delete は実害がない)。
  Future<void> deleteItem({
    required String householdId,
    required String itemId,
  }) async {
    try {
      await _client
          .from('stock_items')
          .delete()
          .eq('id', itemId)
          .eq('household_id', householdId)
          .timeout(_kQueryTimeout);
    } on Object catch (e, st) {
      _logMutationError(
        'deleteItem',
        e,
        st,
        'householdId=$householdId itemId=$itemId',
      );
      rethrow;
    }
  }

  /// 在庫アイテムを買い物リストへ手動追加する。
  ///
  /// web `stock/actions.ts` `addToShoppingList` (:107-160) の忠実移植:
  /// 1. `stock_items` から `name, category` を household スコープ single 取得
  ///    (失敗は rethrow — web の「在庫アイテムが見つかりません」相当は UI 側の
  ///    generic catch で「買い物リストへの追加に失敗しました」に縮退する。
  ///    意図的差異として PR 本文に明記)。
  /// 2. `shopping_items` を `.ilike('name', 生の name)` + `limit(1)` で重複
  ///    チェック。
  ///    **【web parity の意図的 quirk — レビューで「修正」しないこと】**
  ///    web actions.ts:129 `.ilike("name", stockItem.name)` は `%` `_` を
  ///    エスケープしない。名前に `%` / `_` を含む在庫は wildcard として
  ///    誤マッチする latent quirk ごと移植する (直すなら web と同時に別 issue
  ///    — Phase 2.5 計画 risks 欄)。照合規格が `autoAddToStock` の
  ///    trim+case-sensitive eq / [autoAddLowStockItems] の toLowerCase と
  ///    異なるのも意図的 (3 規格の混在が web の現挙動)。
  /// 3. 重複チェックの **read 失敗はログのみで insert へ続行**
  ///    (web actions.ts:130-134 — `logSupabaseError` のみで return しない)。
  /// 4. 重複なら [DuplicateShoppingItemException]。
  /// 5. `store_type: 'supermarket'` で insert (web actions.ts:151。
  ///    [autoAddLowStockItems] の drugstore とは意図的に異なる)。`category` は
  ///    取得した生文字列のパススルー (web の `as ItemCategory` は型 cast のみ
  ///    — enum 往復で fallback 変換しない。`autoAddToStock` と同じ方針)。
  Future<void> addToShoppingList({
    required String householdId,
    required String userId,
    required String itemId,
  }) async {
    final PostgrestMap stockItem;
    try {
      stockItem = await _client
          .from('stock_items')
          .select('name, category')
          .eq('id', itemId)
          .eq('household_id', householdId)
          .single()
          .timeout(_kQueryTimeout);
    } on Object catch (e, st) {
      _logMutationError(
        'addToShoppingList/fetch',
        e,
        st,
        'householdId=$householdId itemId=$itemId',
      );
      rethrow;
    }
    final name = stockItem['name'] as String;

    PostgrestList existing;
    try {
      existing = await _client
          .from('shopping_items')
          .select('id')
          .eq('household_id', householdId)
          .ilike('name', name)
          .limit(1)
          .timeout(_kQueryTimeout);
    } on Object catch (e, st) {
      // web parity: 重複チェック失敗はログのみで「重複なし」扱いで続行
      // (actions.ts:130-134)。
      _logMutationError(
        'addToShoppingList/duplicateCheck',
        e,
        st,
        'householdId=$householdId itemId=$itemId',
      );
      existing = const [];
    }

    if (existing.isNotEmpty) {
      throw const DuplicateShoppingItemException();
    }

    final sortOrder = await _nextShoppingSortOrder(householdId);

    try {
      await _client
          .from('shopping_items')
          .insert({
            'household_id': householdId,
            'name': name,
            'category': stockItem['category'],
            'store_type': 'supermarket',
            'created_by': userId,
            'sort_order': sortOrder,
          })
          .timeout(_kQueryTimeout);
    } on Object catch (e, st) {
      _logMutationError(
        'addToShoppingList/insert',
        e,
        st,
        'householdId=$householdId itemId=$itemId',
      );
      rethrow;
    }
  }

  /// 残日数 3 日以下の消耗品在庫を買い物リストへ自動追加する。
  ///
  /// web `lib/supabase/low-stock.ts` `autoAddLowStockItems` の忠実移植。
  /// 4 read (households / baby_logs / stock_items / shopping_items 未チェック)
  /// を並列実行し、**いずれかの失敗は構造化ログのうえ
  /// `(error: null, addedItems: [])` で静かに諦める** (low-stock.ts:53-61
  /// parity — web は無ログだが Dart は debugPrint を足す。挙動中立)。
  ///
  /// baby_logs の取得窓は `(today-7)T00:00:00+09:00` 以降 — web の TZ 無指定
  /// `gte("logged_at", `${weekAgo}T00:00:00`)` (セッション TZ = UTC 解釈) より
  /// 広い superset prefetch。`calculateDailyRate` が JST 半開区間
  /// `(today-7, today]` で再フィルタするため結果は web と同一。web 側の
  /// limit(500) は web `getConsumptionRates` (limit 無し) と不一致のため
  /// Flutter は **「limit 無し」に統一**する (`consumptionRatesProvider` の
  /// doc 参照)。
  ///
  /// 既存除外は **未チェック (`is_checked=false`) の同名 (toLowerCase) のみ**
  /// (low-stock.ts:47-50, 86-92) — チェック済みの同名は除外されず再追加される
  /// (web parity。「買った直後にまた残り少ない」を許す現挙動)。
  ///
  /// insert は `store_type: 'drugstore'` (low-stock.ts:99 — おむつ等の
  /// 消耗品はドラッグストア導線。[addToShoppingList] の supermarket とは
  /// 意図的に異なる)。insert 失敗のみ `error` 非 null
  /// ([AutoAddLowStockResult] doc 参照)。
  ///
  /// [now] はテスト用 seam (JST 窓とレート算出の基準時刻)。
  Future<AutoAddLowStockResult> autoAddLowStockItems({
    required String householdId,
    required String userId,
    DateTime? now,
  }) async {
    const empty = (error: null, addedItems: <String>[]);
    final effectiveNow = now ?? DateTime.now();
    final today = formatJstDate(effectiveNow);
    final from = '${shiftYmd(today, -7)}T00:00:00+09:00';

    final PostgrestMap household;
    final PostgrestList logRows;
    final PostgrestList stockRows;
    final PostgrestList shoppingRows;
    try {
      final results = await Future.wait<Object?>([
        _client
            .from('households')
            .select('auto_stock_categories')
            .eq('id', householdId)
            .single()
            .timeout(_kQueryTimeout),
        _client
            .from('baby_logs')
            .select('log_type, logged_at, amount_ml')
            .eq('household_id', householdId)
            .inFilter('log_type', ['diaper', 'feeding'])
            .gte('logged_at', from)
            .timeout(_kQueryTimeout),
        _client
            .from('stock_items')
            .select('id, name, category, quantity')
            .eq('household_id', householdId)
            .timeout(_kQueryTimeout),
        _client
            .from('shopping_items')
            .select('name')
            .eq('household_id', householdId)
            .eq('is_checked', false)
            .timeout(_kQueryTimeout),
      ]);
      household = results[0] as PostgrestMap;
      logRows = results[1] as PostgrestList;
      stockRows = results[2] as PostgrestList;
      shoppingRows = results[3] as PostgrestList;
    } on Object catch (e, st) {
      // web parity: read 失敗は error: null の空戻り (low-stock.ts:53-61)。
      _logMutationError(
        'autoAddLowStockItems/read',
        e,
        st,
        'householdId=$householdId',
      );
      return empty;
    }

    // 対象カテゴリ (web: `!Array.isArray(autoCategories) || length === 0`)。
    final categories = household['auto_stock_categories'];
    if (categories is! List || categories.isEmpty) return empty;

    // diaper レート。rates は web (low-stock.ts:73-74) と同じく category
    // **生文字列**キー — stock 行の category と enum 往復なしで照合する
    // (`ShoppingRepository.autoAddToStock` の「enum 化しない」方針と同じ)。
    final inputs = <ConsumptionLogInput>[];
    for (final row in logRows) {
      final input = _consumptionInput(row);
      if (input != null) inputs.add(input);
    }
    final diaperRate = calculateDailyRate(
      inputs,
      BabyLogType.diaper,
      today: effectiveNow,
    );
    final rates = <String, double?>{'baby': diaperRate};

    // 残日数 ≤3 の抽出 (low-stock.ts:77-84)。
    final lowStockItems = <PostgrestMap>[];
    for (final row in stockRows) {
      final category = row['category'];
      if (category is! String || !categories.contains(category)) continue;
      final rate = rates[category];
      if (rate == null) continue;
      if (row['name'] is! String) continue;
      final quantity = _lowStockQuantity(row['quantity']);
      if (quantity == null) continue;
      final remaining = estimateRemainingDays(quantity, rate);
      // **remaining == 0 は「今日切れ」の有効値** — web の
      // `remaining !== null && remaining <= 3` を null 比較で忠実に移植する。
      // `remaining != null` 以外の falsy 風判定 (`remaining > 0` 等) を書くと
      // 残 0 日の在庫が漏れる (estimateRemainingDays doc / 計画 risks)。
      if (remaining == null || remaining > 3) continue;
      lowStockItems.add(row);
    }
    if (lowStockItems.isEmpty) return empty;

    // 未チェックの既存名 (toLowerCase) を除外 (low-stock.ts:86-94)。
    final existingNames = <String>{
      for (final row in shoppingRows)
        if (row['name'] is String) (row['name'] as String).toLowerCase(),
    };
    final toAdd = [
      for (final item in lowStockItems)
        if (!existingNames.contains((item['name'] as String).toLowerCase()))
          item,
    ];
    if (toAdd.isEmpty) return empty;

    // sort_order 連番 (web: `getNextSortOrder` → `nextOrder++`)。
    var nextOrder = await _nextShoppingSortOrder(householdId);
    final insertRows = [
      for (final item in toAdd)
        {
          'household_id': householdId,
          'name': item['name'],
          'category': item['category'],
          'store_type': 'drugstore',
          'created_by': userId,
          'sort_order': nextOrder++,
        },
    ];

    try {
      await _client
          .from('shopping_items')
          .insert(insertRows)
          .timeout(_kQueryTimeout);
    } on Object catch (e, st) {
      _logMutationError(
        'autoAddLowStockItems/insert',
        e,
        st,
        'householdId=$householdId itemCount=${insertRows.length}',
      );
      // web low-stock.ts:108-110 と同一文言。error 非 null はこの経路のみ。
      return (
        error: '買い物リストへの追加に失敗しました',
        addedItems: const <String>[],
      );
    }

    return (
      error: null,
      addedItems: [for (final item in toAdd) item['name'] as String],
    );
  }

  /// 次の `sort_order` (= `shopping_items` の既存最大値 + 1、空なら 1)。
  ///
  /// web `getNextSortOrder(supabase, householdId, "stock")` 相当で、
  /// `ShoppingRepository._nextSortOrder` と同型の**意図的な複製** — 共有化は
  /// 最小変更を優先して見送る (Phase 2.5 計画。挙動を変える時は両方を直す)。
  /// lookup 失敗は web parity でログのみの fallback 1 (insert は止めない)。
  Future<int> _nextShoppingSortOrder(String householdId) async {
    try {
      final row = await _client
          .from('shopping_items')
          .select('sort_order')
          .eq('household_id', householdId)
          .order('sort_order', ascending: false)
          .limit(1)
          .maybeSingle()
          .timeout(_kQueryTimeout);
      return ((row?['sort_order'] as num?)?.toInt() ?? 0) + 1;
    } on Object catch (e, st) {
      _logMutationError(
        'nextShoppingSortOrder',
        e,
        st,
        'householdId=$householdId',
      );
      return 1;
    }
  }

  /// `PostgrestException` を握り潰さず構造化ログする (CLAUDE.md)。
  /// [context] は調査用の識別子 (householdId / itemId — 機密ではない)。
  void _logPostgrestError(String op, PostgrestException e, String context) {
    debugPrint(
      'StockRepository.$op PostgrestException: '
      'code=${e.code} message=${e.message} '
      'details=${e.details} hint=${e.hint} $context',
    );
  }

  void _logMutationError(
    String op,
    Object error,
    StackTrace stackTrace,
    String context,
  ) {
    if (error is PostgrestException) {
      _logPostgrestError(op, error, context);
      return;
    }
    debugPrint('StockRepository.$op error: $error\n$stackTrace $context');
  }
}

/// `StockRepository` の DI provider。
final stockRepositoryProvider = Provider<StockRepository>((ref) {
  return StockRepository(ref.watch(supabaseClientProvider));
});

/// "YYYY-MM-DD" 形式 (web の `<input type="date">` が submit する形)。
final _kYmdPattern = RegExp(r'^\d{4}-\d{2}-\d{2}$');

/// web `parseStockFormData` の name 検証 + trim
/// (`typeof name !== "string" || name.trim().length === 0` → reject、
/// 文言も web と同一)。insert/update には trim 済みの値を使う
/// (web: `name.trim()`)。
String _validatedName(String name) {
  final trimmed = name.trim();
  if (trimmed.isEmpty) {
    throw ArgumentError.value(name, 'name', 'アイテム名を入力してください');
  }
  return trimmed;
}

/// quantity の範囲検証。web は `Number(...) || 1` で 0/NaN を黙って 1 に
/// 補完するが (falsy 衝突の既知の罠 / CLAUDE.md)、Flutter は型付き引数の
/// ため黙殺せず `ArgumentError` で表面化させる。
///
/// 下限を `< 1` ではなく `<= 0` にする理由 (PR #19 レビュー指摘):
/// web のフォームは `step="0.1"` + `|| 1` で **0.5 等の正の小数を素通しで
/// DB (NUMERIC) に保存しうる**。`< 1` で弾くと、web が保存した 0.5 の在庫を
/// Flutter 側で fetch→編集→保存できなくなる (編集不能化)。ゆえに
/// 「正の有限値」のみ要求し、web が書きうる値は全て受理する。
/// NaN は `<= 0` 比較で検出できないため `isFinite` で明示的に弾く
/// (Infinity も同経路で reject)。
/// 上限は web に存在しないため設けない (DB は NUMERIC で制約なし)。
void _validateQuantity(num quantity) {
  if (quantity <= 0 || !quantity.isFinite) {
    throw ArgumentError.value(
      quantity,
      'quantity',
      '数量は0より大きい値で入力してください',
    );
  }
}

/// expiresAt の形式検証 (正規化後の値を渡す — null は「期限なし」で正常)。
/// web は `<input type="date">` が "YYYY-MM-DD" を保証するため、
/// その契約を明示検証に置き換える。
void _validateExpiresAt(String? expiresAt) {
  if (expiresAt == null) return;
  if (!_kYmdPattern.hasMatch(expiresAt)) {
    throw ArgumentError.value(
      expiresAt,
      'expiresAt',
      '賞味期限はYYYY-MM-DD形式で入力してください',
    );
  }
}

/// web の `length > 0 ? v : null` 相当: 空文字を null に正規化する
/// (`BabyRepository` の `_nullableMemo` と同じ流儀)。
String? _emptyToNull(String? value) {
  if (value == null || value.isEmpty) return null;
  return value;
}

/// `autoAddLowStockItems` の baby_logs 生 row を `ConsumptionLogInput` へ
/// 変換する。
///
/// web (low-stock.ts:73) は select した行をそのまま `calculateDailyRate` に
/// 渡す (log_type は文字列比較)。Dart 版は `ConsumptionLogInput.logType` が
/// enum のため diaper/feeding のみ対応付け、未知値・パース不能行は skip する
/// (in filter 済みのため通常は到達しない tolerant 防御 — 1 行の破損で
/// 全体を倒さない `baby_log.dart` 流儀)。
ConsumptionLogInput? _consumptionInput(Map<String, dynamic> row) {
  final logType = switch (row['log_type']) {
    'diaper' => BabyLogType.diaper,
    'feeding' => BabyLogType.feeding,
    _ => null,
  };
  if (logType == null) return null;
  final loggedAtRaw = row['logged_at'];
  if (loggedAtRaw is! String) return null;
  final loggedAt = DateTime.tryParse(loggedAtRaw);
  if (loggedAt == null) return null;
  return ConsumptionLogInput(logType: logType, loggedAt: loggedAt);
}

/// `autoAddLowStockItems` の stock 行 quantity を num 化する。
///
/// Postgres `numeric` は PostgREST が引用符付き文字列で返す場合がある
/// (`StockItem` の `_quantityFromJson` と同じ前提)。web (JS) は `"6" <= 0` /
/// `Math.floor("6"/rate)` の暗黙数値変換で文字列でも計算が成立するため、
/// Dart では `num.tryParse` がその等価。パース不能 (JS では NaN →
/// `remaining <= 3` が false → 対象外) は null を返し呼び出し側が skip する
/// — fallback 1 を使う `StockItem` とは目的が違う (こちらは web の
/// 「対象外」挙動の再現)。
num? _lowStockQuantity(Object? value) {
  if (value is num) return value;
  if (value is String) return num.tryParse(value);
  return null;
}
