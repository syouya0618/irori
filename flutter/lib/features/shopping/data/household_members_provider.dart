import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import '../../../core/supabase/supabase_providers.dart';

/// `Supabase` 呼び出し用タイムアウト (CLAUDE.md「外部API はタイムアウト必須」)。
const _kQueryTimeout = Duration(seconds: 10);

/// 世帯メンバー 1 人分 (チェック者名表示用の最小形)。
///
/// web `shopping/page.tsx` の `MemberInfo` (`{ id, display_name }`) に相当。
typedef HouseholdMember = ({String id, String displayName});

/// 世帯メンバー一覧 (チェック者の表示名用)。
///
/// web `shopping/page.tsx` の members select と同じ
/// `profiles.select("id, display_name").eq("household_id", householdId)`。
/// F4 の UI がチェック済みアイテムの「✓ <名前>」表示
/// (`memberMap.get(checked_by)`) に使う。
///
/// - 世帯未参加 (householdId == null) は空リスト (web は page 全体が
///   null return だが、provider 単位では「メンバー 0 人」が自然な縮退)。
/// - `display_name` は DB 上 NOT NULL (`database.ts` Row: `string`) だが、
///   外部 API レスポンスゆえ null 混入に防御し空文字へ倒す (CLAUDE.md
///   「外部APIレスポンスの値は使用前に必ず検証」)。
/// - `PostgrestException` は構造化ログ + rethrow (握り潰さない)。
final householdMembersProvider = FutureProvider<List<HouseholdMember>>((
  ref,
) async {
  final client = ref.watch(supabaseClientProvider);
  final householdId = await ref.watch(currentHouseholdIdProvider.future);
  if (householdId == null) {
    return const [];
  }

  try {
    final rows = await client
        .from('profiles')
        .select('id, display_name')
        .eq('household_id', householdId)
        .timeout(_kQueryTimeout);
    return [
      for (final row in rows)
        (
          id: row['id'] as String,
          displayName: (row['display_name'] as String?) ?? '',
        ),
    ];
  } on PostgrestException catch (e) {
    debugPrint(
      'householdMembersProvider PostgrestException: '
      'code=${e.code} message=${e.message} '
      'details=${e.details} hint=${e.hint} householdId=$householdId',
    );
    rethrow;
  }
});
