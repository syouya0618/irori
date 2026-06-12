import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import '../../../core/domain/item_category.dart';
import '../../../core/domain/store_type.dart';
import '../../../core/supabase/supabase_providers.dart';
import '../../../core/utils/jst_date.dart';
import '../domain/shopping_item.dart';

/// 全 Supabase 呼び出しに付与するタイムアウト。
/// CLAUDE.md「外部API呼び出しにはタイムアウト設定必須」。
const _kQueryTimeout = Duration(seconds: 10);

/// `shopping_items` の全 13 列 SELECT 文字列 (`database.ts` の Row と 1:1)。
///
/// web `shopping/page.tsx` の初期 select は 9 列 (household_id / meal_id /
/// created_by / created_at を含まない) だが、Flutter 版は `ShoppingItem`
/// モデルが Realtime payload (フル行) と 1:1 のため、初期 fetch も同じ形で
/// 取得して `fromJson` を reducer と共通化する (baby `_kBabyLogColumns` が
/// web に無い `updated_at` を足したのと同じ理由)。WHERE / ORDER の
/// セマンティクスは web と同一に保つ。
const _kShoppingItemColumns =
    'id, household_id, name, quantity, category, store_type, is_checked, '
    'checked_by, checked_at, meal_id, sort_order, created_by, created_at';

/// `clearChecked` 時にチェック済みアイテムが 0 件 (web `actions.ts` の
/// 「チェック済みのアイテムがありません」分岐)。
///
/// web はこのケースで履歴 insert / 削除に進まず error を返す。Flutter 版は
/// 型付き例外に変換し、UI (F4) が [message] をそのまま表示できるようにする
/// (`DuplicateMealException` と同じ流儀)。
class NoCheckedShoppingItemsException implements Exception {
  const NoCheckedShoppingItemsException();

  /// web `actions.ts` と同一文言。
  static const String message = 'チェック済みのアイテムがありません';

  @override
  String toString() => message;
}

/// `generateFromMeals` で今週の献立 (外食を除く) が 0 件
/// (web `actions.ts:184-186` の `no_meals` 分岐)。
class NoMealsThisWeekException implements Exception {
  const NoMealsThisWeekException();

  /// web `actions.ts` と同一文言。
  static const String message = '今週の献立が登録されていません';

  @override
  String toString() => message;
}

/// `generateFromMeals` で今週の献立に食材が 0 件
/// (web `actions.ts:187-189` の `no_ingredients` 分岐)。
class NoIngredientsThisWeekException implements Exception {
  const NoIngredientsThisWeekException();

  /// web `actions.ts` と同一文言。
  static const String message = '今週の献立に食材が登録されていません';

  @override
  String toString() => message;
}

/// `generateFromMeals` で全食材が既存リストと重複し、追加できる新規食材が
/// 0 件 (web `actions.ts:196-198` 分岐)。
class NoNewIngredientsException implements Exception {
  const NoNewIngredientsException();

  /// web `actions.ts` と同一文言。
  static const String message = '追加できる新しい食材がありません';

  @override
  String toString() => message;
}

/// shopping mutation に必要な認証コンテキスト。
typedef ShoppingMutationContext = ({String householdId, String userId});

/// [ShoppingRepository.toggleItem] の戻り値。web `toggleItem` action の
/// `{ success, autoStocked, autoStockedName }` (actions.ts:97) のうち
/// success を除いたもの (Dart では失敗を例外で表現)。UI は autoStocked 時に
/// 成功 toast「{名前}を在庫に追加しました」を出す (`shopping-item.tsx:61-63`)。
typedef ToggleItemResult = ({bool autoStocked, String? autoStockedName});

/// [ShoppingRepository.searchSuggestions] の 1 件。web `getSuggestions` の
/// 戻り shape `{ name, category, storeType }` (actions.ts:279-285) に対応。
///
/// category / store_type が NULL の履歴行は **null のまま透過**し、UI 側が
/// 「非 null のみフォームへ反映」する (web `selectSuggestion` の falsy ガード
/// `if (suggestion.category) setCategory(...)` と等価)。
typedef PurchaseSuggestion = ({
  String name,
  ItemCategory? category,
  StoreType? storeType,
});

