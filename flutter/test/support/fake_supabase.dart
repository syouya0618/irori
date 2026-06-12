import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

/// Auth UI (Issue #48) の widget test 用 fake Supabase 一式。
///
/// 設計方針:
/// - 本物の `Supabase.initialize()` を呼ばずに `supabaseClientProvider` を
///   `overrideWithValue(FakeSupabaseClient(...))` で差し替える (constraint #9)。
/// - `supabase_flutter` の builder 群 (`SupabaseQueryBuilder` /
///   `PostgrestFilterBuilder` / `PostgrestTransformBuilder`) は
///   `implements Future<T>` な具象クラスゆえ全 member 実装は重い。
///   `Fake` (flutter_test 再 export) を継承し `noSuchMethod` 既定 throw に
///   委ねつつ、テストで実際に通る経路のみ override する。
/// - 末尾 builder は `implements Future<T>` を満たすため `then` / `timeout` を
///   canned future に委譲する。`await builder` も `await builder.timeout(...)` も
///   同じ canned response を返す。

/// canned 値 / 例外を返す `Future<T>` 互換 mixin。
mixin _FakeFuture<T> on Fake implements Future<T> {
  T? get cannedValue;
  Object? get cannedError;

  Future<T> get _future {
    if (cannedError != null) return Future<T>.error(cannedError!);
    return Future<T>.value(cannedValue as T);
  }

  @override
  Future<U> then<U>(
    FutureOr<U> Function(T value) onValue, {
    Function? onError,
  }) {
    return _future.then(onValue, onError: onError);
  }

  @override
  Future<T> timeout(Duration timeLimit, {FutureOr<T> Function()? onTimeout}) {
    return _future.timeout(timeLimit, onTimeout: onTimeout);
  }

  @override
  Stream<T> asStream() => _future.asStream();

  @override
  Future<T> catchError(Function onError, {bool Function(Object error)? test}) {
    return _future.catchError(onError, test: test);
  }

  @override
  Future<T> whenComplete(FutureOr<void> Function() action) {
    return _future.whenComplete(action);
  }
}

/// `single()` の結果 (`PostgrestTransformBuilder<PostgrestMap>` 相当)。
class FakeTransformBuilder extends Fake
    with _FakeFuture<PostgrestMap>
    implements PostgrestTransformBuilder<PostgrestMap> {
  FakeTransformBuilder({this.cannedValue, this.cannedError});

  @override
  final PostgrestMap? cannedValue;
  @override
  final Object? cannedError;
}

/// `maybeSingle()` の結果 (`PostgrestTransformBuilder<PostgrestMap?>` 相当)。
/// 0 行は canned null で表現する (meals PR-F1 で追加 — additive)。
class FakeMaybeSingleBuilder extends Fake
    with _FakeFuture<PostgrestMap?>
    implements PostgrestTransformBuilder<PostgrestMap?> {
  FakeMaybeSingleBuilder({this.cannedValue, this.cannedError});

  @override
  final PostgrestMap? cannedValue;
  @override
  final Object? cannedError;
}

