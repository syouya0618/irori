import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../../core/theme/colors.dart';
import '../../../../core/theme/radii.dart';
import '../../../../widgets/glass_card.dart';
import '../../data/settings_provider.dart';
import '../../data/settings_repository.dart';

/// 起動タブの選択肢 (web `default-page-card.tsx` の PAGE_OPTIONS と同一)。
const _kPageOptions = [
  (value: 'meals', label: '献立'),
  (value: 'shopping', label: '買い物'),
  (value: 'stock', label: '在庫'),
  (value: 'baby', label: '育児'),
];

/// 起動時のページカード。Next.js 原典 `default-page-card.tsx` の Flutter 移植。
///
/// Flutter では「ログイン後 redirect 先 (`/login` → branch) の best-effort
/// 適用」へ意味変換する (PR-H 裁定): 更新成功時に [DefaultPageCache] を温め、
/// router の redirect が同期参照する。cold start での完全適用はスコープ外。
///
/// 楽観更新 + 失敗ロールバック (web `handleSelect` と同じ):
/// タップで即時に選択を切り替え、失敗時は `initialPage` prop へ巻き戻す
/// (web の `setSelected(defaultPage)` 対応 — 直前の選択ではなく props 由来の
/// 値へ戻る quirk ごと移植する)。didUpdateWidget 再同期により props は
/// 「直近に観測したサーバ値」を指すため、rollback 先は web の「mount 時
/// props」より stale が縮小する (意図的差異)。
///
/// タブ再表示 refetch (`AppShell` のタップ契機 invalidate) の新 props は
/// [didUpdateWidget] で再同期する — IndexedStack で State が dispose され
/// ないため、initState だけでは相方の変更がアプリ再起動まで見えない。
/// 保存中 (`_pending`) は楽観選択を優先する。
class DefaultPageCard extends ConsumerStatefulWidget {
  const DefaultPageCard({required this.initialPage, super.key});

  final String initialPage;

  @override
  ConsumerState<DefaultPageCard> createState() => _DefaultPageCardState();
}

class _DefaultPageCardState extends ConsumerState<DefaultPageCard> {
  late String _selected;
  bool _pending = false;

  @override
  void initState() {
    super.initState();
    _selected = widget.initialPage;
  }

  @override
  void didUpdateWidget(DefaultPageCard oldWidget) {
    super.didUpdateWidget(oldWidget);
    // タブ再表示 refetch の新 props を反映する (クラス doc 参照)。保存応答
    // 待ちの間は楽観選択が最新の truth のため上書きしない。
    if (!_pending && widget.initialPage != oldWidget.initialPage) {
      _selected = widget.initialPage;
    }
  }

  Future<void> _select(String page) async {
    if (_pending) return;

    final messenger = ScaffoldMessenger.of(context);
    // ref は await 後に widget が破棄されると使えないため、先に解決しておく。
    final cache = ref.read(defaultPageCacheProvider);
    setState(() {
      _selected = page;
      _pending = true;
    });

    try {
      final ctx = await ref.read(settingsMutationContextProvider.future);
      await ref
          .read(settingsRepositoryProvider)
          .updateDefaultPage(userId: ctx.userId, page: page);
      // 成功: 同期キャッシュを温める (router の /login redirect が読む)。
      // web は成功時に何もしない (toast 無し) — 同じく無通知。
      cache.value = page;
    } on Object catch (e, st) {
      // 握り潰さない (CLAUDE.md)。repository 側でも構造化ログ済み。
      debugPrint('DefaultPageCard updateDefaultPage 失敗: $e\n$st');
      if (!mounted) return;
      // web: toast.error(result.error) + setSelected(defaultPage)。
      setState(() => _selected = widget.initialPage);
      final message = e is ArgumentError ? e.message : null;
      messenger.showSnackBar(
        SnackBar(
          content: Text(
            message is String && message.isNotEmpty ? message : '設定の更新に失敗しました',
          ),
        ),
      );
    } finally {
      if (mounted) setState(() => _pending = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return GlassCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Row(
            children: [
              Icon(
                LucideIcons.layoutDashboard,
                size: 18,
                color: IroriColors.textPrimary,
              ),
              SizedBox(width: 8),
              Text(
                '起動時のページ',
                style: TextStyle(
                  fontSize: 16,
                  fontWeight: FontWeight.w600,
                  color: IroriColors.textPrimary,
                ),
              ),
            ],
          ),
          const SizedBox(height: 16),
          // 原典: `flex gap-1 rounded-xl bg-muted/50 p-1` のセグメント。
          Container(
            padding: const EdgeInsets.all(4),
            decoration: BoxDecoration(
              color: IroriColors.muted.withValues(alpha: 0.5),
              borderRadius: BorderRadius.circular(IroriRadii.button),
            ),
            child: Row(
              children: [
                for (final (index, option) in _kPageOptions.indexed) ...[
                  if (index > 0) const SizedBox(width: 4),
                  Expanded(
                    child: _SegmentButton(
                      label: option.label,
                      active: _selected == option.value,
                      onTap: _pending ? null : () => _select(option.value),
                    ),
                  ),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// セグメント 1 個 (原典 `segmentCn` の active/inactive スタイル対応)。
class _SegmentButton extends StatelessWidget {
  const _SegmentButton({
    required this.label,
    required this.active,
    required this.onTap,
  });

  final String label;
  final bool active;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(8),
      child: Container(
        // 44px タッチターゲット (CLAUDE.md — 原典 py-2 より大きい)。
        constraints: const BoxConstraints(minHeight: 44),
        alignment: Alignment.center,
        decoration: BoxDecoration(
          // 原典: active = bg-primary text-primary-foreground。
          color: active ? IroriColors.primary : Colors.transparent,
          borderRadius: BorderRadius.circular(8),
        ),
        child: Text(
          label,
          style: TextStyle(
            fontSize: 14,
            fontWeight: FontWeight.w500,
            color: active ? Colors.white : IroriColors.textMuted,
          ),
        ),
      ),
    );
  }
}
