import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../core/theme/colors.dart';

/// `StatefulShellRoute.indexedStack` の外殻。BottomNav のみを提供する。
///
/// Next.js 原典 `src/components/common/bottom-nav.tsx` の Flutter 移植。
/// タブ順は web に従う (献立 → 育児)。web の 5 タブのうち本シェルは
/// Phase 2 F2 時点で移植済みの 2 つだけを持つ:
/// - 買い物 (`ShoppingCart`) は F4、在庫 (`Package`) は F6 で追加する。
/// - 設定 (`Settings`) は将来の設定画面移植時に追加する。
///
/// AppBar は各ページが自前で持つ (baby との干渉を避けるため、本シェルは
/// `bottomNavigationBar` だけを差し込む)。タブ切替は `IndexedStack` により
/// 各ブランチの Navigator/スクロール位置を保持する。
class AppShell extends StatelessWidget {
  const AppShell({required this.shell, super.key});

  /// go_router が渡すブランチコンテナ。`currentIndex` / `goBranch` を持つ。
  final StatefulNavigationShell shell;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: shell,
      bottomNavigationBar: NavigationBar(
        backgroundColor: IroriColors.surface,
        surfaceTintColor: Colors.transparent,
        selectedIndex: shell.currentIndex,
        // 同一タブ再タップはブランチ初期 location へ戻す (go_router 公式の
        // 推奨パターン。web の BottomNav 再タップ ≒ ルートへ戻る挙動に対応)。
        onDestinationSelected: (i) =>
            shell.goBranch(i, initialLocation: i == shell.currentIndex),
        destinations: const [
          // web bottom-nav.tsx: { href: "/meals", label: "献立", icon: UtensilsCrossed }
          NavigationDestination(
            icon: Icon(LucideIcons.utensilsCrossed, size: 20),
            selectedIcon: Icon(
              LucideIcons.utensilsCrossed,
              size: 20,
              color: IroriColors.primary,
            ),
            label: '献立',
          ),
          // web bottom-nav.tsx: { href: "/baby", label: "育児", icon: Baby }
          NavigationDestination(
            icon: Icon(LucideIcons.baby, size: 20),
            selectedIcon: Icon(
              LucideIcons.baby,
              size: 20,
              color: IroriColors.primary,
            ),
            label: '育児',
          ),
        ],
      ),
    );
  }
}