/// `from('x').select(...).eq(...)` のチェーン
/// (`PostgrestFilterBuilder<PostgrestList>` 相当)。
/// 末尾で `await` すれば `PostgrestList` を返し、`single()` で
/// [FakeTransformBuilder] に切り替えられる。
// ignore: must_be_immutable
class FakeFilterBuilder extends Fake
    with _FakeFuture<PostgrestList>
    implements PostgrestFilterBuilder<PostgrestList> {
  FakeFilterBuilder({
    this.cannedValue,
    this.cannedError,
    PostgrestMap? singleValue,
    Object? singleError,
    PostgrestMap? maybeSingleValue,
    Object? maybeSingleError,
  }) : _single = FakeTransformBuilder(
         cannedValue: singleValue,
         cannedError: singleError,
       ),
       _maybeSingle = FakeMaybeSingleBuilder(
         cannedValue: maybeSingleValue,
         cannedError: maybeSingleError,
       );

  @override
  final PostgrestList? cannedValue;
  @override
  final Object? cannedError;

  final FakeTransformBuilder _single;
  final FakeMaybeSingleBuilder _maybeSingle;
  final eqFilters = <({String column, Object value})>[];
  final isFilters = <({String column, bool? value})>[];
  final gteFilters = <({String column, Object value})>[];
  final lteFilters = <({String column, Object value})>[];
  final orderCalls = <({String column, bool ascending})>[];
  String? selectedColumns;

  @override
  PostgrestFilterBuilder<PostgrestList> eq(String column, Object value) {
    eqFilters.add((column: column, value: value));
    return this;
  }

  @override
  PostgrestFilterBuilder<PostgrestList> isFilter(String column, bool? value) {
    isFilters.add((column: column, value: value));
    return this;
  }

  @override
  PostgrestFilterBuilder<PostgrestList> gte(String column, Object value) {
    gteFilters.add((column: column, value: value));
    return this;
  }

  @override
  PostgrestFilterBuilder<PostgrestList> lte(String column, Object value) {
    lteFilters.add((column: column, value: value));
    return this;
  }

  @override
  PostgrestTransformBuilder<PostgrestList> order(
    String column, {
    bool ascending = false,
    bool nullsFirst = false,
    String? referencedTable,
  }) {
    orderCalls.add((column: column, ascending: ascending));
    return this;
  }

  @override
  PostgrestTransformBuilder<PostgrestList> select([String columns = '*']) {
    selectedColumns = columns;
    return this;
  }

  @override
  PostgrestTransformBuilder<PostgrestMap> single() => _single;

  @override
  PostgrestTransformBuilder<PostgrestMap?> maybeSingle() => _maybeSingle;

  // ─── F3 shopping 用 (additive) ─────────────────────────────
  // `ShoppingRepository._nextSortOrder` の
  // `.order(...).limit(1).maybeSingle()` チェーン検証用。

  /// `limit(n)` の呼び出し記録 (F3 shopping 用)。
  final limitCalls = <int>[];

  @override
  PostgrestTransformBuilder<PostgrestList> limit(
    int count, {
    String? referencedTable,
  }) {
    limitCalls.add(count);
    return this;
  }

  // ─── P2.5-C shopping 用 (additive) ─────────────────────────
  // `ShoppingRepository.generateFromMeals` の
  // `meal_ingredients.inFilter('meal_id', mealIds)` 検証用。
  // PR-G (`autoAddLowStockItems` の `.inFilter('log_type', ...)`) も共用する。

  /// `inFilter(column, values)` の呼び出し記録 (P2.5-C で追加)。
  final inFilters = <({String column, List<dynamic> values})>[];

  @override
  PostgrestFilterBuilder<PostgrestList> inFilter(
    String column,
    List<dynamic> values,
  ) {
    inFilters.add((column: column, values: values));
    return this;
  }

  // ─── P2.5-F recipe suggestions 用 (additive) ──────────────
  // `MealsRepository.fetchTemplateReactions` の
  // `.not('template_id', 'is', null)` チェーン検証用。

  /// `not(column, operator, value)` の呼び出し記録 (P2.5-F 用)。
  final notFilters = <({String column, String operator, Object? value})>[];

  @override
  PostgrestFilterBuilder<PostgrestList> not(
    String column,
    String operator,
    Object? value,
  ) {
    notFilters.add((column: column, operator: operator, value: value));
    return this;
  }

  // ─── PR-G stock⇆shopping 用 (additive) ─────────────────────
  // `StockRepository.addToShoppingList` の `.ilike('name', 生値)` 検証用。

  /// `ilike(column, pattern)` の呼び出し記録。pattern はエスケープ検証のため
  /// 生のまま保持する (web stock/actions.ts の % _ 非エスケープ quirk)。
  final ilikeFilters = <({String column, String pattern})>[];

  @override
  PostgrestFilterBuilder<PostgrestList> ilike(String column, String pattern) {
    ilikeFilters.add((column: column, pattern: pattern));
    return this;
  }
}

