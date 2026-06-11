import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import '../../../core/supabase/supabase_providers.dart';
import '../../../core/utils/jst_date.dart';
import '../domain/meal.dart';
import '../domain/meal_template.dart';

/// 全 Supabase 呼び出しに付与するタイムアウト。
/// CLAUDE.md「外部API呼び出しにはタイムアウト設定必須」。
const _kQueryTimeout = Duration(seconds: 10);

/// 週の献立を取る SELECT 文字列。
///
/// Next.js 版 `meals/page.tsx` の select と**一字一句同一** (原典の
/// テンプレートリテラルは改行 + `meal_reactions ( ... )` の空白を含むが、
/// PostgREST が無視する装飾空白を正規化したもの)。列を変える時は必ず
/// web 側と同時に変え、`Meal` モデルとの 1:1 対応を保つこと。
const _kWeekMealColumns =
    'id, date, meal_type, title, is_eating_out, template_id, '
    'meal_reactions(user_id, reaction), '
    'meal_ingredients(name, quantity, category)';

/// `meals` の UNIQUE (household_id, date, meal_type) 違反 (Postgres 23505)。
///
/// web `actions.ts` の `createMeal` / `updateMeal` は `error.code === "23505"`
/// を専用文言に変換する。Flutter 版は型付き例外に変換し、UI (F2) が
/// [message] をそのまま表示できるようにする。
class DuplicateMealException implements Exception {
  const DuplicateMealException();

  /// web `actions.ts` と同一文言。
  static const String message = 'この日時のメニューは既に登録されています。';

  @override
  String toString() => message;
}

/// meals mutation に必要な認証コンテキスト。
typedef MealsMutationContext = ({String householdId, String userId});

/// `meals` / `meal_ingredients` / `meal_reactions` へのアクセスを担う
/// リポジトリ。Next.js 版 `meals/page.tsx` (read) + `actions.ts` (write) の
/// セマンティクスを 1:1 で移植する。
///
/// エラー方針 (CLAUDE.md / `BabyRepository` と同形):
/// - `PostgrestException` は plain object のため、code/message/details/hint を
///   構造化して `debugPrint` し、握り潰さず rethrow する。
/// - 23505 (献立スロット重複) のみ [DuplicateMealException] に変換する。
class MealsRepository {
  MealsRepository(this._client);

  final SupabaseClient _client;

  /// 週 (月曜 [weekStartYmd] 〜 +6 日の日曜) の献立を `date` 昇順で取得。
  ///
  /// web `meals/page.tsx` の `gte(startStr) / lte(endStr) / order("date")`
  /// と同一。週境界の演算は F0 の `shiftYmd` (TZ 非依存の YMD 文字列演算)。
  Future<List<Meal>> fetchWeekMeals(
    String householdId,
    String weekStartYmd,
  ) async {
    final weekEnd = shiftYmd(weekStartYmd, 6);
    try {
      final rows = await _client
          .from('meals')
          .select(_kWeekMealColumns)
          .eq('household_id', householdId)
          .gte('date', weekStartYmd)
          .lte('date', weekEnd)
          // web の `.order("date")` は supabase-js 既定で **ascending**。
          // supabase-dart の `order()` は既定 descending のため明示する。
          .order('date', ascending: true)
          .timeout(_kQueryTimeout);
      return rows.map(Meal.fromJson).toList();
    } on PostgrestException catch (e) {
      _logPostgrestError('fetchWeekMeals', e, 'householdId=$householdId');
      rethrow;
    }
  }

