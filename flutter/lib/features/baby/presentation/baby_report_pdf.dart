/// 育児記録レポートの PDF 生成。
///
/// Next.js 原典 `src/lib/pdf/baby-report.ts` (pdfmake の `docDefinition`) を
/// `pdf` パッケージ (pw) で **1:1 移植** する (Phase 2.6-2)。レイアウト数値・
/// 色・フォント・列幅・空状態文言を原典の行単位で保存し、各所に原典 file:line を
/// 付す (`baby_report_aggregation.dart` の流儀)。
///
/// 生成ロジック (集計結果 → PDF バイト) は副作用が `rootBundle.load`
/// (フォント取得) のみで、`printing` の実印刷/共有 (`baby_report_provider.dart`
/// / `export_card.dart`) からは分離する。これによりバイト生成・ファイル名規則・
/// テーブル行数を `baby_report_pdf_test.dart` で機械検証できる
/// (CLAUDE.md「検証可能性を担保」/ タスク手順5)。
library;

import 'dart:typed_data';

import 'package:flutter/services.dart' show rootBundle;
import 'package:pdf/pdf.dart';
import 'package:pdf/widgets.dart' as pw;

import '../domain/baby_report_aggregation.dart';
import 'baby_display_utils.dart' show formatElapsedMinutes;

/// PDF 生成の入力。原典 `BabyReportInput` (`baby-report.ts:12-23`)。
///
/// [babyName] / [birthDate] / [age] は **縮退済み** の表示文字列を受け取る
/// (原典 `route.ts:69-71` の `|| "未設定"` / "---" 縮退は呼び出し側
/// `baby_report_provider.dart` の責務 — repository は null を返す契約)。
class BabyReportInput {
  const BabyReportInput({
    required this.babyName,
    required this.birthDate,
    required this.age,
    required this.startDate,
    required this.endDate,
    required this.feedings,
    required this.sleep,
    required this.diapers,
    required this.temperatures,
    required this.growth,
  });

  /// 赤ちゃんの名前 (縮退済み)。原典 `babyName`。
  final String babyName;

  /// 生年月日 "YYYY-MM-DD" or "---" (縮退済み)。原典 `birthDate`。
  final String birthDate;

  /// 月齢文字列 or "---" (縮退済み)。原典 `age`。
  final String age;

  /// 期間開始日 "YYYY-MM-DD" (JST)。原典 `startDate`。
  final String startDate;

  /// 期間終了日 "YYYY-MM-DD" (JST, 当日含む)。原典 `endDate`。
  final String endDate;

  final List<DailyFeedingSummary> feedings;
  final List<DailySleepSummary> sleep;
  final List<DailyDiaperSummary> diapers;
  final List<TemperatureRecord> temperatures;
  final List<GrowthRecord> growth;
}

/// レポートのファイル名。原典 `route.ts:95` の `baby-log_${startDate}_${endDate}.pdf`。
String babyReportFileName(String startDate, String endDate) =>
    'baby-log_${startDate}_$endDate.pdf';

// 色定数。原典 `baby-report.ts` の文字列リテラルと同値の sRGB。
// HEADER_BG (`:26`) / BORDER_COLOR (`:27`)。
final _kHeaderBg = PdfColor.fromHex('#f5f5f4');
final _kBorderColor = PdfColor.fromHex('#e7e5e4');
// セクション見出し色 (`baby-report.ts:59` `color: "#44403c"`)。
final _kSectionColor = PdfColor.fromHex('#44403c');
// ヘッダーセル文字色 (`:64` `color: "#57534e"`)。
final _kHeaderCellColor = PdfColor.fromHex('#57534e');
// 「データなし」/ フッターの淡色 (`:80`, `:144` `color: "#a8a29e"`)。
final _kMutedColor = PdfColor.fromHex('#a8a29e');

/// 短縮日付 "M/D" (先頭ゼロなし)。原典 `shortDate` (`baby-report.ts:49-52`)
/// の `${Number(m)}/${Number(d)}` を `int.parse` で再現する。
String _shortDate(String ymd) {
  final parts = ymd.split('-');
  // 原典 `Number(m)` / `Number(d)` の先頭ゼロ落とし ("04" → 4)。
  return '${int.parse(parts[1])}/${int.parse(parts[2])}';
}

