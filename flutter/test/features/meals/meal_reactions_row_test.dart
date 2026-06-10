import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:irori/features/meals/data/meals_repository.dart';
import 'package:irori/features/meals/domain/meal.dart';
import 'package:irori/features/meals/presentation/widgets/meal_reactions_row.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

class _Repo extends Fake implements MealsRepository {
  /// 非 null なら upsert がこの例外で失敗する。
  Object? error;

  /// 非 null なら upsert がこの Completer の完了まで停止する (楽観更新検証用)。
  Completer<bool>? gate;

  int upsertCount = 0;
  ({String mealId, String userId, MealReaction reaction})? lastUpsert;

  @override
  Future<bool> upsertReaction({
    required String mealId,
    required String userId,
    required MealReaction reaction,
  }) async {
    upsertCount++;
    lastUpsert = (mealId: mealId, userId: userId, reaction: reaction);
    if (gate != null) return gate!.future;
    if (error != null) throw error!;
    return false;
  }
}

Widget _wrap({
  required _Repo repo,
  List<MealReactionEntry> reactions = const [],
  String? currentUserId = 'user-1',
}) {
  return ProviderScope(
    overrides: [
      mealsRepositoryProvider.overrideWithValue(repo),
      mealsMutationContextProvider.overrideWith(
        (ref) async => (householdId: 'hh-1', userId: 'user-1'),
      ),
    ],
    child: MaterialApp(
      home: Scaffold(
        body: Center(
          child: MealReactionsRow(
            mealId: 'meal-1',
            reactions: reactions,
            currentUserId: currentUserId,
          ),
        ),
      ),
    ),
  );
}

/// 絵文字ボタンの装飾 (最初の Container ancestor = ボタン本体)。
BoxDecoration? _buttonDecoration(WidgetTester tester, String emoji) {
  final container = tester.widget<Container>(
    find.ancestor(of: find.text(emoji), matching: find.byType(Container)).first,
  );
  return container.decoration as BoxDecoration?;
}

void main() {
  testWidgets('自分のリアクションだけが強調表示される', (tester) async {
    final repo = _Repo();
    await tester.pumpWidget(
      _wrap(
        repo: repo,
        reactions: const [
          MealReactionEntry(userId: 'user-1', reaction: MealReaction.good),
          MealReactionEntry(userId: 'partner', reaction: MealReaction.ok),
        ],
      ),
    );

    // 自分 (good) はハイライト、パートナー (ok) はハイライトされない。
    expect(_buttonDecoration(tester, '😋')!.color, isNotNull);
    expect(_buttonDecoration(tester, '😐')!.color, isNull);
    expect(_buttonDecoration(tester, '🙅')!.color, isNull);
    // 人数表示は good / ok に 1 ずつ。
    expect(find.text('1'), findsNWidgets(2));
    // パートナーの選択にはドットインジケータ (circle Container)。
    final dots = find.byWidgetPredicate(
      (w) =>
          w is Container &&
          w.decoration is BoxDecoration &&
          (w.decoration! as BoxDecoration).shape == BoxShape.circle,
    );
    expect(dots, findsOneWidget);
  });

  testWidgets('タップで repository.upsertReaction が呼ばれる', (tester) async {
    final repo = _Repo();
    await tester.pumpWidget(_wrap(repo: repo));

    await tester.tap(find.text('😐'));
    await tester.pumpAndSettle();

    expect(repo.upsertCount, 1);
    expect(
      repo.lastUpsert,
      (mealId: 'meal-1', userId: 'user-1', reaction: MealReaction.ok),
    );
  });

  testWidgets('楽観更新: 書き込み完了前に選択が反映される', (tester) async {
    final repo = _Repo()..gate = Completer<bool>();
    await tester.pumpWidget(_wrap(repo: repo));

    expect(_buttonDecoration(tester, '😋')!.color, isNull);

    await tester.tap(find.text('😋'));
    await tester.pump();

    // gate 未完了 (= サーバ応答前) でも即時ハイライト + 人数 1。
    expect(repo.upsertCount, 1);
    expect(_buttonDecoration(tester, '😋')!.color, isNotNull);
    expect(find.text('1'), findsOneWidget);

    repo.gate!.complete(false);
    await tester.pumpAndSettle();

    // 完了後も維持される (realtime refetch が来るまで楽観値を表示)。
    expect(_buttonDecoration(tester, '😋')!.color, isNotNull);
  });

  testWidgets('pending 中の連打は無視される', (tester) async {
    final repo = _Repo()..gate = Completer<bool>();
    await tester.pumpWidget(_wrap(repo: repo));

    await tester.tap(find.text('😋'));
    await tester.pump();
    await tester.tap(find.text('😐'));
    await tester.pump();

    expect(repo.upsertCount, 1);

    repo.gate!.complete(false);
    await tester.pumpAndSettle();
  });

  testWidgets('失敗時は巻き戻して SnackBar を表示する', (tester) async {
    final repo = _Repo()
      ..error = const PostgrestException(message: 'boom', code: '500');
    await tester.pumpWidget(_wrap(repo: repo));

    await tester.tap(find.text('😋'));
    await tester.pumpAndSettle();

    // 楽観更新が巻き戻る (ハイライトも人数も消える)。
    expect(_buttonDecoration(tester, '😋')!.color, isNull);
    expect(find.text('1'), findsNothing);
    expect(find.text('リアクションの登録に失敗しました。'), findsOneWidget);
  });

  testWidgets('同じリアクションの再タップは取消として送信される (取消失敗時の文言)', (tester) async {
    final repo = _Repo()
      ..error = const PostgrestException(message: 'boom', code: '500');
    await tester.pumpWidget(
      _wrap(
        repo: repo,
        reactions: const [
          MealReactionEntry(userId: 'user-1', reaction: MealReaction.good),
        ],
      ),
    );

    // 再タップ → 楽観的に取消表示 → 失敗で巻き戻し + 削除系文言。
    await tester.tap(find.text('😋'));
    await tester.pumpAndSettle();

    expect(_buttonDecoration(tester, '😋')!.color, isNotNull);
    expect(find.text('リアクションの削除に失敗しました。'), findsOneWidget);
  });

  testWidgets('currentUserId が null の間はタップしても送信しない', (tester) async {
    final repo = _Repo();
    await tester.pumpWidget(_wrap(repo: repo, currentUserId: null));

    await tester.tap(find.text('😋'));
    await tester.pumpAndSettle();

    expect(repo.upsertCount, 0);
  });
}
