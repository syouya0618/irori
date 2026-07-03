import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:irori/core/utils/app_origin.dart';
import 'package:irori/features/settings/data/settings_repository.dart';
import 'package:irori/features/settings/presentation/widgets/invite_card.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

/// createInvitation を捕捉 / 制御する fake repository
/// (approval_card_test._FakeRepo の流儀)。
class _FakeRepo extends Fake implements SettingsRepository {
  _FakeRepo({this.token = 'tok-1', this.error});

  /// 次回 createInvitation が返す token (再生成テストで差し替える)。
  String token;
  Object? error;

  /// 非 null なら createInvitation がこの Completer の完了まで停止する。
  Completer<void>? gate;

  final calls = <({String householdId, String userId})>[];

  @override
  Future<String> createInvitation({
    required String householdId,
    required String userId,
  }) async {
    calls.add((householdId: householdId, userId: userId));
    if (gate != null) await gate!.future;
    if (error != null) throw error!;
    return token;
  }
}

Widget _harness({_FakeRepo? repo}) {
  return ProviderScope(
    overrides: [
      // flutter-test VM は Uri.base が file: scheme のため必ず override する
      // (app_origin.dart の doc 契約)。
      originProvider.overrideWithValue('https://irori.example'),
      settingsMutationContextProvider.overrideWith(
        (ref) async => (householdId: 'hh-1', userId: 'user-1'),
      ),
      settingsRepositoryProvider.overrideWithValue(repo ?? _FakeRepo()),
    ],
    child: const MaterialApp(home: Scaffold(body: InviteCard())),
  );
}

/// SystemChannels.platform を mock して Clipboard.setData を捕捉する。
/// [error] 非 null なら Clipboard.setData を失敗させる。
List<MethodCall> _mockClipboard(WidgetTester tester, {Object? error}) {
  final calls = <MethodCall>[];
  tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
    SystemChannels.platform,
    (call) async {
      calls.add(call);
      if (call.method == 'Clipboard.setData' && error != null) {
        throw error;
      }
      return null;
    },
  );
  addTearDown(() {
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
      SystemChannels.platform,
      null,
    );
  });
  return calls;
}

/// URL 表示欄 (readOnly TextField) の現在値。
String? _urlFieldText(WidgetTester tester) {
  final fields = find.byType(TextField);
  if (fields.evaluate().isEmpty) return null;
  return tester.widget<TextField>(fields).controller?.text;
}

