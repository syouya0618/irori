import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import '../../../core/supabase/supabase_providers.dart';
import '../../../core/theme/colors.dart';
import '../../../widgets/glass_card.dart';
import '../../settings/data/settings_provider.dart';

/// Supabase 呼び出しに付与するタイムアウト
/// (CLAUDE.md「外部API呼び出しにはタイムアウト設定必須」)。
const _kQueryTimeout = Duration(seconds: 10);

/// 世帯作成ページ (Issue #75 / 元 `src/app/setup/{page,setup-form,actions}.tsx`)。
///
/// フロー (web と同じ分岐優先順):
/// 1. mount で profiles を取得し、`household_id` があれば `/meals` へ退避
///    (web `page.tsx:29-31` の `redirect("/meals")`)。取得失敗は web 同様
///    log の上 form 表示へ縮退する (`page.tsx:23-27` — 作成試行時は DB 側の
///    「既所属なら拒否」ガードが最終防衛)。
/// 2. 世帯名 form を表示 (web `setup-form.tsx` の忠実移植)。trim 後空は
///    SnackBar で拒否 (web の `toast.error`)。
/// 3. 作成は **web と同一の** SECURITY DEFINER RPC `create_household`
///    (`p_name` 引数 / migration 20260603000001)。profiles の household_id /
///    role / is_approved は列権限で直接書込不可のため、世帯 INSERT + owner
///    付与 + 自動承認をこの RPC がアトミックに行う (web `actions.ts:18-22`)。
/// 4. 成功 → 世帯参加前に null を保持した provider
///    (`currentHouseholdIdProvider` / `settingsProvider`) を invalidate して
///    `/meals` へ遷移 (web `actions.ts:34-35` の revalidatePath + redirect 対応)。
///    失敗 → 構造化ログ + SnackBar (web と同一文言) で form に留まる。
///
/// 遷移設計 (Issue #74 との整合): `/setup` は保護 route。未認証 → `/login`、
/// 未承認 → `/pending-approval` は router redirect (承認ゲート) が先に処理する
/// ため、本ページ到達時は認証済み + 承認済みが保証される。
///
/// `userId` はコンストラクタ引数。認証ユーザーの取り出しは router wiring 側で
/// 行う (`InvitePage` と同じ流儀)。
///
/// E2E (実 create_household + RLS) は実 Supabase 接続が必要なため worktree
/// では検証不能。widget test は fake 注入で「RPC が正しい引数で呼ばれ、
/// 分岐 UI と遷移先が決まる」ところまで検証する。
class SetupPage extends ConsumerStatefulWidget {
  const SetupPage({required this.userId, this.onComplete, super.key});

  /// 認証済みユーザー ID (profiles 検索用)。
  final String userId;

  /// 遷移先を受け取るコールバック (テスト注入用)。
  /// null なら `context.go` (`InvitePage.onAccepted` と同じ流儀)。
  final void Function(String destination)? onComplete;

  @override
  ConsumerState<SetupPage> createState() => _SetupPageState();
}

class _SetupPageState extends ConsumerState<SetupPage> {
  final _nameController = TextEditingController();

