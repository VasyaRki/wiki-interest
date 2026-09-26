import { existsSync, mkdirSync, readFileSync, createWriteStream } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import PDFDocument from "pdfkit";
import SVGtoPDF from "svg-to-pdfkit";
import type { Cache } from "./cache.js";
import { WikiInterestError } from "./errors.js";
import type { AnalyzeOutput } from "./schemas.js";

const FONT_REGULAR_PATH = fileURLToPath(new URL("../../assets/fonts/DejaVuSans.ttf", import.meta.url));
const FONT_BOLD_PATH = fileURLToPath(new URL("../../assets/fonts/DejaVuSans-Bold.ttf", import.meta.url));

const MARGIN = 40;
const PAGE_WIDTH = 595.28; // A4, pt
const PAGE_HEIGHT = 841.89;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const FOOTER_HEIGHT = 110; // fixed region at the bottom: assumptions/limitations + retrieval date + source
const CHART_MAX_HEIGHT = 180;
const TABLE_ROW_HEIGHT = 15;
const TABLE_HEADER_HEIGHT = 17;

const COLUMN_WIDTHS = { lang: 65, views: 90, share: 80, yoy: 100, trend: 80, confidence: 100 } as const;

type ReportLang = "en" | "uk";

interface Labels {
  title: string;
  generated: (date: string) => string;
  question: string;
  scopeFallback: (topicOrQids: string, langs: string, period: string) => string;
  tableHeaders: [string, string, string, string, string, string];
  assumptions: string;
  assumptionsList: string[];
  dataRetrieved: string;
  source: string;
  chartUnavailable: string;
  truncatedNote: (shown: number, total: number) => string;
  confidence: Record<"low" | "medium" | "high", string>;
  na: string;
}

const LABELS: Record<ReportLang, Labels> = {
  en: {
    title: "Wikipedia Interest Report",
    generated: (date) => `Generated ${date}`,
    question: "Question",
    scopeFallback: (topicOrQids, langs, period) => `${topicOrQids} — languages: ${langs} — period: ${period}`,
    tableHeaders: ["Language", "Avg. monthly views", "Share/million", "YoY growth (norm.)", "Trend %/yr", "Confidence"],
    assumptions: "Assumptions & limitations",
    assumptionsList: [
      "Pageviews measure page visits, not purchase intent or willingness to pay.",
      "Overall Wikipedia traffic is declining; figures are normalized as share-per-million views to correct for this.",
      "Bot traffic is excluded (agent=user), but some automated or proxy traffic may remain.",
      "The same Wikidata topic can map to differently-scoped articles across language editions.",
    ],
    dataRetrieved: "Data retrieved",
    source: "Source",
    chartUnavailable: "Chart unavailable for this run.",
    truncatedNote: (shown, total) => `Showing ${shown} of ${total} languages. Run analyze for the full list.`,
    confidence: { low: "low", medium: "medium", high: "high" },
    na: "—",
  },
  uk: {
    title: "Звіт про інтерес у Вікіпедії",
    generated: (date) => `Сформовано ${date}`,
    question: "Питання",
    scopeFallback: (topicOrQids, langs, period) => `${topicOrQids} — мови: ${langs} — період: ${period}`,
    tableHeaders: ["Мова", "Сер. перегляди/міс.", "Частка/млн", "Річний приріст (норм.)", "Тренд %/рік", "Довіра"],
    assumptions: "Припущення та обмеження",
    assumptionsList: [
      "Перегляди сторінок показують відвідуваність, а не готовність платити.",
      "Загальний трафік Вікіпедії знижується; показники нормалізовано як частку на мільйон переглядів, щоб це врахувати.",
      "Трафік ботів виключено (agent=user), але частина автоматизованого трафіку може залишатися.",
      "Один і той самий предмет Wikidata може відповідати статтям різного обсягу в різних мовних розділах.",
    ],
    dataRetrieved: "Дані отримано",
    source: "Джерело",
    chartUnavailable: "Графік недоступний для цього запуску.",
    truncatedNote: (shown, total) => `Показано ${shown} з ${total} мов. Повний список — команда analyze.`,
    confidence: { low: "низька", medium: "середня", high: "висока" },
    na: "—",
  },
};

export interface GenerateReportInput {
  runId: string;
  question?: string | undefined;
  lang: ReportLang;
  outDir: string;
}

