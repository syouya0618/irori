import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import 'app/router.dart';
import 'core/theme/app_theme.dart';

/// irori entry point.
///
/// Supabase の URL と anon key は build 時に
/// `--dart-define=SUPABASE_URL=... --dart-define=SUPABASE_ANON_KEY=...`
/// で注入する (Vercel env と連動)。
///
/// 環境変数取得後は **必ず `.trim()`** を適用すること
/// (CLAUDE.md 普遍ルール「環境変数は .trim() で防御」、4 回再発の学習)。
/// Vercel UI からコピペした際の末尾改行・空白で `Supabase.initialize` が
/// silent fail するのを防ぐ。
///
/// release build (`kReleaseMode == true`) で env が空の場合は `StateError`
/// を throw して fail-fast する。debug build では未設定でも runApp 続行
/// (Phase 0 互換の Hello World 動作確認用)。
Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();

  const rawUrl = String.fromEnvironment('SUPABASE_URL');
  const rawAnonKey = String.fromEnvironment('SUPABASE_ANON_KEY');
  final url = rawUrl.trim();
  final anonKey = rawAnonKey.trim();

  if (url.isNotEmpty && anonKey.isNotEmpty) {
    await Supabase.initialize(url: url, anonKey: anonKey);
  } else if (kReleaseMode) {
    throw StateError(
      'SUPABASE_URL / SUPABASE_ANON_KEY が release build で必須です。'
      ' --dart-define で注入してください。',
    );
  }

  runApp(const ProviderScope(child: IroriApp()));
}

class IroriApp extends ConsumerWidget {
  const IroriApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final router = ref.watch(appRouterProvider);

    return MaterialApp.router(
      title: 'irori',
      theme: iroriTheme,
      routerConfig: router,
      debugShowCheckedModeBanner: false,
    );
  }
}
