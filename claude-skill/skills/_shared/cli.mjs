// Shared CLI helpers for all ~/.claude skill scripts.
// Gives every helper a real, runtime-readable `--help`/`-h` so the model never
// has to guess flags, plus a consistent flag parser.
//
// Usage:
//   import { parseFlags, handleHelp } from "../../_shared/cli.mjs";
//   handleHelp(process.argv.slice(2), USAGE);   // prints USAGE + exit 0 on -h/--help/help
//   const { flags, positional } = parseFlags(rest);

// Parse "--key value" / "--flag" / positional args.
export function parseFlags(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next === undefined || next.startsWith("--")) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

// If the user asked for help (help / -h / --help, or no command at all when
// requireCommand is true), print `usage` to stdout and exit 0. Returns true if
// it handled help (caller can `return`), false otherwise.
export function handleHelp(args, usage, { requireCommand = false } = {}) {
  const asked = args.includes("--help") || args.includes("-h") || args[0] === "help";
  const empty = requireCommand && args.length === 0;
  if (asked || empty) {
    process.stdout.write(usage.trimEnd() + "\n");
    process.exit(0);
  }
  return false;
}

// Print an error + the usage, exit non-zero (for unknown commands / bad input).
export function usageError(msg, usage, code = 1) {
  console.error(`✖ ${msg}\n`);
  console.error(usage.trimEnd());
  process.exit(code);
}
