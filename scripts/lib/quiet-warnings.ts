/**
 * Drops Node's "SQLite is an experimental feature" warning so agents don't
 * see two lines of noise on every call when NODE_NO_WARNINGS is unset.
 * Must be the first import of the CLI entry point: Node emits the warning
 * on nextTick, after this module has swapped the default listener.
 */
const defaultListeners = process.listeners("warning");
process.removeAllListeners("warning");
process.on("warning", (warning) => {
  if (warning.name === "ExperimentalWarning" && warning.message.includes("SQLite")) return;
  for (const listener of defaultListeners) listener(warning);
});
