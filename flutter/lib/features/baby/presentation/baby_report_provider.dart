/// 育児記録レポートの生成束ね役 (Riverpod 3)。
///
/// Next.js 原典 `src/app/api/baby-report/route.ts` の GET ハンドラ本体
/// (`route.ts:27-101`) を Flutter/Riverpod へ移植 (Phase 2.6-2)。原典が
/// 1 リクエストで行う「プロフィール + ログ並列取得 → 縮退 → 集計 6 関数 →
/// PDF バイト生成」を 1 関数に束ねる。HTTP の認証 (`getAuthContext` `:28-32`)
/// と period 400 検証 (`:36-39`) は Flutter 側ではそれぞれ
/// `currentHouseholdIdProvider` (auth-reactive) と `BabyReportPeriod` enum
/// (型レベル排除) が担う。
///
/// 縮退ルール (原典 `route.ts:69-71`) はここで適用する:
/// - `babyName`: null/空 → "未設定" (原典 `household?.baby_name || "未設定"`)。
/// - `birthDate`: null → "---" (原典 `birthDate || "---"` を PDF 入力で適用)。
/// - `age`: birthDate があれば `calculateAge`、無ければ "---"
///   (原典 `birthDate ? calculateAge(...) : "---"`)。
library;

import 'dart:typed_data';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/supabase/supabase_providers.dart';
// `formatJstDate` は `baby_repository.dart` の re-export 経由で得る
// (`baby_weekly_summary_provider.dart` と同流儀)。
import '../data/baby_repository.dart';
import '../domain/baby_report_aggregation.dart';
import '../domain/baby_report_period.dart';
import 'baby_report_pdf.dart';

/// 生成済みレポート (PDF バイト + ファイル名)。
///
/// `export_card.dart` が共有/印刷 (`printing`) に使う。ファイル名は原典
/// `route.ts:95` の `baby-log_${startDate}_${endDate}.pdf`。
typedef BabyReportResult = ({Uint8List bytes, String fileName});

/// 指定期間の育児レポート PDF を生成する。
///
/// `householdId` は `currentHouseholdIdProvider` から解決する (auth-reactive)。
/// 世帯未参加 (null) は握り潰さず `StateError` に倒す — UI 側 (`export_card`)
/// が SnackBar に変換する (CLAUDE.md「エラー握り潰し禁止」)。原典 HTTP では
/// 認証ミドルウェアが 401 を返す経路に対応する。
///
/// `ref` から repository / householdId を読むため、`FutureProvider.family` では
/// なくプレーンな async 関数にする (生成は「ボタン押下の 1 回」だけ起きる一回性の
/// アクションで、provider のキャッシュに乗せる必要がない — period ごとの再生成は
/// 常に最新データで行いたい)。よって `ref.watch` ではなく `ref.read` で一度だけ
/// 読む。`WidgetRef` を受け、`export_card.dart` から直接呼べる。テストは
/// [generateBabyReportFromData] で集計→PDF 部を `WidgetRef` 無しで直接検証する。
Future<BabyReportResult> generateBabyReportForPeriod(
  WidgetRef ref,
  BabyReportPeriod period,
) async {
  final householdId = await ref.read(currentHouseholdIdProvider.future);
  if (householdId == null) {
    throw StateError('generateBabyReportForPeriod: 世帯未参加状態でレポートを要求した');
  }

  final repository = ref.read(babyRepositoryProvider);

  // 原典 `today = todayJstString()` / `babyReportDateRange` で [start, end]。
  final today = formatJstDate();
  final range = babyReportDateRange(period, today);

  // 原典 `route.ts:46-63` の `Promise.all` 並列取得を `Future.wait` で再現する。
  // 型の異なる 2 future を真に並列実行する。
  //
  // review H1: 個別 `await f1; await f2` の直列形は f1 が throw した瞬間に f2 が
  // unawaited で宙吊りになり unhandled future 事故を起こす (web Promise.all と
  // 挙動が乖離) ため、`Future.wait` にする。`Future.wait` (eagerError 既定
  // false) は **全 future にエラーハンドラを即時登録** したうえで全完了を待ち、
  // 最初に起きた error を **そのまま** (ラップせず) 投げ、残りの error は吸収する
  // (SDK `future.dart` の handleError 実装で確認)。これは原典 `Promise.all` の
  // 「最初の rejection を投げる / 他は unhandled にしない」と同一で、repository の
  // `PostgrestException` 契約 (UI 文言マッピング前提) も保たれる。
  //
  // 戻り値は要素型が異なるため `List<Object?>` になる。順序は呼び出し順で確定する
  // ので各要素を型付きで取り出す。
  final results = await Future.wait<Object>([
    repository.fetchBabyReportProfile(householdId),
    repository.fetchReportLogs(householdId, range.startDate, range.endDate),
  ]);
  final profile = results[0] as BabyReportProfile;
  final logs = results[1] as List<AggregationLogInput>;

  return generateBabyReportFromData(
    profile: profile,
    logs: logs,
    startDate: range.startDate,
    endDate: range.endDate,
    today: today,
  );
}

/// プロフィール + ログ + 期間から PDF を組む純粋寄りのコア (I/O は font 読込のみ)。
///
/// 原典 `route.ts:69-94` の「縮退 → 集計 → generateBabyReport」を再現する。
/// repository を介さないため、テストで集計結果・ファイル名・バイト生成を
/// 直接固定できる (タスク手順5)。
Future<BabyReportResult> generateBabyReportFromData({
  required BabyReportProfile profile,
  required List<AggregationLogInput> logs,
  required String startDate,
  required String endDate,
  required String today,
}) async {
  // 原典 `route.ts:69-71` の縮退。
  // `household?.baby_name || "未設定"` は JS falsy のため null も空文字も縮退する。
  final name = profile.babyName;
  final babyName = (name == null || name.isEmpty) ? '未設定' : name;
  final birthDate = profile.babyBirthDate; // null なら以降 "---"。
  final age = birthDate != null ? calculateAge(birthDate, today) : '---';

  // 原典 `route.ts:74-79` の集計 6 関数 (calculateAge を含め 2.6-1 で移植済み)。
  final input = BabyReportInput(
    babyName: babyName,
    birthDate: birthDate ?? '---',
    age: age,
    startDate: startDate,
    endDate: endDate,
    feedings: aggregateFeedings(logs, startDate, endDate),
    sleep: aggregateSleep(logs, startDate, endDate),
    diapers: aggregateDiapers(logs, startDate, endDate),
    temperatures: extractTemperatures(logs, startDate, endDate),
    growth: extractGrowth(logs, startDate, endDate),
  );

  final bytes = await generateBabyReport(input);
  return (bytes: bytes, fileName: babyReportFileName(startDate, endDate));
}
