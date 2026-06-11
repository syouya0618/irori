import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../core/supabase/supabase_providers.dart';
import '../../../core/theme/colors.dart';
import '../../../widgets/glass_card.dart';
import '../data/settings_provider.dart';
import 'widgets/auto_stock_card.dart';
import 'widgets/baby_profile_card.dart';
import 'widgets/default_page_card.dart';
import 'widgets/profile_card.dart';

/// 設定タブ。Next.js 原典 `settings-content.tsx` (+ `settings/page.tsx`) の
/// Flutter 移植 **サブセット**。
///
/// 移植カード (P2.5-H スコープ):
/// プロフィール / 世帯表示 / 起動時のページ / 在庫自動追加 / 赤ちゃん情報 /
/// サインアウト。Invite / Approval / Theme / Export カードは deferred
/// (p25plan の deferred 欄参照)。
///
/// データ:
/// - profiles / households は **Realtime publication 非対象**のため、
///   `settingsProvider` (FutureProvider) を `AppShell` がタブ表示ごとに
///   invalidate して refetch する (realtime 前提で provider を設計すると
///   更新が永遠に届かない — p25plan risks)。
/// - 書き込みは各カード → `SettingsRepository`。
///
/// サインアウトは `auth.signOut()` (10s timeout 付き) のみ。web の SW
/// キャッシュ purge / localStorage 掃除 (`settings-content.tsx`
/// handleSignOut) は PWA 固有機構のため移植しない (意図的差異)。遷移は
/// `authNotifier` (`refreshListenable`) → router redirect が自動処理する。
class SettingsPage extends ConsumerWidget {
  const SettingsPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final settingsAsync = ref.watch(settingsProvider);

    return Scaffold(
      // web ヘッダー: h1「設定」。
      appBar: AppBar(title: const Text('設定')),
      body: SafeArea(
        child: settingsAsync.when(
          skipLoadingOnReload: true,
          data: (data) => _SettingsBody(data: data),
          loading: () => const Center(child: CircularProgressIndicator()),
          error: (error, _) => Center(
            child: Padding(
              padding: const EdgeInsets.all(24),
              child: _ErrorView(error: error),
            ),
          ),
        ),
      ),
    );
  }
}

/// data 分岐の本体。カードの並びは web `settings-content.tsx` と同一
/// (deferred カードを除く)。
class _SettingsBody extends StatelessWidget {
  const _SettingsBody({required this.data});

  final SettingsData data;

  @override
  Widget build(BuildContext context) {
    final settings = data.settings;
    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 32),
      children: [
        ProfileCard(displayName: settings.displayName, email: data.email),
        const SizedBox(height: 16),
        _HouseholdCard(name: settings.householdName, role: settings.role),
        const SizedBox(height: 16),
        DefaultPageCard(initialPage: settings.defaultPage),
        const SizedBox(height: 16),
        AutoStockCategoriesCard(
          initialCategories: settings.autoStockCategories,
        ),
        const SizedBox(height: 16),
        BabyProfileCard(
          initialName: settings.babyName,
          initialBirthDate: settings.babyBirthDate,
        ),
        const SizedBox(height: 16),
        // web: <Separator /> → ログアウト。
        const Divider(height: 1, color: IroriColors.border),
        const SizedBox(height: 16),
        const _SignOutButton(),
      ],
    );
  }
}

/// 世帯情報の表示カード (web `settings-content.tsx` のインライン Card 部)。
class _HouseholdCard extends StatelessWidget {
  const _HouseholdCard({required this.name, required this.role});

  final String? name;
  final String role;

