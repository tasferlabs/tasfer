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
 * Thrown by {@link invariant} when an internal invariant is violated. A plain
 * `Error` subclass (no domain base) so it crosses package boundaries without
 * dragging in a hierarchy, and so it escapes any domain-specific `catch` that's
 * meant for recoverable failures — an invariant means a bug, and a bug should
 * surface, not be quietly handled.
 */
export class InvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvariantError";
  }
}

/**
 * Assert an internal invariant. Throws an {@link InvariantError} when
 * `condition` is falsy; otherwise narrows `condition` via `asserts`, so the
 * compiler treats it as truthy afterwards (e.g. a nullable value becomes
 * non-null after `invariant(value, …)`).
 *
 * `%s` placeholders in `message` are substituted from `args` in order, so the
 * formatted string is only assembled on the failure path:
 *
 *   invariant(ctx, "useAuth must be used within an AuthProvider");
 *   invariant(text.length > 0, "insertChars: empty text in block %s", blockId);
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
