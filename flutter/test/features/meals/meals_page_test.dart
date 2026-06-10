import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:irori/core/domain/item_category.dart';
import 'package:irori/core/utils/jst_date.dart';
import 'package:irori/features/meals/data/meals_repository.dart';
import 'package:irori/features/meals/data/meals_week_notifier.dart';
import 'package:irori/features/meals/data/selected_week_start_provider.dart';
import 'package:irori/features/meals/domain/meal.dart';
import 'package:irori/features/meals/presentation/meal_display_utils.dart';
import 'package:irori/features/meals/presentation/meals_page.dart';
import 'package:irori/features/meals/presentation/widgets/meal_card.dart';
import 'package:irori/features/meals/presentation/widgets/meal_form_sheet.dart';
import 'package:irori/features/meals/presentation/widgets/meal_week_nav.dart';

Meal _meal({
  required String id,
  required String date,
  MealType mealType = MealType.dinner,
  String title = '献立',
  bool isEatingOut = false,
  List<MealReactionEntry> reactions = const [],
  List<MealIngredient> ingredients = const [],
}) {
  return Meal(
    id: id,
    date: date,
    mealType: mealType,
    title: title,
    isEatingOut: isEatingOut,
    reactions: reactions,
    ingredients: ingredients,
  );
}

/// 固定リストを返す AsyncNotifier (data 分岐用 — baby の流儀)。
class _FakeWeekNotifier extends MealsWeekNotifier {
  _FakeWeekNotifier(this._meals);

  final List<Meal> _meals;

  @override
  Future<List<Meal>> build() async => _meals;
}

/// build をテスト側 closure に委譲する AsyncNotifier (再試行検証用)。
/// invalidate でインスタンスが再生成されても外側の closure が状態を持つため
/// 「1 回目失敗 → 2 回目成功」を決定的に再現できる。
class _HookedWeekNotifier extends MealsWeekNotifier {
  _HookedWeekNotifier(this._onBuild);

  final Future<List<Meal>> Function() _onBuild;

  @override
  Future<List<Meal>> build() => _onBuild();
}

/// selectedWeekStart を固定週に。
class _FixedWeekStartNotifier extends SelectedWeekStartNotifier {
  _FixedWeekStartNotifier(this._w);

  final String _w;

  @override
  String build() => _w;
}

Widget _harness({
  required MealsWeekNotifier Function() notifier,
  String? weekStart,
}) {
  return ProviderScope(
    overrides: [
      mealsWeekNotifierProvider.overrideWith(notifier),
      if (weekStart != null)
        selectedWeekStartProvider.overrideWith(
          () => _FixedWeekStartNotifier(weekStart),
        ),
      mealsMutationContextProvider.overrideWith(
        (ref) async => (householdId: 'hh-1', userId: 'user-1'),
      ),
    ],
    child: const MaterialApp(home: MealsPage()),
  );
}

/// 7 日分すべてが ListView にマウントされるよう縦長 viewport にする
/// (ListView は画面外 child を build しないため)。
void _useTallViewport(WidgetTester tester) {
  tester.view.physicalSize = const Size(800, 2400);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
}

