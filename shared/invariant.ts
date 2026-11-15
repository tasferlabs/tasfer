/**
 * invariant — a Lexical-style internal assertion, shared across the whole Tasfer
 * codebase (the `@tasfer/*` packages and the apps). Imported via the
 * `@shared/*` path alias: `import { invariant } from "@shared/invariant"`.
 *
 * An invariant asserts something the program's OWN code is supposed to
 * guarantee. It is the right tool for "can't happen unless there's a bug"
 * backstops — a violated caller precondition, an unreachable branch, a missing
 * React context provider, a not-yet-initialized singleton accessed too early.
 * It is the WRONG tool for conditions a user/host/network can legitimately
 * produce (bad input, a missing asset, an HTTP failure); those deserve a normal
 * `Error` (or a domain-specific typed error a caller can catch and recover on).
 *
 * Lives in the repo-root `shared/` folder rather than inside one package so it
 * carries no domain coupling — an {@link InvariantError} is deliberately a plain
 * `Error`, not (for example) a domain-specific error base, so a host catching
 * recoverable errors never accidentally swallows a bug.
 */

/**
 * Thrown by {@link invariant} when a check fails. It means a bug, not bad
 * input. It is a plain `Error` subclass, so code that catches recoverable
 * errors will not swallow it by accident.
 */
export class InvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvariantError";
  }
}

/**
 * Check something that must be true unless there is a bug. Throws an
 * {@link InvariantError} when `condition` is falsy. Otherwise TypeScript treats
 * `condition` as true after the call, so a nullable value becomes non-null.
 *
 * Each `%s` in `message` is replaced by the next value in `args`. The message
 * is only built when the check fails.
 *
 * ```ts
 * invariant(ctx, "useAuth must be used within an AuthProvider");
 * invariant(text.length > 0, "insertChars: empty text in block %s", blockId);
 * ```
 */
export function invariant(
  condition: unknown,
  message: string,
  ...args: (string | number)[]
): asserts condition {
  if (condition) return;
  let i = 0;
  const formatted = message.replace(/%s/g, () =>
    i < args.length ? String(args[i++]) : "%s",
  );
  throw new InvariantError(formatted);
}