void main() {
  testWidgets('生成前はタイトル・説明・生成ボタンのみで URL 欄は出ない', (tester) async {
    await tester.pumpWidget(_harness());
    await tester.pump();

    expect(find.text('メンバー招待'), findsOneWidget);
    expect(
      find.text('招待リンクを共有して、家族をこの世帯に招待できます。リンクは7日間有効です。'),
      findsOneWidget,
    );
    expect(find.text('招待リンクを生成'), findsOneWidget);
    expect(find.byType(TextField), findsNothing);
    expect(find.text('新しいリンクを生成'), findsNothing);
  });

  testWidgets('生成で createInvitation が呼ばれ、URL 表示 + 成功 SnackBar が出る', (
    tester,
  ) async {
    final repo = _FakeRepo(token: 'tok-abc');
    await tester.pumpWidget(_harness(repo: repo));
    await tester.pump();

    await tester.tap(find.text('招待リンクを生成'));
    await tester.pump(); // mutation context + createInvitation future
    await tester.pump(); // setState + snackbar 描画

    // web generateInvite と同じ引数 (household_id / invited_by=userId)。
    expect(repo.calls, [(householdId: 'hh-1', userId: 'user-1')]);
    // リンク形式は受け側 invite_page (`/invite/:token`) と同一。
    expect(_urlFieldText(tester), 'https://irori.example/invite/tok-abc');
    expect(find.text('招待リンクを生成しました'), findsOneWidget);
    // 生成後は初回生成ボタンが再生成ボタンへ入れ替わる (web の分岐)。
    expect(find.text('招待リンクを生成'), findsNothing);
    expect(find.text('新しいリンクを生成'), findsOneWidget);
  });

  testWidgets('生成失敗はエラー SnackBar を出し URL 欄は出ない (握り潰さない)', (tester) async {
    final repo = _FakeRepo(error: const PostgrestException(message: 'boom'));
    await tester.pumpWidget(_harness(repo: repo));
    await tester.pump();

    await tester.tap(find.text('招待リンクを生成'));
    await tester.pump();
    await tester.pump();

    // web: toast.error("招待リンクの生成に失敗しました")。
    expect(find.text('招待リンクの生成に失敗しました'), findsOneWidget);
    expect(find.byType(TextField), findsNothing);
    // 失敗後は再度生成できる (disabled が解除される)。
    expect(
      tester.widget<OutlinedButton>(find.byType(OutlinedButton)).onPressed,
      isNotNull,
    );
  });

  testWidgets('生成中はボタン disabled + spinner で二重タップを防ぐ', (tester) async {
    final repo = _FakeRepo()..gate = Completer<void>();
    await tester.pumpWidget(_harness(repo: repo));
    await tester.pump();

    await tester.tap(find.text('招待リンクを生成'));
    await tester.pump();
    await tester.pump(); // mutation context 解決 → createInvitation で停止

    expect(find.byType(CircularProgressIndicator), findsOneWidget);
    expect(
      tester.widget<OutlinedButton>(find.byType(OutlinedButton)).onPressed,
      isNull,
    );

    // 二重タップ (disabled) は no-op。createInvitation は 1 回のみ。
    await tester.tap(find.byType(OutlinedButton), warnIfMissed: false);
    await tester.pump();
    expect(repo.calls, hasLength(1));

    repo.gate!.complete();
    await tester.pumpAndSettle();
  });

  testWidgets('コピーで Clipboard へ URL が渡り、Check アイコンが 2 秒で元に戻る', (tester) async {
    final clipboardCalls = _mockClipboard(tester);
    await tester.pumpWidget(_harness(repo: _FakeRepo(token: 'tok-abc')));
    await tester.pump();

    await tester.tap(find.text('招待リンクを生成'));
    await tester.pump();
    await tester.pump();

    // 先行 SnackBar (生成しました) を掃く。ScaffoldMessenger はキュー処理の
    // ため、掃かないと「コピーしました」が表示されない。表示 timer は入場
    // アニメーション完了フレームで始動するため settle → 4s → settle の順。
    await tester.pumpAndSettle();
    await tester.pump(const Duration(seconds: 4));
    await tester.pumpAndSettle();

    await tester.tap(find.byIcon(LucideIcons.clipboardCopy));
    await tester.pump();
    await tester.pump();

    final setData = clipboardCalls.where(
      (c) => c.method == 'Clipboard.setData',
    );
    expect(setData, hasLength(1));
    final args = setData.single.arguments as Map<dynamic, dynamic>;
    expect(args['text'], 'https://irori.example/invite/tok-abc');
    // web: setCopied(true) + toast.success("コピーしました")。
    expect(find.text('コピーしました'), findsOneWidget);
    expect(find.byIcon(LucideIcons.check), findsOneWidget);
    expect(find.byIcon(LucideIcons.clipboardCopy), findsNothing);

    // web: setTimeout 2000ms で copied を戻す。
    await tester.pump(const Duration(seconds: 2));
    await tester.pump();
    expect(find.byIcon(LucideIcons.check), findsNothing);
    expect(find.byIcon(LucideIcons.clipboardCopy), findsOneWidget);
  });

  testWidgets('コピー失敗は「コピーに失敗しました」を出す (握り潰さない)', (tester) async {
    _mockClipboard(
      tester,
      error: PlatformException(code: 'copy_fail', message: 'denied'),
    );
    await tester.pumpWidget(_harness());
    await tester.pump();

    await tester.tap(find.text('招待リンクを生成'));
    await tester.pump();
    await tester.pump();

    // 先行 SnackBar (生成しました) を掃く (コピー成功テストと同じ手順)。
    await tester.pumpAndSettle();
    await tester.pump(const Duration(seconds: 4));
    await tester.pumpAndSettle();

    await tester.tap(find.byIcon(LucideIcons.clipboardCopy));
    await tester.pump();
    await tester.pump();

    expect(find.text('コピーに失敗しました'), findsOneWidget);
    // copied 状態にはしない (web は catch で setCopied を呼ばない)。
    expect(find.byIcon(LucideIcons.check), findsNothing);
  });

  testWidgets('「新しいリンクを生成」で再生成され URL が更新される', (tester) async {
    final repo = _FakeRepo(token: 'tok-1');
    await tester.pumpWidget(_harness(repo: repo));
    await tester.pump();

    await tester.tap(find.text('招待リンクを生成'));
    await tester.pump();
    await tester.pump();
    expect(_urlFieldText(tester), 'https://irori.example/invite/tok-1');

    repo.token = 'tok-2';
    await tester.tap(find.text('新しいリンクを生成'));
    await tester.pump();
    await tester.pump();

    expect(repo.calls, hasLength(2));
    expect(_urlFieldText(tester), 'https://irori.example/invite/tok-2');
  });
}