function formatThousands(n: number): string {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function formatPct(n: number | null, na: string): string {
  if (n === null) return na;
  return `${n > 0 ? "+" : ""}${n}%`;
}

/** Scales (w,h) to fit within (maxW,maxH), preserving aspect ratio, never upscaling. */
function fitWithin(w: number, h: number, maxW: number, maxH: number): { width: number; height: number } {
  const scale = Math.min(maxW / w, maxH / h, 1);
  return { width: w * scale, height: h * scale };
}

function loadChartSvg(chartPath: string | null): { svg: string; width: number; height: number } | null {
  if (!chartPath) return null;
  if (!existsSync(chartPath)) return null;
  const svg = readFileSync(chartPath, "utf8");
  const widthMatch = svg.match(/width="([\d.]+)"/);
  const heightMatch = svg.match(/height="([\d.]+)"/);
  if (!widthMatch || !heightMatch) return null;
  return { svg, width: Number(widthMatch[1]), height: Number(heightMatch[1]) };
}

/**
 * Renders a one-page A4 PDF for a stored run. Layout is computed top-down
 * with explicit y-coordinates (not pdfkit's auto-flowing cursor) so the
 * table's row count can be sized to whatever space remains above a
 * fixed-height footer, guaranteeing the page never overflows: see the
 * pageCount check at the end, which fails loudly if it ever would.
 */
export async function generateReport(cache: Cache, input: GenerateReportInput): Promise<string> {
  const run = cache.getRun(input.runId);
  if (!run) {
    throw new WikiInterestError(
      "run_not_found",
      `No stored run with id "${input.runId}".`,
      "Run the `runs` command to list available run ids, or run `analyze` first.",
    );
  }
  const result = run.result as AnalyzeOutput;
  const labels = LABELS[input.lang];

  const outDir = resolve(input.outDir);
  mkdirSync(outDir, { recursive: true });
  const pdfPath = join(outDir, `wiki-interest-${input.runId}-${input.lang}.pdf`);

  const doc = new PDFDocument({ size: "A4", margin: MARGIN, autoFirstPage: true });
  let pageCount = 1; // autoFirstPage's page is created before we can attach the listener below
  doc.on("pageAdded", () => {
    pageCount++;
  });
  doc.registerFont("Body", FONT_REGULAR_PATH);
  doc.registerFont("Body-Bold", FONT_BOLD_PATH);

  const streamDone = new Promise<void>((resolve, reject) => {
    const stream = createWriteStream(pdfPath);
    stream.on("finish", resolve);
    stream.on("error", reject);
    doc.pipe(stream);
  });

  let y = MARGIN;

  // ---- Header ----
  doc.font("Body-Bold").fontSize(16).text(labels.title, MARGIN, y, { width: CONTENT_WIDTH });
  y += doc.heightOfString(labels.title, { width: CONTENT_WIDTH }) + 2;
  const generatedText = labels.generated(run.createdAt.slice(0, 10));
  doc.font("Body").fontSize(8).fillColor("#555555").text(generatedText, MARGIN, y, { width: CONTENT_WIDTH });
  y += doc.heightOfString(generatedText, { width: CONTENT_WIDTH }) + 10;
  doc.fillColor("black");

  // ---- Question / scope ----
  const questionText =
    input.question ??
    labels.scopeFallback(
      run.topic ?? `QIDs: ${run.qids.join(", ")}`,
      run.langs.join(", "),
      `${run.from} – ${run.to}`,
    );
  doc.font("Body-Bold").fontSize(10).text(labels.question, MARGIN, y, { width: CONTENT_WIDTH });
  y += doc.heightOfString(labels.question, { width: CONTENT_WIDTH }) + 2;
  doc.font("Body").fontSize(10).text(questionText, MARGIN, y, { width: CONTENT_WIDTH });
  y += doc.heightOfString(questionText, { width: CONTENT_WIDTH }) + 8;

  // ---- Summary (2-3 sentence answer) ----
  doc.font("Body").fontSize(10).text(result.summary, MARGIN, y, { width: CONTENT_WIDTH });
  y += doc.heightOfString(result.summary, { width: CONTENT_WIDTH }) + 10;

  // ---- Chart ----
  const chart = loadChartSvg(result.chart_path);
  if (chart) {
    const { width, height } = fitWithin(chart.width, chart.height, CONTENT_WIDTH, CHART_MAX_HEIGHT);
    // preserveAspectRatio must be set explicitly: svg-to-pdfkit only honors
    // the width/height box at all when this is present (confirmed against
    // its source — otherwise it silently ignores both and draws the SVG at
    // its own native size, scaled only by the px->pt constant).
    SVGtoPDF(doc, chart.svg, MARGIN, y, { width, height, preserveAspectRatio: "xMinYMin meet" });
    y += height + 10;
  } else {
    doc.font("Body").fontSize(9).fillColor("#555555").text(labels.chartUnavailable, MARGIN, y, { width: CONTENT_WIDTH });
    y += doc.heightOfString(labels.chartUnavailable, { width: CONTENT_WIDTH }) + 10;
    doc.fillColor("black");
  }

  // ---- Per-language table (row count truncated to whatever space remains above the footer) ----
  const footerTop = PAGE_HEIGHT - MARGIN - FOOTER_HEIGHT;
  const tableAvailableHeight = footerTop - y - 8;
  const maxRows = Math.max(0, Math.floor((tableAvailableHeight - TABLE_HEADER_HEIGHT) / TABLE_ROW_HEIGHT));
  const rowsToShow = result.per_language.slice(0, maxRows);
  const truncated = result.per_language.length > rowsToShow.length;

  const colX = {
    lang: MARGIN,
    views: MARGIN + COLUMN_WIDTHS.lang,
    share: MARGIN + COLUMN_WIDTHS.lang + COLUMN_WIDTHS.views,
    yoy: MARGIN + COLUMN_WIDTHS.lang + COLUMN_WIDTHS.views + COLUMN_WIDTHS.share,
    trend: MARGIN + COLUMN_WIDTHS.lang + COLUMN_WIDTHS.views + COLUMN_WIDTHS.share + COLUMN_WIDTHS.yoy,
    confidence: MARGIN + COLUMN_WIDTHS.lang + COLUMN_WIDTHS.views + COLUMN_WIDTHS.share + COLUMN_WIDTHS.yoy + COLUMN_WIDTHS.trend,
  };

  if (rowsToShow.length > 0) {
    doc.font("Body-Bold").fontSize(8);
    doc.text(labels.tableHeaders[0], colX.lang, y, { width: COLUMN_WIDTHS.lang });
    doc.text(labels.tableHeaders[1], colX.views, y, { width: COLUMN_WIDTHS.views });
    doc.text(labels.tableHeaders[2], colX.share, y, { width: COLUMN_WIDTHS.share });
    doc.text(labels.tableHeaders[3], colX.yoy, y, { width: COLUMN_WIDTHS.yoy });
    doc.text(labels.tableHeaders[4], colX.trend, y, { width: COLUMN_WIDTHS.trend });
    doc.text(labels.tableHeaders[5], colX.confidence, y, { width: COLUMN_WIDTHS.confidence });
    y += TABLE_HEADER_HEIGHT;

    doc.font("Body").fontSize(8);
    for (const row of rowsToShow) {
      doc.text(row.lang, colX.lang, y, { width: COLUMN_WIDTHS.lang });
      doc.text(row.avg_monthly_views === null ? labels.na : formatThousands(row.avg_monthly_views), colX.views, y, { width: COLUMN_WIDTHS.views });
      doc.text(row.share_per_million === null ? labels.na : String(row.share_per_million), colX.share, y, { width: COLUMN_WIDTHS.share });
      doc.text(formatPct(row.yoy_growth_normalized_pct, labels.na), colX.yoy, y, { width: COLUMN_WIDTHS.yoy });
      doc.text(formatPct(row.trend_slope_pct_per_year, labels.na), colX.trend, y, { width: COLUMN_WIDTHS.trend });
      doc.text(labels.confidence[row.confidence], colX.confidence, y, { width: COLUMN_WIDTHS.confidence });
      y += TABLE_ROW_HEIGHT;
    }

    if (truncated) {
      const note = labels.truncatedNote(rowsToShow.length, result.per_language.length);
      doc.font("Body").fontSize(7).fillColor("#555555").text(note, MARGIN, y, { width: CONTENT_WIDTH });
      y += doc.heightOfString(note, { width: CONTENT_WIDTH });
      doc.fillColor("black");
    }
  }

  // ---- Footer: follows directly after the table, but never past the
  // reserved bottom region (which the table truncation above guarantees). ----
  let footerY = Math.min(y + 12, footerTop);
  doc.font("Body-Bold").fontSize(8).text(labels.assumptions, MARGIN, footerY, { width: CONTENT_WIDTH });
  footerY += doc.heightOfString(labels.assumptions, { width: CONTENT_WIDTH }) + 1;
  doc.font("Body").fontSize(7).fillColor("#555555");
  const assumptionsText = [...labels.assumptionsList, ...result.caveats].map((line) => `• ${line}`).join("\n");
  doc.text(assumptionsText, MARGIN, footerY, { width: CONTENT_WIDTH, height: FOOTER_HEIGHT - 30, ellipsis: true });
  doc.fillColor("black");

  const sourceY = PAGE_HEIGHT - MARGIN - 10;
  doc
    .font("Body")
    .fontSize(7)
    .fillColor("#555555")
    .text(
      `${labels.dataRetrieved}: ${run.createdAt.slice(0, 10)}. ${labels.source}: https://wikimedia.org/api/rest_v1/metrics/pageviews`,
      MARGIN,
      sourceY,
      { width: CONTENT_WIDTH },
    );
  doc.fillColor("black");

  doc.end();
  await streamDone;

  if (pageCount !== 1) {
    throw new WikiInterestError(
      "internal_error",
      `Report PDF rendered with ${pageCount} pages instead of exactly 1.`,
      "This is a report-layout bug; please report it rather than retrying.",
    );
  }

  return pdfPath;
}
