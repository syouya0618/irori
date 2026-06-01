import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:irori/features/baby/data/feeding_timer_store.dart';
import 'package:irori/features/baby/domain/baby_log.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// `SharedPreferencesFeedingTimerStore` の永続化層を検証。
///
/// `setMockInitialValues` は内部で `_completer = null` し getInstance の cache を
/// リセットするため (確認済み: shared_preferences_legacy.dart:285)、各テストは
/// 独立した mock store を得る。
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  const store = SharedPreferencesFeedingTimerStore();
  const key = 'irori:feeding-timer'; // 原典 STORAGE_KEY と同一

  test('save→load が同一 instant と feedingType を往復する (UTC round-trip)', () async {
    SharedPreferences.setMockInitialValues({});
    // JST 表現の instant を保存し、UTC ISO で永続化 → load で同一 instant に戻る。
    final started = DateTime.parse('2026-01-01T09:00:00+09:00');

    await store.save((
      startedAt: started,
      feedingType: FeedingType.breastRight,
    ));
    final loaded = await store.load();

    expect(loaded, isNotNull);
    expect(loaded!.startedAt.isAtSameMomentAs(started), isTrue);
    expect(loaded.feedingType, FeedingType.breastRight);
  });

  test('保存キーは原典 STORAGE_KEY (irori:feeding-timer) と一致し DB ENUM 値で書く', () async {
    SharedPreferences.setMockInitialValues({});

    await store.save((
      startedAt: DateTime.utc(2026, 1, 1),
      feedingType: FeedingType.breastLeft,
    ));

    final prefs = await SharedPreferences.getInstance();
    final raw = prefs.getString(key);
    expect(raw, isNotNull);
    final map = jsonDecode(raw!) as Map<String, dynamic>;
    expect(map['feedingType'], 'breast_left'); // camelCase ではなく DB ENUM 値
  });

  test('破損 JSON は null を返しキーを破棄する', () async {
    SharedPreferences.setMockInitialValues({key: 'not-json-at-all'});

    final loaded = await store.load();

    expect(loaded, isNull);
    final prefs = await SharedPreferences.getInstance();
    expect(prefs.getString(key), isNull); // 破損値は除去される
  });

  test('未知の feedingType は null を返しキーを破棄する', () async {
    SharedPreferences.setMockInitialValues({
      key: jsonEncode({
        'startedAt': DateTime.utc(2026, 1, 1).toIso8601String(),
        'feedingType': 'future_value', // スキーマ変更等で増えた未知値
      }),
    });

    final loaded = await store.load();

    expect(loaded, isNull);
    final prefs = await SharedPreferences.getInstance();
    expect(prefs.getString(key), isNull);
  });

  test('保存が無ければ null', () async {
    SharedPreferences.setMockInitialValues({});
    expect(await store.load(), isNull);
  });

  test('clear で保存が消える', () async {
    SharedPreferences.setMockInitialValues({});
    await store.save((
      startedAt: DateTime.utc(2026, 1, 1),
      feedingType: FeedingType.bottle,
    ));

    await store.clear();

    expect(await store.load(), isNull);
  });
}
