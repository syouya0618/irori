import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import '../../../core/supabase/supabase_providers.dart';
import '../../../core/theme/colors.dart';
import '../../../core/theme/radii.dart';
import '../../../widgets/glass_card.dart';

/// 招待リンク受諾ページ
/// (Issue #48 / 元 `src/app/(auth)/invite/[token]/page.tsx` + `actions.ts`)。
///
/// フロー (元 Next.js page.tsx と同じ分岐優先順):
/// 1. profiles を取得し、`household_id` があれば「すでに所属」エラー
/// 2. `get_invitation_by_token(invite_token)` で招待検証
///    - 行が無い → 無効な招待
///    - `expires_at < now` → 期限切れ
///    - `status != pending` → 使用済み
/// 3. 上記いずれにも該当しなければ承認ボタン (世帯名 + ロール) を表示
/// 4. 承認ボタン → `accept_invitation(invitation_uuid)` を実行
///    - 成功 → 遷移 (`onAccepted` / default `context.go('/baby')`)
///    - 失敗 → エラーメッセージを SnackBar / card に表示し画面に留まる
///
/// `token` / `userId` はコンストラクタ引数。GoRouter path param / 認証ユーザーの
/// 取り出しは親の router wiring 側で行う (constraint #1: router.dart 非編集)。
///
/// E2E (実 invitation レコード + RLS バイパス RPC) は実 Supabase 接続が必要なため
/// worktree では検証不能。本 widget test は mock 注入で
/// 「RPC が正しい引数で呼ばれ、4 分岐 + 承認の UI が出る」ところまで検証する。
class InvitePage extends ConsumerStatefulWidget {
  const InvitePage({
    required this.token,
    required this.userId,
    this.onAccepted,
    super.key,
  });

  /// 招待トークン (`/invite/:token`)。secret ゆえログには含めない。
  final String token;

  /// 認証済みユーザー ID (profiles 検索用)。
  final String userId;

  /// 承認成功後の遷移先コールバック (テスト注入用)。null なら `context.go('/baby')`。
  final void Function(String destination)? onAccepted;

  @override
  ConsumerState<InvitePage> createState() => _InvitePageState();
}

enum _InviteStatus { loading, ready, alreadyBelongs, notFound, expired, used }

