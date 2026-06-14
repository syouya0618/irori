import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:irori/core/supabase/supabase_providers.dart';
import 'package:irori/features/baby/data/baby_repository.dart';
import 'package:irori/features/baby/domain/baby_report_aggregation.dart';
import 'package:irori/features/baby/domain/baby_report_period.dart';
import 'package:irori/features/baby/presentation/baby_report_provider.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

/// `generateBabyReportForPeriod` (Phase 2.6-2 / review H1) のエラー合流テスト。
///
/// 原典 `route.ts:46-63` の `Promise.all` は「最初の rejection をそのまま投げ /
/// 残りを unhandled にしない」。直列 `await f1; await f2` だと f1 throw 時に f2 が
/// 宙吊り (unhandled future) になる回帰を防ぐため、**どちらの取得が throw しても**
/// (1) 元 error が catch に合流し、(2) もう片方の future が unhandled で残らない
/// ことを両方向で固定する。
///
/// 検証手段:
/// - 関数は `WidgetRef` を要求する (ExportCard と同じ呼び出し経路)。pump した
///   Consumer の ref を使い、override 済み provider で実 Supabase に触れず駆動する。
/// - 実非同期 (`Future.delayed` の遅延 error) を扱うため `tester.runAsync` で
///   FakeAsync の外に出す。`runAsync` 中に unhandled future が出れば zone が
///   検知してテストが fail する → 「green = 敗者側 future も handle された」証跡。
/// - fake は error future を **メソッド呼び出し時に lazy 生成** する (フィールド
///   初期化での事前生成は subscribe 前に unhandled 扱いされうるため)。

/// 各メソッドの戻り future を遅延付きで差し替えられる fake repository。
class _Repo extends Fake implements BabyRepository {
  _Repo({this.profile, this.logs});

  /// 呼び出し時に評価する profile future ファクトリ (lazy 生成で事前 unhandled
  /// を回避)。null なら既定の成功値。
  final Future<BabyReportProfile> Function()? profile;

  /// 呼び出し時に評価する logs future ファクトリ。null なら空リスト。
  final Future<List<AggregationLogInput>> Function()? logs;

  int profileCalls = 0;
  int logsCalls = 0;

  @override
  Future<BabyReportProfile> fetchBabyReportProfile(String householdId) {
    profileCalls++;
    return profile?.call() ??
        Future.value((babyName: 'さくら', babyBirthDate: null));
  }

  @override
  Future<List<AggregationLogInput>> fetchReportLogs(
    String householdId,
    String startDate,
    String endDate,
  ) {
    logsCalls++;
    return logs?.call() ?? Future.value(const []);
  }
}

/// override 済み ProviderScope を pump し、Consumer の `WidgetRef` を返す。
Future<WidgetRef> _pumpRef(
  WidgetTester tester, {
  required _Repo repo,
  required Future<String?> Function() householdId,
}) async {
  late WidgetRef captured;
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        babyRepositoryProvider.overrideWithValue(repo),
        currentHouseholdIdProvider.overrideWith((ref) => householdId()),
      ],
      child: Consumer(
        builder: (context, ref, _) {
          captured = ref;
          return const SizedBox();
        },
      ),
    ),
  );
  await tester.pumpAndSettle();
  return captured;
}

void main() {
  group('generateBabyReportForPeriod の並列取得エラー合流 (review H1)', () {
    testWidgets(
      'fetchReportLogs が throw → 元 error が合流し profile 側は unhandled に残らない',
      (
        tester,
      ) async {
        final repo = _Repo(
          // profile は敗者側より遅れて成功する (両 future が handle される確認)。
          profile: () => Future.delayed(
            const Duration(milliseconds: 20),
            () => (babyName: 'さくら', babyBirthDate: '2026-01-11'),
          ),
          logs: () => Future<List<AggregationLogInput>>.error(
            const PostgrestException(message: 'logs boom', code: '500'),
          ),
        );
        final ref = await _pumpRef(
          tester,
          repo: repo,
          householdId: () async => 'hh-1',
        );

        await tester.runAsync(() async {
          Object? caught;
          try {
            await generateBabyReportForPeriod(ref, BabyReportPeriod.oneWeek);
          } on Object catch (e) {
            caught = e;
          }
          // 原典 Promise.all 同様、ラップせず元 PostgrestException が出る。
          expect(caught, isA<PostgrestException>());
          expect((caught as PostgrestException).message, 'logs boom');
        });

        expect(repo.profileCalls, 1);
        expect(repo.logsCalls, 1);
        // ここまで zone error が出ていない = profile future も handle 済み。
      },
    );

    testWidgets(
      'fetchBabyReportProfile が throw → 元 error が合流し logs 側 (宙吊り回帰) が unhandled に残らない',
      (tester) async {
        // ★ 直列 `await profileFuture; await logsFuture;` の回帰を直接突く:
        // profile が即 throw すると旧実装では logsFuture が never await のまま残り、
        // 後から error/完了で unhandled になる。logs を「遅れて error」にして、
        // 敗者側が宙吊りにならないことを固定する。
        final repo = _Repo(
          profile: () => Future<BabyReportProfile>.error(
            const PostgrestException(message: 'profile boom', code: 'PGRST116'),
          ),
          logs: () => Future.delayed(
            const Duration(milliseconds: 20),
            () => throw const PostgrestException(
              message: 'logs late boom',
              code: '500',
            ),
          ),
        );
        final ref = await _pumpRef(
          tester,
          repo: repo,
          householdId: () async => 'hh-1',
        );

        await tester.runAsync(() async {
          Object? caught;
          try {
            await generateBabyReportForPeriod(ref, BabyReportPeriod.oneWeek);
          } on Object catch (e) {
            caught = e;
          }
          expect(caught, isA<PostgrestException>());
          // 先に失敗した profile の元 error が出る (Promise.all の最初の rejection)。
          expect((caught as PostgrestException).message, 'profile boom');
          // 遅延 error future を完全に消化させてから抜ける (宙吊り検知の猶予)。
          await Future<void>.delayed(const Duration(milliseconds: 50));
        });

        expect(repo.profileCalls, 1);
        expect(repo.logsCalls, 1);
        // Future.wait が両方 handle していれば green、旧直列なら logs 側 unhandled。
      },
    );

    testWidgets('世帯未参加 (householdId null) は StateError で握り潰さず失敗する', (
      tester,
    ) async {
      final repo = _Repo();
      final ref = await _pumpRef(
        tester,
        repo: repo,
        householdId: () async => null,
      );

      await tester.runAsync(() async {
        Object? caught;
        try {
          await generateBabyReportForPeriod(ref, BabyReportPeriod.oneWeek);
        } on Object catch (e) {
          caught = e;
        }
        expect(caught, isA<StateError>());
      });

      // 世帯未参加では取得を一切呼ばない (原典 401 早期 return 相当)。
      expect(repo.profileCalls, 0);
      expect(repo.logsCalls, 0);
    });
  });
}
