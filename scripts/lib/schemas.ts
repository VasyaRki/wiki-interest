import { z } from "zod";

/** Wikimedia language codes: lowercase letters with optional hyphen segments (e.g. "uk", "zh-yue", "be-tarask"). */
export const langCodeSchema = z
  .string()
  .regex(/^[a-z]{2,3}(-[a-z0-9]+)*$/, "language code must look like 'uk' or 'zh-yue'");

export const langsListSchema = z
  .string()
  .transform((s) => s.split(",").map((v) => v.trim()).filter(Boolean))
  .pipe(z.array(langCodeSchema).min(1, "at least one language is required"));

export const qidSchema = z.string().regex(/^Q[1-9][0-9]*$/, "Wikidata QID must look like 'Q12345'");

/** YYYY-MM month string. */
export const yearMonthSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "date must be in YYYY-MM format");

export const periodSchema = z
  .string()
  .regex(/^\d+m$/, "period must look like '24m'");

export const excludeRangeSchema = z
  .string()
  .regex(
    /^\d{4}-(0[1-9]|1[0-2]):\d{4}-(0[1-9]|1[0-2])$/,
    "exclude range must look like '2020-03:2020-06'",
  );

export const runIdSchema = z.string().regex(/^r_\d{8}_[a-z0-9]+$/, "run id must look like 'r_20260925_ab12'");

export const resolveInputSchema = z.object({
  topic: z.string().min(1, "--topic is required"),
  langs: langsListSchema,
  searchLang: langCodeSchema.default("en"),
});
export type ResolveInput = z.infer<typeof resolveInputSchema>;

export const analyzeInputSchema = z
  .object({
    qids: z.array(qidSchema).optional(),
    topic: z.string().min(1).optional(),
    // Optional: --run can supply langs from a previous run when omitted here.
    langs: langsListSchema.optional(),
    period: periodSchema.optional(),
    from: yearMonthSchema.optional(),
    to: yearMonthSchema.optional(),
    exclude: z.array(excludeRangeSchema).optional(),
    run: runIdSchema.optional(),
    rankBy: z.enum(["level", "growth"]).optional(),
  })
  .refine((v) => (v.qids && v.qids.length > 0) || v.topic || v.run, {
    message: "one of --qid, --topic, or --run is required",
  })
  .refine((v) => v.langs !== undefined || v.run !== undefined, {
    message: "--langs is required unless --run is given",
  })
  .refine((v) => !(v.from && !v.to) && !(v.to && !v.from), {
    message: "--from and --to must be given together",
  })
  .refine((v) => !(v.period && (v.from || v.to)), {
    message: "--period cannot be combined with --from/--to",
  });
export type AnalyzeInput = z.infer<typeof analyzeInputSchema>;

export const reportInputSchema = z.object({
  run: runIdSchema,
  question: z.string().optional(),
  lang: z.enum(["uk", "en"]).default("en"),
});
export type ReportInput = z.infer<typeof reportInputSchema>;

export const runsInputSchema = z.object({
  limit: z.coerce.number().int().positive().max(100).default(20),
});
export type RunsInput = z.infer<typeof runsInputSchema>;

export const resolveOutputSchema = z.object({
  ok: z.literal(true),
  topic: z.string(),
  search_lang: langCodeSchema,
  candidates: z.array(
    z.object({ qid: qidSchema, label: z.string(), description: z.string().nullable() }),
  ),
  needs_confirmation: z.boolean(),
  best_qid: qidSchema.nullable(),
  articles: z.record(z.string(), z.string().nullable()).nullable(),
  notes: z.array(z.string()),
});
export type ResolveOutput = z.infer<typeof resolveOutputSchema>;

const anomalyOutputSchema = z.object({
  month: yearMonthSchema,
  views: z.number().int(),
  z: z.number(),
});

const perLanguageOutputSchema = z.object({
  lang: langCodeSchema,
  articles: z.array(z.string()),
  /** null when the language has no article: nothing was measured. */
  avg_monthly_views: z.number().nullable(),
  share_per_million: z.number().nullable(),
  yoy_growth_raw_pct: z.number().nullable(),
  yoy_growth_normalized_pct: z.number().nullable(),
  trend_slope_pct_per_year: z.number().nullable(),
  trend_p_value: z.number().nullable(),
  seasonality: z.string(),
  anomalies: z.array(anomalyOutputSchema),
  confidence: z.enum(["low", "medium", "high"]),
  confidence_reasons: z.array(z.string()),
});

export const analyzeOutputSchema = z.object({
  ok: z.literal(true),
  run_id: runIdSchema,
  question_scope: z.object({
    qids: z.array(qidSchema),
    langs: z.array(langCodeSchema),
    from: yearMonthSchema,
    to: yearMonthSchema,
    /** Optional so runs stored before --rank-by existed still parse. */
    rank_by: z.enum(["level", "growth"]).optional(),
  }),
  per_language: z.array(perLanguageOutputSchema),
  ranking: z.array(langCodeSchema),
  summary: z.string(),
  caveats: z.array(z.string()),
  chart_path: z.string().nullable(),
});
export type AnalyzeOutput = z.infer<typeof analyzeOutputSchema>;

export const runSummaryOutputSchema = z.object({
  run_id: runIdSchema,
  created_at: z.string(),
  topic: z.string().nullable(),
  qids: z.array(qidSchema),
  langs: z.array(langCodeSchema),
  from: yearMonthSchema,
  to: yearMonthSchema,
});

export const runsOutputSchema = z.object({
  ok: z.literal(true),
  runs: z.array(runSummaryOutputSchema),
});
export type RunsOutput = z.infer<typeof runsOutputSchema>;

export const reportOutputSchema = z.object({
  ok: z.literal(true),
  run_id: runIdSchema,
  pdf_path: z.string(),
});
export type ReportOutput = z.infer<typeof reportOutputSchema>;
