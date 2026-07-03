import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import '../../../core/supabase/supabase_providers.dart';

/// 全 Supabase 呼び出しに付与するタイムアウト。
/// CLAUDE.md「外部API呼び出しにはタイムアウト設定必須」。
const _kQueryTimeout = Duration(seconds: 10);

/// 起動タブとして有効な page 値。
///
/// 正は web `src/lib/constants/pages.ts` の `VALID_PAGES`
/// (`["meals", "shopping", "stock", "baby"]`) + DB CHECK 制約
/// `profiles.chk_default_page` (migration 20260411000001) — 両者と同一。
const kValidDefaultPages = ['meals', 'shopping', 'stock', 'baby'];

/// 在庫自動追加の有効カテゴリ (web `settings/actions.ts` の
/// `VALID_STOCK_CATEGORIES` と同一)。DB 側 CHECK
/// (`chk_auto_stock_categories`) は「JSONB 配列であること」しか検証しない
/// ため、値 whitelist はアプリ層 (= 本リポジトリ) が正となる。
const kValidAutoStockCategories = [
  'baby',
  'cleaning',
  'hygiene',
  'other_daily',
];

/// `auto_stock_categories` が null / 破損時の既定値
/// (web `settings/page.tsx` の `?? ["baby", "cleaning", "hygiene"]` と同一。
/// DB DEFAULT '["baby","cleaning","hygiene"]' とも一致)。
const kDefaultAutoStockCategories = ['baby', 'cleaning', 'hygiene'];

/// 設定画面の read バンドル。
///
/// web `settings/page.tsx` が server component で組み立てる
/// profiles (display_name, role, default_page) + households
/// (name, auto_stock_categories, baby_name, baby_birth_date) に対応する。
/// profiles / households とも Realtime publication 非対象のため
/// (migrations grep 検証済み)、realtime モデルではなく fetch 専用の
/// 平易な immutable クラスとする。
@immutable
class HouseholdSettings {
  const HouseholdSettings({
    required this.displayName,
    required this.role,
    required this.defaultPage,
    required this.householdId,
    required this.householdName,
    required this.autoStockCategories,
    required this.babyName,
    required this.babyBirthDate,
  });

  /// プロフィール表示名 (DB NOT NULL だが外部 API 由来ゆえ null は '' に防御)。
  final String displayName;

  /// 世帯内役割 (`household_role` ENUM: owner / member / viewer)。
  /// 表示ラベル変換は UI 層 (web `roleLabels` 対応) が担う。
  final String role;

  /// 起動タブ (web `profile.default_page ?? "meals"` と同じ null 防御済み)。
  final String defaultPage;

  /// 所属世帯 id (update の eq スコープに使う)。
  final String householdId;

  /// 世帯名。households 行の取得に失敗した場合は null
  /// (web は household エラーを log して null のまま描画する — 同一挙動)。
  final String? householdName;

  /// 在庫自動追加カテゴリ (DB 文字列のまま保持 — web が string[] で
  /// 扱う挙動の忠実移植。enum 化すると未知値が黙って書き換わり web と乖離する)。
  final List<String> autoStockCategories;

  final String? babyName;

  /// "YYYY-MM-DD"。DATE 列ゆえ通常素の YMD が返るが、ISO 形式にも防御する。
  final String? babyBirthDate;
}

/// 承認待ちユーザー 1 件 (web `approval-card.tsx` の `PendingUser` 型に対応)。
///
/// `get_pending_approvals` RPC (RETURNS TABLE id/display_name/email/created_at)
/// の 1 行。display_name / email は DB NOT NULL だが外部 API 由来ゆえ null を
/// '' へ防御する (web は `display_name || email` で表示するため空文字でも安全)。
@immutable
class PendingUser {
  const PendingUser({
    required this.id,
    required this.displayName,
    required this.email,
    required this.createdAt,
  });

  factory PendingUser.fromRow(Map<String, dynamic> row) {
    return PendingUser(
      id: (row['id'] as String?) ?? '',
      displayName: (row['display_name'] as String?) ?? '',
      email: (row['email'] as String?) ?? '',
      createdAt: (row['created_at'] as String?) ?? '',
    );
  }

  final String id;
  final String displayName;
  final String email;

  /// TIMESTAMPTZ ISO 文字列 (現状 UI では未表示だが web 型と対称に保持)。
  final String createdAt;
}