  @override
  Widget build(BuildContext context) {
    final householdName = name;
    return GlassCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Row(
            children: [
              // web: <Home size={18} /> 世帯
              Icon(LucideIcons.home, size: 18, color: IroriColors.textPrimary),
              SizedBox(width: 8),
              Text(
                '世帯',
                style: TextStyle(
                  fontSize: 16,
                  fontWeight: FontWeight.w600,
                  color: IroriColors.textPrimary,
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          Text(
            // web: `household?.name || "世帯名未設定"` (falsy = null / 空文字)。
            (householdName == null || householdName.isEmpty)
                ? '世帯名未設定'
                : householdName,
            style: const TextStyle(
              fontSize: 14,
              fontWeight: FontWeight.w500,
              color: IroriColors.textPrimary,
            ),
          ),
          const SizedBox(height: 2),
          Text(
            'あなたの役割: ${_roleLabel(role)}',
            style: const TextStyle(
              fontSize: 12,
              color: IroriColors.textMuted,
            ),
          ),
        ],
      ),
    );
  }
}

/// web `roleLabels` (owner/member/viewer) の対応。未知値は raw のまま表示する
/// (tolerant — schema drift で画面を壊さない)。
String _roleLabel(String role) {
  switch (role) {
    case 'owner':
      return 'オーナー';
    case 'member':
      return 'メンバー';
    case 'viewer':
      return '閲覧者';
    default:
      return role;
  }
}

/// ログアウトボタン (web `settings-content.tsx` の handleSignOut 対応)。
///
/// web 固有の SW purge / localStorage 掃除は移植しない (クラス doc 参照)。
/// Flutter 追加の防御: `DefaultPageCache` を破棄してから signOut する
/// (端末共用時に他ユーザーの default_page で /login redirect しないため)。
class _SignOutButton extends ConsumerStatefulWidget {
  const _SignOutButton();

  @override
  ConsumerState<_SignOutButton> createState() => _SignOutButtonState();
}

class _SignOutButtonState extends ConsumerState<_SignOutButton> {
  bool _pending = false;

  Future<void> _signOut() async {
    if (_pending) return;

    final messenger = ScaffoldMessenger.of(context);
    // ref は await 後に widget が破棄されると使えないため、先に解決しておく。
    final cache = ref.read(defaultPageCacheProvider);
    final auth = ref.read(supabaseClientProvider).auth;
    setState(() => _pending = true);

    try {
      // signOut より前に破棄する (web が purge を signOut より前に行うのと
      // 同じ理由 — 後続処理の実行保証がないため)。失敗しても次回 fetch で
      // 再度温まるだけで安全側。
      cache.value = null;
      // CLAUDE.md「外部 API 呼び出しにはタイムアウト設定必須」
      // (login_page の signInWithOtp と同じ 10s)。
      await auth.signOut().timeout(const Duration(seconds: 10));
      // 画面遷移はしない: authNotifier (refreshListenable) の signedOut 通知で
      // router redirect が /login へ送る。
    } on Object catch (e, st) {
      // 握り潰さない (CLAUDE.md)。web は server action redirect のため
      // エラー表示が無いが、Flutter は表面化させる (意図的差異)。
      debugPrint('SettingsPage signOut 失敗: $e\n$st');
      if (!mounted) return;
      messenger.showSnackBar(
        const SnackBar(content: Text('ログアウトに失敗しました')),
      );
    } finally {
      if (mounted) setState(() => _pending = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    // web: variant ghost + text-destructive。
    return TextButton.icon(
      onPressed: _pending ? null : _signOut,
      icon: const Icon(LucideIcons.logOut, size: 16),
      label: const Text('ログアウト'),
      style: TextButton.styleFrom(
        foregroundColor: IroriColors.error,
        // 44px タッチターゲット (CLAUDE.md)。
        minimumSize: const Size(44, 44),
      ),
    );
  }
}

/// error 分岐。読み込み失敗の告知 + 再試行ボタン (stock `_ErrorView` と同形)。
class _ErrorView extends ConsumerWidget {
  const _ErrorView({required this.error});

  final Object error;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return GlassCard(
      padding: const EdgeInsets.all(24),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Icon(Icons.error_outline, color: IroriColors.error),
          const SizedBox(height: 12),
          Text(
            '設定の読み込みに失敗しました。',
            style: Theme.of(context).textTheme.bodyLarge,
          ),
          const SizedBox(height: 8),
          Text('$error', style: Theme.of(context).textTheme.bodySmall),
          const SizedBox(height: 16),
          FilledButton.tonal(
            onPressed: () => ref.invalidate(settingsProvider),
            style: FilledButton.styleFrom(minimumSize: const Size(44, 44)),
            child: const Text('再試行'),
          ),
        ],
      ),
    );
  }
}
