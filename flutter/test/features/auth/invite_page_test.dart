import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:irori/core/supabase/supabase_providers.dart';
import 'package:irori/features/auth/presentation/invite_page.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import '../../support/fake_supabase.dart';

/// 招待ページの未来 / 過去日付 (ISO8601 文字列)。
String _future() =>
    DateTime.now().add(const Duration(days: 7)).toUtc().toIso8601String();
String _past() =>
    DateTime.now().subtract(const Duration(days: 1)).toUtc().toIso8601String();

/// `get_invitation_by_token` の canned 行。
Map<String, dynamic> _invitationRow({
  String id = 'inv-1',
  String householdName = 'すずき家',
  String role = 'member',
  String status = 'pending',
  String? expiresAt,
}) {
  return {
    'id': id,
    'household_id': 'hh-1',
    'household_name': householdName,
    'role': role,
    'status': status,
    'expires_at': expiresAt ?? _future(),
  };
}

void main() {
  group('InvitePage', () {
    /// userId は profiles 取得に使う。profileHouseholdId が非 null なら
    /// 「すでに所属」分岐に入る。invitationRows が rpc の戻り値。
    Widget wrap({
      String token = 'tok-123',
      String? profileHouseholdId,
      List<Map<String, dynamic>>? invitationRows,
      Object? acceptError,
      void Function(String destination)? onAccepted,
      FakeGoTrueClient? auth,
      void Function(FakeSupabaseClient client)? onClient,
    }) {
      final client = FakeSupabaseClient(
        auth: auth ?? FakeGoTrueClient(),
        fromBuilders: {
          'profiles': FakeQueryBuilder(
            FakeFilterBuilder(
              singleValue: {'household_id': profileHouseholdId},
            ),
          ),
        },
        rpcBuilders: {
          'get_invitation_by_token': FakeRpcBuilder(
            cannedValue: invitationRows ?? <Map<String, dynamic>>[],
          ),
          'accept_invitation': FakeRpcBuilder(cannedError: acceptError),
        },
      );
      onClient?.call(client);
      return ProviderScope(
        overrides: [supabaseClientProvider.overrideWithValue(client)],
        child: MaterialApp(
          home: InvitePage(
            token: token,
            userId: 'user-1',
            onAccepted: onAccepted,
          ),
        ),
      );
    }

    testWidgets('正常: 世帯名 + ロール + 参加ボタンを表示', (tester) async {
      FakeSupabaseClient? captured;
      await tester.pumpWidget(
        wrap(
          token: 'tok-xyz',
          invitationRows: [_invitationRow()],
          onClient: (c) => captured = c,
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('すずき家'), findsOneWidget);
      expect(find.textContaining('メンバー'), findsOneWidget);
      expect(find.widgetWithText(FilledButton, '参加する'), findsOneWidget);

      // RPC 契約: get_invitation_by_token は `invite_token` 引数名で token を渡す
      // (migration 20260407000001 / page.tsx と一致)。
      expect(captured!.lastRpcFn, 'get_invitation_by_token');
      expect(captured!.lastRpcParams, {'invite_token': 'tok-xyz'});
    });

    testWidgets('既に世帯所属 → already belongs エラー', (tester) async {
      await tester.pumpWidget(
        wrap(
          profileHouseholdId: 'existing-hh',
          invitationRows: [_invitationRow()],
        ),
      );
      await tester.pumpAndSettle();

      expect(find.textContaining('すでに世帯に参加'), findsOneWidget);
      expect(find.widgetWithText(FilledButton, '参加する'), findsNothing);
    });

    testWidgets('招待が無い → not found エラー', (tester) async {
      await tester.pumpWidget(wrap(invitationRows: []));
      await tester.pumpAndSettle();

      expect(find.textContaining('無効な招待'), findsOneWidget);
      expect(find.widgetWithText(FilledButton, '参加する'), findsNothing);
    });

    testWidgets('期限切れ → expired エラー', (tester) async {
      await tester.pumpWidget(
        wrap(invitationRows: [_invitationRow(expiresAt: _past())]),
      );
      await tester.pumpAndSettle();

      expect(find.text('招待の有効期限切れ'), findsOneWidget);
      expect(find.widgetWithText(FilledButton, '参加する'), findsNothing);
    });

    testWidgets('status != pending → 使用済みエラー', (tester) async {
      await tester.pumpWidget(
        wrap(invitationRows: [_invitationRow(status: 'accepted')]),
      );
      await tester.pumpAndSettle();

      expect(find.textContaining('使用済み'), findsOneWidget);
      expect(find.widgetWithText(FilledButton, '参加する'), findsNothing);
    });

    testWidgets('参加ボタン → accept_invitation を invitation id 付きで呼ぶ', (
      tester,
    ) async {
      String? dest;
      FakeSupabaseClient? captured;
      await tester.pumpWidget(
        wrap(
          invitationRows: [_invitationRow(id: 'inv-42')],
          onAccepted: (d) => dest = d,
          onClient: (c) => captured = c,
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.widgetWithText(FilledButton, '参加する'));
      // 成功時はボタンの spinner が回り続けるため pumpAndSettle は使えない。
      // accept の await (canned future) を流すのに十分な固定 pump を行う。
      await tester.pump(); // tap → setState(_accepting=true)
      await tester.pump(const Duration(milliseconds: 50)); // accept await 解決
      await tester.pump(const Duration(milliseconds: 50)); // onAccepted 反映

      expect(dest, '/baby');
      // RPC 契約: accept_invitation は `invitation_uuid` 引数名で invitation.id
      // を渡す (migration 20260407000001 / actions.ts と一致)。
      expect(captured!.lastRpcFn, 'accept_invitation');
      expect(captured!.lastRpcParams, {'invitation_uuid': 'inv-42'});
    });

    testWidgets('accept 失敗 (already belongs) → エラー表示し画面に留まる', (tester) async {
      String? dest;
      await tester.pumpWidget(
        wrap(
          invitationRows: [_invitationRow()],
          acceptError: const PostgrestException(
            message: 'User already belongs to a household',
          ),
          onAccepted: (d) => dest = d,
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.widgetWithText(FilledButton, '参加する'));
      await tester.pumpAndSettle();

      expect(dest, isNull);
      expect(find.textContaining('すでに世帯に参加'), findsOneWidget);
    });
  });
}