/// settings mutation に必要な認証コンテキスト
/// (`stockMutationContextProvider` と同形)。
typedef SettingsMutationContext = ({String householdId, String userId});

/// write 系 UI が使う最小コンテキスト。
///
/// Next.js 版 `getAuthContext()` と同じ役割。世帯未参加・未認証は握り潰さず
/// `StateError` に倒し、呼び出し側が user-facing error に変換する。
final settingsMutationContextProvider = FutureProvider<SettingsMutationContext>(
  (ref) async {
    final client = ref.watch(supabaseClientProvider);
    final householdId = await ref.watch(currentHouseholdIdProvider.future);
    if (householdId == null) {
      throw StateError('settingsMutationContextProvider: 世帯未参加状態で設定変更を要求した');
    }

    final user = client.auth.currentUser;
    if (user == null) {
      throw StateError('settingsMutationContextProvider: 未認証状態で設定変更を要求した');
    }

    return (householdId: householdId, userId: user.id);
  },
);

/// 世帯未参加 (profiles.household_id が null) を表す型付きエラー (Issue #75)。
///
/// web `settings/page.tsx:34-36` は同状態で `/setup` へ redirect する。
/// Flutter は本エラーを型で識別し、`SettingsPage` が `/setup` へ誘導する
/// (従来は `StateError` の行き止まり)。汎用のエラー表示 (再試行カード) と
/// 区別するため専用型にする。
///
/// `Exception` ではなく **`Error` を継承する** (従来の `StateError` と同じ側):
/// Riverpod 3 の `ProviderContainer.defaultRetry` は失敗した provider を
/// 自動リトライするが、`Error` (と ProviderException) は「リトライ無意味」
/// として除外される (riverpod-3.3.2 `provider_container.dart` の
/// `defaultRetry` 実装で確認)。世帯未参加は DB の決定的状態でありリトライで
/// 解消しないため、`Exception` にすると 200ms〜の指数バックオフで profiles
/// fetch が最大 10 回無駄撃ちされ、`settingsProvider.future` も retry 完了
/// まで解決しない。
class HouseholdRequiredError extends Error {
  HouseholdRequiredError();

  @override
  String toString() => 'HouseholdRequiredError: 世帯未参加 (setup 未完了) の設定要求';
}

/// `profiles` / `households` の設定列へのアクセスを担うリポジトリ。
///
/// Next.js 原典:
/// - read: `settings/page.tsx` (profiles → households の 2 段 fetch)
/// - write: `settings/actions.ts` (updateProfile / updateDefaultPage /
///   updateAutoStockCategories / updateBabyProfile)
///
/// **profiles の列 GRANT 制約** (supabase/migrations/
/// 20260603000001_security_hardening_rls.sql:74-75):
/// ```sql
/// REVOKE INSERT, UPDATE ON public.profiles FROM authenticated;
/// GRANT UPDATE (display_name, avatar_url, default_page) ON public.profiles TO authenticated;
/// ```
/// authenticated が UPDATE できる profiles 列は display_name / avatar_url /
/// default_page **のみ**。これ以外の列 (household_id / role / is_approved 等)
/// を update payload に含めると列権限違反 (42501) で死ぬ。本リポジトリの
/// update payload を拡張する際は必ずこの GRANT を確認すること。
///
/// エラー方針 (CLAUDE.md / `StockRepository` と同形):
/// - `PostgrestException` は plain object のため、code/message/details/hint を
///   構造化して `debugPrint` し、握り潰さず rethrow する。
/// - 入力検証エラーは `ArgumentError` (message は web action の文言と同一)。
class SettingsRepository {
  SettingsRepository(this._client);

  final SupabaseClient _client;

