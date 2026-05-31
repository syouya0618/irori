import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:irori/core/supabase/supabase_providers.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

/// #54 item4: `currentHouseholdIdProvider` の auth-reactivity 回帰テスト。
///
/// 検証する 2 点:
/// 1. auth state の emit で provider が recompute される
///    (= `ref.watch(authStateChangeProvider)` 依存が効いている)。
/// 2. 起動時 (stream 初回 emit 前) でも `client.auth.currentUser` があれば
///    user が解決され、StateError に倒れない (startup null-window 回帰なし)。
///
/// **検証できなかった事項 (正直報告)**:
/// - `user != null` 経路の profiles 取得 (`client.from('profiles')...`) チェーン
///   全体の解決値の中身までは追わない。profiles 取得ロジック自体は #49 から
///   無変更で、別経路 (実 Supabase / 既存 InvitePage テスト) で担保。本テストは
///   item4 の差分 (= auth watch 反応 + currentUser 直読 + null-window 非回帰) に
///   限定する。「user あり」ケースは「StateError を投げない (= currentUser 直読が
///   効き user!=null 判定を通過する)」ところまでを検証する。

/// `currentUser` を可変にして「ストレージ同期復元済みセッション」を模す
/// `GoTrueClient` フェイク。`onAuthStateChange` は外部 StreamController を返す。
class _FakeGoTrueClient extends Fake implements GoTrueClient {
  _FakeGoTrueClient({required this.controller, User? initialUser})
    : _currentUser = initialUser;

  final StreamController<AuthState> controller;
  User? _currentUser;

  /// `currentUser` getter の読み取り回数。
  ///
  /// `currentHouseholdIdProvider` の body は recompute のたびに `currentUser` を
  /// **ちょうど 1 回** 読む (watch の直後、from/StateError の前)。よってこの値は
  /// 「provider body の実行回数 = recompute 回数」の決定的な代理になる (C1)。
  /// listener 発火回数 (async 解決とタイミング競合する) を数える旧方式は CI で
  /// flaky だったため、body 実行回数で計測する。
  int currentUserReads = 0;

  /// gotrue の「currentUser 更新 → emit」順序を模す (gotrue 2.20.x 確認済み:
  /// signOut は `_removeSession()` で `_currentSession=null` にした後に
  /// `notifyAllSubscribers(signedOut)`、signIn 系は `_saveSession` 後に emit)。
  void emit(AuthChangeEvent event, {Session? session}) {
    _currentUser = session?.user;
    controller.add(AuthState(event, session));
  }

  @override
  User? get currentUser {
    currentUserReads++;
    return _currentUser;
  }

  @override
  Stream<AuthState> get onAuthStateChange => controller.stream;
}

/// `auth` だけ差し替える `SupabaseClient` フェイク。
/// `from('profiles')` は user!=null 経路で呼ばれるが、未実装ゆえ Fake の
/// `noSuchMethod` が **StateError 以外** の例外を投げる。テストはその差
/// (StateError か否か) を使って null-window 非回帰を判定する。
class _FakeSupabaseClient extends Fake implements SupabaseClient {
  _FakeSupabaseClient(this._auth);

  final GoTrueClient _auth;

  @override
  GoTrueClient get auth => _auth;
}

User _user(String id) => User(
  id: id,
  appMetadata: const {},
  userMetadata: const {},
  aud: 'authenticated',
  createdAt: DateTime.utc(2026, 5, 29).toIso8601String(),
);

/// 識別力の負側対照群 (positive control の安全版):
/// 本物の `currentHouseholdIdProvider` から `ref.watch(authStateChangeProvider)`
/// **だけ** を抜いた等価 provider。これが auth emit で recompute されないことを
/// 示すことで、本物が recompute する差分が「watch 依存」に由来すると確定できる。
/// prod コードを mutate せずに識別力を証明するための仕掛け (#54 item4)。
final noWatchHouseholdIdProviderForTest = FutureProvider<String?>((ref) async {
  final client = ref.watch(supabaseClientProvider);
  // ★ ここに authStateChange の watch が無い (= item4 fix を抜いた状態)。
  final user = client.auth.currentUser;
  if (user == null) {
    throw StateError('no user');
  }
  // 本物と同じ profiles チェーン (fake では from が throw → AsyncError)。
  final row = await client
      .from('profiles')
      .select('household_id')
      .eq('id', user.id)
      .maybeSingle();
  return row?['household_id'] as String?;
});

