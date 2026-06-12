import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'stock_repository.dart';

/// 低在庫自動追加 (`StockRepository.autoAddLowStockItems`) の 30 分スロットル。
///
/// web 原典 `stock-list.tsx:117-133`: mount ごとの useEffect で
/// sessionStorage `stock_low_checked_at` を見て 30 分以内なら skip、
/// 実行後 `result.error` が無いときのみ `Date.now()` を記録する。
///
/// 意図的差異 (PR 本文にも明記):
/// - **永続単位**: web の sessionStorage はタブセッションで消えるが、
///   Flutter は `SharedPreferences` 永続のためアプリ再起動を跨いで残る。
///   30 分判定そのものは同じで、再起動直後の再実行が web より抑制される
///   (安全側 — 自動 insert の重複機会が減るだけ)。
/// - **発火回数**: web は mount ごと + スロットル。Flutter は stock タブの
///   初回 build のみ + スロットル (`StatefulShellRoute.indexedStack` がタブ
///   状態を保持するため再選択で remount しない)。タブ再選択ごとの発火は
///   スコープ外 (裁定済み)。

/// スロットルのタイムスタンプ永続化層。
///
/// `FeedingTimerStore` と同じ dumb store 流儀 — 30 分判定は
/// [LowStockAutoAddRunner] が行い、本ストアは load/save のみ。
abstract class LowStockCheckStore {
  Future<DateTime?> loadLastCheckedAt();
  Future<void> saveLastCheckedAt(DateTime value);
}

/// `SharedPreferences` (web では sessionStorage) 実装。
///
/// `SharedPreferences.getInstance()` は内部キャッシュされる singleton のため
/// 毎回呼んでも安価 (`SharedPreferencesFeedingTimerStore` と同じ)。
class SharedPreferencesLowStockCheckStore implements LowStockCheckStore {
  const SharedPreferencesLowStockCheckStore();

  /// web sessionStorage のキー (`stock-list.tsx:118`) と同一。
  static const _key = 'stock_low_checked_at';

  @override
  Future<DateTime?> loadLastCheckedAt() async {
    final prefs = await SharedPreferences.getInstance();
    final millis = prefs.getInt(_key);
    if (millis == null) return null;
    return DateTime.fromMillisecondsSinceEpoch(millis, isUtc: true);
  }

  @override
  Future<void> saveLastCheckedAt(DateTime value) async {
    final prefs = await SharedPreferences.getInstance();
    // web `String(Date.now())` と同じ epoch ms (instant — TZ 非依存)。
    await prefs.setInt(_key, value.toUtc().millisecondsSinceEpoch);
  }
}

/// web `THIRTY_MIN = 30 * 60 * 1000` (stock-list.tsx:119) と同値。
const lowStockCheckInterval = Duration(minutes: 30);

/// スロットル付きの低在庫自動追加の実行器。
///
/// [runCheck] はチェック本体 (`autoAddLowStockItems`) を注入する seam —
/// テストでは canned result のクロージャに差し替える。
class LowStockAutoAddRunner {
  // Dart 3.10 の private named parameter (呼び出し側は public 名
  // `store:` / `runCheck:` / `now:`)。
  LowStockAutoAddRunner({
    required this._store,
    required this._runCheck,
    this._now = DateTime.now,
  });

  final LowStockCheckStore _store;
  final Future<AutoAddLowStockResult> Function() _runCheck;
  final DateTime Function() _now;

  /// 前回記録から 30 分未満なら実行せず null を返す (skip)。
  ///
  /// web `stock-list.tsx:120-126` と同一の判定・記録規則:
  /// - `last && now - last < 30min` → skip (時計巻き戻りで差が負でも skip —
  ///   `<` 比較がそのまま web の挙動)。
  /// - 実行後 `result.error == null` のときのみタイムスタンプを記録する。
  ///   insert 失敗 (error 非 null) は未記録 → 次回再試行。read 失敗は web
  ///   同様 error: null で返るため「成功」として記録される
  ///   (`AutoAddLowStockResult` doc 参照)。
  Future<AutoAddLowStockResult?> runIfDue() async {
    final last = await _store.loadLastCheckedAt();
    if (last != null && _now().difference(last) < lowStockCheckInterval) {
      return null;
    }
    final result = await _runCheck();
    if (result.error == null) {
      await _store.saveLastCheckedAt(_now());
    }
    return result;
  }
}

/// store の DI provider。本番は `SharedPreferences` 実装。
/// テストは in-memory fake で override する。
final lowStockCheckStoreProvider = Provider<LowStockCheckStore>((ref) {
  return const SharedPreferencesLowStockCheckStore();
});

/// runner の DI provider。
///
/// `runCheck` 内の `ref.read` は実行時 (発火時) 解決 — provider 構築時に
/// mutation context を await しない (未認証時に provider 構築自体を
/// 壊さないため)。発火箇所は `stock_page.dart` `_StockBody.initState`。
final lowStockAutoAddRunnerProvider = Provider<LowStockAutoAddRunner>((ref) {
  return LowStockAutoAddRunner(
    store: ref.watch(lowStockCheckStoreProvider),
    runCheck: () async {
      final ctx = await ref.read(stockMutationContextProvider.future);
      return ref
          .read(stockRepositoryProvider)
          .autoAddLowStockItems(
            householdId: ctx.householdId,
            userId: ctx.userId,
          );
    },
  );
});
