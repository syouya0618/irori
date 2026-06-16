import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:irori/features/settings/data/settings_provider.dart';
import 'package:irori/features/settings/data/settings_repository.dart';
import 'package:irori/features/settings/presentation/widgets/approval_card.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

/// approveUser を捕捉 / 制御する fake repository。
class _FakeRepo extends Fake implements SettingsRepository {
  _FakeRepo({this.approveError});

  final Object? approveError;
  final List<String> approvedIds = [];

  @override
  Future<void> approveUser(String targetUserId) async {
    approvedIds.add(targetUserId);
    if (approveError != null) throw approveError!;
  }
}

PendingUser _user({
  String id = 'u-1',
  String displayName = '花子',
  String email = 'hanako@example.com',
}) => PendingUser(
  id: id,
  displayName: displayName,
  email: email,
  createdAt: '2026-06-01T00:00:00.000Z',
);

Widget _harness({
  required List<PendingUser> Function() pending,
  _FakeRepo? repo,
}) {
  return ProviderScope(
    overrides: [
      pendingApprovalsProvider.overrideWith((ref) async => pending()),
      settingsRepositoryProvider.overrideWithValue(repo ?? _FakeRepo()),
    ],
    child: const MaterialApp(home: Scaffold(body: ApprovalCard())),
  );
}

void main() {
  testWidgets('owner + 承認待ちありで タイトル・件数バッジ・行を描画する', (tester) async {
    await tester.pumpWidget(
      _harness(
        pending: () => [
          _user(id: 'u-1', displayName: '花子', email: 'h@example.com'),
          _user(id: 'u-2', displayName: '', email: 't@example.com'),
        ],
      ),
    );
    await tester.pump(); // FutureProvider 解決

    expect(find.text('承認待ち'), findsOneWidget);
    expect(find.text('2'), findsOneWidget); // 件数バッジ
    expect(find.text('花子'), findsOneWidget);
    // display_name 空のユーザーは email を主表示する (web `display_name || email`)。
    expect(find.text('t@example.com'), findsOneWidget);
    expect(find.widgetWithText(FilledButton, '承認'), findsNWidgets(2));
  });

  testWidgets('承認待ち 0 件ではカードを描画しない (web parity)', (tester) async {
    await tester.pumpWidget(_harness(pending: () => const []));
    await tester.pump();

    expect(find.text('承認待ち'), findsNothing);
  });

  testWidgets('承認ボタンで approveUser を呼び成功 snackbar + 一覧を再取得する', (tester) async {
    final repo = _FakeRepo();
    var fetchCount = 0;
    await tester.pumpWidget(
      _harness(
        repo: repo,
        pending: () {
          fetchCount++;
          // 1 回目は承認待ち 1 件、承認後の再取得 (invalidate) では 0 件。
          return fetchCount == 1
              ? [_user(id: 'u-1', email: 'h@example.com')]
              : const <PendingUser>[];
        },
      ),
    );
    await tester.pump();

    await tester.tap(find.text('承認'));
    await tester.pump(); // approveUser future
    await tester.pump(); // snackbar 描画 + provider invalidate

    expect(repo.approvedIds, ['u-1']);
    expect(find.text('h@example.com を承認しました'), findsOneWidget);

    // 承認後 invalidate → 再 fetch (0 件) でカードが消える。
    await tester.pump();
    await tester.pump();
    expect(find.text('承認待ち'), findsNothing);
    expect(fetchCount, greaterThanOrEqualTo(2));
  });

  testWidgets('「Only owners」由来の権限エラーは「承認権限がありません」を表示する', (tester) async {
    final repo = _FakeRepo(approveError: ArgumentError('承認権限がありません'));
    await tester.pumpWidget(_harness(repo: repo, pending: () => [_user()]));
    await tester.pump();

    await tester.tap(find.text('承認'));
    await tester.pump();
    await tester.pump();

    expect(find.text('承認権限がありません'), findsOneWidget);
  });

  testWidgets('その他エラーは汎用文言「承認に失敗しました」を表示する', (tester) async {
    final repo = _FakeRepo(
      approveError: const PostgrestException(message: 'boom'),
    );
    await tester.pumpWidget(_harness(repo: repo, pending: () => [_user()]));
    await tester.pump();

    await tester.tap(find.text('承認'));
    await tester.pump();
    await tester.pump();

    expect(find.text('承認に失敗しました'), findsOneWidget);
  });
}