  /// 既存所属チェック (mount 時) の完了前は form を出さない
  /// (web は server component ゆえチェック完了までページ自体が出ない)。
  bool _checking = true;
  bool _creating = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback(
      (_) => _checkExistingHousehold(),
    );
  }

  @override
  void dispose() {
    _nameController.dispose();
    super.dispose();
  }

  /// 既に世帯所属なら `/meals` へ退避する (web `setup/page.tsx:17-31`)。
  Future<void> _checkExistingHousehold() async {
    final client = ref.read(supabaseClientProvider);
    String? householdId;
    try {
      final profile = await client
          .from('profiles')
          .select('household_id')
          .eq('id', widget.userId)
          .single()
          .timeout(_kQueryTimeout);
      final value = profile['household_id'];
      householdId = value is String ? value : null;
    } on PostgrestException catch (e) {
      // web parity (`page.tsx:23-27`): logSupabaseError の上、profile null の
      // まま form を描画する (作成試行時は DB 側ガードが最終防衛)。
      debugPrint(
        'SetupPage.profiles lookup PostgrestException: '
        'code=${e.code} message=${e.message} '
        'details=${e.details} hint=${e.hint} userId=${widget.userId}',
      );
    } on Object catch (e, st) {
      debugPrint('SetupPage.profiles lookup error: $e\n$st');
    }

    if (!mounted) return;
    if (householdId != null) {
      // web `redirect("/meals")`。
      _complete('/meals');
      return;
    }
    setState(() => _checking = false);
  }

  Future<void> _submit() async {
    if (_creating) return;

    final trimmed = _nameController.text.trim();
    if (trimmed.isEmpty) {
      // web `setup-form.tsx:19-22`: toast.error("世帯名を入力してください")。
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('世帯名を入力してください')),
      );
      return;
    }

    final client = ref.read(supabaseClientProvider);
    setState(() => _creating = true);

    try {
      // web `actions.ts:22` と同一の RPC / 引数名 (trim 済みの名前を渡す)。
      await client
          .rpc<dynamic>('create_household', params: {'p_name': trimmed})
          .timeout(_kQueryTimeout);
    } on PostgrestException catch (e) {
      // 握り潰さない (CLAUDE.md)。user-facing は web と同じ一律文言へ丸める。
      debugPrint(
        'SetupPage.create_household PostgrestException: '
        'code=${e.code} message=${e.message} '
        'details=${e.details} hint=${e.hint} userId=${widget.userId}',
      );
      _onCreateError();
      return;
    } on Object catch (e, st) {
      // timeout / ネットワーク等。詳細を握り潰さずログ。
      debugPrint('SetupPage.create_household error: $e\n$st');
      _onCreateError();
      return;
    }

    // Riverpod 正準順序 (PR #67/#71): async gap 後は mounted ガードが先、
    // ref.invalidate が後。
    if (!mounted) return;
    // 世帯参加前に評価済みの provider は household_id=null を保持している。
    // 破棄しないと /meals 以降が「世帯なし」の stale 値のままになる
    // (web `actions.ts:34` の revalidatePath("/meals") 対応)。
    ref.invalidate(currentHouseholdIdProvider);
    // settings は世帯未参加時 HouseholdRequiredError を保持しているため
    // こちらも破棄する (settings 経由で誘導されたユーザーの復帰経路)。
    ref.invalidate(settingsProvider);
    // web `actions.ts:35` の redirect("/meals")。
    _complete('/meals');
  }

  void _onCreateError() {
    if (!mounted) return;
    setState(() => _creating = false);
    // web `actions.ts:31` と同一文言 (詳細は log 済み)。
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('世帯の作成に失敗しました。もう一度お試しください。')),
    );
  }

  void _complete(String destination) {
    if (!mounted) return;
    final onComplete = widget.onComplete;
    if (onComplete != null) {
      onComplete(destination);
    } else {
      context.go(destination);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: _checking
              ? const CircularProgressIndicator()
              : SingleChildScrollView(
                  // web `page.tsx`: flex min-h-dvh items-center justify-center
                  //                 px-4 + max-w-sm。
                  padding: const EdgeInsets.all(16),
                  child: ConstrainedBox(
                    constraints: const BoxConstraints(maxWidth: 384),
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        // web: h1 text-2xl font-bold「世帯をつくる」。
                        Text(
                          '世帯をつくる',
                          style: TextStyle(
                            fontSize: 24,
                            fontWeight: FontWeight.w700,
                            color: context.colors.textPrimary,
                          ),
                        ),
                        const SizedBox(height: 4),
                        // web: p text-sm muted「まずは世帯名を決めましょう」。
                        Text(
                          'まずは世帯名を決めましょう',
                          style: TextStyle(
                            fontSize: 14,
                            color: context.colors.textMuted,
                          ),
                        ),
                        const SizedBox(height: 32),
                        _SetupForm(
                          nameController: _nameController,
                          isLoading: _creating,
                          onSubmit: _submit,
                        ),
                      ],
                    ),
                  ),
                ),
        ),
      ),
    );
  }
}

/// 世帯名 form のカード本体 (web `setup-form.tsx:36-75` の忠実移植)。
class _SetupForm extends StatelessWidget {
  const _SetupForm({
    required this.nameController,
    required this.isLoading,
    required this.onSubmit,
  });

  final TextEditingController nameController;
  final bool isLoading;
  final Future<void> Function() onSubmit;

  @override
  Widget build(BuildContext context) {
    return GlassCard(
      padding: const EdgeInsets.all(24),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          // web: size-12 rounded-full bg-primary/10 + Home size-6 primary。
          Container(
            width: 48,
            height: 48,
            decoration: BoxDecoration(
              color: IroriColors.primary.withValues(alpha: 0.1),
              shape: BoxShape.circle,
            ),
            alignment: Alignment.center,
            child: const Icon(
              LucideIcons.home,
              size: 24,
              color: IroriColors.primary,
            ),
          ),
          const SizedBox(height: 16),
          TextFormField(
            controller: nameController,
            enabled: !isLoading,
            decoration: const InputDecoration(
              // web: Label「世帯名」/ placeholder「例: 田中家」/
              //      helper「あとから変更できます」(text-xs muted)。
              labelText: '世帯名',
              hintText: '例: 田中家',
              helperText: 'あとから変更できます',
            ),
            onFieldSubmitted: (_) {
              if (!isLoading) onSubmit();
            },
          ),
          const SizedBox(height: 20),
          SizedBox(
            width: double.infinity,
            child: FilledButton(
              onPressed: isLoading ? null : onSubmit,
              style: FilledButton.styleFrom(
                // 44px タッチターゲット (web: min-h-11)。
                minimumSize: const Size.fromHeight(44),
              ),
              child: isLoading
                  ? const Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        SizedBox(
                          width: 16,
                          height: 16,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        ),
                        SizedBox(width: 8),
                        // web: <Loader2 spin /> 作成中...
                        Text('作成中...'),
                      ],
                    )
                  : const Text('世帯を作成する'),
            ),
          ),
        ],
      ),
    );
  }
}
