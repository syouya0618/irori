/// 賞味期限・リアクションのスコア計算 (純関数)。
///
/// Next.js 原典 `src/lib/domain/scoring.ts` の 1:1 移植 (Phase 2.5 PR-A)。
library;

import 'dart:math' as math;

import '../../../features/meals/domain/meal.dart' show MealReaction;
import '../../utils/jst_date.dart';
import 'matching.dart';
import 'types.dart';

/// web `parseYmd` (`src/lib/utils/date-jst.ts`) と同一の厳密形式検証
/// (Issue #38)。
///
/// `jst_date.dart` の `daysBetweenYmd` は桁数チェック + `int.parse` のため、
/// `int.parse` が許容する前後空白 (`'9 '`)・符号 prefix (`'+123'`)・
/// 16進 prefix (`'0x10'`) をすり抜けて数値を返してしまう。web は regex
/// 不一致で null のため、`daysBetweenYmd` へ渡す前に同じ regex で弾く
/// (`jst_date.dart` 本体は正規形保証済みの呼び出し元があるため変えない)。
final _ymdPattern = RegExp(r'^\d{4}-\d{2}-\d{2}$');

/// 指定された [expiresAt] (YYYY-MM-DD) から、今日 (JST) までの日数差を返す。
/// 期限切れは負の値、当日は 0、未来は正の値。
/// [expiresAt] が null または不正な場合は null を返す。
///
/// タイムゾーン非依存: 端末 OS の TZ 設定によらず同じ結果になる
/// (原典は「サーバー(UTC)とクライアント(JST)で同じ結果」)。
///
/// 原典 `daysUntilExpiry` は `daysFromTodayJst` (= `daysBetweenYmd` の
/// パース失敗 null 経路) に委譲する。Dart 側は web `parseYmd` と同一の
/// `_ymdPattern` で事前検証して不一致を null に倒し (Issue #38)、さらに
/// `daysBetweenYmd` の throw 規約 (`ArgumentError` / `FormatException`) も
/// 捕捉して null へ倒す — `stock_expiry.dart` の `classifyExpiry` と同流儀。
int? daysUntilExpiry(String? expiresAt, DateTime today) {
  // 原典 `if (!expiresAt) return null` — null と空文字の両方を弾く。
  if (expiresAt == null || expiresAt.isEmpty) return null;
  // 原典 `parseYmd` の regex 検証 — 不一致は null (Issue #38)。
  if (!_ymdPattern.hasMatch(expiresAt)) return null;
  try {
    return daysBetweenYmd(formatJstDate(today), expiresAt);
  } on ArgumentError {
    // "YYYY-MM-DD" の桁構成でない (jst_date の形式検証)。
    // regex 事前検証後は理論上到達しないが、防御として残す。
    return null;
  } on FormatException {
    // 桁構成は合うが数値でない ("abcd-ef-gh" 等の int.parse 失敗)。
    // 同上 — regex 事前検証後は到達しないが、防御として残す。
    return null;
  }
}

/// 賞味期限ボーナスを計算する。
/// マッチした食材の中で、`expiryBonusThresholdDays` 以内の期限切れ間近食材が
/// 含まれていればボーナスを付与する (1 件ごとに加算、上限あり)。
/// 期限切れ (負の日数) も「使い切りたい」としてボーナス対象。
///
/// 原典 `calculateExpiryBonus`。原典は `Pick<ScoringConfig, ...>` で必要
/// 3 値のみ受けるが、Dart は構造的部分型が無いため [ScoringConfig] 全体を
/// 受ける (参照するのは expiryBonus* の 3 値のみ — 挙動同一)。
double calculateExpiryBonus(
  List<MatchedStockPair> matched,
  ScoringConfig config,
  DateTime today,
) {
  if (matched.isEmpty) return 0;

  var bonus = 0.0;
  for (final pair in matched) {
    final days = daysUntilExpiry(pair.stockItem.expiresAt, today);
    if (days == null) continue;
    if (days <= config.expiryBonusThresholdDays) {
      bonus += config.expiryBonusPerItem;
    }
  }

  return math.min(bonus, config.expiryBonusMax);
}

/// 過去リアクション履歴からスコア補正を計算する。
/// good → 加点、bad → 減点、ok → 無視。
///
/// 原典 `calculateReactionScore` (config は `Pick<...>` — 上記と同じ理由で
/// [ScoringConfig] 全体を受ける)。
double calculateReactionScore(
  List<MealReaction> reactionHistory,
  ScoringConfig config,
) {
  if (reactionHistory.isEmpty) return 0;

  var score = 0.0;
  for (final reaction in reactionHistory) {
    if (reaction == MealReaction.good) {
      score += config.goodReactionBonus;
    } else if (reaction == MealReaction.bad) {
      score -= config.badReactionPenalty;
    }
  }

  return math.max(
    config.reactionScoreMin,
    math.min(config.reactionScoreMax, score),
  );
}