/// 期間表示用の日付整形。原典 `formatDate` (`baby-report.ts:96-98`) の
/// `ymd.replace(/-/g, "/")` ("2026-04-04" → "2026/04/04")。
String _formatDate(String ymd) => ymd.replaceAll('-', '/');

/// `avgBottleMl` 等の nullable 数値を原典の `?? "-"` で文字列化する
/// (`baby-report.ts:125`)。
String _orDash(num? value) => value == null ? '-' : '$value';

/// 育児レポートの PDF バイトを生成する。原典 `generateBabyReport`
/// (`baby-report.ts:100-151`)。
///
/// 原典 pdfmake は CommonJS シングルトンへ `setFonts` でフォントを一度だけ登録
/// するが (`:42-47`)、Dart `pdf` は `ThemeData.withFont` で Document ごとに
/// フォントを与える (シングルトン競合の懸念がそもそも無い)。日本語フォントは
/// `assets/fonts/NotoSansJP-Regular.ttf` を `rootBundle.load` で読み、
/// `pw.Font.ttf` で埋め込む (原典 `FONT_PATH` `:25` 相当)。
Future<Uint8List> generateBabyReport(BabyReportInput input) async {
  final fontData = await rootBundle.load(
    'assets/fonts/NotoSansJP-Regular.ttf',
  );
  final notoSansJp = pw.Font.ttf(fontData);
  return buildBabyReportBytes(input, notoSansJp);
}