  /// 設定バンドルを取得する (web `settings/page.tsx` の fetch 部の移植)。
  ///
  /// - profiles select は web の
  ///   `id, display_name, avatar_url, household_id, role, default_page` から
  ///   Flutter サブセットで未使用の `id` / `avatar_url` を除いたもの
  ///   (意図的差異 — id は eq キーで既知、avatar 表示は移植対象外)。
  /// - `household_id` が null (世帯未参加) は [HouseholdRequiredError]。
  ///   web は `/setup` へ redirect する経路 (`settings/page.tsx:34-36`) —
  ///   Flutter は `SettingsPage` が本エラーを検知して `/setup` へ誘導する
  ///   (Issue #75。握り潰さない — 型で識別可能な明示的失敗)。
  /// - households 取得失敗は web 同様 **縮退** する (log した上で
  ///   householdName=null / 既定カテゴリ / baby null で描画を続ける —
  ///   `settings/page.tsx` が `logSupabaseError` 後に household=null のまま
  ///   render する挙動の忠実移植)。
  Future<HouseholdSettings> fetchSettings({required String userId}) async {
    final Map<String, dynamic> profile;
    try {
      profile = await _client
          .from('profiles')
          .select('display_name, role, default_page, household_id')
          .eq('id', userId)
          .single()
          .timeout(_kQueryTimeout);
    } on PostgrestException catch (e) {
      _logPostgrestError('fetchSettings(profiles)', e, 'userId=$userId');
      rethrow;
    }

    final householdId = profile['household_id'] as String?;
    if (householdId == null) {
      // 呼び出し側 (SettingsPage) が /setup へ誘導する (Issue #75 /
      // web settings/page.tsx:34-36 の redirect("/setup") 対応)。
      throw HouseholdRequiredError();
    }

    Map<String, dynamic>? household;
    try {
      household = await _client
          .from('households')
          .select('name, auto_stock_categories, baby_name, baby_birth_date')
          .eq('id', householdId)
          .single()
          .timeout(_kQueryTimeout);
    } on Object catch (e, st) {
      // web parity: households の取得失敗は fatal にせず縮退する
      // (握り潰しではない — 構造化ログした上で既定値描画に切り替える)。
      // PostgrestException に限定しない: web `settings/page.tsx`:38-48 は
      // **全失敗** で縮退する (supabase-js は throw せず error を返す) ため、
      // `.timeout` の TimeoutException / socket 例外でも profiles が取れて
      // いれば縮退表示できるよう catch を広げる。
      _logError('fetchSettings(households)', e, st, 'householdId=$householdId');
      household = null;
    }

    // DATE 列は素の "YYYY-MM-DD" が返るが、ISO 形式にも防御する
    // (stock の `expires_at?.split("T")[0]` と同じ流儀)。
    final rawBirthDate = household?['baby_birth_date'] as String?;
    return HouseholdSettings(
      displayName: (profile['display_name'] as String?) ?? '',
      // DB DEFAULT 'member' (initial_schema) と同じ安全側へ防御。
      role: (profile['role'] as String?) ?? 'member',
      // web: `profile.default_page ?? "meals"`。
      defaultPage: (profile['default_page'] as String?) ?? 'meals',
      householdId: householdId,
      householdName: household?['name'] as String?,
      autoStockCategories: _parseAutoStockCategories(
        household?['auto_stock_categories'],
      ),
      babyName: household?['baby_name'] as String?,
      babyBirthDate: rawBirthDate?.split('T').first,
    );
  }

  /// 表示名を更新する (web `updateProfile`)。
  ///
  /// trim 必須・空 reject (文言は web action と同一)。payload は
  /// `display_name` のみ — クラス doc の GRANT 制約
  /// (security_hardening_rls.sql:74-75) を参照のこと。
  /// web は素の update だが、Flutter 版は `.select('id').single()` の行数検証を
  /// 足す (CLAUDE.md「`.update()` は 0 行更新でも error: null」/
  /// `StockRepository.updateItem` と同形)。
  Future<void> updateDisplayName({
    required String userId,
    required String displayName,
  }) async {
    final trimmed = displayName.trim();
    if (trimmed.isEmpty) {
      throw ArgumentError.value(displayName, 'displayName', '表示名を入力してください');
    }

    try {
      await _client
          .from('profiles')
          .update({'display_name': trimmed})
          .eq('id', userId)
          .select('id')
          .single()
          .timeout(_kQueryTimeout);
    } on Object catch (e, st) {
      _logError('updateDisplayName', e, st, 'userId=$userId');
      rethrow;
    }
  }

  /// 起動タブを更新する (web `updateDefaultPage`)。
  ///
  /// [kValidDefaultPages] の whitelist 4 値のみ受理 (文言は web と同一)。
  Future<void> updateDefaultPage({
    required String userId,
    required String page,
  }) async {
    if (!kValidDefaultPages.contains(page)) {
      throw ArgumentError.value(page, 'page', '無効なページ指定です');
    }

    try {
      await _client
          .from('profiles')
          .update({'default_page': page})
          .eq('id', userId)
          .select('id')
          .single()
          .timeout(_kQueryTimeout);
    } on Object catch (e, st) {
      _logError('updateDefaultPage', e, st, 'userId=$userId');
      rethrow;
    }
  }