  /// 献立を作成し、作成した meals 行の id を返す。
  ///
  /// web `createMeal` の順序を踏襲: meals insert (`.select("id").single()` で
  /// id 取得) → ingredients が空でなければ一括 insert。
  /// 23505 (同一 household × date × meal_type の重複) は
  /// [DuplicateMealException] に変換する。
  ///
  /// 注意 (web と同じ挙動): ingredients insert が失敗しても meals 行は
  /// 残る (トランザクションでは括らない)。呼び出し側はエラー後に refetch で
  /// 整合を取る。
  Future<String> createMeal({
    required String householdId,
    required String userId,
    required String date,
    required MealType mealType,
    required String title,
    required bool isEatingOut,
    List<MealIngredient> ingredients = const [],
  }) async {
    final PostgrestMap meal;
    try {
      meal = await _client
          .from('meals')
          .insert({
            'household_id': householdId,
            'date': date,
            'meal_type': _mealTypeValue(mealType),
            'title': title,
            'is_eating_out': isEatingOut,
            'created_by': userId,
          })
          .select('id')
          .single()
          .timeout(_kQueryTimeout);
    } on Object catch (e, st) {
      _logMutationError('createMeal', e, st, 'householdId=$householdId');
      _throwIfDuplicate(e);
      rethrow;
    }
    final mealId = meal['id'] as String;

    if (ingredients.isNotEmpty) {
      try {
        await _client
            .from('meal_ingredients')
            .insert(_ingredientRows(mealId, ingredients))
            .timeout(_kQueryTimeout);
      } on Object catch (e, st) {
        _logMutationError('createMeal/ingredients', e, st, 'mealId=$mealId');
        rethrow;
      }
    }
    return mealId;
  }

  /// 献立を更新する。
  ///
  /// web `updateMeal` は「ownership 事前 select → 素の update → ingredients
  /// delete → reinsert」だが、Flutter 版は household スコープ付き update +
  /// `.select('id').single()` の行数検証 1 回に畳む
  /// (`BabyRepository._updateLog` と同形 / CLAUDE.md「`.update()` は 0 行更新
  /// でも error: null」)。対象 0 行 (他世帯 or 既削除) は PGRST116 で throw
  /// され、web の「この献立を編集する権限がありません。」分岐に相当する。
  /// 23505 は [DuplicateMealException] に変換 (web と同一分岐)。
  ///
  /// ingredients は web の順序どおり「全削除 → 再 insert」。
  Future<void> updateMeal({
    required String householdId,
    required String mealId,
    required String date,
    required MealType mealType,
    required String title,
    required bool isEatingOut,
    List<MealIngredient> ingredients = const [],
  }) async {
    try {
      await _client
          .from('meals')
          .update({
            'date': date,
            'meal_type': _mealTypeValue(mealType),
            'title': title,
            'is_eating_out': isEatingOut,
          })
          .eq('id', mealId)
          .eq('household_id', householdId)
          .select('id')
          .single()
          .timeout(_kQueryTimeout);
    } on Object catch (e, st) {
      _logMutationError('updateMeal', e, st, 'householdId=$householdId');
      _throwIfDuplicate(e);
      rethrow;
    }

    // web の順序: 既存 ingredients を全削除してから再 insert。
    // (削除失敗は throw で伝播する — 握り潰さない。web の `await` 放置と違い
    //  Dart は error が例外になるため自然に検出される。)
    try {
      await _client
          .from('meal_ingredients')
          .delete()
          .eq('meal_id', mealId)
          .timeout(_kQueryTimeout);
    } on Object catch (e, st) {
      _logMutationError(
        'updateMeal/deleteIngredients',
        e,
        st,
        'mealId=$mealId',
      );
      rethrow;
    }

    if (ingredients.isNotEmpty) {
      try {
        await _client
            .from('meal_ingredients')
            .insert(_ingredientRows(mealId, ingredients))
            .timeout(_kQueryTimeout);
      } on Object catch (e, st) {
        _logMutationError(
          'updateMeal/insertIngredients',
          e,
          st,
          'mealId=$mealId',
        );
        rethrow;
      }
    }
  }

