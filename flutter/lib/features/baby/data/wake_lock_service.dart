import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:wakelock_plus/wakelock_plus.dart';

/// 画面 WakeLock の薄い抽象。原典 `use-wake-lock.ts` (Screen Wake Lock API)
/// 相当。授乳タイマー実行中に OS の自動ロックで画面が消灯するのを防ぐ。
///
/// enable/disable の呼び分け (タイマー動作中のみ enable) と失敗時の
/// best-effort 処理 (取得失敗でもタイマーは継続) は **呼び出し側 (sheet)** が
/// 行う。本サービスは platform API への委譲のみの dumb な層。
abstract class WakeLockService {
  Future<void> enable();
  Future<void> disable();
}

/// `wakelock_plus` 実装。
///
/// `WakelockPlus.enable/disable` は冪等 (plugin が現在状態を確認して
/// 重複呼び出しを無視する) なので、停止 + dispose の二重 disable も安全。
class WakelockPlusService implements WakeLockService {
  const WakelockPlusService();

  @override
  Future<void> enable() => WakelockPlus.enable();

  @override
  Future<void> disable() => WakelockPlus.disable();
}

/// 画面 WakeLock の DI provider。
///
/// 本番は `wakelock_plus` 実装。テストは fake で override する
/// (`feedingTimerStoreProvider` と同流儀)。
final wakeLockServiceProvider = Provider<WakeLockService>((ref) {
  return const WakelockPlusService();
});