/// `shopping_items` / `purchase_history` と、在庫自動登録
/// ([autoAddToStock]) のための `households` / `stock_items`、献立からの
/// 食材生成 ([generateFromMeals]) のための `meals` / `meal_ingredients` への
/// アクセスを担うリポジトリ。Next.js 版 `shopping/page.tsx` (read) +
/// `actions.ts` (write) + `auto-stock.ts` + `shopping-queries.ts` の
/// セマンティクスを移植する。
///
/// `households` / `meals` 系の read は web 同様このリポジトリ内の inline
/// select とし、共有 provider へ抽象化しない (Phase 2.5 計画 — 過剰抽象の
/// 回避)。
///
/// エラー方針 (CLAUDE.md / `BabyRepository` / `MealsRepository` と同形):
/// - `PostgrestException` は plain object のため、code/message/details/hint を
///   構造化して `debugPrint` し、握り潰さず rethrow する。
/// - 例外: `_nextSortOrder` の lookup 失敗 (web parity の fallback)、
///   `clearChecked` の履歴 insert 失敗 (web parity の続行)、
///   [autoAddToStock] 内の各失敗 (web parity の bool false 戻し)、
///   [_newIngredientsForWeek] の既存リスト取得失敗 (web parity の空 Set
///   続行)、[previewMealIngredients] (web parity の count 0 縮退)、
///   [searchSuggestions] の検索失敗 (web parity の空 list 縮退) のみ、
///   構造化ログのうえ rethrow しない — 各メソッドの doc コメント参照。
class ShoppingRepository {
  ShoppingRepository(this._client);

  final SupabaseClient _client;

  /// 世帯の買い物アイテムを `sort_order` 昇順で全件取得。
  ///
  /// web `shopping/page.tsx` と同じ
  /// `eq(household_id) / order("sort_order", ascending)`。
  /// 列は web の 9 列ではなく全 13 列 ([_kShoppingItemColumns] 参照)。
  Future<List<ShoppingItem>> fetchItems(String householdId) async {
    try {
      final rows = await _client
          .from('shopping_items')
          .select(_kShoppingItemColumns)
          .eq('household_id', householdId)
          // web の `.order("sort_order", { ascending: true })`。
          // supabase-dart の `order()` は既定 descending のため明示する。
          .order('sort_order', ascending: true)
          .timeout(_kQueryTimeout);
      return rows.map(ShoppingItem.fromJson).toList();
    } on PostgrestException catch (e) {
      _logPostgrestError('fetchItems', e, 'householdId=$householdId');
      rethrow;
    }
  }

  /// アイテムを追加する。
  ///
  /// web `addItem` のセマンティクス:
  /// - `name` は trim し、空なら入力エラー (web の
  ///   「アイテム名を入力してください」分岐 → `ArgumentError`)。
  /// - `quantity` の空文字は null に正規化 (web: `quantity || null`)。
  /// - [category] / [storeType] の既定値は web のフォーム既定
  ///   (`"other_food"` / `"supermarket"`) と同一。
  /// - `sort_order` は既存の最大値 + 1 ([_nextSortOrder])。
  /// - `meal_id` は設定しない (web `addItem` も設定しない。meal_id を書くのは
  ///   [generateFromMeals] のみ)。
  Future<void> addItem({
    required String householdId,
    required String userId,
    required String name,
    String? quantity,
    ItemCategory category = ItemCategory.otherFood,
    StoreType storeType = StoreType.supermarket,
  }) async {
    final trimmed = name.trim();
    if (trimmed.isEmpty) {
      throw ArgumentError.value(name, 'name', 'アイテム名を入力してください');
    }

    // sort_order は既存の最大値 + 1 (web `getNextSortOrder`)。
    final sortOrder = await _nextSortOrder(householdId);

    try {
      await _client
          .from('shopping_items')
          .insert({
            'household_id': householdId,
            'name': trimmed,
            'quantity': _nullableQuantity(quantity),
            'category': category.dbValue,
            'store_type': storeType.dbValue,
            'created_by': userId,
            'sort_order': sortOrder,
          })
          .timeout(_kQueryTimeout);
    } on Object catch (e, st) {
      _logMutationError('addItem', e, st, 'householdId=$householdId');
      rethrow;
    }
  }