/// 条件 [cond] が真になるまで event loop を 1ms 刻みで bounded に回す。
/// 固定回数の `Duration.zero` は async hop 数に依存して脆いため、状態ベースで待つ
/// (既存 baby_logs_notifier_test の error 遷移待ちと同じ流儀)。
Future<void> _pumpUntil(bool Function() cond, {int maxIterations = 100}) async {
  for (var i = 0; i < maxIterations && !cond(); i++) {
    await Future<void>.delayed(const Duration(milliseconds: 1));
  }
}

void main() {
  group('currentHouseholdIdProvider auth-reactivity (#54 item4)', () {
    test('未認証 (currentUser=null) は StateError を投げる', () async {
      final controller = StreamController<AuthState>.broadcast();
      addTearDown(controller.close);
      final fakeAuth = _FakeGoTrueClient(controller: controller);
      final container = ProviderContainer(
        overrides: [
          supabaseClientProvider.overrideWithValue(
            _FakeSupabaseClient(fakeAuth),
          ),
        ],
      );
      addTearDown(container.dispose);

      await expectLater(
        container.read(currentHouseholdIdProvider.future),
        throwsA(isA<StateError>()),
      );
    });

    test(
      '起動時 (stream 未 emit) でも currentUser があれば StateError に倒れない '
      '(null-window 回帰なし)',
      () async {
        final controller = StreamController<AuthState>.broadcast();
        addTearDown(controller.close);
        // ストレージ同期復元済みユーザーを currentUser に設定。stream は未 emit。
        final fakeAuth = _FakeGoTrueClient(
          controller: controller,
          initialUser: _user('user-1'),
        );
        final container = ProviderContainer(
          overrides: [
            supabaseClientProvider.overrideWithValue(
              _FakeSupabaseClient(fakeAuth),
            ),
          ],
        );
        addTearDown(container.dispose);

        // user!=null 判定を通過 → profiles 取得 (from) に進む。fake の from は
        // noSuchMethod 経由で投げるが、それは StateError ではない。
        // 「StateError ではない」= currentUser 直読が効き null-window を踏んでいない。
        Object? caught;
        try {
          await container.read(currentHouseholdIdProvider.future);
        } catch (e) {
          caught = e;
        }
        expect(
          caught,
          isNot(isA<StateError>()),
          reason:
              'currentUser があるのに StateError なら null-window 回帰 '
              '(stream 未 emit で user=null と誤判定している)',
        );
      },
    );

    // ─────────────────────────────────────────────────────────────────
    // 識別テスト (#54 item4): 「auth emit で recompute され、currentUser の
    // 変化が結果へ反映されるか」を観測する。
    //
    // ★ 旧テストの欠陥 (修正済み): rebuild 回数を「初回 build の async 解決前」に
    //   baseline として取り、`rebuilds > initialRebuilds` を期待していた。だが
    //   FutureProvider は初回 loading→settle の遷移だけで listener を再発火させる
    //   ため、emit や watch 依存と**無関係に**この条件が真になり、watch を外しても
    //   通ってしまった (= 識別力ゼロ)。
    //
    // ★ 新設計: 初回を settle させてから emit し、currentUser=user-1→null の変化が
    //   provider の error 型 (非 StateError→StateError) に**反映される**ことを観測。
    //   同一 setup・同一 emit で、watch を抜いた負側対照 provider が**反映しない**
    //   ことを対比 (positive control)。唯一の違いは watch の有無ゆえ、差分は
    //   `ref.watch(authStateChangeProvider)` 依存に由来すると確定できる。
    // ─────────────────────────────────────────────────────────────────

    test(
      'tokenRefreshed では recompute せず signedOut では recompute する '
      '(C1 / #54 item4)',
      () async {
        final controller = StreamController<AuthState>.broadcast();
        addTearDown(controller.close);
        // 起動時はストレージ復元済み user-1 (currentUser!=null)。
        final fakeAuth = _FakeGoTrueClient(
          controller: controller,
          initialUser: _user('user-1'),
        );
        final container = ProviderContainer(
          overrides: [
            supabaseClientProvider.overrideWithValue(
              _FakeSupabaseClient(fakeAuth),
            ),
          ],
        );
        addTearDown(container.dispose);

        // 決定的計測の根拠 (select の同期 short-circuit):
        // currentHouseholdIdProvider の body は実行のたび currentUser を 1 回読む。
        // select((s)=>user.id) は選択値が前回と `==` なら **recompute しない**。
        // よって body 実行回数 (=currentUserReads) は次の通り厳密に決まる:
        //   1. listen(fireImmediately): authStateChange 未 emit → select=null →
        //      build#1 → reads=1
        //   2. signedIn (null→user-1): select 変化 → build#2 → reads=2
        //   3. tokenRefreshed (user-1→user-1): select 不変 → **no build** → reads=2
        //   4. signedOut (user-1→null): select 変化 → build#3 → reads=3
        // 厳密値で assert することで settle の曖昧さ (CI flaky の原因) を排除する。
        container.listen(currentHouseholdIdProvider, (_, _) {});

        // signedIn まで進め、build#2 の解決 (非 StateError の AsyncError) を待つ。
        // ここまで来れば reads は確定的に 2。
        fakeAuth.emit(
          AuthChangeEvent.signedIn,
          session: Session(
            accessToken: 'tok1',
            tokenType: 'bearer',
            user: _user('user-1'),
          ),
        );
        await _pumpUntil(
          () => container.read(currentHouseholdIdProvider).hasError,
        );
        expect(
          container.read(currentHouseholdIdProvider).error,
          isNot(isA<StateError>()),
          reason: 'user-1 がいるので user!=null 経路 (StateError ではない)',
        );
        expect(
          fakeAuth.currentUserReads,
          2,
          reason: 'fireImmediately build#1 + signedIn build#2 = 2 回',
        );

        // tokenRefreshed: 同一 user (id 不変)。select 短絡で recompute されない。
        // 誤って recompute する余地を与えるため十分 pump してから不変を確認する
        // (negative assertion ゆえ固定 pump。select の短絡は信頼できる)。
        fakeAuth.emit(
          AuthChangeEvent.tokenRefreshed,
          session: Session(
            accessToken: 'tok2',
            tokenType: 'bearer',
            user: _user('user-1'),
          ),
        );
        for (var i = 0; i < 30; i++) {
          await Future<void>.delayed(const Duration(milliseconds: 1));
        }
        expect(
          fakeAuth.currentUserReads,
          2,
          reason:
              'tokenRefreshed (user id 不変) では recompute されないべき '
              '(.select(user.id) で token refresh の周期発火を無視する = C1 fix)。'
              'ここが 3 なら authStateChangeProvider を全体 watch に戻している',
        );

        // signedOut: user id が user-1 → null → select 変化で build#3 → reads=3。
        // currentUser=null 判定で StateError へ遷移する。
        fakeAuth.emit(AuthChangeEvent.signedOut);
        await _pumpUntil(
          () => container.read(currentHouseholdIdProvider).error is StateError,
        );
        expect(
          fakeAuth.currentUserReads,
          3,
          reason: 'signedOut (user id 変化) では recompute され reads=3 になるべき',
        );
        expect(
          container.read(currentHouseholdIdProvider).error,
          isA<StateError>(),
          reason: 'logout で currentUser=null が反映され StateError になるべき',
        );
      },
    );

    test(
      'positive control: watch を抜いた等価 provider は emit で recompute されず '
      'currentUser の変化が反映されない',
      () async {
        final controller = StreamController<AuthState>.broadcast();
        addTearDown(controller.close);
        final fakeAuth = _FakeGoTrueClient(
          controller: controller,
          initialUser: _user('user-1'),
        );
        final container = ProviderContainer(
          overrides: [
            supabaseClientProvider.overrideWithValue(
              _FakeSupabaseClient(fakeAuth),
            ),
          ],
        );
        addTearDown(container.dispose);

        container.listen(
          noWatchHouseholdIdProviderForTest,
          (_, _) {},
          fireImmediately: true,
        );

        await _pumpUntil(
          () => container.read(noWatchHouseholdIdProviderForTest).hasError,
        );
        final before = container.read(noWatchHouseholdIdProviderForTest).error;
        expect(before, isNot(isA<StateError>()));

        // 本物と同一の emit。currentUser=null になる。
        fakeAuth.emit(AuthChangeEvent.signedOut);
        // 本物が StateError へ遷移するのに十分な時間を与えても、watch が無い
        // 負側は recompute されないので error は変わらないことを確認する。
        await Future<void>.delayed(const Duration(milliseconds: 30));

        expect(
          container.read(noWatchHouseholdIdProviderForTest).error,
          isNot(isA<StateError>()),
          reason:
              'watch が無いので emit しても recompute されず、currentUser=null が '
              '反映されない (= 本物の StateError 遷移は watch 依存に由来する証拠)',
        );
      },
    );
  });
}