  /// 献立を削除する。
  ///
  /// web `deleteMeal` の削除順を踏襲: meal_ingredients → meal_reactions →
  /// meals (原典コメント "in case cascade isn't set" の明示削除)。
  /// `eating_out_logs` は web 同様**明示削除しない** — 初期スキーマで
  /// `meal_id ... REFERENCES meals(id) ON DELETE CASCADE` を確認済みで、
  /// meals 行の削除に連動して DB 側で消える。
  ///
  /// 子テーブルには household_id 列が無いため `meal_id` のみで絞る
  /// (他世帯の行は RLS で不可視ゆえ誤削除は構造的に起きない)。最後の meals
  /// 削除は household スコープ + `.select('id').single()` で「対象 0 行
  /// (他世帯 / 既削除)」を silent success にしない — web の ownership check
  /// (「この献立を削除する権限がありません。」) に相当する検出。
  Future<void> deleteMeal({
    required String householdId,
    required String mealId,
  }) async {
    try {
      await _client
          .from('meal_ingredients')
          .delete()
          .eq('meal_id', mealId)
          .timeout(_kQueryTimeout);
      await _client
          .from('meal_reactions')
          .delete()
          .eq('meal_id', mealId)
          .timeout(_kQueryTimeout);
      await _client
          .from('meals')
          .delete()
          .eq('id', mealId)
          .eq('household_id', householdId)
          .select('id')
          .single()
          .timeout(_kQueryTimeout);
    } on Object catch (e, st) {
      _logMutationError(
        'deleteMeal',
        e,
        st,
        'householdId=$householdId mealId=$mealId',
      );
      rethrow;
    }
  }

  /// リアクションをトグル/上書き登録する。
  ///
  /// web `upsertReaction` のセマンティクス:
  /// 1. 既存リアクションを `maybeSingle` で取得 (未リアクションは正常系ゆえ
  ///    0 行 → null。エラーは Dart では `PostgrestException` として throw
  ///    される — 握り潰さず構造化ログ + rethrow し、silent fail を作らない
  ///    (CLAUDE.md「maybeSingle の error を必ず受け取る」))。
  /// 2. 同一 reaction なら削除 (トグルオフ) → `true` を返す。
  /// 3. 異なる reaction なら update → `false` を返す。
  /// 4. 既存なしなら insert → `false` を返す。
  ///
  /// 戻り値は web の `removed` フラグに相当する (true = 取り消した)。
  Future<bool> upsertReaction({
    required String mealId,
    required String userId,
    required MealReaction reaction,
  }) async {
    final reactionValue = _reactionValue(reaction);

    final PostgrestMap? existing;
    try {
      existing = await _client
          .from('meal_reactions')
          .select('id, reaction')
          .eq('meal_id', mealId)
          .eq('user_id', userId)
          .maybeSingle()
          .timeout(_kQueryTimeout);
    } on Object catch (e, st) {
      _logMutationError('upsertReaction/lookup', e, st, 'mealId=$mealId');
      rethrow;
    }

    if (existing != null) {
      final existingId = existing['id'] as String;
      if (existing['reaction'] == reactionValue) {
        // 同一リアクションの再タップ = トグルオフ (web: delete)。
        try {
          await _client
              .from('meal_reactions')
              .delete()
              .eq('id', existingId)
              .timeout(_kQueryTimeout);
        } on Object catch (e, st) {
          _logMutationError('upsertReaction/delete', e, st, 'mealId=$mealId');
          rethrow;
        }
        return true;
      }

      // 異なるリアクション = 上書き (web: update)。web は素の update だが、
      // lookup 後にパートナー操作等で行が消えるレースの 0 行更新を
      // silent success にしないため行数検証を足す (CLAUDE.md)。
      try {
        await _client
            .from('meal_reactions')
            .update({'reaction': reactionValue})
            .eq('id', existingId)
            .select('id')
            .single()
            .timeout(_kQueryTimeout);
      } on Object catch (e, st) {
        _logMutationError('upsertReaction/update', e, st, 'mealId=$mealId');
        rethrow;
      }
      return false;
    }

    // 既存なし = 新規 insert (web: insert)。
    try {
      await _client
          .from('meal_reactions')
          .insert({
            'meal_id': mealId,
            'user_id': userId,
            'reaction': reactionValue,
          })
          .timeout(_kQueryTimeout);
    } on Object catch (e, st) {
      _logMutationError('upsertReaction/insert', e, st, 'mealId=$mealId');
      rethrow;
    }
    return false;
  }

  // ─── テンプレート (P2.5-E) ──────────────────────────────────
  // web `meals/actions.ts:248-392` (saveAsTemplate / loadTemplate /
  // deleteTemplate / getTemplates) の移植。`meal_templates` は Realtime
  // publication 非対象 (migrations 検証済) のため notifier は持たず、
  // 選択ダイアログが open ごとに refetch する ([mealTemplatesProvider])。