/// `from('table')` の結果 (`SupabaseQueryBuilder` 相当)。
/// `select(...)` で [FakeFilterBuilder] へ切り替える。
// ignore: must_be_immutable
class FakeQueryBuilder extends Fake implements SupabaseQueryBuilder {
  FakeQueryBuilder(this._filter, {FakeFilterBuilder? mutationFilter})
    : _mutationFilter = mutationFilter ?? _filter;

  final FakeFilterBuilder _filter;
  final FakeFilterBuilder _mutationFilter;
  Object? lastInsertValues;
  Map<dynamic, dynamic>? lastUpdateValues;
  int deleteCallCount = 0;

  /// read 系 `select(...)` に渡された列文字列 (meals PR-F1 で追加 — additive)。
  String? lastSelectColumns;

  /// read 系 `select(...)` の**全**呼び出し記録 (P2.5-C で追加 — additive)。
  /// [lastSelectColumns] は最後の 1 件のみのため、同一テーブルへの複数 select
  /// (generateFromMeals の既存照合 `'name'` → sort_order lookup `'sort_order'`)
  /// の順序検証に使う。
  final selectCalls = <String>[];

  @override
  PostgrestFilterBuilder<PostgrestList> select([String columns = '*']) {
    lastSelectColumns = columns;
    selectCalls.add(columns);
    return _filter;
  }

  @override
  PostgrestFilterBuilder<dynamic> insert(
    Object values, {
    bool defaultToNull = true,
  }) {
    lastInsertValues = values;
    return _mutationFilter as PostgrestFilterBuilder<dynamic>;
  }

  @override
  PostgrestFilterBuilder<dynamic> update(Map<dynamic, dynamic> values) {
    lastUpdateValues = values;
    return _mutationFilter as PostgrestFilterBuilder<dynamic>;
  }

  @override
  PostgrestFilterBuilder<dynamic> delete() {
    deleteCallCount++;
    return _mutationFilter as PostgrestFilterBuilder<dynamic>;
  }
}

/// `rpc(fn)` の結果。RETURNS TABLE 系は `PostgrestList`、RETURNS VOID 系は
/// `await` で `null` を返す (型は `dynamic` 扱い)。
class FakeRpcBuilder extends Fake
    with _FakeFuture<dynamic>
    implements PostgrestFilterBuilder<dynamic> {
  FakeRpcBuilder({this.cannedValue, this.cannedError});

  @override
  final dynamic cannedValue;
  @override
  final Object? cannedError;
}

/// `auth` 経由の呼び出し (`signInWithOtp` / `exchangeCodeForSession`) を
/// 記録 + canned 動作させる fake。
class FakeGoTrueClient extends Fake implements GoTrueClient {
  FakeGoTrueClient({
    this.signInError,
    this.exchangeError,
    this.exchangeResponse,
    this.cannedCurrentUser,
  });

  /// `signInWithOtp` が投げる例外 (null なら成功)。
  final Object? signInError;

  /// `exchangeCodeForSession` が投げる例外 (null なら成功)。
  final Object? exchangeError;

  /// `exchangeCodeForSession` の戻り値 (success 時)。
  final AuthSessionUrlResponse? exchangeResponse;

  /// `currentUser` の canned 値 (P2.5-H settings 用 — additive)。
  /// null は「未認証」。従来この getter は未実装 (noSuchMethod throw) で、
  /// 既存テストは一切読まないことを grep 確認済み (挙動変更なし)。
  ///
  /// mutable (PR #40 レビュー対応 F3 — additive): fetch 中のサインアウト
  /// (`cannedCurrentUser = null` へ差し替え) を再現するため final にしない。
  User? cannedCurrentUser;

  /// `signOut` が投げる例外 (null なら成功 — P2.5-H settings 用 additive)。
  Object? signOutError;

  /// 非 null なら `signOut` がこの Completer の完了まで停止する
  /// (PR #40 レビュー対応 F2: timeout 検証用 — additive)。
  Completer<void>? signOutGate;

