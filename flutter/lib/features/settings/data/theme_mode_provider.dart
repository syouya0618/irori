import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart' show ThemeMode;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// テーマモード (light / dark / system) の永続化 + 状態管理。
///
/// web 原典 `theme-card.tsx` は next-themes の `useTheme` で localStorage に
/// テーマを保存する。Flutter 版は `SharedPreferences` に文字列で永続化し、
/// `MaterialApp.themeMode` へ配線する。永続化層は `FeedingTimerStore` と同じ
/// 「dumb store (load/save のみ)」流儀。

/// テーマモードの永続化層。
abstract class ThemeModeStore {
  Future<ThemeMode?> load();
  Future<void> save(ThemeMode mode);
}

/// `SharedPreferences` 実装。
///
/// `SharedPreferences.getInstance()` は内部でキャッシュされる singleton のため
/// 毎回呼んでも安価 (`SharedPreferencesFeedingTimerStore` と同じ)。
class SharedPreferencesThemeModeStore implements ThemeModeStore {
  const SharedPreferencesThemeModeStore();

  static const _key = 'irori:theme-mode';

  @override
  Future<ThemeMode?> load() async {
    final prefs = await SharedPreferences.getInstance();
    final raw = prefs.getString(_key);
    return _themeModeFromValue(raw);
  }

  @override
  Future<void> save(ThemeMode mode) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_key, _themeModeValue(mode));
  }
}

/// 永続化用の文字列対応 (web next-themes の 'light'/'dark'/'system' と同一)。
String _themeModeValue(ThemeMode mode) {
  switch (mode) {
    case ThemeMode.light:
      return 'light';
    case ThemeMode.dark:
      return 'dark';
    case ThemeMode.system:
      return 'system';
  }
}

/// 未知値 / null は null を返す (呼び出し側で system 既定にフォールバック)。
ThemeMode? _themeModeFromValue(String? value) {
  switch (value) {
    case 'light':
      return ThemeMode.light;
    case 'dark':
      return ThemeMode.dark;
    case 'system':
      return ThemeMode.system;
    default:
      return null;
  }
}

/// テーマモードストアの DI provider。
///
/// 本番は `SharedPreferences` 実装。テストは in-memory fake で override する。
final themeModeStoreProvider = Provider<ThemeModeStore>((ref) {
  return const SharedPreferencesThemeModeStore();
});

/// アプリ全体のテーマモード。`MaterialApp.themeMode` が watch する。
///
/// 初期値は [ThemeMode.system]。生成時に永続値を非同期ロードして反映する
/// (`store_filter_tabs.dart` の `Notifier` 流儀 + 非同期ロード)。
class ThemeModeNotifier extends Notifier<ThemeMode> {
  @override
  ThemeMode build() {
    // 同期の既定は system。永続値のロードは build 後に state を更新する
    // (MaterialApp が rebuild して反映)。
    _load();
    return ThemeMode.system;
  }

  Future<void> _load() async {
    try {
      final stored = await ref.read(themeModeStoreProvider).load();
      if (stored != null && stored != state) state = stored;
    } on Object catch (e, st) {
      // 握り潰さない (CLAUDE.md)。ロード失敗時は system 既定のまま。
      debugPrint('ThemeModeNotifier.load 失敗: $e\n$st');
    }
  }

  /// テーマ切替。楽観更新 (即時反映) + 永続化。web `setTheme` 相当。
  Future<void> setThemeMode(ThemeMode mode) async {
    if (mode == state) return;
    state = mode;
    try {
      await ref.read(themeModeStoreProvider).save(mode);
    } on Object catch (e, st) {
      // 保存失敗でも当該セッションの表示は正 (次回起動で戻るのみ、安全側)。
      // 握り潰さずログする (CLAUDE.md)。
      debugPrint('ThemeModeNotifier.save 失敗: $e\n$st');
    }
  }
}

/// アプリ全体のテーマモード provider。
final themeModeProvider = NotifierProvider<ThemeModeNotifier, ThemeMode>(
  ThemeModeNotifier.new,
);