  /// 既存の献立をテンプレートとして保存し、作成した template の id を返す。
  ///
  /// web `saveAsTemplate` と同じ流れ:
  /// 1. meals から title を取得。web は select 後に app 層で
  ///    `household_id !== householdId` を照合するが、Flutter は
  ///    `.eq('household_id')` を query に畳む (RLS と二重の防御)。対象 0 行
  ///    (他世帯 / 既削除) は PGRST116 で throw — web の
  ///    「この献立をテンプレートとして保存する権限がありません。」分岐に相当。
  /// 2. meal_ingredients を web と同一列 (`name, quantity, category`) で取得。
  ///    **意図的差異**: web は取得エラーを log して空配列で保存を続行する
  ///    (actions.ts:273-277 + `ingredients || []`) が、Dart は rethrow する —
  ///    食材が静かに欠落したテンプレートを作らない (エラー握り潰し禁止)。
  /// 3. meal_templates へ insert (`.select('id').single()` で id 取得)。
  ///    ingredients は取得行をそのまま JSONB として渡す (web と同形)。
  /// 4. meals.template_id へのリンク update。**web parity**: web は
  ///    `.error` を検証しない (actions.ts:295-298) ため、Dart も失敗を
  ///    構造化ログのみで握り、テンプレート保存自体は成功扱いにする
  ///    (テンプレート行は既に作成済み — リンクは付加情報)。観測性のため
  ///    web に無い行数検証 (`.select('id').single()`) を足すが、その失敗も
  ///    log のみ (挙動中立)。
  Future<String> saveAsTemplate({
    required String householdId,
    required String userId,
    required String mealId,
  }) async {
    final PostgrestMap meal;
    try {
      meal = await _client
          .from('meals')
          .select('title')
          .eq('id', mealId)
          .eq('household_id', householdId)
          .single()
          .timeout(_kQueryTimeout);
    } on Object catch (e, st) {
      _logMutationError('saveAsTemplate/lookup', e, st, 'mealId=$mealId');
      rethrow;
    }

    final PostgrestList ingredientRows;
    try {
      ingredientRows = await _client
          .from('meal_ingredients')
          .select('name, quantity, category')
          .eq('meal_id', mealId)
          .timeout(_kQueryTimeout);
    } on Object catch (e, st) {
      _logMutationError('saveAsTemplate/ingredients', e, st, 'mealId=$mealId');
      rethrow;
    }

    final PostgrestMap template;
    try {
      template = await _client
          .from('meal_templates')
          .insert({
            'household_id': householdId,
            'title': meal['title'] as String,
            'ingredients': ingredientRows,
            'created_by': userId,
          })
          .select('id')
          .single()
          .timeout(_kQueryTimeout);
    } on Object catch (e, st) {
      _logMutationError('saveAsTemplate/insert', e, st, 'mealId=$mealId');
      rethrow;
    }
    final templateId = template['id'] as String;

    try {
      await _client
          .from('meals')
          .update({'template_id': templateId})
          .eq('id', mealId)
          .eq('household_id', householdId)
          .select('id')
          .single()
          .timeout(_kQueryTimeout);
    } on Object catch (e, st) {
      // 握り潰しではなく web parity の意図的継続 (メソッド doc 4. 参照)。
      _logMutationError(
        'saveAsTemplate/link',
        e,
        st,
        'mealId=$mealId templateId=$templateId',
      );
    }
    return templateId;
  }