  /// 次の `sort_order` (= 既存最大値 + 1、空リストなら 1) を取得する。
  ///
  /// web `getNextSortOrder` のセマンティクスを正確に踏襲:
  /// - 空リスト (0 行) は正常系ゆえ `maybeSingle` (null → 0 + 1 = 1)。
  /// - **lookup 失敗は致命扱いしない**: web は error を log したうえで
  ///   `(data?.sort_order ?? 0) + 1` = 1 に fallback して insert へ進む。
  ///   Dart 版も握り潰さず構造化ログし (CLAUDE.md「maybeSingle の error を
  ///   必ず受け取る」)、同じ fallback 値 1 を返す。
  ///
  /// `StockRepository._nextShoppingSortOrder` に同型の意図的な複製あり —
  /// 挙動を変える時は両方を直すこと (相互参照)。
  Future<int> _nextSortOrder(String householdId) async {
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
      // web parity: sort_order lookup 失敗でアイテム追加自体は止めない。
      _logMutationError('nextSortOrder', e, st, 'householdId=$householdId');
      return 1;
    }
  }

  /// チェック状態を切り替え、在庫自動登録の結果を返す。
  ///
  /// web `toggleItem` (actions.ts:51-98) の移植:
  /// - 更新列は `is_checked` / `checked_by` / `checked_at` のみ。チェック ON
  ///   で checked_by = [userId] / checked_at = 現在時刻、OFF で両方 null
  ///   (web と同一)。
  /// - household スコープ + `.select('name, category').single()` で「対象
  ///   0 行 (他世帯 or 既削除)」を silent success にしない (CLAUDE.md
  ///   「`.update()` は 0 行更新でも error: null」)。返却列は web
  ///   actions.ts:66 と同一で、行数検証と [autoAddToStock] への入力取得を
  ///   兼ねる。
  /// - チェック ON のときのみ [autoAddToStock] を実行する (actions.ts:73-93)。
  ///   その**失敗・throw はチェック操作自体に影響させない** — actions.ts:90-92
  ///   の `catch {}` parity。ただし Dart 版は握り潰さず構造化ログを出す
  ///   (CLAUDE.md「エラー握り潰し禁止」— 挙動中立の追加)。
  ///
  /// 戻り値は web の `{ autoStocked, autoStockedName }` に対応し、UI が成功
  /// toast を出すのに使う ([ToggleItemResult] doc 参照)。
  Future<ToggleItemResult> toggleItem({
    required String householdId,
    required String itemId,
    required bool isChecked,
    required String userId,
  }) async {
    final PostgrestMap updatedItem;
    try {
      updatedItem = await _client
          .from('shopping_items')
          .update({
            'is_checked': isChecked,
            'checked_by': isChecked ? userId : null,
            'checked_at': isChecked
                ? DateTime.now().toUtc().toIso8601String()
                : null,
          })
          .eq('id', itemId)
          .eq('household_id', householdId)
          .select('name, category')
          .single()
          .timeout(_kQueryTimeout);
    } on Object catch (e, st) {
      _logMutationError('toggleItem', e, st, 'householdId=$householdId');
      rethrow;
    }

    var autoStocked = false;
    String? autoStockedName;

    // 在庫自動追加: チェック ON 時のみ (web actions.ts:77 の
    // `isChecked && updatedItem` — Dart は single() が非 null を保証する
    // ため isChecked のみで等価)。
    if (isChecked) {
      try {
        final stocked = await autoAddToStock(
          householdId: householdId,
          userId: userId,
          itemName: updatedItem['name'] as String,
          itemCategory: updatedItem['category'] as String,
        );
        if (stocked) {
          autoStocked = true;
          autoStockedName = updatedItem['name'] as String;
        }
      } on Object catch (e, st) {
        // auto-stock の失敗はチェック操作自体には影響させない
        // (web actions.ts:90-92)。握り潰さず構造化ログ (CLAUDE.md)。
        _logMutationError(
          'toggleItem/autoStock',
          e,
          st,
          'householdId=$householdId',
        );
      }
    }

    return (autoStocked: autoStocked, autoStockedName: autoStockedName);
  }

  /// チェック ON 時の在庫自動追加 — web `auto-stock.ts:15-77` の忠実移植。
  ///
  /// 世帯の `auto_stock_categories` に含まれるカテゴリのみ対象。同名在庫が
  /// あれば quantity +1、なければ quantity 1 / unit「個」で新規作成する。
  /// 失敗は bool (false) で返すのみで、呼び出し側のチェック操作には影響
  /// させない (web auto-stock.ts:10-11 の方針)。
  ///
  /// **web parity の意図的 quirk — レビューで「統一・修正」しないこと**
  /// (Phase 2.5 計画 risks 欄 / CLAUDE.md「防御コード削除禁止」と同類。
  /// 直す場合は web と同時に別 issue で):
  /// - 在庫名照合は `eq('name', itemName.trim())` — **trim のみの
  ///   case-sensitive 完全一致** (web auto-stock.ts:47)。買い物リスト生成
  ///   ([generateFromMeals]) の toLowerCase 照合とは意図的に規格が異なる。
  /// - 既存在庫の quantity +1 は **read-modify-write のまま**
  ///   (web auto-stock.ts:45,61) — atomic 化 (RPC 等) しない。
  /// - `limit(1)` は **order なし** (web auto-stock.ts:48) — 同名複数行が
  ///   あるときは非決定で 1 行を選ぶ。
  /// - 照合 lookup の失敗はログのみで「既存なし」扱いとなり**新規 insert に
  ///   進む** (web auto-stock.ts:50-56 の `matchedItems?.[0] ?? null`)。
  ///
  /// [itemCategory] は DB の生文字列のまま受け取る (web actions.ts:84 の
  /// `as ItemCategory` は型 cast のみで実行時変換なし)。
  /// `ItemCategory.fromDbValue` の tolerant fallback (未知値 → other_daily)
  /// を通すと照合・insert の挙動が web から乖離するため enum 化しない。
  ///
  /// quantity は num のまま +1 する (`StockItem.quantity` doc 参照 —
  /// int キャスト / round() はデータ破壊)。
  Future<bool> autoAddToStock({
    required String householdId,
    required String userId,
    required String itemName,
    required String itemCategory,
  }) async {
    // 世帯の自動追加対象カテゴリを取得。supabase-dart はエラーを throw する
    // ため、web の `if (householdError) log` + `if (!household) return false`
    // (auto-stock.ts:29-35) は catch + 構造化ログ + false で等価になる。
    final PostgrestMap household;
    try {
      household = await _client
          .from('households')
          .select('auto_stock_categories')
          .eq('id', householdId)
          .single()
          .timeout(_kQueryTimeout);
    } on Object catch (e, st) {
      _logMutationError(
        'autoAddToStock/household',
        e,
        st,
        'householdId=$householdId',
      );
      return false;
    }

    // カテゴリ対象外は silent skip (web auto-stock.ts:37-40 の
    // `Array.isArray` ガード + `includes`)。web は無ログだが、Dart 版は
    // 調査用に debug ログのみ足す (挙動中立 — DB アクセス・戻り値は不変)。
    final categories = household['auto_stock_categories'];
    if (categories is! List<dynamic> || !categories.contains(itemCategory)) {
      debugPrint(
        'ShoppingRepository.autoAddToStock skip: '
        'category=$itemCategory は auto_stock_categories 対象外 '
        'householdId=$householdId',
      );
      return false;
    }

    // 同名の在庫アイテムがあるか確認 — trim のみ・case-sensitive eq・
    // order なし limit(1) (web auto-stock.ts:43-48。メソッド doc の quirk
    // 一覧参照)。
    PostgrestList matchedItems;
    try {
      matchedItems = await _client
          .from('stock_items')
          .select('id, name, quantity')
          .eq('household_id', householdId)
          .eq('name', itemName.trim())
          .limit(1)
          .timeout(_kQueryTimeout);
    } on Object catch (e, st) {
      // web parity: 照合失敗はログのみで existing = null 扱い
      // (auto-stock.ts:50-56) — このまま新規 insert へ進む。
      _logMutationError(
        'autoAddToStock/match',
        e,
        st,
        'householdId=$householdId',
      );
      matchedItems = const [];
    }

    final existing = matchedItems.firstOrNull;

    if (existing != null) {
      // read-modify-write の +1 (web auto-stock.ts:58-63 — atomic 化しない)。
      // quantity は num のまま加算する (1.5 + 1 = 2.5)。
      final newQuantity = (existing['quantity'] as num) + 1;
      try {
        await _client
            .from('stock_items')
            .update({'quantity': newQuantity})
            .eq('id', existing['id'] as String)
            .timeout(_kQueryTimeout);
      } on Object catch (e, st) {
        // web は `if (updateError) return false` (auto-stock.ts:63)。
        // Dart 版は CLAUDE.md「エラー握り潰し禁止」により構造化ログを足す
        // (挙動中立の追加)。
        _logMutationError(
          'autoAddToStock/update',
          e,
          st,
          'householdId=$householdId',
        );
        return false;
      }
    } else {
      try {
        await _client
            .from('stock_items')
            .insert({
              'household_id': householdId,
              'name': itemName.trim(),
              'category': itemCategory,
              'quantity': 1,
              'unit': '個',
              'created_by': userId,
            })
            .timeout(_kQueryTimeout);
      } on Object catch (e, st) {
        // web は `if (insertError) return false` (auto-stock.ts:73)。同上。
        _logMutationError(
          'autoAddToStock/insert',
          e,
          st,
          'householdId=$householdId',
        );
        return false;
      }
    }

    return true;
  }

  /// アイテムを削除する。
  ///
  /// web `deleteItem` と同じ household スコープ付き削除
  /// (`BabyRepository.deleteLog` と同形 — web 同様、行数検証はしない。
  /// 既削除行への delete は冪等な正常系)。
  Future<void> deleteItem({
    required String householdId,
    required String itemId,
  }) async {
    try {
      await _client
          .from('shopping_items')
          .delete()
          .eq('id', itemId)
          .eq('household_id', householdId)
          .timeout(_kQueryTimeout);
    } on Object catch (e, st) {
      _logMutationError('deleteItem', e, st, 'householdId=$householdId');
      rethrow;
    }
  }

  /// チェック済みアイテムを購入履歴に記録してから削除し、件数を返す。
  ///
  /// web `clearChecked` の 3 段処理の順序・対象列を正確に踏襲する:
  /// 1. チェック済みを取得 — `select("name, category, store_type")` +
  ///    `eq(household_id) / eq(is_checked, true)`。失敗は rethrow
  ///    (web の「チェック済みアイテムの取得に失敗しました」)。0 件は
  ///    [NoCheckedShoppingItemsException] (web は履歴/削除に進まず error)。
  /// 2. `purchase_history` へ一括 insert — 行は web と同じ
  ///    `{household_id, item_name, category, store_type}`。category /
  ///    store_type は取得した**生の値をそのまま**渡す (enum 往復で未知値を
  ///    fallback 変換しない — web のパススルーと同一)。**insert 失敗は
  ///    構造化ログのみで削除を続行** (web「履歴の記録に失敗しても削除は続行」。
  ///    購入履歴はサジェスト品質を支えるデータ生成ゆえ Phase 2 に含めるが、
  ///    履歴の失敗でリスト掃除を止めない)。
  /// 3. チェック済みを削除 — `eq(household_id) / eq(is_checked, true)`。
  ///    失敗は rethrow (web の「チェック済みアイテムの削除に失敗しました」)。
  ///
  /// 戻り値は削除対象件数 (web の `{ success: true, count }` 相当)。
  Future<int> clearChecked(String householdId) async {
    // ── 1 段目: チェック済みアイテムを取得 ──
    final PostgrestList checkedItems;
    try {
      checkedItems = await _client
          .from('shopping_items')
          .select('name, category, store_type')
          .eq('household_id', householdId)
          .eq('is_checked', true)
          .timeout(_kQueryTimeout);
    } on Object catch (e, st) {
      _logMutationError(
        'clearChecked/fetch',
        e,
        st,
        'householdId=$householdId',
      );
      rethrow;
    }

    if (checkedItems.isEmpty) {
      throw const NoCheckedShoppingItemsException();
    }

    // ── 2 段目: 購入履歴に記録 (失敗してもログのみで削除続行 — web parity) ──
    final historyRows = [
      for (final item in checkedItems)
        {
          'household_id': householdId,
          'item_name': item['name'],
          'category': item['category'],
          'store_type': item['store_type'],
        },
    ];
    try {
      await _client
          .from('purchase_history')
          .insert(historyRows)
          .timeout(_kQueryTimeout);
    } on Object catch (e, st) {
      // 履歴の記録に失敗しても削除は続行 (web parity)。握り潰さず構造化ログ。
      _logMutationError(
        'clearChecked/history',
        e,
        st,
        'householdId=$householdId itemCount=${historyRows.length}',
      );
    }

    // ── 3 段目: チェック済みアイテムを削除 ──
    try {
      await _client
          .from('shopping_items')
          .delete()
          .eq('household_id', householdId)
          .eq('is_checked', true)
          .timeout(_kQueryTimeout);
    } on Object catch (e, st) {
      _logMutationError(
        'clearChecked/delete',
        e,
        st,
        'householdId=$householdId',
      );
      rethrow;
    }

    return checkedItems.length;
  }

  /// 購入履歴を部分一致検索し、名前でユニーク化したサジェストを返す。
  ///
  /// web `getSuggestions` (actions.ts:260-286) + `searchPurchaseHistory`
  /// (shopping-queries.ts:114-141) の移植:
  /// - 空 query (trim 後) は **DB 非アクセスで早期 return []**
  ///   (actions.ts:261-263 — 認証前の early return)。
  /// - `ilike` パターンは `query.trim()` の `%` `_` `\` を `\` 前置で
  ///   エスケープしてから `%...%` に包む (shopping-queries.ts:123
  ///   `.ilike("item_name", `%${query.trim().replace(/[%_\\]/g, "\\$&")}%`)`
  ///   と同一 regex 意味論)。
  /// - `purchased_at` 降順 + `limit(20)` (shopping-queries.ts:124-125)。
  /// - 名前の toLowerCase でクライアント側 dedupe — 降順ゆえ**最新の履歴が
  ///   勝つ** (shopping-queries.ts:131-138)。
  /// - category / store_type の **NULL 列は null のまま透過**し、非 null
  ///   のみ tolerant `fromDbValue` で enum 化する ([PurchaseSuggestion] doc
  ///   参照)。
  /// - **検索失敗は構造化ログのみで [] に縮退** (actions.ts:275-277 の
  ///   `if (error) return { suggestions: [] }` — サジェストは best-effort で
  ///   入力 UI を止めない)。rethrow しない例外則はクラス doc 参照。
  ///
  /// **web parity の意図的な規格差 — レビューで「統一」しないこと**
  /// (Phase 2.5 計画 risks 欄): 本検索の ilike は**エスケープする**側の
  /// 規格。在庫→買い物リスト追加の重複チェック ilike (web
  /// stock/actions.ts:129) は**生値のまま**が正 (% _ を含む名前で誤マッチ
  /// する latent quirk ごと移植する方針 — PR-G)。直す場合は web と同時に
  /// 別 issue で。
  Future<List<PurchaseSuggestion>> searchSuggestions({
    required String householdId,
    required String query,
  }) async {
    final trimmed = query.trim();
    if (trimmed.isEmpty) return const [];

    // % _ \ を \ 前置でエスケープ (web の `replace(/[%_\\]/g, "\\$&")`)。
    final escaped = trimmed.replaceAllMapped(
      RegExp(r'[%_\\]'),
      (match) => '\\${match[0]}',
    );

    final PostgrestList rows;
    try {
      rows = await _client
          .from('purchase_history')
          .select('item_name, category, store_type')
          .eq('household_id', householdId)
          .ilike('item_name', '%$escaped%')
          .order('purchased_at', ascending: false)
          .limit(20)
          .timeout(_kQueryTimeout);
    } on Object catch (e, st) {
      // web parity: 検索失敗は空サジェスト (actions.ts:275-277)。
      _logMutationError(
        'searchSuggestions',
        e,
        st,
        'householdId=$householdId',
      );
      return const [];
    }

    // 名前でユニーク化 — 最新の履歴を優先 (purchased_at 降順の先勝ち。
    // web shopping-queries.ts:131-138 の Set filter と同形)。
    final seen = <String>{};
    return [
      for (final row in rows)
        if (seen.add((row['item_name'] as String).toLowerCase()))
          (
            name: row['item_name'] as String,
            category: switch (row['category'] as String?) {
              null => null,
              final value => ItemCategory.fromDbValue(value),
            },
            storeType: switch (row['store_type'] as String?) {
              null => null,
              final value => StoreType.fromDbValue(value),
            },
          ),
    ];
  }

  /// 今週の献立の食材を買い物リストへ一括追加し、追加件数を返す。
  ///
  /// web `generateFromMeals` (actions.ts:177-236) +
  /// `getNewIngredientsForWeek` (shopping-queries.ts:15-77) の移植:
  /// 1. 今週の新規食材を [_newIngredientsForWeek] で取得 (0 件系は
  ///    [NoMealsThisWeekException] / [NoIngredientsThisWeekException])。
  /// 2. 全件が既存重複なら [NoNewIngredientsException]
  ///    (web actions.ts:196-198 — 判定は getNextSortOrder より前)。
  /// 3. 同名 (toLowerCase) は**先勝ち**でユニーク化 — 最初に現れた行の
  ///    name/quantity/meal_id が勝つ (web actions.ts:204-213 の
  ///    `if (!uniqueMap.has(key)) set`)。
  /// 4. insert 行は web actions.ts:215-224 と同一 shape:
  ///    `store_type` は **'supermarket' 固定**、`meal_id` で献立にリンク、
  ///    `sort_order` は [_nextSortOrder] からの連番。category / quantity は
  ///    取得した生の値をパススルー ([autoAddToStock] / [clearChecked] と同じ
  ///    方針 — enum 往復で未知値を fallback 変換しない)。
  ///    insert 失敗は構造化ログ + rethrow (web「食材の追加に失敗しました」)。
  ///
  /// [now] はテスト用の現在時刻注入 (`formatJstDate([DateTime? now])` と同じ
  /// 流儀)。production は省略して実時刻を使う。
  Future<int> generateFromMeals({
    required String householdId,
    required String userId,
    DateTime? now,
  }) async {
    final newIngredients = await _newIngredientsForWeek(householdId, now);

    if (newIngredients.isEmpty) {
      throw const NoNewIngredientsException();
    }

    var sortOrder = await _nextSortOrder(householdId);

    // 名前で重複をまとめる (同じ食材が複数の献立に含まれる場合) — 先勝ち。
    final uniqueIngredients = <String, PostgrestMap>{};
    for (final ingredient in newIngredients) {
      uniqueIngredients.putIfAbsent(
        (ingredient['name'] as String).toLowerCase(),
        () => ingredient,
      );
    }

    final rows = [
      for (final ingredient in uniqueIngredients.values)
        {
          'household_id': householdId,
          'name': ingredient['name'],
          'quantity': ingredient['quantity'],
          'category': ingredient['category'],
          'store_type': StoreType.supermarket.dbValue,
          'created_by': userId,
          'meal_id': ingredient['meal_id'],
          'sort_order': sortOrder++,
        },
    ];

    try {
      await _client.from('shopping_items').insert(rows).timeout(_kQueryTimeout);
    } on Object catch (e, st) {
      _logMutationError(
        'generateFromMeals/insert',
        e,
        st,
        'householdId=$householdId rowCount=${rows.length}',
      );
      rethrow;
    }

    return rows.length;
  }

  /// 確認ダイアログ用: 今週追加できる新規食材のユニーク名 (toLowerCase) 数。
  ///
  /// web `previewMealIngredients` (actions.ts:239-257) の移植。**全エラーを
  /// count 0 に縮退する** (web は getAuthContext 失敗・取得失敗・0 件系の
  /// いずれも `{ count: 0 }`) — rethrow しない例外則はクラス doc 参照。
  /// 読み取り専用で、sort_order lookup / insert には一切進まない。
  ///
  /// [now] はテスト用の現在時刻注入 ([generateFromMeals] と同じ流儀)。
  Future<int> previewMealIngredients(
    String householdId, {
    DateTime? now,
  }) async {
    try {
      final newIngredients = await _newIngredientsForWeek(householdId, now);
      final uniqueNames = <String>{
        for (final ingredient in newIngredients)
          (ingredient['name'] as String).toLowerCase(),
      };
      return uniqueNames.length;
    } on Object catch (e, st) {
      // web parity: preview は全エラー → count 0 (actions.ts:246-248)。
      // 0 件系の型付き例外も「プレビュー 0 件」として正常縮退する。
      _logMutationError(
        'previewMealIngredients',
        e,
        st,
        'householdId=$householdId',
      );
      return 0;
    }
  }

  /// 今週の献立の食材から、既存買い物リストと重複しないものを返す。
  ///
  /// web `getNewIngredientsForWeek` (shopping-queries.ts:15-77) の移植。
  ///
  /// **週範囲は JST 固定**: `weekStartMonday(formatJstDate(now))` 〜
  /// `shiftYmd(+6)`。web も PR #32 (issue #23) で `currentWeekRangeJst`
  /// (date-jst.ts:100-114 = `weekStartMonday(todayJstString(now))` 〜
  /// `shiftYmd(monday, 6)`) に修正済みで、本実装と同一意味論
  /// (JST 今日基準・月曜開始・日曜は同週の末尾) — 新規 TZ 計算は発明しない。
  ///
  /// フロー (web と同一順序):
  /// 1. `meals` から今週の献立 id を取得 — household / `is_eating_out=false` /
  ///    date gte/lte (shopping-queries.ts:22-28)。失敗は rethrow
  ///    (web「献立の取得に失敗しました」)。0 件は [NoMealsThisWeekException]。
  /// 2. `meal_ingredients` を `inFilter('meal_id', mealIds)` で取得
  ///    (同 :40-43)。失敗は rethrow (web「食材の取得に失敗しました」)。
  ///    0 件は [NoIngredientsThisWeekException]。
  /// 3. `shopping_items` の name 全件 (**is_checked 不問** — チェック済みも
  ///    除外対象。同 :54-57) と **toLowerCase 完全一致**で重複除外 (同 :65-72)。
  ///    **取得失敗は構造化ログのみで空 Set 続行** (同 :59-63 の
  ///    `logSupabaseError` — web parity の rethrow しない例外則)。
  ///
  /// **名前照合は toLowerCase 完全一致 — [autoAddToStock] の trim のみ
  /// case-sensitive `eq` (auto-stock.ts:47) とは意図的に別規格**。機能ごとに
  /// 照合規格が異なるのは web の現挙動で、「統一」すると重複判定が web から
  /// 乖離する (Phase 2.5 計画 risks 欄。直す場合は web と同時に別 issue)。
  Future<List<PostgrestMap>> _newIngredientsForWeek(
    String householdId,
    DateTime? now,
  ) async {
    final startDate = weekStartMonday(formatJstDate(now));
    final endDate = shiftYmd(startDate, 6);

    // ── 1. 今週の献立 (外食を除く) ──
    final PostgrestList meals;
    try {
      meals = await _client
          .from('meals')
          .select('id')
          .eq('household_id', householdId)
          .eq('is_eating_out', false)
          .gte('date', startDate)
          .lte('date', endDate)
          .timeout(_kQueryTimeout);
    } on Object catch (e, st) {
      _logMutationError(
        'newIngredientsForWeek/meals',
        e,
        st,
        'householdId=$householdId week=$startDate..$endDate',
      );
      rethrow;
    }

    if (meals.isEmpty) {
      throw const NoMealsThisWeekException();
    }

    final mealIds = [for (final meal in meals) meal['id'] as String];

    // ── 2. 献立の食材 ──
    final PostgrestList ingredients;
    try {
      ingredients = await _client
          .from('meal_ingredients')
          .select('name, quantity, category, meal_id')
          .inFilter('meal_id', mealIds)
          .timeout(_kQueryTimeout);
    } on Object catch (e, st) {
      _logMutationError(
        'newIngredientsForWeek/ingredients',
        e,
        st,
        'householdId=$householdId mealCount=${mealIds.length}',
      );
      rethrow;
    }

    if (ingredients.isEmpty) {
      throw const NoIngredientsThisWeekException();
    }

    // ── 3. 既存リストとの重複除外 (toLowerCase 完全一致・is_checked 不問) ──
    PostgrestList existingItems;
    try {
      existingItems = await _client
          .from('shopping_items')
          .select('name')
          .eq('household_id', householdId)
          .timeout(_kQueryTimeout);
    } on Object catch (e, st) {
      // web parity: 既存リスト取得失敗は log のみで空 Set 続行
      // (shopping-queries.ts:59-63 — 重複除外なしで全食材を新規扱い)。
      _logMutationError(
        'newIngredientsForWeek/existing',
        e,
        st,
        'householdId=$householdId',
      );
      existingItems = const [];
    }

    final existingNames = <String>{
      for (final item in existingItems) (item['name'] as String).toLowerCase(),
    };

    return [
      for (final ingredient in ingredients)
        if (!existingNames.contains(
          (ingredient['name'] as String).toLowerCase(),
        ))
          ingredient,
    ];
  }

  /// `PostgrestException` を握り潰さず構造化ログする (CLAUDE.md)。
  /// [context] は調査用の識別子 (householdId 等 — 機密ではない)。
  void _logPostgrestError(String op, PostgrestException e, String context) {
    debugPrint(
      'ShoppingRepository.$op PostgrestException: '
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
    debugPrint('ShoppingRepository.$op error: $error\n$stackTrace $context');
  }
}

