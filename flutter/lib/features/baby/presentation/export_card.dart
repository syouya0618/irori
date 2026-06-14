/// 設定画面の「記録エクスポート」カード。
///
/// Next.js 原典 `src/components/settings/export-card.tsx` の Flutter 移植
/// (Phase 2.6-2)。原典は `<a download>` で PDF を保存するが、Flutter では
/// `printing` の `Printing.sharePdf` で OS の共有/保存シートに渡す
/// (モバイルの download 相当)。
///
/// UI 対応 (原典 file:line):
/// - タイトル "記録エクスポート" + FileDown アイコン (`export-card.tsx:48-50`)。
/// - 説明文 "小児科受診用のPDFレポートを生成します。" (`:53-55`)。
/// - 期間 3 セグメント 1週間/1ヶ月/3ヶ月 (`PERIOD_OPTIONS` `:15-19`)。
/// - ボタン "PDFをダウンロード" / 生成中はスピナー (`:68-82`)。
/// - 失敗トースト "ダウンロードに失敗しました" (`:38`) → SnackBar に置換。
///
/// 生成 (集計→PDF バイト) は `baby_report_provider.dart` に分離し、共有
/// (`Printing.sharePdf`) は [onExport] 経由で注入する。既定は実共有だが、
/// widget テストは onExport を stub して実デバイス印刷を呼ばずに loading /
/// 成功 / 失敗経路を検証する (タスク手順5 / 規約「実デバイス印刷を呼ばない形」)。
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:printing/printing.dart';

import '../../../core/theme/colors.dart';
import '../../../widgets/glass_card.dart';
import '../domain/baby_report_period.dart';
import 'baby_report_provider.dart';

/// 期間セグメントの選択肢。原典 `PERIOD_OPTIONS` (`export-card.tsx:15-19`)。
const _kPeriodOptions = <(BabyReportPeriod, String)>[
  (BabyReportPeriod.oneWeek, '1週間'),
  (BabyReportPeriod.oneMonth, '1ヶ月'),
  (BabyReportPeriod.threeMonths, '3ヶ月'),
];

/// レポートを生成して共有/保存する既定の実装。
///
/// `generateBabyReportForPeriod` (集計→PDF) → `Printing.sharePdf` (OS 共有)。
/// ファイル名は原典 `route.ts:95` と同じ `baby-log_{start}_{end}.pdf`。
Future<void> _defaultExport(WidgetRef ref, BabyReportPeriod period) async {
  final report = await generateBabyReportForPeriod(ref, period);
  await Printing.sharePdf(bytes: report.bytes, filename: report.fileName);
}

/// 記録エクスポートカード。`SettingsPage` に配線する。
class ExportCard extends ConsumerStatefulWidget {
  const ExportCard({this.onExport, super.key});

  /// 生成+共有のフック (テスト注入用)。null なら [_defaultExport]。
  final Future<void> Function(WidgetRef ref, BabyReportPeriod period)? onExport;

  @override
  ConsumerState<ExportCard> createState() => _ExportCardState();
}

class _ExportCardState extends ConsumerState<ExportCard> {
  // 原典 `useState("1week")` (`export-card.tsx:22`)。
  BabyReportPeriod _period = BabyReportPeriod.oneWeek;
  // 原典 `isDownloading` (`:23`)。
  bool _downloading = false;

  Future<void> _handleDownload() async {
    // 原典 `handleDownload`。生成中の二重押下は disabled で抑止するが、念のため
    // 再入もガードする。
    if (_downloading) return;
    final messenger = ScaffoldMessenger.of(context);
    setState(() => _downloading = true);
    try {
      final export = widget.onExport ?? _defaultExport;
      await export(ref, _period);
    } on Object catch (e, st) {
      // 原典は catch で `toast.error` のみだが、CLAUDE.md「握り潰し禁止」に
      // 従い構造化ログも出す (householdId 等の機密は含めない)。
      debugPrint('ExportCard PDF 生成/共有に失敗: $e\n$st');
      if (!mounted) return;
      // 原典 `toast.error("ダウンロードに失敗しました")` (`:38`)。
      messenger.showSnackBar(
        const SnackBar(content: Text('ダウンロードに失敗しました')),
      );
    } finally {
      if (mounted) setState(() => _downloading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return GlassCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // 原典 CardTitle: FileDown + "記録エクスポート" (`export-card.tsx:47-50`)。
          const Row(
            children: [
              Icon(
                LucideIcons.fileDown,
                size: 18,
                color: IroriColors.textPrimary,
              ),
              SizedBox(width: 8),
              Text(
                '記録エクスポート',
                style: TextStyle(
                  fontSize: 16,
                  fontWeight: FontWeight.w600,
                  color: IroriColors.textPrimary,
                ),
              ),
            ],
          ),
          const SizedBox(height: 16),
          // 原典 説明文 (`:53-55`)。
          const Text(
            '小児科受診用のPDFレポートを生成します。',
            style: TextStyle(fontSize: 12, color: IroriColors.textMuted),
          ),
          const SizedBox(height: 16),
          // 原典 期間セグメント (`:56-67`)。既存 baby/meal フォームと同じ
          // SegmentedButton 流儀。生成中は選択不可にする。
          SegmentedButton<BabyReportPeriod>(
            selected: {_period},
            showSelectedIcon: false,
            onSelectionChanged: _downloading
                ? null
                : (selected) => setState(() => _period = selected.single),
            segments: [
              for (final (value, label) in _kPeriodOptions)
                ButtonSegment(value: value, label: Text(label)),
            ],
          ),
          const SizedBox(height: 16),
          // 原典 ボタン (`:68-82`): 生成中はスピナー / "PDFをダウンロード"。
          SizedBox(
            width: double.infinity,
            child: OutlinedButton.icon(
              onPressed: _downloading ? null : _handleDownload,
              // 44px タッチターゲット (CLAUDE.md)。size="lg" 相当。
              style: OutlinedButton.styleFrom(
                minimumSize: const Size.fromHeight(48),
              ),
              icon: _downloading
                  ? const SizedBox(
                      width: 16,
                      height: 16,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(LucideIcons.download, size: 16),
              label: const Text('PDFをダウンロード'),
            ),
          ),
        ],
      ),
    );
  }
}