/// フォントを注入して PDF バイトを組み立てる純粋寄りのコア。
///
/// `rootBundle` (asset I/O) を切り離し、テストでは `flutter test` の asset
/// バンドルから読んだ実フォントを渡してバイト生成を検証する。原典の
/// `docDefinition` (`baby-report.ts:103-147`) をこの関数で再現する。
Future<Uint8List> buildBabyReportBytes(
  BabyReportInput input,
  pw.Font notoSansJp,
) async {
  // 原典 `defaultStyle: { font: "NotoSansJP", fontSize: 9 }` (`:104`)。
  // bold も同一 ttf を使う (原典 setFonts は normal/bold とも FONT_PATH `:43-46`)。
  final theme = pw.ThemeData.withFont(
    base: notoSansJp,
    bold: notoSansJp,
  ).copyWith(defaultTextStyle: pw.TextStyle(font: notoSansJp, fontSize: 9));

  // 原典 `periodLabel` (`:101`) — `${formatDate(start)} 〜 ${formatDate(end)}`。
  final periodLabel =
      '${_formatDate(input.startDate)} 〜 ${_formatDate(input.endDate)}';

  final doc = pw.Document();
  doc.addPage(
    pw.MultiPage(
      // 原典 `pageSize: "A4"` (`:105`) / `pageMargins: [40,40,40,40]` (`:106`)。
      pageFormat: PdfPageFormat.a4,
      margin: const pw.EdgeInsets.all(40),
      theme: theme,
      // 原典 pdfmake はページ数無制限。3 ヶ月分でも溢れぬよう上限を広げる
      // (`pdf` の既定 maxPages=20 は debug build で assert される)。
      maxPages: 1000,
      // 原典 `footer: (currentPage, pageCount) => ...` (`:140-146`)。
      footer: _buildFooter,
      build: (context) => [
        // 原典 `{ text: "育児記録レポート", fontSize: 18, margin: [0,0,0,12] }`
        // (`:108`)。
        pw.Padding(
          padding: const pw.EdgeInsets.only(bottom: 12),
          child: pw.Text('育児記録レポート', style: const pw.TextStyle(fontSize: 18)),
        ),
        // 原典 3 列 (名前/生年月日/月齢) — columnGap 20 / fontSize 10 /
        // margin [0,0,0,4] (`:109-118`)。pdfmake の `width: "auto"` は内容幅 →
        // `MainAxisSize.min` の Row で再現し、列間 20pt を SizedBox で空ける。
        pw.Padding(
          padding: const pw.EdgeInsets.only(bottom: 4),
          child: pw.Row(
            mainAxisSize: pw.MainAxisSize.min,
            children: [
              pw.Text(
                '名前: ${input.babyName}',
                style: const pw.TextStyle(fontSize: 10),
              ),
              pw.SizedBox(width: 20),
              pw.Text(
                '生年月日: ${input.birthDate}',
                style: const pw.TextStyle(fontSize: 10),
              ),
              pw.SizedBox(width: 20),
              pw.Text(
                '月齢: ${input.age}',
                style: const pw.TextStyle(fontSize: 10),
              ),
            ],
          ),
        ),
        // 原典 `{ text: "期間: ...", fontSize: 10, margin: [0,0,0,8] }` (`:119`)。
        pw.Padding(
          padding: const pw.EdgeInsets.only(bottom: 8),
          child: pw.Text(
            '期間: $periodLabel',
            style: const pw.TextStyle(fontSize: 10),
          ),
        ),
        // 原典の区切り線 (`:120-123`) — lineWidth 0.5 / color #e7e5e4 /
        // x2=515 (= A4 幅 595 − 左右 40 余白) / margin [0,0,0,4]。
        pw.Padding(
          padding: const pw.EdgeInsets.only(bottom: 4),
          child: pw.Container(
            height: 0.5,
            width: 515,
            color: _kBorderColor,
          ),
        ),
        // 原典 5 テーブル (`:124-138`)。列見出し・列幅・空状態を 1:1 で移植。
        ..._buildTable(
          '授乳記録',
          const ['日付', '合計', '母乳', 'ミルク', '離乳食', 'ミルク平均(ml)'],
          // 原典 widths ["auto","auto","auto","auto","auto","*"] (`:124`)。
          const [
            _ColW.auto,
            _ColW.auto,
            _ColW.auto,
            _ColW.auto,
            _ColW.auto,
            _ColW.flex,
          ],
          [
            for (final f in input.feedings)
              [
                _shortDate(f.date),
                '${f.totalCount}',
                '${f.breastCount}',
                '${f.bottleCount}',
                '${f.solidCount}',
                _orDash(f.avgBottleMl),
              ],
          ],
        ),
        ..._buildTable(
          '睡眠記録',
          const ['日付', '合計時間', '回数'],
          // 原典 widths ["auto","*","auto"] (`:127`)。
          const [_ColW.auto, _ColW.flex, _ColW.auto],
          [
            for (final s in input.sleep)
              [
                _shortDate(s.date),
                // 原典 `formatElapsedMinutes(s.totalMinutes)` (`:128`)。
                formatElapsedMinutes(s.totalMinutes),
                '${s.sessionCount}',
              ],
          ],
        ),
        ..._buildTable(
          'おむつ記録',
          const ['日付', '合計', 'おしっこ', 'うんち', '両方'],
          // 原典 widths ["auto","auto","auto","auto","*"] (`:130`)。
          const [_ColW.auto, _ColW.auto, _ColW.auto, _ColW.auto, _ColW.flex],
          [
            for (final d in input.diapers)
              [
                _shortDate(d.date),
                '${d.totalCount}',
                '${d.peeCount}',
                '${d.poopCount}',
                '${d.bothCount}',
              ],
          ],
        ),
        ..._buildTable(
          '体温記録',
          const ['日付', '時刻', '体温(℃)'],
          // 原典 widths ["auto","auto","*"] (`:133`)。
          const [_ColW.auto, _ColW.auto, _ColW.flex],
          [
            for (final t in input.temperatures)
              [
                _shortDate(t.date),
                t.time,
                // 原典 `t.temperature.toFixed(1)` (`:134`)。
                t.temperature.toStringAsFixed(1),
              ],
          ],
        ),
        ..._buildTable(
          '成長記録',
          const ['日付', '体重(g)', '身長(cm)'],
          // 原典 widths ["auto","*","*"] (`:136`)。
          const [_ColW.auto, _ColW.flex, _ColW.flex],
          [
            for (final g in input.growth)
              [
                _shortDate(g.date),
                // 原典 `g.weightG ?? "-"` (`:137`)。
                _orDash(g.weightG),
                // 原典 `g.heightCm != null ? g.heightCm.toFixed(1) : "-"` (`:137`)。
                g.heightCm != null ? g.heightCm!.toStringAsFixed(1) : '-',
              ],
          ],
        ),
      ],
    ),
  );

  return doc.save();
}

