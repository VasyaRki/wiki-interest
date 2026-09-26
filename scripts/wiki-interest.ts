#!/usr/bin/env -S npx tsx
import "./lib/quiet-warnings.js";
import { Command } from "commander";
import {
  analyzeInputSchema,
  analyzeOutputSchema,
  reportInputSchema,
  reportOutputSchema,
  resolveInputSchema,
  resolveOutputSchema,
  runsInputSchema,
  runsOutputSchema,
} from "./lib/schemas.js";
import { emitError, emitSuccess, WikiInterestError } from "./lib/errors.js";
import { CommanderError } from "commander";
import { Cache } from "./lib/cache.js";
import { resolveTopic } from "./lib/resolve.js";
import { runAnalyze } from "./lib/analyze.js";
import { generateReport } from "./lib/report.js";

const program = new Command();

program
  .name("wiki-interest")
  .description("Analyze Wikipedia pageview trends for a topic across language editions.")
  .exitOverride() // let us control process.exit and error formatting
  .configureOutput({ writeErr: (str) => process.stderr.write(str) });

program
  .command("resolve")
  .description("Resolve a topic to a Wikidata entity and per-language article titles.")
  .requiredOption("--topic <text>", "topic to search for, e.g. \"intermittent fasting\"")
  .requiredOption("--langs <codes>", "comma-separated language codes, e.g. uk,pl,cs")
  .option("--search-lang <code>", "language to run the Wikidata search in", "en")
  .action(async (opts) => {
    const cache = new Cache();
    try {
      const input = resolveInputSchema.parse({
        topic: opts.topic,
        langs: opts.langs,
        searchLang: opts.searchLang,
      });
      const outcome = await resolveTopic(cache, input.topic, input.langs, input.searchLang);

      const notes: string[] = [];
      if (outcome.needsConfirmation) {
        notes.push(
          "Multiple plausible Wikidata entities match this topic. Show the candidate list to the user and ask which one they mean before calling analyze.",
        );
      } else if (outcome.articles) {
        for (const lang of input.langs) {
          if (outcome.articles[lang] === null) {
            notes.push(`No Wikipedia article in "${lang}" for this topic.`);
          }
        }
      }

      const output = resolveOutputSchema.parse({
        ok: true,
        topic: input.topic,
        search_lang: input.searchLang,
        candidates: outcome.candidates,
        needs_confirmation: outcome.needsConfirmation,
        best_qid: outcome.bestQid,
        articles: outcome.articles,
        notes,
      });
      emitSuccess(output);
    } catch (err) {
      emitError(err);
    } finally {
      cache.close();
    }
  });

program
  .command("analyze")
  .description("Compute pageview metrics for a topic across languages.")
  .option("--qid <id>", "Wikidata QID; repeat for a topic basket", (v, prev: string[]) => [...prev, v], [] as string[])
  .option("--topic <text>", "topic text (resolved implicitly if no --qid/--run)")
  .option("--langs <codes>", "comma-separated language codes, e.g. uk,pl,cs (inherited from --run if omitted)")
  .option("--period <n m>", "relative period, e.g. 24m")
  .option("--from <yyyy-mm>", "start month")
  .option("--to <yyyy-mm>", "end month")
  .option("--exclude <range>", "month range to exclude, e.g. 2020-03:2020-06; repeatable", (v, prev: string[]) => [...prev, v], [] as string[])
  .option("--run <run_id>", "reuse a previous run's articles and settings")
  .option("--rank-by <key>", "rank languages by: level (normalized share, default) or growth (trend slope); inherited from --run")
  .action(async (opts) => {
    const cache = new Cache();
    try {
      const input = analyzeInputSchema.parse({
        qids: opts.qid.length > 0 ? opts.qid : undefined,
        topic: opts.topic,
        langs: opts.langs,
        period: opts.period,
        from: opts.from,
        to: opts.to,
        exclude: opts.exclude.length > 0 ? opts.exclude : undefined,
        run: opts.run,
        rankBy: opts.rankBy,
      });
      const result = await runAnalyze(cache, input);
      emitSuccess(analyzeOutputSchema.parse(result));
    } catch (err) {
      emitError(err);
    } finally {
      cache.close();
    }
  });

program
  .command("report")
  .description("Render a one-page PDF report for a previous analyze run.")
  .requiredOption("--run <run_id>", "run id from analyze or runs")
  .option("--question <text>", "original user question, included in the report")
  .option("--lang <code>", "report language: uk or en", "en")
  .action(async (opts) => {
    const cache = new Cache();
    try {
      const input = reportInputSchema.parse({ run: opts.run, question: opts.question, lang: opts.lang });
      const pdfPath = await generateReport(cache, { runId: input.run, question: input.question, lang: input.lang, outDir: process.cwd() });
      emitSuccess(reportOutputSchema.parse({ ok: true, run_id: input.run, pdf_path: pdfPath }));
    } catch (err) {
      emitError(err);
    } finally {
      cache.close();
    }
  });

program
  .command("runs")
  .description("List recent analyze runs.")
  .option("--limit <n>", "max runs to list", "20")
  .action((opts) => {
    const cache = new Cache();
    try {
      const input = runsInputSchema.parse({ limit: opts.limit });
      const runs = cache.listRuns(input.limit).map((r) => ({
        run_id: r.runId,
        created_at: r.createdAt,
        topic: r.topic,
        qids: r.qids,
        langs: r.langs,
        from: r.from,
        to: r.to,
      }));
      emitSuccess(runsOutputSchema.parse({ ok: true, runs }));
    } catch (err) {
      emitError(err);
    } finally {
      cache.close();
    }
  });

try {
  await program.parseAsync();
} catch (err) {
  // exitOverride() makes commander throw instead of calling process.exit,
  // which keeps --help/--version output as plain text while any real parse
  // failure (unknown/missing option) still goes out as JSON per the error contract.
  if (err instanceof CommanderError) {
    if (["commander.helpDisplayed", "commander.version", "commander.help"].includes(err.code)) {
      process.exit(0);
    }
    emitError(
      new WikiInterestError(
        "invalid_input",
        err.message,
        "Check the command's options against SKILL.md and retry with corrected arguments.",
      ),
    );
  }
  emitError(err);
}