class _InvitePageState extends ConsumerState<InvitePage> {
  _InviteStatus _status = _InviteStatus.loading;
  String? _invitationId;
  String? _householdName;
  String? _role;
  bool _accepting = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _load());
  }

  Future<void> _load() async {
    final client = ref.read(supabaseClientProvider);

    // 1. profiles 取得 — 既に世帯所属かを判定。
    //    profile 取得失敗は元 Next.js 同様ログのみ (所属なし扱いで続行)。
    String? householdId;
    try {
      final profile = await client
          .from('profiles')
          .select('household_id')
          .eq('id', widget.userId)
          .single()
          .timeout(const Duration(seconds: 10));
      final value = profile['household_id'];
      householdId = value is String ? value : null;
    } on PostgrestException catch (e) {
      // token は secret ゆえログに含めない (userId のみ)。
      debugPrint(
        'InvitePage.profiles lookup PostgrestException: '
        'message=${e.message}, code=${e.code}, details=${e.details}, '
        'hint=${e.hint}, userId=${widget.userId}',
      );
    } on Object catch (e, stack) {
      debugPrint('InvitePage.profiles lookup error: $e\n$stack');
    }

    if (householdId != null) {
      _setStatus(_InviteStatus.alreadyBelongs);
      return;
    }

    // 2. 招待を token で検証。
    List<dynamic> rows;
    try {
      final result = await client
          .rpc<dynamic>(
            'get_invitation_by_token',
            params: {'invite_token': widget.token},
          )
          .timeout(const Duration(seconds: 10));
      rows = result is List ? result : const [];
    } on PostgrestException catch (e) {
      debugPrint(
        'InvitePage.get_invitation_by_token PostgrestException: '
        'message=${e.message}, code=${e.code}, details=${e.details}, '
        'hint=${e.hint}, userId=${widget.userId}',
      );
      _setStatus(_InviteStatus.notFound);
      return;
    } on Object catch (e, stack) {
      debugPrint('InvitePage.get_invitation_by_token error: $e\n$stack');
      _setStatus(_InviteStatus.notFound);
      return;
    }

    if (rows.isEmpty) {
      _setStatus(_InviteStatus.notFound);
      return;
    }

    final invitation = rows.first as Map<String, dynamic>;
    final expiresAtRaw = invitation['expires_at'];
    // TIMESTAMPTZ は ISO8601 文字列。`DateTime.parse` で UTC offset を尊重し
    // 比較する (`DateTime('YYYY-MM-DD')` の UTC 罠を避ける — 完了前チェックリスト #10)。
    final expiresAt = expiresAtRaw is String
        ? DateTime.tryParse(expiresAtRaw)
        : null;

    if (expiresAt != null && expiresAt.isBefore(DateTime.now())) {
      _setStatus(_InviteStatus.expired);
      return;
    }

    if (invitation['status'] != 'pending') {
      _setStatus(_InviteStatus.used);
      return;
    }

    if (!mounted) return;
    setState(() {
      _status = _InviteStatus.ready;
      _invitationId = invitation['id'] as String?;
      _householdName = invitation['household_name'] as String?;
      _role = invitation['role'] as String?;
    });
  }

  void _setStatus(_InviteStatus status) {
    if (!mounted) return;
    setState(() => _status = status);
  }

  Future<void> _accept() async {
    final invitationId = _invitationId;
    if (invitationId == null || _accepting) return;

    setState(() => _accepting = true);
    final client = ref.read(supabaseClientProvider);
    try {
      await client
          .rpc<dynamic>(
            'accept_invitation',
            params: {'invitation_uuid': invitationId},
          )
          .timeout(const Duration(seconds: 10));
      _onAccepted('/baby');
    } on PostgrestException catch (e) {
      debugPrint(
        'InvitePage.accept_invitation PostgrestException: '
        'message=${e.message}, code=${e.code}, details=${e.details}, '
        'hint=${e.hint}, userId=${widget.userId}',
      );
      _onAcceptError(_acceptErrorMessage(e.message));
    } on Object catch (e, stack) {
      debugPrint('InvitePage.accept_invitation error: $e\n$stack');
      _onAcceptError('世帯への参加に失敗しました。もう一度お試しください。');
    }
  }

  /// DB 関数が `RAISE EXCEPTION` する英語メッセージを日本語に対応付け
  /// (元 `actions.ts` の分岐と同じ)。
  String _acceptErrorMessage(String message) {
    if (message.contains('already belongs')) {
      return 'すでに世帯に参加しています。';
    }
    if (message.contains('not pending')) {
      return 'この招待は無効です。';
    }
    if (message.contains('expired')) {
      return '招待の有効期限が切れています。';
    }
    if (message.contains('not found')) {
      return 'この招待は無効です。';
    }
    return '世帯への参加に失敗しました。もう一度お試しください。';
  }

  void _onAccepted(String destination) {
    if (!mounted) return;
    final onAccepted = widget.onAccepted;
    if (onAccepted != null) {
      onAccepted(destination);
    } else {
      context.go(destination);
    }
  }

  void _onAcceptError(String message) {
    if (!mounted) return;
    setState(() => _accepting = false);
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(message)),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 420),
              child: _buildContent(context),
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildContent(BuildContext context) {
    switch (_status) {
      case _InviteStatus.loading:
        return const Padding(
          padding: EdgeInsets.all(32),
          child: Center(child: CircularProgressIndicator()),
        );
      case _InviteStatus.alreadyBelongs:
        return const _InviteError(
          title: 'すでに世帯に参加しています',
          description: '現在の世帯を退出してから、新しい招待を受けてください。',
        );
      case _InviteStatus.notFound:
        return const _InviteError(
          title: '無効な招待リンク',
          description: 'この招待リンクは無効です。正しいリンクを確認してください。',
        );
      case _InviteStatus.expired:
        return const _InviteError(
          title: '招待の有効期限切れ',
          description:
              'この招待リンクの有効期限が切れています。'
              '招待者に新しいリンクを発行してもらってください。',
        );
      case _InviteStatus.used:
        return const _InviteError(
          title: 'この招待は使用済みです',
          description: 'この招待リンクはすでに使用されています。',
        );
      case _InviteStatus.ready:
        return _InviteAccept(
          householdName: _householdName ?? '不明な世帯',
          roleLabel: _roleLabel(_role),
          isLoading: _accepting,
          onAccept: _accept,
        );
    }
  }
}

