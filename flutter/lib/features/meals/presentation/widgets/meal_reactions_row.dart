import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/theme/colors.dart';
import '../../../../core/theme/radii.dart';
import '../../data/meals_repository.dart';
import '../../domain/meal.dart';

/// リアクション 3 種の定義。原典 `meal-reactions.tsx` の `REACTION_CONFIG`
/// と同一 (絵文字は design system の例外規定により meal reactions のみ使用可)。
const _reactionConfig = [
  (value: MealReaction.good, emoji: '\u{1F60B}', label: 'おいしい'),
  (value: MealReaction.ok, emoji: '\u{1F610}', label: 'ふつう'),
  (value: MealReaction.bad, emoji: '\u{1F645}', label: 'いまいち'),
];

/// 献立カードのリアクション行 (😋 / 😐 / 🙅)。
///
/// Next.js 原典 `meal-reactions.tsx` の Flutter 移植:
/// - 自分の選択をハイライト (`bg-primary/10` + `ring-primary/30` 相当)。
/// - パートナーの選択に小ドット (`bg-primary/60`) を表示。
/// - **楽観更新**: タップで即座にローカル state へ反映し、`upsertReaction`
///   失敗時に巻き戻して SnackBar でエラー表示 (原典 `useOptimistic` 相当)。
/// - 同じリアクションの再タップはトグルオフ (取消)。
/// - 送信中は 3 ボタンとも disabled (原典 `disabled={isPending}`)。
///
/// web に無い追加表示: 各リアクションの人数 (>0 のときのみ)。2 人世帯前提の
/// 小さな件数バッジで、パートナードットと併せて誰が何を選んだかを示す。
///
/// 親 (`MealCard`) から渡される [reactions] が更新されたら (refetch /
/// realtime 反映)、楽観 state は破棄してサーバ値を正とする。
class MealReactionsRow extends ConsumerStatefulWidget {
  const MealReactionsRow({
    required this.mealId,
    required this.reactions,
    required this.currentUserId,
    super.key,
  });

  final String mealId;
  final List<MealReactionEntry> reactions;

  /// 自分の user id。`mealsMutationContextProvider` 未解決の window では
  /// null になり、その間はタップ不可 (ハイライトも出ない)。
  final String? currentUserId;

  @override
  ConsumerState<MealReactionsRow> createState() => _MealReactionsRowState();
}

class _MealReactionsRowState extends ConsumerState<MealReactionsRow> {
  /// 楽観更新中のローカル上書き。null = サーバ値 ([MealReactionsRow.reactions])
  /// をそのまま表示。
  List<MealReactionEntry>? _optimistic;

  bool _pending = false;

  @override
  void didUpdateWidget(MealReactionsRow oldWidget) {
    super.didUpdateWidget(oldWidget);
    // 新しいサーバ値が届いたら楽観 state を破棄 (refetch / realtime が正)。
    if (!listEquals(widget.reactions, oldWidget.reactions)) {
      _optimistic = null;
    }
  }

  List<MealReactionEntry> get _effective => _optimistic ?? widget.reactions;

  MealReactionEntry? _ownReaction() {
    final userId = widget.currentUserId;
    if (userId == null) return null;
    for (final r in _effective) {
      if (r.userId == userId) return r;
    }
    return null;
  }

  MealReactionEntry? _partnerReaction() {
    final userId = widget.currentUserId;
    for (final r in _effective) {
      if (r.userId != userId) return r;
    }
    return null;
  }