/// write 系 UI が使う最小コンテキスト (`mealsMutationContextProvider` と同形)。
///
/// Next.js 版 `getAuthContext()` と同じ役割。世帯未参加・未認証は握り潰さず
/// `StateError` に倒し、呼び出し側が user-facing error に変換する。
final shoppingMutationContextProvider = FutureProvider<ShoppingMutationContext>(
  (ref) async {
    final client = ref.watch(supabaseClientProvider);
    final householdId = await ref.watch(currentHouseholdIdProvider.future);
    if (householdId == null) {
      throw StateError('shoppingMutationContextProvider: 世帯未参加状態で記録を要求した');
    }

    final user = client.auth.currentUser;
    if (user == null) {
      throw StateError('shoppingMutationContextProvider: 未認証状態で記録を要求した');
    }

    return (householdId: householdId, userId: user.id);
  },
);

/// `ShoppingRepository` の DI provider。
final shoppingRepositoryProvider = Provider<ShoppingRepository>((ref) {
  return ShoppingRepository(ref.watch(supabaseClientProvider));
});

/// web の `quantity || null` 相当: 空文字を null に正規化する
/// (`MealsRepository._nullableQuantity` と同じ流儀)。
String? _nullableQuantity(String? quantity) {
  if (quantity == null || quantity.isEmpty) return null;
  return quantity;
}
