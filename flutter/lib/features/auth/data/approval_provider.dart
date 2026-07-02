import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import '../../../core/supabase/supabase_providers.dart';

/// Supabase 呼び出しに付与するタイムアウト
/// (CLAUDE.md「外部API呼び出しにはタイムアウト設定必須」)。
const _kQueryTimeout = Duration(seconds: 10);

/// `profiles.is_approved` の同期キャッシュ (GoRouter redirect の承認ゲート用 /
/// Issue #74)。
///
/// **web との差分 (キャッシュ方針 — Issue #74 の明記要求)**:
/// web 原典 `src/proxy.ts:57-93` はミドルウェアで **毎リクエスト** DB の
/// `is_approved` を検証する fail-closed 設計。Flutter の GoRouter redirect は
/// 同期評価を保つ設計 (`resolveLoginLandingPath` の doc / P2.5-H 裁定) のため、
/// redirect 内で DB を非同期取得できない。そこで:
///
/// - redirect は本キャッシュを **同期参照のみ** し、未取得 (null) は
///   「未承認」として扱う (fail-closed — 確認が取れるまで絶対に通さない)。
/// - 書き込みは [approvalStatusProvider] の fetch 完了時のみ。cold start では
///   承認済みユーザーも一度 `/pending-approval` (確認中スピナー) を経由して
///   から本来の目的地へ進む。
/// - **承認取り消しの検知は web より遅い**: web は次のリクエストで即検出するが、
///   Flutter はセッション中 true を保持し続ける (再ログイン / 再起動まで)。
///   現行 DB 関数に取り消し導線は無く (approve_user は承認のみ)、また RLS
///   (household 分離) がデータ層の防御を担うため、この遅延は許容する。
///
/// キャッシュは **userId キー付き** (単純な `bool?` にしない): 端末共用で
/// ユーザーが切り替わった場合、別ユーザーの参照は構造的に null (= fail-closed)
/// になり、サインアウト時の [clear] 漏れが承認状態の漏洩にならない。
class ApprovalCache {
  String? _userId;
  bool? _isApproved;

  /// [userId] の承認状態。未取得・別ユーザーのキャッシュは null (= 未承認扱い)。
  bool? isApprovedFor(String userId) => _userId == userId ? _isApproved : null;

  /// fetch 結果を反映する ([approvalStatusProvider] のみが呼ぶ)。
  void set({required String userId, required bool isApproved}) {
    _userId = userId;
    _isApproved = isApproved;
  }

  /// サインアウト時に破棄する (`DefaultPageCache` を null へ戻すのと同じ防御。
  /// userId キーにより漏れても安全側だが、前ユーザーの承認状態をメモリに
  /// 残さない defense-in-depth)。
  void clear() {
    _userId = null;
    _isApproved = null;
  }
}

/// [ApprovalCache] の DI provider。
///
/// root `ProviderContainer` と同寿命の mutable holder。router
/// (`appRouterProvider`) が redirect 評価時に `ref.read` で同期参照する
/// (`defaultPageCacheProvider` と同じ構成)。
final approvalCacheProvider = Provider<ApprovalCache>((ref) {
  return ApprovalCache();
});

/// 現在ユーザーの `profiles.is_approved` を取得する FutureProvider
/// (web `src/proxy.ts:60-73` の承認チェック部の移植)。
///
/// fail-closed 方針 (web 忠実):
/// - 行なし (profile 未作成) → false (web の `profile?.is_approved ?? false`)
/// - 取得失敗 (PostgrestException / timeout 等) → 構造化ログの上で false。
///   握り潰しではない — 「通さない」ことが安全側であり、/pending-approval の
///   「承認状態を確認」ボタンが retry 導線を兼ねる (web も logSupabaseError 後
///   未承認扱いで pending へ送る)。
/// - 未認証は `StateError` (呼び出し側は authed 前提 — `settingsProvider` と同形)。
///
/// auth-reactivity は `settingsProvider` と同じ流儀: user id の変化のみを watch
/// (tokenRefreshed の周期発火で再取得しない)、値は `client.auth.currentUser` を
/// 直読する (startup null-window 回避)。
///
/// fetch 成功 (および fail-closed の false 縮退) は [ApprovalCache] へ反映する。
/// fetch 中にサインアウト / ユーザー切替が起きた場合は書き戻さない —
/// 遅れて完了した fetch が現ユーザーのキャッシュを別ユーザーの値で上書きする
/// stale-write レースを塞ぐ (`settingsProvider` と同じ防御)。
final approvalStatusProvider = FutureProvider<bool>((ref) async {
  final client = ref.watch(supabaseClientProvider);
  // login / logout で recompute させるため user id の変化のみを watch する。
  ref.watch(authStateChangeProvider.select((s) => s.value?.session?.user.id));
  final user = client.auth.currentUser;
  if (user == null) {
    throw StateError('approvalStatusProvider: 未認証状態で承認状態を要求した');
  }

  bool isApproved;
  try {
    final row = await client
        .from('profiles')
        .select('is_approved')
        .eq('id', user.id)
        .maybeSingle()
        .timeout(_kQueryTimeout);
    isApproved = (row?['is_approved'] as bool?) ?? false;
  } on Object catch (e, st) {
    // fail-closed (web proxy.ts:66-73 parity): 失敗は log して未承認へ倒す。
    if (e is PostgrestException) {
      debugPrint(
        'approvalStatusProvider PostgrestException: '
        'code=${e.code} message=${e.message} '
        'details=${e.details} hint=${e.hint}',
      );
    } else {
      debugPrint('approvalStatusProvider error: $e\n$st');
    }
    isApproved = false;
  }

  if (client.auth.currentUser?.id == user.id) {
    ref
        .read(approvalCacheProvider)
        .set(userId: user.id, isApproved: isApproved);
  }
  return isApproved;
});
