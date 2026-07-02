import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:irori/core/supabase/supabase_providers.dart';
import 'package:irori/features/auth/data/approval_provider.dart';
import 'package:irori/features/auth/presentation/pending_approval_page.dart';
import 'package:irori/features/settings/data/settings_provider.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import '../../support/fake_supabase.dart';

/// PendingApprovalPage (Issue #74 / 元 `pending-content.tsx` + `actions.ts`) の
/// widget test。承認確認 → 自動遷移・再確認・ログアウトの各経路を固定する。
///
/// E2E (実 profiles.is_approved + owner の承認操作) は実 Supabase 接続が必要な
/// ため worktree では検証不能。本テストは provider / client の fake 注入で
/// 「fetch 結果に応じた UI 分岐と遷移先の決定」までを検証する。
void main() {
  // `Override` 型は riverpod 3.x で公開 export されていないため、helper は
  // 型を露出せず差し替え内容を引数で受ける (baby_logs_notifier_test と同じ流儀)。
  Widget wrap({
    required FutureOr<bool> Function(Ref ref) approval,
    FakeSupabaseClient? client,
    String? from,
    void Function(String destination)? onNavigate,
  }) {
    return ProviderScope(
      overrides: [
        approvalStatusProvider.overrideWith(approval),
        if (client != null) supabaseClientProvider.overrideWithValue(client),
      ],
      child: MaterialApp(
        home: PendingApprovalPage(from: from, onNavigate: onNavigate),
      ),
    );
  }

  ProviderContainer containerOf(WidgetTester tester) =>
      ProviderScope.containerOf(
        tester.element(find.byType(PendingApprovalPage)),
      );

  /// provider 解決 → rebuild → post-frame 遷移まで有限 pump で流す
  /// (承認済み分岐は無限アニメの CircularProgressIndicator を表示するため
  /// pumpAndSettle は使わない — auth_callback_page_test と同じ流儀)。
  Future<void> settle(WidgetTester tester) async {
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    await tester.pump(const Duration(milliseconds: 50));
  }

  group('PendingApprovalPage', () {
    testWidgets('未承認は承認待ちカードを表示し、遷移しない', (tester) async {
      String? dest;
      await tester.pumpWidget(
        wrap(approval: (ref) async => false, onNavigate: (d) => dest = d),
      );
      await settle(tester);

      // web pending-content.tsx の文言 (日本語 UI)。
      expect(find.text('承認待ち'), findsOneWidget);
      expect(
        find.text('管理者の承認をお待ちください。承認されると自動的にアプリをご利用いただけます。'),
        findsOneWidget,
      );
      expect(find.text('承認状態を確認'), findsOneWidget);
      expect(find.text('ログアウト'), findsOneWidget);
      expect(dest, isNull, reason: '未承認では遷移しない (fail-closed)');
    });

    testWidgets('確認中 (初回 fetch 解決前) はスピナーのみで「承認待ち」を出さない', (tester) async {
      // cold start で承認済みユーザーが経由した際に「承認待ち」文言を
      // 一瞬見せない (既存フロー非回帰の一部)。
      final gate = Completer<bool>();
      // 解決しない fetch (loading 継続)。
      await tester.pumpWidget(wrap(approval: (ref) => gate.future));
      await tester.pump();

      expect(find.byType(CircularProgressIndicator), findsOneWidget);
      expect(find.text('承認待ち'), findsNothing);

      // teardown: 宙吊り future を残さない (未承認で解決 → カード表示)。
      gate.complete(false);
      await settle(tester);
    });

    testWidgets('承認済みと判明したら from へ自動遷移する', (tester) async {
      String? dest;
      await tester.pumpWidget(
        wrap(
          approval: (ref) async => true,
          from: '/shopping',
          onNavigate: (d) => dest = d,
        ),
      );
      await settle(tester);

      expect(dest, '/shopping');
      // 遷移待ちの間も「承認待ち」文言は出さない (スピナーのみ)。
      expect(find.text('承認待ち'), findsNothing);
    });

    testWidgets('from 無しは /login へ trampoline (redirect が landing を解決する)', (
      tester,
    ) async {
      String? dest;
      await tester.pumpWidget(
        wrap(approval: (ref) async => true, onNavigate: (d) => dest = d),
      );
      await settle(tester);

      expect(dest, '/login');
    });

    testWidgets('from が open redirect 系の不正値なら /login へ倒す', (tester) async {
      String? dest;
      await tester.pumpWidget(
        wrap(
          approval: (ref) async => true,
          from: '//evil.com',
          onNavigate: (d) => dest = d,
        ),
      );
      await settle(tester);

      expect(dest, '/login');
    });

    testWidgets('「承認状態を確認」で refetch し、承認済みになっていれば遷移する', (tester) async {
      var approved = false;
      var fetchCount = 0;
      String? dest;
      await tester.pumpWidget(
        wrap(
          approval: (ref) async {
            fetchCount++;
            return approved;
          },
          from: '/baby',
          onNavigate: (d) => dest = d,
        ),
      );
      await settle(tester);
      expect(find.text('承認待ち'), findsOneWidget);
      expect(fetchCount, 1);
      expect(dest, isNull);

      // owner が承認した後の再確認 (web handleCheck の router.refresh() 相当)。
      approved = true;
      await tester.tap(find.text('承認状態を確認'));
      await settle(tester);

      expect(fetchCount, 2);
      expect(dest, '/baby');
    });

    testWidgets('再確認しても未承認なら承認待ちカードに留まる', (tester) async {
      var fetchCount = 0;
      String? dest;
      await tester.pumpWidget(
        wrap(
          approval: (ref) async {
            fetchCount++;
            return false;
          },
          onNavigate: (d) => dest = d,
        ),
      );
      await settle(tester);

      await tester.tap(find.text('承認状態を確認'));
      await settle(tester);

      expect(fetchCount, 2);
      expect(dest, isNull);
      expect(find.text('承認待ち'), findsOneWidget);
    });

    testWidgets('provider の想定外エラーは承認待ちカードへ縮退する (fail-closed)', (tester) async {
      String? dest;
      await tester.pumpWidget(
        wrap(
          approval: (ref) async => throw StateError('boom'),
          onNavigate: (d) => dest = d,
        ),
      );
      await settle(tester);

      expect(find.text('承認待ち'), findsOneWidget);
      expect(dest, isNull, reason: 'エラーでも絶対に通さない');
    });

    testWidgets('ログアウトで signOut が呼ばれ、同期キャッシュを破棄する', (tester) async {
      final auth = FakeGoTrueClient();
      await tester.pumpWidget(
        wrap(
          approval: (ref) async => false,
          client: FakeSupabaseClient(auth: auth),
        ),
      );
      await settle(tester);

      // 端末共用時に前ユーザーの状態を残さないことの検証用に温めておく。
      containerOf(tester).read(defaultPageCacheProvider).value = 'stock';
      containerOf(
        tester,
      ).read(approvalCacheProvider).set(userId: 'user-1', isApproved: true);

      await tester.tap(find.text('ログアウト'));
      await settle(tester);

      expect(auth.signOutCallCount, 1);
      expect(containerOf(tester).read(defaultPageCacheProvider).value, isNull);
      expect(
        containerOf(tester).read(approvalCacheProvider).isApprovedFor('user-1'),
        isNull,
        reason: '承認キャッシュを破棄する (web actions.ts signOut 相当の掃除)',
      );
    });

    testWidgets('signOut 失敗は SnackBar で表面化する (握り潰さない)', (tester) async {
      final auth = FakeGoTrueClient()
        ..signOutError = const AuthException('boom');
      await tester.pumpWidget(
        wrap(
          approval: (ref) async => false,
          client: FakeSupabaseClient(auth: auth),
        ),
      );
      await settle(tester);

      await tester.tap(find.text('ログアウト'));
      await settle(tester);

      expect(find.text('ログアウトに失敗しました'), findsOneWidget);
    });
  });
}
