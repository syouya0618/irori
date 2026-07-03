import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:irori/core/supabase/supabase_providers.dart';
import 'package:irori/features/settings/data/settings_provider.dart';
import 'package:irori/features/settings/data/settings_repository.dart';
import 'package:irori/features/setup/presentation/setup_page.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import '../../support/fake_supabase.dart';

/// SetupPage (Issue #75 / 元 `src/app/setup/{page,setup-form,actions}.tsx`) の
/// widget test。既存所属チェック → form → `create_household` RPC の各経路を
/// 固定する。
///
/// E2E (実 create_household + RLS) は実 Supabase 接続が必要なため worktree
/// では検証不能。本テストは fake 注入で「RPC が正しい引数で呼ばれ、
/// 分岐 UI と遷移先が決まる」ところまで検証する (invite_page_test と同じ流儀)。
void main() {
  group('SetupPage', () {
    /// profileHouseholdId が非 null なら「既に所属」分岐 (→ /meals 退避)。
    /// createError は `create_household` RPC の失敗を注入する。
    ///
    /// `Override` 型は riverpod 3.x で公開 export されていないため、provider の
    /// 差し替えは関数引数で受ける (pending_approval_page_test と同じ流儀)。
    Widget wrap({
      String? profileHouseholdId,
      Object? profileError,
      Object? createError,
      void Function(String destination)? onComplete,
      void Function(FakeSupabaseClient client)? onClient,
      FutureOr<String?> Function(Ref ref)? householdFetch,
      FutureOr<SettingsData> Function(Ref ref)? settingsFetch,
    }) {
      final client = FakeSupabaseClient(
        fromBuilders: {
          'profiles': FakeQueryBuilder(
            FakeFilterBuilder(
              singleValue: {'household_id': profileHouseholdId},
              singleError: profileError,
            ),
          ),
        },
        rpcBuilders: {
          'create_household': FakeRpcBuilder(
            cannedValue: 'hh-new',
            cannedError: createError,
          ),
        },
      );
      onClient?.call(client);
      return ProviderScope(
        overrides: [
          supabaseClientProvider.overrideWithValue(client),
          if (householdFetch != null)
            currentHouseholdIdProvider.overrideWith(householdFetch),
          if (settingsFetch != null)
            settingsProvider.overrideWith(settingsFetch),
        ],
        child: MaterialApp(
          home: SetupPage(userId: 'user-1', onComplete: onComplete),
        ),
      );
    }

    /// mount fetch → rebuild → 遷移まで有限 pump で流す (既所属分岐と作成成功
    /// 分岐はスピナーが回り続けるため pumpAndSettle は使えない —
    /// pending_approval_page_test と同じ流儀)。
    Future<void> settle(WidgetTester tester) async {
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 50));
      await tester.pump(const Duration(milliseconds: 50));
    }

    testWidgets('世帯未参加なら世帯作成フォームを表示する', (tester) async {
      FakeSupabaseClient? captured;
      await tester.pumpWidget(wrap(onClient: (c) => captured = c));
      await settle(tester);

      // web page.tsx / setup-form.tsx の文言 (日本語 UI)。
      expect(find.text('世帯をつくる'), findsOneWidget);
      expect(find.text('まずは世帯名を決めましょう'), findsOneWidget);
      expect(find.text('世帯名'), findsOneWidget);
      expect(find.text('あとから変更できます'), findsOneWidget);
      expect(find.widgetWithText(FilledButton, '世帯を作成する'), findsOneWidget);

      // 既存所属チェックは profiles を自分の id スコープで引く (web page.tsx:17-21)。
      expect(captured!.lastFromTable, 'profiles');
    });

    testWidgets('既に世帯所属なら /meals へ退避しフォームを出さない', (tester) async {
      String? dest;
      await tester.pumpWidget(
        wrap(profileHouseholdId: 'hh-1', onComplete: (d) => dest = d),
      );
      await settle(tester);

      // web page.tsx:29-31 の redirect("/meals")。
      expect(dest, '/meals');
      expect(find.text('世帯をつくる'), findsNothing);
    });

    testWidgets('profiles 取得失敗はフォーム表示へ縮退する (web parity)', (tester) async {
      String? dest;
      await tester.pumpWidget(
        wrap(
          profileError: const PostgrestException(message: 'boom', code: '500'),
          onComplete: (d) => dest = d,
        ),
      );
      await settle(tester);

      // web page.tsx:23-27: logSupabaseError の上 form を描画する
      // (作成試行時は DB 側の「既所属なら拒否」ガードが最終防衛)。
      expect(dest, isNull);
      expect(find.text('世帯をつくる'), findsOneWidget);
    });

    testWidgets('空白のみの世帯名は SnackBar で拒否し RPC を呼ばない', (tester) async {
      FakeSupabaseClient? captured;
      String? dest;
      await tester.pumpWidget(
        wrap(onClient: (c) => captured = c, onComplete: (d) => dest = d),
      );
      await settle(tester);

      await tester.enterText(find.byType(TextFormField), '   ');
      await tester.tap(find.widgetWithText(FilledButton, '世帯を作成する'));
      await settle(tester);

      // web setup-form.tsx:18-22: trim 後空は toast.error で拒否。
      expect(find.text('世帯名を入力してください'), findsOneWidget);
      expect(captured!.lastRpcFn, isNull);
      expect(dest, isNull);
    });

    testWidgets('作成成功: create_household を p_name (trim 済) で呼び /meals へ遷移する', (
      tester,
    ) async {
      FakeSupabaseClient? captured;
      String? dest;
      await tester.pumpWidget(
        wrap(onClient: (c) => captured = c, onComplete: (d) => dest = d),
      );
      await settle(tester);

      await tester.enterText(find.byType(TextFormField), '  田中家  ');
      await tester.tap(find.widgetWithText(FilledButton, '世帯を作成する'));
      await settle(tester);

      // RPC 契約: create_household は `p_name` 引数名で trim 済みの世帯名を渡す
      // (migration 20260603000001 / web actions.ts:22 と一致)。
      expect(captured!.lastRpcFn, 'create_household');
      expect(captured!.lastRpcParams, {'p_name': '田中家'});
      expect(dest, '/meals');
    });

    testWidgets('作成成功で household / settings provider を invalidate する', (
      tester,
    ) async {
      // 世帯参加前に評価済みの provider は household_id=null /
      // HouseholdRequiredError を保持している — 破棄されないと /meals 以降が
      // stale なままになる (web actions.ts:34 の revalidatePath 対応)。
      var householdFetches = 0;
      var settingsFetches = 0;
      await tester.pumpWidget(
        wrap(
          onComplete: (_) {},
          householdFetch: (ref) async {
            householdFetches++;
            return null;
          },
          settingsFetch: (ref) async {
            settingsFetches++;
            // Error 継承ゆえ Riverpod 3 defaultRetry の自動リトライ対象外
            // (対象だと fetch 回数が非決定になる — HouseholdRequiredError doc)。
            throw HouseholdRequiredError();
          },
        ),
      );
      await settle(tester);

      // 世帯参加前の評価を再現 (未評価の provider への invalidate は no-op で
      // 再計算を観測できないため、先に温める)。
      final container = ProviderScope.containerOf(
        tester.element(find.byType(SetupPage)),
      );
      await container.read(currentHouseholdIdProvider.future);
      await expectLater(
        container.read(settingsProvider.future),
        throwsA(isA<HouseholdRequiredError>()),
      );
      expect(householdFetches, 1);
      expect(settingsFetches, 1);

      await tester.enterText(find.byType(TextFormField), '田中家');
      await tester.tap(find.widgetWithText(FilledButton, '世帯を作成する'));
      await settle(tester);

      // invalidate 済みなら次の read で再計算される。
      await container.read(currentHouseholdIdProvider.future);
      expect(householdFetches, 2);
      await expectLater(
        container.read(settingsProvider.future),
        throwsA(isA<HouseholdRequiredError>()),
      );
      expect(settingsFetches, 2);
    });

    testWidgets('作成失敗は SnackBar で表面化しフォームに留まる', (tester) async {
      String? dest;
      await tester.pumpWidget(
        wrap(
          createError: const PostgrestException(
            message: 'User already belongs to a household',
            code: 'P0001',
          ),
          onComplete: (d) => dest = d,
        ),
      );
      await settle(tester);

      await tester.enterText(find.byType(TextFormField), '田中家');
      await tester.tap(find.widgetWithText(FilledButton, '世帯を作成する'));
      await settle(tester);

      // web actions.ts:31 と同一文言 (詳細丸め)。form に留まり再試行できる。
      expect(find.text('世帯の作成に失敗しました。もう一度お試しください。'), findsOneWidget);
      expect(dest, isNull);
      final button = tester.widget<FilledButton>(
        find.widgetWithText(FilledButton, '世帯を作成する'),
      );
      expect(button.onPressed, isNotNull, reason: '失敗後は再試行可能に戻す');
    });
  });
}
