/// Next.js 原典 `src/lib/domain/__tests__/normalize.test.ts` の 1:1 移植
/// + minMatchLength 境界の追加ケース (Phase 2.5 PR-A 計画)。
library;

import 'package:flutter_test/flutter_test.dart';
import 'package:irori/core/domain/suggestions/normalize.dart';

void main() {
  group('normalizeIngredientName', () {
    test('前後の空白を除去する', () {
      expect(normalizeIngredientName('  トマト  '), 'トマト');
    });

    test('全角スペースを半角に変換する', () {
      expect(normalizeIngredientName('トマト　缶'), 'トマト 缶');
    });

    test('大文字を小文字に変換する', () {
      expect(normalizeIngredientName('TOMATO'), 'tomato');
    });

    test('空文字はそのまま空文字を返す', () {
      expect(normalizeIngredientName(''), '');
    });
  });

  group('ingredientsMatch', () {
    const minLen = 2;

    test('完全一致でマッチする', () {
      expect(ingredientsMatch('トマト', 'トマト', minLen), isTrue);
    });

    test('前後空白を無視してマッチする', () {
      expect(ingredientsMatch('  トマト  ', 'トマト', minLen), isTrue);
    });

    test('大文字小文字を無視してマッチする', () {
      expect(ingredientsMatch('Tomato', 'TOMATO', minLen), isTrue);
    });

    test('部分一致（片方が他方を含む）でマッチする', () {
      // 在庫が「トマト缶」でテンプレートが「トマト」のケース
      expect(ingredientsMatch('トマト缶', 'トマト', minLen), isTrue);
      expect(ingredientsMatch('トマト', 'トマト缶', minLen), isTrue);
      // 「鶏もも肉」と「鶏もも」も同様にマッチ
      expect(ingredientsMatch('鶏もも肉', '鶏もも', minLen), isTrue);
    });

    test('無関係な食材はマッチしない', () {
      expect(ingredientsMatch('トマト', '豚肉', minLen), isFalse);
    });

    test('1文字の名前は完全一致のみ（誤マッチ防止）', () {
      // "肉"と"鶏肉"は部分一致だが、"肉"は1文字なので完全一致のみ対象
      expect(ingredientsMatch('肉', '鶏肉', minLen), isFalse);
      expect(ingredientsMatch('肉', '肉', minLen), isTrue);
    });

    test('空文字はマッチしない', () {
      expect(ingredientsMatch('', 'トマト', minLen), isFalse);
      expect(ingredientsMatch('トマト', '', minLen), isFalse);
    });

    // 追加ケース (web 未テストの境界を Dart 移植時に固定):
    // `a.length < minMatchLength` は厳密未満 — 長さ == minMatchLength は
    // 部分一致が許可される境界値であることを機械防御する。
    test('minMatchLength 境界: 長さ == minMatchLength は部分一致可・未満は完全一致のみ', () {
      // 2文字 "鶏肉" は minLen=2 ちょうど → 部分一致できる
      expect(ingredientsMatch('鶏肉', '鶏肉団子', 2), isTrue);
      // minLen=3 に上げると 2文字名は部分一致不可
      expect(ingredientsMatch('鶏肉', '鶏肉団子', 3), isFalse);
      // ただし完全一致は minMatchLength に関係なく常にマッチ
      expect(ingredientsMatch('鶏肉', '鶏肉', 3), isTrue);
    });
  });
}