String _roleLabel(String? role) {
  switch (role) {
    case 'owner':
      return 'オーナー';
    case 'viewer':
      return '閲覧者';
    case 'member':
    default:
      return 'メンバー';
  }
}

class _InviteError extends StatelessWidget {
  const _InviteError({required this.title, required this.description});

  final String title;
  final String description;

  @override
  Widget build(BuildContext context) {
    return GlassCard(
      padding: const EdgeInsets.all(24),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Icon(
            LucideIcons.circleAlert,
            size: 32,
            color: IroriColors.warning,
          ),
          const SizedBox(height: 16),
          Text(
            title,
            style: Theme.of(context).textTheme.titleLarge,
            textAlign: TextAlign.center,
          ),
          const SizedBox(height: 8),
          Text(
            description,
            style: Theme.of(context).textTheme.bodyMedium,
            textAlign: TextAlign.center,
          ),
        ],
      ),
    );
  }
}

class _InviteAccept extends StatelessWidget {
  const _InviteAccept({
    required this.householdName,
    required this.roleLabel,
    required this.isLoading,
    required this.onAccept,
  });

  final String householdName;
  final String roleLabel;
  final bool isLoading;
  final Future<void> Function() onAccept;

  @override
  Widget build(BuildContext context) {
    return GlassCard(
      padding: const EdgeInsets.all(24),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: 48,
            height: 48,
            decoration: BoxDecoration(
              color: IroriColors.primary.withValues(alpha: 0.1),
              shape: BoxShape.circle,
            ),
            child: const Icon(
              LucideIcons.users,
              size: 24,
              color: IroriColors.primary,
            ),
          ),
          const SizedBox(height: 16),
          Text(
            '世帯への招待',
            style: Theme.of(context).textTheme.titleLarge,
            textAlign: TextAlign.center,
          ),
          const SizedBox(height: 8),
          Text(
            '以下の世帯に招待されています',
            style: Theme.of(context).textTheme.bodyMedium,
            textAlign: TextAlign.center,
          ),
          const SizedBox(height: 16),
          Container(
            width: double.infinity,
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
            decoration: BoxDecoration(
              color: IroriColors.primary.withValues(alpha: 0.06),
              borderRadius: BorderRadius.circular(IroriRadii.button),
            ),
            child: Column(
              children: [
                Text(
                  householdName,
                  style: Theme.of(context).textTheme.titleLarge,
                  textAlign: TextAlign.center,
                ),
                const SizedBox(height: 2),
                Text(
                  '$roleLabelとして参加',
                  style: Theme.of(context).textTheme.bodySmall,
                  textAlign: TextAlign.center,
                ),
              ],
            ),
          ),
          const SizedBox(height: 24),
          SizedBox(
            width: double.infinity,
            child: FilledButton(
              onPressed: isLoading ? null : onAccept,
              style: FilledButton.styleFrom(
                minimumSize: const Size.fromHeight(48),
              ),
              child: isLoading
                  ? const SizedBox(
                      width: 20,
                      height: 20,
                      child: CircularProgressIndicator(
                        strokeWidth: 2,
                        color: Colors.white,
                      ),
                    )
                  : const Text('参加する'),
            ),
          ),
        ],
      ),
    );
  }
}
