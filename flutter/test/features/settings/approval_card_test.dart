import 'dart:async';

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

/// 承認を in-flight に固定できる Completer ゲート付き fake。
/// approveUser を承認中状態 (_approving=true) に保ったまま一覧 reorder を起こすため。
class _GatedRepo extends Fake implements SettingsRepository {
  final List<String> approvedIds = [];
  Completer<void>? gate;

  @override
  Future<void> approveUser(String targetUserId) async {
    approvedIds.add(targetUserId);
    if (gate != null) await gate!.future;
  }
}

/// 一覧 reorder を同一 element tree へ流すための feed (Riverpod 3 の Notifier)。
/// pendingApprovalsProvider.overrideWith((ref) async => ref.watch(_usersNP)) で接続する。
class _UsersNotifier extends Notifier<List<PendingUser>> {
  @override
  List<PendingUser> build() => const <PendingUser>[];
  void set(List<PendingUser> value) => state = value;
}

final _usersNP = NotifierProvider<_UsersNotifier, List<PendingUser>>(
  _UsersNotifier.new,
);

/// [text] を表示している行 (_PendingUserRow の Row) に承認中スピナーが在るか。
/// spinner の「数」では key 有無を判別できない (どちらも 1 個) ため、
/// 行 identity (ユーザー名 text の最近接 Row 祖先) で承認中フラグの束縛先を見る。
bool _rowHasSpinner(WidgetTester tester, String text) {
  final row = find
      .ancestor(of: find.text(text), matching: find.byType(Row))
      .first;
  return find
      .descendant(of: row, matching: find.byType(CircularProgressIndicator))
      .evaluate()
      .isNotEmpty;
}

