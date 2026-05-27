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
/// Phase 0 では env が未設定でも GlassCard の Hello World が描画される設計
/// (Supabase.initialize は env がある時のみ実行)。
Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();

  const url = String.fromEnvironment('SUPABASE_URL');
  const anonKey = String.fromEnvironment('SUPABASE_ANON_KEY');

  if (url.isNotEmpty && anonKey.isNotEmpty) {
    await Supabase.initialize(url: url, anonKey: anonKey);
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