  /// 在庫自動追加カテゴリを更新する (web `updateAutoStockCategories`)。
  ///
  /// [kValidAutoStockCategories] の 4 値をリポジトリ層で再検証する
  /// (DB CHECK は「JSONB 配列であること」のみで値は見ない)。空リストは
  /// 「全カテゴリ OFF」の有効値 (web `every` は空配列で true)。
  Future<void> updateAutoStockCategories({
    required String householdId,
    required List<String> categories,
  }) async {
    final valid = categories.every(kValidAutoStockCategories.contains);
    if (!valid) {
      throw ArgumentError.value(
        categories,
        'categories',
        '無効なカテゴリが含まれています',
      );
    }

    try {
      await _client
          .from('households')
          .update({'auto_stock_categories': categories})
          .eq('id', householdId)
          .select('id')
          .single()
          .timeout(_kQueryTimeout);
    } on Object catch (e, st) {
      _logError(
        'updateAutoStockCategories',
        e,
        st,
        'householdId=$householdId',
      );
      rethrow;
    }
  }

  /// 赤ちゃん情報を更新する (web `updateBabyProfile`)。
  ///
  /// - 名前: trim して空なら null (web `babyName.trim() || null`)。
  /// - 生年月日: null / 空 (trim 後) は null。それ以外は **trim 前の値** を
  ///   `^\d{4}-\d{2}-\d{2}$` で検証する (web も未 trim 値を regex 検証する —
  ///   忠実移植。空白付き日付は不正扱い)。
  /// - DB CHECK `chk_baby_birth_date` (birth <= CURRENT_DATE) 違反は
  ///   `PostgrestException` で rethrow される。「赤ちゃん情報の更新に
  ///   失敗しました」への丸めは UI 層の責務 (web parity — web action も
  ///   DB エラーを一律この文言へ丸める)。
  Future<void> updateBabyProfile({
    required String householdId,
    required String babyName,
    String? babyBirthDate,
  }) async {
    String? birthValue;
    if (babyBirthDate != null && babyBirthDate.trim().isNotEmpty) {
      if (!_kYmdPattern.hasMatch(babyBirthDate)) {
        throw ArgumentError.value(
          babyBirthDate,
          'babyBirthDate',
          '生年月日の形式が不正です',
        );
      }
      birthValue = babyBirthDate;
    }

    final trimmedName = babyName.trim();
    try {
      await _client
          .from('households')
          .update({
            'baby_name': trimmedName.isEmpty ? null : trimmedName,
            'baby_birth_date': birthValue,
          })
          .eq('id', householdId)
          .select('id')
          .single()
          .timeout(_kQueryTimeout);
    } on Object catch (e, st) {
      _logError(
        'updateBabyProfile',
        e,
        st,
        'householdId=$householdId',
      );
      rethrow;
    }
  }

  /// 招待リンクを発行し、招待トークンを返す (web `generateInvite` action の移植)。
  ///
  /// web `settings/actions.ts:31-54` と同じく `invitations` へ直接 insert する
  /// (RPC ではない)。token は DB DEFAULT
  /// `encode(gen_random_bytes(32), 'hex')` (initial_schema:91) が生成し、
  /// `.select('token').single()` で受け取る (insert 1 行の行数検証を兼ねる)。
  /// 受け側 `get_invitation_by_token(invite_token)` (invite_page) はこの
  /// token 生値で照合するため、加工せずそのまま返す。
  ///
  /// - payload は web と同一 (`household_id` / `invited_by` / `role: 'member'`。
  ///   status / expires_at は DB DEFAULT: pending / now()+7日)。
  /// - token 欠損 (外部 API 由来の null / 空) は URL を壊すため `StateError`
  ///   (CLAUDE.md「外部APIレスポンスの値は使用前に必ず検証」)。
  /// - token は secret ゆえログへ含めない (invite_page と同じ流儀 —
  ///   [_logError] の context は householdId / userId のみ)。
  Future<String> createInvitation({
    required String householdId,
    required String userId,
  }) async {
    try {
      final row = await _client
          .from('invitations')
          .insert({
            'household_id': householdId,
            'invited_by': userId,
            'role': 'member',
          })
          .select('token')
          .single()
          .timeout(_kQueryTimeout);
      final token = row['token'] as String?;
      if (token == null || token.isEmpty) {
        throw StateError(
          'SettingsRepository.createInvitation: insert 応答に token が無い',
        );
      }
      return token;
    } on Object catch (e, st) {
      _logError(
        'createInvitation',
        e,
        st,
        'householdId=$householdId userId=$userId',
      );
      rethrow;
    }
  }