/// reorder の async feed (overrideWith の Future hop) が描画へ伝播するまで
/// 有限回 pump する。固定 pump 回数だと reconcile レースで間欠失敗するため、
/// [topText] の行が [bottomText] の行より上に来た (=新しい行順が反映された) ことを
/// 確認してから spinner identity を見る。承認中スピナーが永続アニメするため
/// pumpAndSettle は使えない。
Future<void> _pumpUntilAbove(
  WidgetTester tester,
  String topText,
  String bottomText,
) async {
  for (var i = 0; i < 60; i++) {
    final top = find.text(topText);
    final bottom = find.text(bottomText);
    if (top.evaluate().isNotEmpty &&
        bottom.evaluate().isNotEmpty &&
        tester.getTopLeft(top).dy < tester.getTopLeft(bottom).dy) {
      return;
    }
    await tester.pump(const Duration(milliseconds: 16));
  }
  fail('reorder が描画へ反映されなかった ($topText が $bottomText より上に来ない)');
}

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

  // M1 (Medium): 承認中に一覧が reorder されても、承認中スピナーは「位置」でなく
  // 「ユーザー identity」に追従しなければならない。get_pending_approvals は
  // ORDER BY 無し (migration 20260408000002) のため承認後 refetch で行順が変わりうる。
  // key 無しだと Flutter は StatefulWidget を位置で reconcile し、_approving State が
  // 別ユーザーへ化ける (web approval-card.tsx:37 の key={pendingUser.id} 移植漏れ)。
  testWidgets(
    'M1: 承認中に一覧が reorder されても承認中スピナーは user identity に追従する',
    (tester) async {
      final repo = _GatedRepo()..gate = Completer<void>();
      final userA = _user(id: 'a', displayName: 'あ太郎', email: 'a@example.com');
      final userB = _user(id: 'b', displayName: 'い花子', email: 'b@example.com');

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            // re-emit を同一 element tree へ流すため _usersNP を watch する。
            pendingApprovalsProvider.overrideWith(
              (ref) async => ref.watch(_usersNP),
            ),
            settingsRepositoryProvider.overrideWithValue(repo),
          ],
          child: const MaterialApp(home: Scaffold(body: ApprovalCard())),
        ),
      );

      final container = ProviderScope.containerOf(
        tester.element(find.byType(ApprovalCard)),
      );
      container.read(_usersNP.notifier).set([userA, userB]);
      await tester.pump();
      await tester.pump();

      // userA の承認を tap → Completer 未完了で in-flight (_approving=true) に固定。
      final aRow = find
          .ancestor(of: find.text('あ太郎'), matching: find.byType(Row))
          .first;
      await tester.tap(find.descendant(of: aRow, matching: find.text('承認')));
      await tester.pump();

      expect(
        _rowHasSpinner(tester, 'あ太郎'),
        isTrue,
        reason: '承認直後は A 行が承認中スピナー',
      );
      expect(_rowHasSpinner(tester, 'い花子'), isFalse);
      expect(repo.approvedIds, ['a']);

      // 一覧を reorder (refetch で順序が変わった状況を再現)。
      container.read(_usersNP.notifier).set([userB, userA]);
      // async feed の伝播を決定化: 新しい行順 (い花子 が あ太郎 の上) が描画へ
      // 反映されるまで pump してから spinner identity を見る (固定 pump の race 排除)。
      await _pumpUntilAbove(tester, 'い花子', 'あ太郎');

      // 核心: 承認中スピナーは位置でなく user A に追従すべき。
      expect(
        _rowHasSpinner(tester, 'あ太郎'),
        isTrue,
        reason: 'reorder 後も承認中スピナーは user A の行に残るべき (ValueKey 追従)',
      );
      expect(
        _rowHasSpinner(tester, 'い花子'),
        isFalse,
        reason: 'user B は承認操作していないのでスピナー無し',
      );

      repo.gate!.complete();
      await tester.pump();
    },
  );

  // L3: loading / error 分岐 (ともに SizedBox.shrink) と二重タップ防止の検証。
  testWidgets('L3: 取得中 (loading) はカードを描画しない', (tester) async {
    final gate = Completer<List<PendingUser>>(); // 完了させない=loading 継続
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          pendingApprovalsProvider.overrideWith((ref) => gate.future),
        ],
        child: const MaterialApp(home: Scaffold(body: ApprovalCard())),
      ),
    );
    await tester.pump();

    expect(find.text('承認待ち'), findsNothing);

    gate.complete(const []); // pending future を後始末
    await tester.pump();
  });

  testWidgets('L3: 取得失敗 (error) はカードを描画しない', (tester) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          pendingApprovalsProvider.overrideWith(
            (ref) async => throw const PostgrestException(message: 'boom'),
          ),
        ],
        child: const MaterialApp(home: Scaffold(body: ApprovalCard())),
      ),
    );
    await tester.pump();
    await tester.pump();

    expect(find.text('承認待ち'), findsNothing);
  });

  testWidgets('L3: 承認中は二重タップを防ぎ spinner + disabled を示す', (tester) async {
    final repo = _GatedRepo()..gate = Completer<void>();
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          pendingApprovalsProvider.overrideWith(
            (ref) async => [_user(id: 'a', email: 'a@example.com')],
          ),
          settingsRepositoryProvider.overrideWithValue(repo),
        ],
        child: const MaterialApp(home: Scaffold(body: ApprovalCard())),
      ),
    );
    await tester.pump();

    await tester.tap(find.text('承認'));
    await tester.pump();

    // 承認中: spinner 表示 + ボタン disabled (onPressed==null)。
    expect(find.byType(CircularProgressIndicator), findsOneWidget);
    expect(
      tester.widget<FilledButton>(find.byType(FilledButton)).onPressed,
      isNull,
    );

    // 二重タップ (disabled ボタン) は no-op。approveUser は 1 回のみ。
    await tester.tap(find.byType(FilledButton), warnIfMissed: false);
    await tester.pump();
    expect(repo.approvedIds, ['a']);

    repo.gate!.complete();
    await tester.pump();
  });
}