  /// テンプレート一覧を `created_at` 降順で取得する (web `getTemplates`)。
  ///
  /// **意図的差異 (裁定済)**: web はエラー時に log + 空配列を返し
  /// 「エラー」と「0 件」を UI が区別できないが、Flutter は既存 fetch 系規約
  /// ([fetchWeekMeals] と同形) どおり rethrow し、選択ダイアログが
  /// error 表示 + 再試行を出す。
  ///
  /// `ingredients` JSONB の破損行は [mealTemplateIngredientsFromJson] が
  /// 空リスト / 要素 skip に倒すため、1 行の破損で一覧全体は落ちない。
  Future<List<MealTemplate>> getTemplates(String householdId) async {
    try {
      final rows = await _client
          .from('meal_templates')
          .select('id, title, ingredients, created_at')
          .eq('household_id', householdId)
          // web の .order("created_at", { ascending: false })。supabase-dart の
          // 既定も descending だが、web との対応を明示する。
          .order('created_at', ascending: false)
          .timeout(_kQueryTimeout);
      return rows.map(MealTemplate.fromJson).toList();
    } on PostgrestException catch (e) {
      _logPostgrestError('getTemplates', e, 'householdId=$householdId');
      rethrow;
    }
  }

  /// テンプレート 1 件をフォーム prefill 用に取得する (web `loadTemplate`)。
  ///
  /// web は select に `household_id` を足して app 層で照合するが、Flutter は
  /// `.eq('household_id')` を query に畳む (RLS と二重の防御)。対象 0 行
  /// (他世帯 / 既削除) は PGRST116 で throw — web の
  /// 「テンプレートが見つかりません。」分岐に相当。
  ///
  /// `ingredients` は web の無検証 cast (actions.ts:329) と違い
  /// [mealTemplateIngredientsFromJson] で防御的にパースする (非配列 → 空)。
  Future<MealTemplatePrefill> loadTemplate({
    required String householdId,
    required String templateId,
  }) async {
    final PostgrestMap row;
    try {
      row = await _client
          .from('meal_templates')
          .select('title, ingredients')
          .eq('id', templateId)
          .eq('household_id', householdId)
          .single()
          .timeout(_kQueryTimeout);
    } on Object catch (e, st) {
      _logMutationError('loadTemplate', e, st, 'templateId=$templateId');
      rethrow;
    }
    return (
      title: row['title'] as String,
      ingredients: mealTemplateIngredientsFromJson(row['ingredients']),
    );
  }

  /// テンプレートを削除する (web `deleteTemplate`)。
  ///
  /// web と同じ順序: meals の unlink update (`template_id = null`) →
  /// meal_templates delete。
  ///
  /// - unlink は web と同じく `template_id` のみで絞る (meals に household
  ///   スコープは付けない — 他世帯の行は RLS で不可視)。**web parity**: web は
  ///   unlink の `.error` を検証しない (actions.ts:356-359) ため、Dart も
  ///   失敗を構造化ログのみで握って delete に進む。`meals.template_id` は
  ///   FK `ON DELETE SET NULL` のため、unlink が失敗しても delete 成功時に
  ///   DB 側で null 化され孤児リンクは残らない (initial_schema.sql:129)。
  /// - delete は household スコープ + `.select('id').single()` の行数検証
  ///   ([deleteMeal] と同形)。対象 0 行は PGRST116 で throw — web の
  ///   「このテンプレートを削除する権限がありません。」分岐 (ownership
  ///   事前 select) を query 化したもの。
  Future<void> deleteTemplate({
    required String householdId,
    required String templateId,
  }) async {
    try {
      await _client
          .from('meals')
          .update({'template_id': null})
          .eq('template_id', templateId)
          .timeout(_kQueryTimeout);
    } on Object catch (e, st) {
      // 握り潰しではなく web parity の意図的継続 (メソッド doc 参照)。
      _logMutationError(
        'deleteTemplate/unlink',
        e,
        st,
        'templateId=$templateId',
      );
    }

    try {
      await _client
          .from('meal_templates')
          .delete()
          .eq('id', templateId)
          .eq('household_id', householdId)
          .select('id')
          .single()
          .timeout(_kQueryTimeout);
    } on Object catch (e, st) {
      _logMutationError('deleteTemplate', e, st, 'templateId=$templateId');
      rethrow;
    }
  }

  /// `meal_ingredients` への一括 insert 行を組み立てる。
  /// web と同じく `quantity` の空文字は null に正規化する
  /// (`quantity: ing.quantity || null`)。
  List<Map<String, dynamic>> _ingredientRows(
    String mealId,
    List<MealIngredient> ingredients,
  ) {
    return [
      for (final ing in ingredients)
        {
          'meal_id': mealId,
          'name': ing.name,
          'quantity': _nullableQuantity(ing.quantity),
          'category': ing.category.dbValue,
        },
    ];
  }

