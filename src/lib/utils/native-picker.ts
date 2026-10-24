/**
 * date/time 系入力を叩いた時に、ネイティブのピッカーを明示的に開く。
 *
 * **なぜ要るか**: Chrome for Android 154（2026-09 配信）で date/time 入力が
 * 「欄のどこを叩いても OS ピッカー」から desktop と同じ多欄コントロール（時・分の
 * サブフィールド + 右端の小さなアイコン）へ変わった。Chromium はタップでピッカーを
 * 開くのを「fine ポインタが一つも無い端末」に限る（`ShouldSubfieldsBeFocusable`
 * = `has_fine_pointer || !has_coarse_pointer`）ため、S Pen 搭載機や SOURCE_MOUSE を
 * 偽って報告する OEM 機では、欄を叩いても「時」が強調されるだけで時刻を変えられぬ
 * （「記録後の時刻が編集できなくなった」の正体。アプリ側は無変更のまま壊れた）。
 *
 * **開く条件を `(pointer: coarse) and (any-pointer: fine)` に絞る理由**: any-pointer は
 * Chromium の上記判定と同じ値源（`Settings::GetAvailablePointerTypes`）を読む。ゆえに
 * `any-pointer: fine` は「Chromium がタップで開かぬ」ことと対応する。そこへ
 * `pointer: coarse`（primary が指）を重ね、隙間のうち**指で操作する端末だけ**に絞る:
 * - 対象: fine も報告する電話機（S Pen 機・SOURCE_MOUSE を偽る OEM 機。primary は coarse）
 * - 意図して外す: primary が fine の端末（Android の desktop mode でタッチとマウスを併用、
 *   タッチ対応の Windows ノート PC 等）。マウスでのサブフィールド直接入力を残すため
 * - 触れぬ: 純タッチ端末（fine が無く Chromium が自前で開く）
 * - 条件に入りうるが未検証: iPad にトラックパッド/マウスを繋いだ状態（pointer は coarse
 *   のまま any-pointer だけ fine になる）。既にピッカーが開く環境での showPicker は
 *   害が無い想定じゃが実機では見ておらぬ。例外は下の try/catch で warn に落ちる
 *
 * `showPicker()` は transient user activation を要するゆえ、click ハンドラ内からのみ呼ぶ。
 * Chromium は二重起動を内部で弾く（`PickerIndicatorElement::OpenPopup` の
 * `HasOpenedPopup()`）ため、右端アイコンを叩いた時に重ねて呼んでも害は無い。
 */

const TEMPORAL_INPUT_TYPES = new Set([
  "date",
  "time",
  "datetime-local",
  "month",
  "week",
])

export const NATIVE_PICKER_GAP_QUERY =
  "(pointer: coarse) and (any-pointer: fine)"

export function openNativePickerOnTap(input: HTMLInputElement): void {
  if (!TEMPORAL_INPUT_TYPES.has(input.type)) return
  // disabled / readOnly への showPicker は InvalidStateError ゆえ先に弾く
  if (input.disabled || input.readOnly) return
  if (typeof input.showPicker !== "function") return
  if (
    typeof window.matchMedia !== "function" ||
    !window.matchMedia(NATIVE_PICKER_GAP_QUERY).matches
  ) {
    return
  }
  try {
    input.showPicker()
  } catch (err) {
    // ピッカーが開かぬだけで入力自体は生きておる（右端アイコンが残る）ゆえ握って残す
    console.warn("[native-picker] showPicker failed", {
      type: input.type,
      ...describeError(err),
    })
  }
}

// showPicker が投げるのは DOMException（NotAllowedError 等）。DOMException が
// `instanceof Error` になるかは実装次第（jsdom ではならぬ）ゆえ、形で読む。
function describeError(err: unknown): { name: string; message: string } {
  if (typeof err === "object" && err !== null) {
    const { name, message } = err as { name?: unknown; message?: unknown }
    if (typeof name === "string") {
      return { name, message: typeof message === "string" ? message : "" }
    }
  }
  return { name: typeof err, message: String(err) }
}