  // --- 呼び出し記録 (assert 用) ---
  int signInCallCount = 0;
  String? lastEmail;
  String? lastEmailRedirectTo;

  int exchangeCallCount = 0;
  String? lastAuthCode;

  /// `signOut` の呼び出し回数 (P2.5-H settings 用 — additive)。
  int signOutCallCount = 0;

  @override
  Future<void> signInWithOtp({
    String? email,
    String? phone,
    String? emailRedirectTo,
    bool? shouldCreateUser,
    Map<String, dynamic>? data,
    String? captchaToken,
    OtpChannel channel = OtpChannel.sms,
    String? token,
  }) async {
    signInCallCount++;
    lastEmail = email;
    lastEmailRedirectTo = emailRedirectTo;
    if (signInError != null) throw signInError!;
  }

  @override
  Future<AuthSessionUrlResponse> exchangeCodeForSession(String authCode) async {
    exchangeCallCount++;
    lastAuthCode = authCode;
    if (exchangeError != null) throw exchangeError!;
    return exchangeResponse ?? _emptyAuthSessionUrlResponse();
  }

  @override
  User? get currentUser => cannedCurrentUser;

  @override
  Future<void> signOut({SignOutScope scope = SignOutScope.local}) async {
    signOutCallCount++;
    if (signOutGate != null) await signOutGate!.future;
    if (signOutError != null) throw signOutError!;
  }
}

/// `supabaseClientProvider` に注入する root fake。
///
/// - `auth` → [FakeGoTrueClient]
/// - `from(table)` → `fromBuilders[table]`
/// - `rpc(fn)` → `rpcBuilders[fn]`
///
/// 呼び出し記録 ([lastRpcFn] / [lastRpcParams]) で RPC 引数名検証も行う。
class FakeSupabaseClient extends Fake implements SupabaseClient {
  FakeSupabaseClient({
    FakeGoTrueClient? auth,
    Map<String, FakeQueryBuilder>? fromBuilders,
    Map<String, FakeRpcBuilder>? rpcBuilders,
  }) : _auth = auth ?? FakeGoTrueClient(),
       _fromBuilders = fromBuilders ?? const {},
       _rpcBuilders = rpcBuilders ?? const {};

  final FakeGoTrueClient _auth;
  final Map<String, FakeQueryBuilder> _fromBuilders;
  final Map<String, FakeRpcBuilder> _rpcBuilders;

  String? lastRpcFn;
  Map<String, dynamic>? lastRpcParams;
  String? lastFromTable;

  /// `from(table)` 呼び出し順の記録 (meals PR-F1 で追加 — additive)。
  /// deleteMeal の「子テーブル → 親テーブル」削除順などの検証に使う。
  final fromTables = <String>[];

  @override
  GoTrueClient get auth => _auth;

  @override
  SupabaseQueryBuilder from(String table) {
    lastFromTable = table;
    fromTables.add(table);
    final builder = _fromBuilders[table];
    if (builder == null) {
      throw StateError('FakeSupabaseClient: from("$table") は未設定です');
    }
    return builder;
  }

  @override
  PostgrestFilterBuilder<T> rpc<T>(
    String fn, {
    Map<String, dynamic>? params,
    dynamic get = false,
  }) {
    lastRpcFn = fn;
    lastRpcParams = params;
    final builder = _rpcBuilders[fn];
    if (builder == null) {
      throw StateError('FakeSupabaseClient: rpc("$fn") は未設定です');
    }
    return builder as PostgrestFilterBuilder<T>;
  }
}

/// `exchangeCodeForSession` 成功時のダミー戻り値。
/// session 中身はテストでは参照しないため最小構成。
AuthSessionUrlResponse _emptyAuthSessionUrlResponse() {
  return AuthSessionUrlResponse(
    session: Session(
      accessToken: 'fake-access-token',
      tokenType: 'bearer',
      user: const User(
        id: 'fake-user-id',
        appMetadata: {},
        userMetadata: {},
        aud: 'authenticated',
        createdAt: '2026-01-01T00:00:00.000Z',
      ),
    ),
    redirectType: null,
  );
}
