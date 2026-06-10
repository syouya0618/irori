import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:irori/core/utils/jst_date.dart';
import 'package:irori/features/meals/data/selected_week_start_provider.dart';

/// 初期値を固定する Notifier (週切替メソッドは実装を継承して検証する)。
class _FixedWeekNotifier extends SelectedWeekStartNotifier {
  _FixedWeekNotifier(this._w);
  final String _w;
  @override
  String build() => _w;
}

void main() {
  group('selectedWeekStartProvider (週ナビゲーション)', () {
    test('デフォルトは今日 (JST) を含む週の月曜', () {
      final container = ProviderContainer();
      addTearDown(container.dispose);

      expect(
        container.read(selectedWeekStartProvider),
        weekStartMonday(formatJstDate()),
      );
    });

    test('previousWeek で 7 日戻る (月跨ぎも正しい)', () {
      final container = ProviderContainer(
        overrides: [
          selectedWeekStartProvider.overrideWith(
            () => _FixedWeekNotifier('2026-06-01'),
          ),
        ],
      );
      addTearDown(container.dispose);

      container.read(selectedWeekStartProvider.notifier).previousWeek();
      expect(container.read(selectedWeekStartProvider), '2026-05-25');
    });

    test('nextWeek で 7 日進む', () {
      final container = ProviderContainer(
        overrides: [
          selectedWeekStartProvider.overrideWith(
            () => _FixedWeekNotifier('2026-06-08'),
          ),
        ],
      );
      addTearDown(container.dispose);

      container.read(selectedWeekStartProvider.notifier).nextWeek();
      expect(container.read(selectedWeekStartProvider), '2026-06-15');
    });

    test('goToCurrentWeek で今週の月曜に戻る', () {
      final container = ProviderContainer(
        overrides: [
          selectedWeekStartProvider.overrideWith(
            () => _FixedWeekNotifier('2020-01-06'),
          ),
        ],
      );
      addTearDown(container.dispose);

      container.read(selectedWeekStartProvider.notifier).goToCurrentWeek();
      expect(
        container.read(selectedWeekStartProvider),
        weekStartMonday(formatJstDate()),
      );
    });
  });

  group('isCurrentWeekStart (原典 isCurrentWeek 相当)', () {
    test('now を含む週の月曜なら true', () {
      // 2026-06-10 (水, JST) を含む週の月曜は 2026-06-08。
      final now = DateTime.utc(2026, 6, 10, 3); // = JST 2026-06-10 12:00
      expect(isCurrentWeekStart('2026-06-08', now), isTrue);
      expect(isCurrentWeekStart('2026-06-01', now), isFalse);
      expect(isCurrentWeekStart('2026-06-15', now), isFalse);
    });

    test('日曜 (JST) は前週末扱い — その週の月曜は 6 日前 (原典 getMonday 互換)', () {
      // 2026-06-14 は日曜 (JST)。週の月曜は 2026-06-08。
      final now = DateTime.utc(2026, 6, 14, 3);
      expect(isCurrentWeekStart('2026-06-08', now), isTrue);
      expect(isCurrentWeekStart('2026-06-15', now), isFalse);
    });
  });
}
