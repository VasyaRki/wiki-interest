import { z } from "zod";

export const ErrorOutputSchema = z.object({
  ok: z.literal(false),
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
  hint: z.string(),
});

export type ErrorOutput = z.infer<typeof ErrorOutputSchema>;

export class WikiInterestError extends Error {
  readonly code: string;
  readonly hint: string;

  constructor(code: string, message: string, hint: string) {
    super(message);
    this.name = "WikiInterestError";
    this.code = code;
    this.hint = hint;
  }
}

export function toErrorOutput(err: unknown): ErrorOutput {
  if (err instanceof WikiInterestError) {
    return {
      ok: false,
      error: { code: err.code, message: err.message },
      hint: err.hint,
    };
  }
  if (err instanceof z.ZodError) {
    return {
      ok: false,
      error: { code: "invalid_input", message: err.issues.map((i) => i.message).join("; ") },
      hint: "Check the command's options against SKILL.md and retry with corrected arguments.",
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    ok: false,
    error: { code: "internal_error", message },
    hint: "This is an unexpected error. Do not retry automatically; report the exact command and message to the user.",
  };
}

/** Writes the single JSON error object to stdout and exits non-zero. */
export function emitError(err: unknown): never {
  const output = toErrorOutput(err);
  process.stdout.write(JSON.stringify(output) + "\n");
  process.exit(1);
}

/** Writes a single successful JSON object to stdout. */
export function emitSuccess(output: unknown): void {
  process.stdout.write(JSON.stringify(output) + "\n");
}
