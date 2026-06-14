import 'dart:typed_data';

import 'package:flutter/services.dart' show rootBundle;
import 'package:flutter_test/flutter_test.dart';
import 'package:irori/features/baby/data/baby_repository.dart'
    show BabyReportProfile;
import 'package:irori/features/baby/domain/baby_log.dart';
import 'package:irori/features/baby/domain/baby_report_aggregation.dart';
import 'package:irori/features/baby/presentation/baby_report_pdf.dart';
import 'package:irori/features/baby/presentation/baby_report_provider.dart';
import 'package:pdf/widgets.dart' as pw;

/// 育児レポート PDF 生成 (Phase 2.6-2) のスモーク + 契約テスト。
///
/// PDF バイナリは font subset / 圧縮で内部テキストを直接 assert できないため、
/// (1) ファイル名規則、(2) `%PDF` マジック + 非空バイト、(3) 縮退ルール
/// (未設定/---/月齢)、(4) 空データでも生成成功、(5) データ量で出力が増える
/// 構造サニティ を固定する (タスク手順5 / 規約「生成が throw せず非空バイト」)。

/// 原典 `route.ts:55-57` の 9 列 row 形 (JST 03:00Z = 当日 12:00 JST)。
AggregationLogInput _feeding(String iso, {int? amountMl}) {
  return AggregationLogInput(
    logType: BabyLogType.feeding,
    loggedAt: iso,
    feedingType: FeedingType.bottle,
    amountMl: amountMl,
  );
}

Future<pw.Font> _loadFont() async {
  final data = await rootBundle.load('assets/fonts/NotoSansJP-Regular.ttf');
  return pw.Font.ttf(data);
}

/// PDF マジックバイト `%PDF`。
bool _isPdf(Uint8List bytes) {
  if (bytes.length < 4) return false;
  return bytes[0] == 0x25 && // %
      bytes[1] == 0x50 && // P
      bytes[2] == 0x44 && // D
      bytes[3] == 0x46; // F
}

void main() {
  // rootBundle で font asset を読むため binding が要る (feeding_timer_store_test
  // と同流儀)。
  TestWidgetsFlutterBinding.ensureInitialized();

  group('babyReportFileName (route.ts:95)', () {
    test('baby-log_{start}_{end}.pdf 形式', () {
      expect(
        babyReportFileName('2026-04-04', '2026-04-11'),
        'baby-log_2026-04-04_2026-04-11.pdf',
      );
    });

    test('月跨ぎ・年跨ぎの日付もそのまま埋め込む', () {
      expect(
        babyReportFileName('2025-12-01', '2026-02-28'),
        'baby-log_2025-12-01_2026-02-28.pdf',
      );
    });
  });

  group('buildBabyReportBytes (generateBabyReport コア)', () {
    late pw.Font font;

    setUpAll(() async {
      font = await _loadFont();
    });

    BabyReportInput inputWith({
      List<DailyFeedingSummary> feedings = const [],
      List<DailySleepSummary> sleep = const [],
      List<DailyDiaperSummary> diapers = const [],
      List<TemperatureRecord> temperatures = const [],
      List<GrowthRecord> growth = const [],
      String babyName = 'さくら',
      String birthDate = '2026-01-11',
      String age = '3ヶ月',
    }) {
      return BabyReportInput(
        babyName: babyName,
        birthDate: birthDate,
        age: age,
        startDate: '2026-04-04',
        endDate: '2026-04-11',
        feedings: feedings,
        sleep: sleep,
        diapers: diapers,
        temperatures: temperatures,
        growth: growth,
      );
    }

    test('全テーブルにデータがあると %PDF の非空バイトを返す', () async {
      final bytes = await buildBabyReportBytes(
        inputWith(
          feedings: const [
            (
              date: '2026-04-10',
              totalCount: 3,
              breastCount: 1,
              bottleCount: 1,
              solidCount: 1,
              totalBottleMl: 120,
              avgBottleMl: 120,
            ),
          ],
          sleep: const [
            (date: '2026-04-10', totalMinutes: 270, sessionCount: 3),
          ],
          diapers: const [
            (
              date: '2026-04-10',
              totalCount: 4,
              peeCount: 2,
              poopCount: 1,
              bothCount: 1,
            ),
          ],
          temperatures: const [
            (date: '2026-04-10', time: '08:30', temperature: 37.2),
          ],
          growth: const [
            (date: '2026-04-10', weightG: 5200, heightCm: 58.5),
          ],
        ),
        font,
      );

      expect(bytes, isNotEmpty);
      expect(_isPdf(bytes), isTrue, reason: '先頭が %PDF マジック');
    });

    test('全データ空でも「データなし」レイアウトで生成成功する', () async {
      final bytes = await buildBabyReportBytes(inputWith(), font);
      expect(bytes, isNotEmpty);
      expect(_isPdf(bytes), isTrue);
    });

    test('縮退表示 (未設定 / ---) でも throw せず生成する', () async {
      final bytes = await buildBabyReportBytes(
        inputWith(babyName: '未設定', birthDate: '---', age: '---'),
        font,
      );
      expect(bytes, isNotEmpty);
      expect(_isPdf(bytes), isTrue);
    });

    test('行数が多いほど出力バイトが増える (テーブル行が描かれている構造サニティ)', () async {
      final empty = await buildBabyReportBytes(inputWith(), font);

      final manyRows = <DailyFeedingSummary>[
        for (var d = 1; d <= 28; d++)
          (
            date: '2026-04-${d.toString().padLeft(2, '0')}',
            totalCount: 5,
            breastCount: 2,
            bottleCount: 2,
            solidCount: 1,
            totalBottleMl: 240,
            avgBottleMl: 120,
          ),
      ];
      final populated = await buildBabyReportBytes(
        inputWith(feedings: manyRows),
        font,
      );

      expect(
        populated.length,
        greaterThan(empty.length),
        reason: 'データ行が PDF に実際に描画されている',
      );
    });
  });

  group('generateBabyReportFromData (route.ts:69-94 の縮退+集計+生成)', () {
    const today = '2026-04-11';

    test('プロフィール有りで集計→PDF を生成しファイル名を返す', () async {
      final result = await generateBabyReportFromData(
        profile: (babyName: 'さくら', babyBirthDate: '2026-01-11'),
        logs: [
          _feeding('2026-04-10T03:00:00+00:00', amountMl: 120),
          _feeding('2026-04-11T03:00:00+00:00', amountMl: 100),
        ],
        startDate: '2026-04-04',
        endDate: '2026-04-11',
        today: today,
      );

      expect(result.fileName, 'baby-log_2026-04-04_2026-04-11.pdf');
      expect(_isPdf(result.bytes), isTrue);
      expect(result.bytes, isNotEmpty);
    });

    test('baby_name が null/空でも縮退で生成成功する (route.ts:69 の || 未設定)', () async {
      const BabyReportProfile nullProfile = (
        babyName: null,
        babyBirthDate: null,
      );

      final result = await generateBabyReportFromData(
        profile: nullProfile,
        logs: const [],
        startDate: '2026-04-04',
        endDate: '2026-04-11',
        today: today,
      );

      // 生成成功 + ファイル名規則が保たれる (縮退は PDF 内部のため byte で固定)。
      expect(_isPdf(result.bytes), isTrue);
      expect(result.fileName, 'baby-log_2026-04-04_2026-04-11.pdf');
    });
  });
}
