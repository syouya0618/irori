import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import '../../../core/domain/item_category.dart';
import '../../../core/domain/store_type.dart';
import '../../../core/supabase/supabase_providers.dart';
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

/// shopping mutation に必要な認証コンテキスト。
typedef ShoppingMutationContext = ({String householdId, String userId});

/// `shopping_items` / `purchase_history` へのアクセスを担うリポジトリ。
/// Next.js 版 `shopping/page.tsx` (read) + `actions.ts` (write) の
/// セマンティクスを移植する。
///
/// **Phase 2.5 送り (本リポジトリに含めない web 機能)**:
/// - `toggleItem` の在庫自動登録 (`autoAddToStock`) — stock 機能ごと Phase 2.5
/// - `generateFromMeals` / `previewMealIngredients` (献立からの食材生成)
/// - `getSuggestions` (購入履歴サジェスト)
///
/// エラー方針 (CLAUDE.md / `BabyRepository` / `MealsRepository` と同形):
/// - `PostgrestException` は plain object のため、code/message/details/hint を
///   構造化して `debugPrint` し、握り潰さず rethrow する。
/// - 例外: `_nextSortOrder` の lookup 失敗 (web parity の fallback) と
///   `clearChecked` の履歴 insert 失敗 (web parity の続行) のみ、構造化ログの
///   うえ rethrow しない — 各メソッドの doc コメント参照。
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
  ///   `generateFromMeals` のみで、それは Phase 2.5 — クラス doc 参照)。
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

  /// チェック状態を切り替える。
  ///
  /// web `toggleItem` の更新列と同じ `is_checked` / `checked_by` /
  /// `checked_at` のみを更新する。チェック ON で checked_by = [userId] /
  /// checked_at = 現在時刻、OFF で両方 null (web と同一)。
  ///
  /// household スコープ + `.select('id').single()` の行数検証で「対象 0 行
  /// (他世帯 or 既削除)」を silent success にしない (CLAUDE.md「`.update()` は
  /// 0 行更新でも error: null」/ web の「世帯に属するアイテムか確認してから
  /// 更新」に相当)。
  ///
  /// **在庫自動登録 (`autoAddToStock`) は含めない** — stock 機能ごと
  /// Phase 2.5 のプラットフォーム差 (クラス doc 参照)。web が
  /// `.select("name, category")` で返却列を取るのは autoAddToStock 用のため、
  /// Flutter 版は行数検証に必要な `id` のみ取る。
  Future<void> toggleItem({
    required String householdId,
    required String itemId,
    required bool isChecked,
    required String userId,
  }) async {
    try {
      await _client
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
          .select('id')
          .single()
          .timeout(_kQueryTimeout);
    } on Object catch (e, st) {
      _logMutationError('toggleItem', e, st, 'householdId=$householdId');
      rethrow;
    }
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
