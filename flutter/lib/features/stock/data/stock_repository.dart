import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import '../../../core/domain/item_category.dart';
import '../../../core/supabase/supabase_providers.dart';
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
/// レシピ提案 / 消費レート / 低在庫自動追加 / 入力サジェスト
/// (`getRecipeSuggestions` / `getConsumptionRates` / `checkAndAutoAddLowStock`
/// / `getStockSuggestions` / `addToShoppingList`) は Phase 2.5 送り —
/// 本リポジトリには含めない。
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