  Future<void> _handleTap(MealReaction reaction) async {
    final userId = widget.currentUserId;
    if (_pending || userId == null) return;

    final current = _effective;
    final own = _ownReaction();
    final isRemoving = own?.reaction == reaction;

    // 原典 useOptimistic の reducer と同じ 3 分岐 (取消 / 上書き / 追加)。
    final List<MealReactionEntry> next;
    if (isRemoving) {
      next = [
        for (final r in current)
          if (r.userId != userId) r,
      ];
    } else if (own != null) {
      next = [
        for (final r in current)
          if (r.userId == userId) r.copyWith(reaction: reaction) else r,
      ];
    } else {
      next = [
        ...current,
        MealReactionEntry(userId: userId, reaction: reaction),
      ];
    }

    final messenger = ScaffoldMessenger.of(context);
    setState(() {
      _optimistic = next;
      _pending = true;
    });

    try {
      // userId は mutation context を正とする (widget 値と同一ユーザーの前提)。
      final mutationContext = await ref.read(
        mealsMutationContextProvider.future,
      );
      await ref
          .read(mealsRepositoryProvider)
          .upsertReaction(
            mealId: widget.mealId,
            userId: mutationContext.userId,
            reaction: reaction,
          );
      // 成功時は楽観 state を保持したまま、F1 の realtime refetch
      // (meal_reactions 購読) がサーバ値で置き換えるのを待つ。
    } on Object catch (e, st) {
      // 握り潰さない (CLAUDE.md)。repository 側でも構造化ログ済み。
      debugPrint('MealReactionsRow upsertReaction 失敗: $e\n$st');
      if (!mounted) return;
      // 巻き戻し + エラー表示 (文言は web `upsertReaction` action の分岐に対応)。
      setState(() => _optimistic = null);
      final message = isRemoving
          ? 'リアクションの削除に失敗しました。'
          : own != null
          ? 'リアクションの更新に失敗しました。'
          : 'リアクションの登録に失敗しました。';
      messenger.showSnackBar(SnackBar(content: Text(message)));
    } finally {
      if (mounted) setState(() => _pending = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final own = _ownReaction();
    final partner = _partnerReaction();
    final disabled = _pending || widget.currentUserId == null;

    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        for (final config in _reactionConfig)
          _ReactionButton(
            emoji: config.emoji,
            label: config.label,
            isActive: own?.reaction == config.value,
            isPartnerReaction: partner?.reaction == config.value,
            count: _effective.where((r) => r.reaction == config.value).length,
            onTap: disabled ? null : () => _handleTap(config.value),
          ),
      ],
    );
  }
}

/// リアクション 1 ボタン。原典の `min-h-8 min-w-8` (32px) を踏襲する
/// (3 ボタンが献立カードの 1/3 幅スロットに収まる必要があり、web も
/// 44px ではなく 32px を採用している意図的例外)。
class _ReactionButton extends StatelessWidget {
  const _ReactionButton({
    required this.emoji,
    required this.label,
    required this.isActive,
    required this.isPartnerReaction,
    required this.count,
    required this.onTap,
  });

  final String emoji;
  final String label;
  final bool isActive;
  final bool isPartnerReaction;
  final int count;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      label: label,
      selected: isActive,
      child: InkWell(
        onTap: onTap,
        customBorder: const StadiumBorder(),
        child: Stack(
          clipBehavior: Clip.none,
          children: [
            Container(
              constraints: const BoxConstraints(minWidth: 32, minHeight: 32),
              padding: const EdgeInsets.symmetric(horizontal: 5),
              decoration: BoxDecoration(
                color: isActive
                    ? IroriColors.primary.withValues(alpha: 0.1)
                    : null,
                borderRadius: BorderRadius.circular(IroriRadii.pill),
                // 非選択時も透明 border を敷いて選択切替のレイアウトシフトを防ぐ
                // (web の ring は layout に影響しないため)。
                border: Border.all(
                  color: isActive
                      ? IroriColors.primary.withValues(alpha: 0.3)
                      : Colors.transparent,
                  width: 2,
                ),
              ),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Text(emoji, style: const TextStyle(fontSize: 14)),
                  if (count > 0) ...[
                    const SizedBox(width: 2),
                    Text(
                      '$count',
                      style: const TextStyle(
                        fontSize: 10,
                        fontWeight: FontWeight.w600,
                        color: IroriColors.textMuted,
                      ),
                    ),
                  ],
                ],
              ),
            ),
            // パートナーの選択インジケータ (原典 `bg-primary/60` の 8px ドット)。
            if (isPartnerReaction)
              Positioned(
                top: -1,
                right: -1,
                child: Container(
                  width: 8,
                  height: 8,
                  decoration: BoxDecoration(
                    color: IroriColors.primary.withValues(alpha: 0.6),
                    shape: BoxShape.circle,
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}
