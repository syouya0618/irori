import path from "node:path"
import type { TDocumentDefinitions, Content, TableCell } from "pdfmake/interfaces"
import { formatElapsedMinutes } from "@/lib/utils/baby-log-labels"
import type {
  DailyFeedingSummary,
  DailySleepSummary,
  DailyDiaperSummary,
  TemperatureRecord,
  GrowthRecord,
} from "@/lib/domain/baby-log-aggregation"

export interface BabyReportInput {
  babyName: string
  birthDate: string
  age: string
  startDate: string
  endDate: string
  feedings: DailyFeedingSummary[]
  sleep: DailySleepSummary[]
  diapers: DailyDiaperSummary[]
  temperatures: TemperatureRecord[]
  growth: GrowthRecord[]
}

const FONT_PATH = path.join(process.cwd(), "fonts", "NotoSansJP-Regular.ttf")
const HEADER_BG = "#f5f5f4"
const BORDER_COLOR = "#e7e5e4"

const TABLE_LAYOUT = {
  hLineColor: () => BORDER_COLOR,
  vLineColor: () => BORDER_COLOR,
  hLineWidth: () => 0.5,
  vLineWidth: () => 0.5,
}

// pdfmake は CommonJS シングルトン。フォント設定はモジュールスコープで1回だけ行う
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfmake = require("pdfmake/js/index.js") as {
  setFonts: (fonts: Record<string, Record<string, string>>) => void
  createPdf: (docDefinition: TDocumentDefinitions) => { getBuffer: () => Promise<Buffer> }
}
pdfmake.setFonts({
  NotoSansJP: {
    normal: FONT_PATH,
    bold: FONT_PATH,
  },
})

function shortDate(ymd: string): string {
  const [, m, d] = ymd.split("-")
  return `${Number(m)}/${Number(d)}`
}

function sectionHeader(text: string): Content {
  return {
    text,
    fontSize: 12,
    margin: [0, 16, 0, 6],
    color: "#44403c",
  }
}

function headerCell(text: string): TableCell {
  return { text, fontSize: 8, color: "#57534e", fillColor: HEADER_BG }
}

function dataCell(text: string | number): TableCell {
  return { text: String(text), fontSize: 9 }
}

function buildTable(
  title: string,
  headers: string[],
  widths: (string | number)[],
  rows: (string | number)[][],
): Content[] {
  if (rows.length === 0) {
    return [
      sectionHeader(title),
      { text: "データなし", fontSize: 9, color: "#a8a29e", margin: [0, 0, 0, 8] } as Content,
    ]
  }
  return [
    sectionHeader(title),
    {
      table: {
        headerRows: 1,
        widths,
        body: [headers.map(headerCell), ...rows.map((r) => r.map(dataCell))],
      },
      layout: TABLE_LAYOUT,
    } as Content,
  ]
}

function formatDate(ymd: string): string {
  return ymd.replace(/-/g, "/")
}

export async function generateBabyReport(input: BabyReportInput): Promise<Buffer> {
  const periodLabel = `${formatDate(input.startDate)} 〜 ${formatDate(input.endDate)}`

  const docDefinition: TDocumentDefinitions = {
    defaultStyle: { font: "NotoSansJP", fontSize: 9 },
    pageSize: "A4",
    pageMargins: [40, 40, 40, 40],
    content: [
      { text: "育児記録レポート", fontSize: 18, margin: [0, 0, 0, 12] } as Content,
      {
        columns: [
          { text: `名前: ${input.babyName}`, width: "auto" },
          { text: `生年月日: ${input.birthDate}`, width: "auto" },
          { text: `月齢: ${input.age}`, width: "auto" },
        ],
        columnGap: 20,
        fontSize: 10,
        margin: [0, 0, 0, 4],
      } as Content,
      { text: `期間: ${periodLabel}`, fontSize: 10, margin: [0, 0, 0, 8] } as Content,
      {
        canvas: [{ type: "line", x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 0.5, lineColor: BORDER_COLOR }],
        margin: [0, 0, 0, 4],
      } as Content,
      ...buildTable("授乳記録", ["日付", "合計", "母乳", "ミルク", "離乳食", "ミルク平均(ml)"], ["auto", "auto", "auto", "auto", "auto", "*"],
        input.feedings.map((f) => [shortDate(f.date), f.totalCount, f.breastCount, f.bottleCount, f.solidCount, f.avgBottleMl ?? "-"]),
      ),
      ...buildTable("睡眠記録", ["日付", "合計時間", "回数"], ["auto", "*", "auto"],
        input.sleep.map((s) => [shortDate(s.date), formatElapsedMinutes(s.totalMinutes), s.sessionCount]),
      ),
      ...buildTable("おむつ記録", ["日付", "合計", "おしっこ", "うんち", "両方"], ["auto", "auto", "auto", "auto", "*"],
        input.diapers.map((d) => [shortDate(d.date), d.totalCount, d.peeCount, d.poopCount, d.bothCount]),
      ),
      ...buildTable("体温記録", ["日付", "時刻", "体温(℃)"], ["auto", "auto", "*"],
        input.temperatures.map((t) => [shortDate(t.date), t.time, t.temperature.toFixed(1)]),
      ),
      ...buildTable("成長記録", ["日付", "体重(g)", "身長(cm)"], ["auto", "*", "*"],
        input.growth.map((g) => [shortDate(g.date), g.weightG ?? "-", g.heightCm != null ? g.heightCm.toFixed(1) : "-"]),
      ),
    ],
    footer: (currentPage: number, pageCount: number) => ({
      text: `${currentPage} / ${pageCount}`,
      alignment: "center" as const,
      fontSize: 8,
      color: "#a8a29e",
      margin: [0, 10, 0, 0],
    }),
  }

  const doc = pdfmake.createPdf(docDefinition)
  return doc.getBuffer()
}
