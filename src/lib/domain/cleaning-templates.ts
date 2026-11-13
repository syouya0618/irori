/**
 * 掃除の項目のテンプレート（中立モジュール）。
 *
 * テンプレートは**作成フォームの入力欄を埋めるだけ**じゃ。選んでも DB へは何も書かず、
 * 実施の履歴も作らぬ（B-08）。周期は目安で、利用者が保存の前に自由に変えられる。
 * 基準日は持たぬ（フォームが「今日」を初期値にし、利用者が選ぶ）。
 *
 * 周期は家庭での一般的な目安として Irori が独自に置いた初期値で、メーカーや公的機関の
 * 推奨値ではない（そう読める文言を画面に出さぬこと）。
 */
import type { CadenceUnit, ScheduleMode } from "@/lib/domain/cleaning-schedule"

export interface CleaningTemplate {
  key: string
  name: string
  location: string
  cadenceUnit: CadenceUnit
  cadenceInterval: number
  scheduleMode: ScheduleMode
}

export const CLEANING_TEMPLATES: readonly CleaningTemplate[] = [
  { key: "bath-drain", name: "浴室の排水口", location: "浴室", cadenceUnit: "week", cadenceInterval: 1, scheduleMode: "fixed" },
  { key: "toilet", name: "トイレ掃除", location: "トイレ", cadenceUnit: "week", cadenceInterval: 1, scheduleMode: "fixed" },
  { key: "kitchen-drain", name: "キッチンの排水口", location: "キッチン", cadenceUnit: "week", cadenceInterval: 1, scheduleMode: "fixed" },
  { key: "washbasin", name: "洗面台", location: "洗面所", cadenceUnit: "week", cadenceInterval: 1, scheduleMode: "fixed" },
  { key: "bedding", name: "シーツ・枕カバーの洗濯", location: "寝室", cadenceUnit: "week", cadenceInterval: 2, scheduleMode: "after_done" },
  { key: "washer-tub", name: "洗濯槽の掃除", location: "洗面所", cadenceUnit: "month", cadenceInterval: 1, scheduleMode: "after_done" },
  { key: "bath-fan", name: "浴室の換気扇", location: "浴室", cadenceUnit: "month", cadenceInterval: 3, scheduleMode: "after_done" },
  { key: "aircon-filter", name: "エアコンのフィルター", location: "リビング", cadenceUnit: "month", cadenceInterval: 1, scheduleMode: "after_done" },
  { key: "fridge", name: "冷蔵庫の中の拭き掃除", location: "キッチン", cadenceUnit: "month", cadenceInterval: 1, scheduleMode: "fixed" },
  { key: "range-hood", name: "レンジフードのフィルター", location: "キッチン", cadenceUnit: "month", cadenceInterval: 3, scheduleMode: "after_done" },
  { key: "windows", name: "窓・網戸", location: "リビング", cadenceUnit: "month", cadenceInterval: 6, scheduleMode: "fixed" },
  { key: "year-end", name: "年末の大掃除", location: "", cadenceUnit: "year", cadenceInterval: 1, scheduleMode: "fixed" },
] as const