  /// 承認待ちユーザー一覧を取得する (web `settings/page.tsx` の owner-gated
  /// `get_pending_approvals` 呼び出しの移植)。
  ///
  /// RPC は SECURITY DEFINER で owner 以外には空を返す (migration
  /// 20260408000002) ため、ここでは role チェックを行わない (呼び出し側
  /// provider が owner 限定で評価する)。結果は web の `data ?? []` と同じく
  /// List 以外を空へ縮退する。
  Future<List<PendingUser>> fetchPendingApprovals() async {
    try {
      final result = await _client
          .rpc<dynamic>('get_pending_approvals')
          .timeout(_kQueryTimeout);
      final rows = result is List ? result : const <dynamic>[];
      return rows
          .whereType<Map<String, dynamic>>()
          .map(PendingUser.fromRow)
          .toList();
    } on Object catch (e, st) {
      _logError('fetchPendingApprovals', e, st, '');
      rethrow;
    }
  }

  /// 承認待ちユーザーを承認する (web `approveUser` action の移植)。
  ///
  /// RPC `approve_user` は owner 以外で 'Only owners can approve users' を
  /// RAISE する。web `approveUser` は `error.message.includes("Only owners")`
  /// を「承認権限がありません」へ写すため、同判定で [ArgumentError] (UI が
  /// `e.message` を snackbar 表示する user-facing message の carrier — 本 repo の
  /// validation エラーと同じ流儀) に変換する。それ以外の DB エラー
  /// ('User not found or already approved' 等) は rethrow し、UI 層が汎用文言
  /// 「承認に失敗しました」へ丸める (web parity)。
  Future<void> approveUser(String targetUserId) async {
    try {
      await _client
          .rpc<dynamic>(
            'approve_user',
            params: {'target_user_id': targetUserId},
          )
          .timeout(_kQueryTimeout);
    } on PostgrestException catch (e, st) {
      _logError('approveUser', e, st, 'targetUserId=$targetUserId');
      if (e.message.contains('Only owners')) {
        throw ArgumentError('承認権限がありません');
      }
      rethrow;
    } on Object catch (e, st) {
      _logError('approveUser', e, st, 'targetUserId=$targetUserId');
      rethrow;
    }
  }

  /// `auto_stock_categories` (JSONB) の tolerant パース。
  ///
  /// - null / 非配列 → 既定値 (web `?? [...]` + DB CHECK は配列保証のみ)
  /// - 配列内の非文字列は除外 (1 要素の破損で画面全体を倒さない —
  ///   `ItemCategory.fromDbValue` と同じ tolerant 流儀)
  /// - 値は DB 文字列のまま保持 (enum 化すると未知値が黙って
  ///   `other_daily` に書き換わり、次回保存時に web と挙動が乖離する)
  static List<String> _parseAutoStockCategories(Object? raw) {
    if (raw is! List) return kDefaultAutoStockCategories;
    return raw.whereType<String>().toList();
  }

  /// `PostgrestException` を握り潰さず構造化ログする (CLAUDE.md)。
  /// [context] は調査用の識別子 (userId / householdId — 機密ではない)。
  void _logPostgrestError(String op, PostgrestException e, String context) {
    debugPrint(
      'SettingsRepository.$op PostgrestException: '
      'code=${e.code} message=${e.message} '
      'details=${e.details} hint=${e.hint} $context',
    );
  }

  /// 任意の失敗を握り潰さずログする (read / write 共用)。
  /// `PostgrestException` は構造化、それ以外は raw + stack を出す。
  void _logError(
    String op,
    Object error,
    StackTrace stackTrace,
    String context,
  ) {
    if (error is PostgrestException) {
      _logPostgrestError(op, error, context);
      return;
    }
    debugPrint('SettingsRepository.$op error: $error\n$stackTrace $context');
  }
}

/// "YYYY-MM-DD" 形式 (web `<input type="date">` が submit する形 /
/// web `updateBabyProfile` の regex と同一)。
final _kYmdPattern = RegExp(r'^\d{4}-\d{2}-\d{2}$');

/// `SettingsRepository` の DI provider。
final settingsRepositoryProvider = Provider<SettingsRepository>((ref) {
  return SettingsRepository(ref.watch(supabaseClientProvider));
});
