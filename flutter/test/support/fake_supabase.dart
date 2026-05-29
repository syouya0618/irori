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

/// `from('x').select(...).eq(...)` のチェーン
/// (`PostgrestFilterBuilder<PostgrestList>` 相当)。
/// 末尾で `await` すれば `PostgrestList` を返し、`single()` で
/// [FakeTransformBuilder] に切り替えられる。
class FakeFilterBuilder extends Fake
    with _FakeFuture<PostgrestList>
    implements PostgrestFilterBuilder<PostgrestList> {
  FakeFilterBuilder({
    this.cannedValue,
    this.cannedError,
    PostgrestMap? singleValue,
    Object? singleError,
  }) : _single = FakeTransformBuilder(
         cannedValue: singleValue,
         cannedError: singleError,
       );

  @override
  final PostgrestList? cannedValue;
  @override
  final Object? cannedError;

  final FakeTransformBuilder _single;

  @override
  // ignore: avoid_returning_this
  PostgrestFilterBuilder<PostgrestList> eq(String column, Object value) => this;

  @override
  PostgrestTransformBuilder<PostgrestMap> single() => _single;
}

/// `from('table')` の結果 (`SupabaseQueryBuilder` 相当)。
/// `select(...)` で [FakeFilterBuilder] へ切り替える。
class FakeQueryBuilder extends Fake implements SupabaseQueryBuilder {
  FakeQueryBuilder(this._filter);

  final FakeFilterBuilder _filter;

  @override
  PostgrestFilterBuilder<PostgrestList> select([String columns = '*']) =>
      _filter;
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
  });

  /// `signInWithOtp` が投げる例外 (null なら成功)。
  final Object? signInError;

  /// `exchangeCodeForSession` が投げる例外 (null なら成功)。
  final Object? exchangeError;

  /// `exchangeCodeForSession` の戻り値 (success 時)。
  final AuthSessionUrlResponse? exchangeResponse;

  // --- 呼び出し記録 (assert 用) ---
  int signInCallCount = 0;
  String? lastEmail;
  String? lastEmailRedirectTo;

  int exchangeCallCount = 0;
  String? lastAuthCode;

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

  @override
  GoTrueClient get auth => _auth;

  @override
  SupabaseQueryBuilder from(String table) {
    lastFromTable = table;
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
