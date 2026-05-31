import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:irori/features/baby/data/baby_repository.dart';
import 'package:irori/features/baby/data/selected_baby_date_provider.dart';

void main() {
  group('selectedBabyDateProvider (日付ナビゲーション / #54)', () {
    test('デフォルトは今日 (JST)', () {
      final container = ProviderContainer();
      addTearDown(container.dispose);

      expect(
        container.read(selectedBabyDateProvider),
        formatJstDate(),
      );
    });

    test('setDate で任意の日付に設定できる', () {
      final container = ProviderContainer();
      addTearDown(container.dispose);

      container.read(selectedBabyDateProvider.notifier).setDate('2026-05-20');
      expect(container.read(selectedBabyDateProvider), '2026-05-20');
    });

    test('setDate は不正形式を拒否する (ArgumentError)', () {
      final container = ProviderContainer();
      addTearDown(container.dispose);

      expect(
        () => container
            .read(selectedBabyDateProvider.notifier)
            .setDate('2026/05/20'),
        throwsArgumentError,
      );
    });

    test('goToPreviousDay で前日へ', () {
      final container = ProviderContainer();
      addTearDown(container.dispose);

      container.read(selectedBabyDateProvider.notifier).setDate('2026-05-20');
      container.read(selectedBabyDateProvider.notifier).goToPreviousDay();
      expect(container.read(selectedBabyDateProvider), '2026-05-19');
    });

    test('goToNextDay で翌日へ', () {
      final container = ProviderContainer();
      addTearDown(container.dispose);

      container.read(selectedBabyDateProvider.notifier).setDate('2026-05-20');
      container.read(selectedBabyDateProvider.notifier).goToNextDay();
      expect(container.read(selectedBabyDateProvider), '2026-05-21');
    });

    test('goToPreviousDay は月跨ぎを正しく処理する', () {
      final container = ProviderContainer();
      addTearDown(container.dispose);

      container.read(selectedBabyDateProvider.notifier).setDate('2026-06-01');
      container.read(selectedBabyDateProvider.notifier).goToPreviousDay();
      expect(container.read(selectedBabyDateProvider), '2026-05-31');
    });

    test('goToToday で今日 (JST) に戻る', () {
      final container = ProviderContainer();
      addTearDown(container.dispose);

      container.read(selectedBabyDateProvider.notifier).setDate('2020-01-01');
      container.read(selectedBabyDateProvider.notifier).goToToday();
      expect(container.read(selectedBabyDateProvider), formatJstDate());
    });
  });
}
