import 'package:flutter_test/flutter_test.dart';
import 'package:irori/features/auth/presentation/return_to.dart';

void main() {
  group('sanitizeReturnTo (Open Redirect 防止)', () {
    test('相対パスは許可', () {
      expect(sanitizeReturnTo('/baby'), '/baby');
      expect(sanitizeReturnTo('/invite/abc'), '/invite/abc');
      expect(sanitizeReturnTo('/x?y=1'), '/x?y=1');
      expect(sanitizeReturnTo('/'), '/');
    });

    test('null / 空文字は fallback', () {
      expect(sanitizeReturnTo(null), '/baby');
      expect(sanitizeReturnTo(''), '/baby');
    });

    test('protocol-relative (//) は拒否して fallback', () {
      expect(sanitizeReturnTo('//evil.com'), '/baby');
      expect(sanitizeReturnTo('//evil.com/path'), '/baby');
    });

    test(
      'backslash variant (/\\) は拒否して fallback (#48 review defense-in-depth)',
      () {
        // 一部 UA が `/\evil.com` を `//evil.com` に正規化し外部 redirect になりうる。
        expect(sanitizeReturnTo(r'/\evil.com'), '/baby');
        expect(sanitizeReturnTo(r'/\evil.com/path'), '/baby');
        expect(sanitizeReturnTo(r'/\'), '/baby');
      },
    );

    test('絶対 URL は拒否して fallback', () {
      expect(sanitizeReturnTo('https://evil.com'), '/baby');
      expect(sanitizeReturnTo('http://evil.com'), '/baby');
      expect(sanitizeReturnTo('evil.com'), '/baby');
    });

    test('fallback はカスタム可能', () {
      expect(sanitizeReturnTo(null, fallback: '/'), '/');
      expect(sanitizeReturnTo('//evil', fallback: '/'), '/');
    });
  });
}
