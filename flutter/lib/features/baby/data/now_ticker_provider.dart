import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

/// 60 秒ごとに現在時刻を流す ticker。
///
/// Next.js 原典 `useNow(60_000)` (`baby-dashboard.tsx`) 相当。サマリーバーの
/// 経過時間 (授乳経過 / 睡眠経過 / 覚醒経過) を分単位で reactive 更新するため、
/// 60s 周期で `DateTime.now()` を emit する。
///
/// - 初期値は `Stream.value` 相当で即時 emit (購読直後に "---" でなく実値を出す)。
/// - `Stream.periodic` の `StreamController` は provider 破棄時に Riverpod が
///   自動で subscription を解放する。明示の `Timer` を持たないため leak しない
///   (CLAUDE.md「Timer は dispose で cancel」を Stream の自動解放で満たす)。
final nowTickerProvider = StreamProvider<DateTime>((ref) {
  // 即時に 1 回 emit してから 60s 周期で更新する。
  late final StreamController<DateTime> controller;
  Timer? timer;

  controller = StreamController<DateTime>(
    onListen: () {
      controller.add(DateTime.now());
      timer = Timer.periodic(const Duration(seconds: 60), (_) {
        controller.add(DateTime.now());
      });
    },
    onCancel: () {
      timer?.cancel();
      timer = null;
    },
  );

  ref.onDispose(() {
    timer?.cancel();
    controller.close();
  });

  return controller.stream;
});