void main() {
  testWidgets('7日分の日付見出しと週範囲を表示する', (tester) async {
    _useTallViewport(tester);
    // 2026-06-08 は月曜 (F1 テストと同じ固定週)。
    await tester.pumpWidget(
      _harness(
        notifier: () => _FakeWeekNotifier(const []),
        weekStart: '2026-06-08',
      ),
    );
    await tester.pumpAndSettle();

    expect(find.byType(MealWeekNav), findsOneWidget);
    expect(find.text('6月8日〜6月14日'), findsOneWidget);
    for (final header in [
      '6/8（月）',
      '6/9（火）',
      '6/10（水）',
      '6/11（木）',
      '6/12（金）',
      '6/13（土）',
      '6/14（日）',
    ]) {
      expect(find.text(header), findsOneWidget);
    }
    // 各日に朝・昼・夕の 3 スロット (snack スロットは出さない)。
    expect(find.byType(EmptyMealSlot), findsNWidgets(21));
    expect(find.text('間'), findsNothing);
  });

  testWidgets('Meal のあるスロットはタイトル・外食アイコン・食材数を表示する', (tester) async {
    _useTallViewport(tester);
    await tester.pumpWidget(
      _harness(
        notifier: () => _FakeWeekNotifier([
          _meal(
            id: 'm-1',
            date: '2026-06-08',
            mealType: MealType.breakfast,
            title: 'カレーライス',
            isEatingOut: true,
            ingredients: const [
              MealIngredient(name: 'にんじん', category: ItemCategory.vegetable),
              MealIngredient(name: 'じゃがいも', category: ItemCategory.vegetable),
            ],
          ),
        ]),
        weekStart: '2026-06-08',
      ),
    );
    await tester.pumpAndSettle();

    expect(find.byType(MealCard), findsOneWidget);
    expect(find.text('カレーライス'), findsOneWidget);
    expect(find.text('食材2品'), findsOneWidget);
    // Meal あり 1 スロット分だけ空スロットが減る。
    expect(find.byType(EmptyMealSlot), findsNWidgets(20));
  });

  testWidgets('空スロットのタップで追加 sheet が開く', (tester) async {
    await tester.pumpWidget(
      _harness(
        notifier: () => _FakeWeekNotifier(const []),
        weekStart: '2026-06-08',
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.byType(EmptyMealSlot).first);
    await tester.pumpAndSettle();

    expect(find.byType(MealFormSheet), findsOneWidget);
    expect(find.text('献立を追加'), findsOneWidget);
    expect(find.text('追加する'), findsOneWidget);
  });

  testWidgets('献立カードのタップで編集 sheet が開く (初期値入り)', (tester) async {
    await tester.pumpWidget(
      _harness(
        notifier: () => _FakeWeekNotifier([
          _meal(
            id: 'm-1',
            date: '2026-06-08',
            mealType: MealType.breakfast,
            title: '肉じゃが',
          ),
        ]),
        weekStart: '2026-06-08',
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.text('肉じゃが'));
    await tester.pumpAndSettle();

    expect(find.byType(MealFormSheet), findsOneWidget);
    expect(find.text('献立を編集'), findsOneWidget);
    // タイトル初期値が sheet 側の TextField にも現れる (画面に計 2 箇所)。
    expect(find.text('肉じゃが'), findsNWidgets(2));
  });

  testWidgets('今週が空のときは空状態メッセージを表示する', (tester) async {
    // 「今週へ戻る」判定は実時刻依存のため、今週 (default notifier) を使う。
    await tester.pumpWidget(
      _harness(notifier: () => _FakeWeekNotifier(const [])),
    );
    await tester.pumpAndSettle();

    expect(find.text('今週の献立はまだありません。タップして追加しましょう！'), findsOneWidget);
    // 今週表示中は「今週」ボタンは出ない。
    expect(find.text('今週'), findsNothing);
  });

  testWidgets('今週以外を表示中は「今週」ボタンが出て、タップで今週へ戻る', (tester) async {
    final lastWeek = shiftYmd(weekStartMonday(formatJstDate()), -7);
    await tester.pumpWidget(
      _harness(
        notifier: () => _FakeWeekNotifier(const []),
        weekStart: lastWeek,
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('今週'), findsOneWidget);
    // 先週表示なので空状態メッセージは出ない (原典: isCurrentWeek のみ)。
    expect(find.text('今週の献立はまだありません。タップして追加しましょう！'), findsNothing);

    await tester.tap(find.text('今週'));
    await tester.pumpAndSettle();

    expect(find.text('今週'), findsNothing);
    expect(
      find.text(formatWeekRange(weekStartMonday(formatJstDate()))),
      findsOneWidget,
    );
  });

  testWidgets('エラー時は再試行 UI、タップで refetch して復帰する', (tester) async {
    var attempts = 0;
    await tester.pumpWidget(
      _harness(
        // StateError (Error 系) を使う: Riverpod 3 の自動 retry
        // (`ProviderContainer.defaultRetry`) は Exception を 200ms 後に再実行
        // するため、Exception だと pumpAndSettle 中に勝手に復帰してしまい
        // 「ユーザーの再試行タップで復帰する」ことを検証できない。
        notifier: () => _HookedWeekNotifier(() async {
          attempts++;
          if (attempts == 1) throw StateError('boom');
          return [
            _meal(id: 'm-1', date: '2026-06-08', title: 'リトライ後の献立'),
          ];
        }),
        weekStart: '2026-06-08',
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('献立の読み込みに失敗しました。'), findsOneWidget);
    expect(find.text('再試行'), findsOneWidget);

    await tester.tap(find.text('再試行'));
    await tester.pumpAndSettle();

    expect(attempts, 2);
    expect(find.text('献立の読み込みに失敗しました。'), findsNothing);
    expect(find.text('リトライ後の献立'), findsOneWidget);
  });

  testWidgets('MealsPage 自身の AppBar は 1 つだけ', (tester) async {
    await tester.pumpWidget(
      _harness(
        notifier: () => _FakeWeekNotifier(const []),
        weekStart: '2026-06-08',
      ),
    );
    await tester.pumpAndSettle();

    expect(find.byType(AppBar), findsOneWidget);
    expect(find.text('献立'), findsOneWidget);
  });
}