/// フッター。原典 `footer` (`baby-report.ts:140-146`) —
/// `${currentPage} / ${pageCount}` を中央寄せ / fontSize 8 / color #a8a29e /
/// margin top 10。
pw.Widget _buildFooter(pw.Context context) {
  return pw.Container(
    alignment: pw.Alignment.center,
    margin: const pw.EdgeInsets.only(top: 10),
    child: pw.Text(
      '${context.pageNumber} / ${context.pagesCount}',
      style: pw.TextStyle(fontSize: 8, color: _kMutedColor),
    ),
  );
}

/// 1 テーブル (見出し + 表 or 「データなし」) を組む。原典 `buildTable`
/// (`baby-report.ts:71-94`) + `sectionHeader` (`:54-61`)。
///
/// 原典は行 0 件で表を出さず「データなし」を出す (`:77-82`)。表は header 1 行 +
/// data 行で、罫線・header 背景色・セル文字サイズを原典 `TABLE_LAYOUT`
/// (`:29-34`) / `headerCell` (`:63-65`) / `dataCell` (`:67-69`) と揃える。
List<pw.Widget> _buildTable(
  String title,
  List<String> headers,
  List<_ColW> widths,
  List<List<String>> rows,
) {
  final header = _sectionHeader(title);
  if (rows.isEmpty) {
    // 原典 `{ text: "データなし", fontSize: 9, color: "#a8a29e",
    // margin: [0,0,0,8] }` (`:80`)。
    return [
      header,
      pw.Padding(
        padding: const pw.EdgeInsets.only(bottom: 8),
        child: pw.Text(
          'データなし',
          style: pw.TextStyle(fontSize: 9, color: _kMutedColor),
        ),
      ),
    ];
  }

  return [
    header,
    pw.TableHelper.fromTextArray(
      headers: headers,
      data: rows,
      // 原典 widths の "auto" → IntrinsicColumnWidth、"*" → FlexColumnWidth。
      columnWidths: {
        for (var i = 0; i < widths.length; i++) i: widths[i].toColumnWidth(),
      },
      // 原典 TABLE_LAYOUT: hLine/vLine とも色 #e7e5e4 / 幅 0.5 (`:29-34`)。
      border: pw.TableBorder.all(color: _kBorderColor, width: 0.5),
      // 原典 headerCell: fontSize 8 / color #57534e / fillColor #f5f5f4
      // (`:63-65`)。
      headerStyle: pw.TextStyle(fontSize: 8, color: _kHeaderCellColor),
      headerDecoration: pw.BoxDecoration(color: _kHeaderBg),
      // 原典 dataCell: fontSize 9 (`:67-69`)。
      cellStyle: const pw.TextStyle(fontSize: 9),
      // pdfmake の既定セル整列は左寄せ。原典は alignment 未指定のため左上に揃える。
      headerAlignment: pw.Alignment.centerLeft,
      cellAlignment: pw.Alignment.centerLeft,
      cellPadding: const pw.EdgeInsets.all(3),
    ),
  ];
}

/// セクション見出し。原典 `sectionHeader` (`baby-report.ts:54-61`) —
/// fontSize 12 / margin [0,16,0,6] / color #44403c。
pw.Widget _sectionHeader(String text) {
  return pw.Padding(
    padding: const pw.EdgeInsets.only(top: 16, bottom: 6),
    child: pw.Text(
      text,
      style: pw.TextStyle(fontSize: 12, color: _kSectionColor),
    ),
  );
}

/// pdfmake の列幅指定 ("auto" / "*") を `pdf` の `TableColumnWidth` へ写す
/// 小さな enum。原典 widths 配列の値はこの 2 種のみ (`baby-report.ts:124-136`)。
enum _ColW {
  /// pdfmake "auto" — 内容幅。
  auto,

  /// pdfmake "*" — 残り幅を均等配分 (flex=1)。
  flex;

  pw.TableColumnWidth toColumnWidth() => switch (this) {
    _ColW.auto => const pw.IntrinsicColumnWidth(),
    _ColW.flex => const pw.FlexColumnWidth(),
  };
}
