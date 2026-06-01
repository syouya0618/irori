import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../domain/baby_log.dart';

/// 進行中の授乳タイマーの永続化状態。原典 `feeding-timer.tsx` の `TimerState`
/// (localStorage `irori:feeding-timer`) 相当。
typedef FeedingTimerState = ({DateTime startedAt, FeedingType feedingType});

/// 授乳タイマーの中断復元ストア。
///
/// 端末リロード / タブ eviction を跨いでタイマーを復元するための薄い永続化層。
/// stale 判定 (経過時間が長すぎる保存値の破棄) は **呼び出し側 (sheet)** が
/// clock seam を使って行う。本ストアは load/save/clear のみの dumb な層。
abstract class FeedingTimerStore {
  Future<FeedingTimerState?> load();
  Future<void> save(FeedingTimerState state);
  Future<void> clear();
}

/// `SharedPreferences` (web では localStorage) 実装。
///
/// `SharedPreferences.getInstance()` は内部でインスタンスをキャッシュする singleton
/// なので、毎回呼んでも安価。これにより `main()` の bootstrap を変更せずに済む。
class SharedPreferencesFeedingTimerStore implements FeedingTimerStore {
  const SharedPreferencesFeedingTimerStore();

  /// 原典 `STORAGE_KEY = "irori:feeding-timer"` と同一キー。
  static const _key = 'irori:feeding-timer';

  @override
  Future<FeedingTimerState?> load() async {
    final prefs = await SharedPreferences.getInstance();
    final raw = prefs.getString(_key);
    if (raw == null) return null;
    try {
      final map = jsonDecode(raw) as Map<String, dynamic>;
      final startedAt = DateTime.parse(map['startedAt'] as String);
      final feedingType = _feedingTypeFromValue(map['feedingType'] as String?);
      if (feedingType == null) {
        // 未知の feedingType (スキーマ変更等) は破損扱いで破棄。
        await prefs.remove(_key);
        return null;
      }
      return (startedAt: startedAt, feedingType: feedingType);
    } on Object catch (e) {
      // 壊れた保存値は握り潰さずログして破棄 (CLAUDE.md「エラー握り潰し禁止」)。
      debugPrint('FeedingTimerStore.load 破損データを破棄: $e');
      await prefs.remove(_key);
      return null;
    }
  }

  @override
  Future<void> save(FeedingTimerState state) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(
      _key,
      jsonEncode({
        'startedAt': state.startedAt.toUtc().toIso8601String(),
        'feedingType': _feedingTypeValue(state.feedingType),
      }),
    );
  }

  @override
  Future<void> clear() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(_key);
  }
}

/// `BabyRepository._feedingTypeValue` と同一の文字列対応 (DB ENUM 値)。
/// ストアを repository から独立させるため局所定義する。
String _feedingTypeValue(FeedingType type) {
  switch (type) {
    case FeedingType.breastLeft:
      return 'breast_left';
    case FeedingType.breastRight:
      return 'breast_right';
    case FeedingType.bottle:
      return 'bottle';
    case FeedingType.solid:
      return 'solid';
  }
}

FeedingType? _feedingTypeFromValue(String? value) {
  switch (value) {
    case 'breast_left':
      return FeedingType.breastLeft;
    case 'breast_right':
      return FeedingType.breastRight;
    case 'bottle':
      return FeedingType.bottle;
    case 'solid':
      return FeedingType.solid;
    default:
      return null;
  }
}

/// 授乳タイマーストアの DI provider。
///
/// 本番は `SharedPreferences` 実装。テストは in-memory fake で override する。
final feedingTimerStoreProvider = Provider<FeedingTimerStore>((ref) {
  return const SharedPreferencesFeedingTimerStore();
});