  /// 23505 (unique_violation) を [DuplicateMealException] に変換する。
  /// それ以外は何もしない (呼び出し側が rethrow する)。
  void _throwIfDuplicate(Object error) {
    if (error is PostgrestException && error.code == '23505') {
      throw const DuplicateMealException();
    }
  }

  /// `PostgrestException` を握り潰さず構造化ログする (CLAUDE.md)。
  /// [context] は調査用の識別子 (householdId / mealId — 機密ではない)。
  void _logPostgrestError(String op, PostgrestException e, String context) {
    debugPrint(
      'MealsRepository.$op PostgrestException: '
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
    debugPrint('MealsRepository.$op error: $error\n$stackTrace $context');
  }
}

/// write 系 UI が使う最小コンテキスト (`babyMutationContextProvider` と同形)。
///
/// Next.js 版 `getAuthContext()` と同じ役割。世帯未参加・未認証は握り潰さず
/// `StateError` に倒し、呼び出し側が user-facing error に変換する。
final mealsMutationContextProvider = FutureProvider<MealsMutationContext>((
  ref,
) async {
  final client = ref.watch(supabaseClientProvider);
  final householdId = await ref.watch(currentHouseholdIdProvider.future);
  if (householdId == null) {
    throw StateError('mealsMutationContextProvider: 世帯未参加状態で記録を要求した');
  }

  final user = client.auth.currentUser;
  if (user == null) {
    throw StateError('mealsMutationContextProvider: 未認証状態で記録を要求した');
  }

  return (householdId: householdId, userId: user.id);
});

/// `MealsRepository` の DI provider。
final mealsRepositoryProvider = Provider<MealsRepository>((ref) {
  return MealsRepository(ref.watch(supabaseClientProvider));
});

/// テンプレート一覧 (`created_at` 降順)。
///
/// `meal_templates` は Realtime publication 非対象 (migrations grep 検証済) の
/// ため、realtime 連動の notifier では更新が永遠に届かない (p25plan risks)。
/// 裁定どおり、選択ダイアログ (`showTemplateSelectorDialog`) が **open ごとに
/// `ref.invalidate(mealTemplatesProvider)` で refetch** する。
///
/// householdId は [mealsMutationContextProvider] から取る (一覧はダイアログの
/// load/delete 操作と一体で、認証 + 世帯参加の前提を共有する)。
/// エラーは rethrow 規約 ([MealsRepository.getTemplates] doc) により
/// AsyncError になり、ダイアログが error 表示 + 再試行を出す。
final mealTemplatesProvider = FutureProvider<List<MealTemplate>>((ref) async {
  final context = await ref.watch(mealsMutationContextProvider.future);
  final repo = ref.watch(mealsRepositoryProvider);
  return repo.getTemplates(context.householdId);
});

/// web の `quantity: ing.quantity || null` 相当: 空文字を null に正規化する
/// (`BabyRepository` の `_nullableMemo` と同じ流儀)。
String? _nullableQuantity(String? quantity) {
  if (quantity == null || quantity.isEmpty) return null;
  return quantity;
}

/// `MealType` → Postgres ENUM `meal_type` 文字列 (`BabyRepository` の
/// `_logTypeValue` と同じ手書き switch 流儀 — codegen を通さない insert
/// payload 用)。`@JsonValue` と同一文字列を保証するよう変更時は両方を直す。
String _mealTypeValue(MealType type) {
  switch (type) {
    case MealType.breakfast:
      return 'breakfast';
    case MealType.lunch:
      return 'lunch';
    case MealType.dinner:
      return 'dinner';
    case MealType.snack:
      return 'snack';
  }
}

/// `MealReaction` → Postgres ENUM `meal_reaction` 文字列。
String _reactionValue(MealReaction reaction) {
  switch (reaction) {
    case MealReaction.good:
      return 'good';
    case MealReaction.ok:
      return 'ok';
    case MealReaction.bad:
      return 'bad';
  }
}
