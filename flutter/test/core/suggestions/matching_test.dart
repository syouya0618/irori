/// Next.js 原典 `src/lib/domain/__tests__/matching.test.ts` の 1:1 移植。
library;

import 'package:flutter_test/flutter_test.dart';
import 'package:irori/core/domain/suggestions/matching.dart';

import 'helpers.dart';

void main() {
  group('matchStockToTemplate', () {
    test('全食材がマッチ → matchRate == 1.0', () {
      final template = mkTemplate('t1', ['トマト', '玉ねぎ']);
      final stock = [mkStock('トマト'), mkStock('玉ねぎ')];

      final result = matchStockToTemplate(template, stock, 2);

      expect(result.matchRate, 1.0);
      expect(result.matched, hasLength(2));
      expect(result.missing, isEmpty);
    });

    test('半分マッチ → matchRate == 0.5', () {
      final template = mkTemplate('t1', ['トマト', '玉ねぎ']);
      final stock = [mkStock('トマト')];

      final result = matchStockToTemplate(template, stock, 2);

      expect(result.matchRate, 0.5);
      expect(result.matched, hasLength(1));
      expect(result.missing, hasLength(1));
      expect(result.missing[0].name, '玉ねぎ');
    });

    test('在庫0件 → matchRate == 0, 全食材が不足', () {
      final template = mkTemplate('t1', ['トマト', '玉ねぎ']);

      final result = matchStockToTemplate(template, [], 2);

      expect(result.matchRate, 0);
      expect(result.matched, isEmpty);
      expect(result.missing, hasLength(2));
    });

    test('テンプレート食材0件 → matchRate == 0（0割ガード）', () {
      final template = mkTemplate('t1', []);
      final stock = [mkStock('トマト')];

      final result = matchStockToTemplate(template, stock, 2);

      expect(result.matchRate, 0);
      expect(result.matched, isEmpty);
      expect(result.missing, isEmpty);
    });

    test('部分一致が機能する（トマト缶 in stock で トマト template にマッチ）', () {
      final template = mkTemplate('t1', ['トマト']);
      final stock = [mkStock('トマト缶')];

      final result = matchStockToTemplate(template, stock, 2);

      expect(result.matchRate, 1.0);
      expect(result.matched, hasLength(1));
    });

    test('1文字食材は部分一致せず誤マッチを防ぐ', () {
      final template = mkTemplate('t1', ['肉']);
      final stock = [mkStock('鶏肉')];

      final result = matchStockToTemplate(template, stock, 2);

      expect(result.matchRate, 0);
    });

    test('同じ在庫アイテムが複数食材にマッチしない（重複使用防止）', () {
      // テンプレートに「玉ねぎ」が2回登場するが、在庫の玉ねぎは1つしかない
      final template = mkTemplate('t1', ['玉ねぎ', '玉ねぎ']);
      final stock = [mkStock('玉ねぎ')];

      final result = matchStockToTemplate(template, stock, 2);

      // 1つしかマッチしない（重複使用禁止）
      expect(result.matched, hasLength(1));
      expect(result.missing, hasLength(1));
      expect(result.matchRate, 0.5);
    });

    test('別IDの同名在庫が2つあれば両方の食材にマッチ', () {
      final template = mkTemplate('t1', ['玉ねぎ', '玉ねぎ']);
      final stock = [
        mkStock('玉ねぎ', id: 's-1'),
        mkStock('玉ねぎ', id: 's-2'),
      ];

      final result = matchStockToTemplate(template, stock, 2);

      expect(result.matched, hasLength(2));
      expect(result.missing, isEmpty);
    });
  });
}
