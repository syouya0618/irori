import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../domain/meal_template.dart';

/// 在庫タブ「献立に追加」→ 献立タブへの prefill 受け渡し (PR P2.5-F)。
///
/// web は `/meals?template=ID` の URL パラメータで渡し、`meal-week-view.tsx`
/// が `hasProcessedUrlTemplate` ref で 1 回だけ処理してから
/// `router.replace("/meals")` でパラメータを消す (リロード時の再処理防止)。
/// Flutter は GoRouter の query パラメータの代わりに本 provider へ
/// `MealTemplatePrefill` (loadTemplate 済みの実体) を置き、`MealsPage` が
/// [PendingTemplatePrefillNotifier.consume] で 1 回だけ取り出して
/// `MealFormSheet` をプリフィル open する。
class PendingTemplatePrefillNotifier extends Notifier<MealTemplatePrefill?> {
  @override
  MealTemplatePrefill? build() => null;

  /// 在庫タブ側: prefill を積む
  /// (web `router.push('/meals?template=...')` 相当)。
  void set(MealTemplatePrefill prefill) => state = prefill;

  /// 献立タブ側: 現在値を取り出して null へ戻す。2 回目以降の呼び出し
  /// (再 build / listen の二重発火) は null を返すため、sheet が再 open
  /// しない (web `hasProcessedUrlTemplate.current` + `router.replace` の
  /// 1 回消費保証に相当)。
  MealTemplatePrefill? consume() {
    final value = state;
    state = null;
    return value;
  }
}

/// 在庫タブ → 献立タブのテンプレート prefill 受け渡し provider。
final pendingTemplatePrefillProvider =
    NotifierProvider<PendingTemplatePrefillNotifier, MealTemplatePrefill?>(
      PendingTemplatePrefillNotifier.new,
    );
