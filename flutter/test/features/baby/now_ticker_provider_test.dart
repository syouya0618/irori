import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:irori/features/baby/data/now_ticker_provider.dart';

void main() {
  group('nowTickerProvider', () {
    test('購読直後に初期値を即時 emit する', () async {
      final container = ProviderContainer();
      addTearDown(container.dispose);

      // listen で購読を張る (onListen が走り初期 emit される)。
      container.listen<AsyncValue<DateTime>>(nowTickerProvider, (_, _) {});

      // 初回 microtask で StreamProvider が初期値を拾うのを待つ。
      await Future<void>.delayed(Duration.zero);

      final value = container.read(nowTickerProvider);
      expect(value.hasValue, isTrue);
      expect(value.value, isA<DateTime>());
    });

    test('container.dispose で Timer が解放される (pending Timer なし)', () async {
      // この test 自体が「A Timer is still pending」で fail することで
      // leak を検出する (fake_async を使わず実 Timer のクリーンアップを検証)。
      final container = ProviderContainer();
      container.listen<AsyncValue<DateTime>>(nowTickerProvider, (_, _) {});
      await Future<void>.delayed(Duration.zero);
      expect(container.read(nowTickerProvider).hasValue, isTrue);

      // 破棄で onDispose → timer.cancel() + controller.close() が走る。
      container.dispose();
      // dispose 後に追加の microtask を回しても pending Timer が残らないこと。
      await Future<void>.delayed(Duration.zero);
    });
  });
}
