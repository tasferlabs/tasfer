/**
 * Fractional indexing — generate compact, sortable string keys that always have
 * room for another key strictly between any two existing ones.
 *
 * Block order is modelled as a single per-block `orderKey`; the document order
 * is `sort by (orderKey, id)`. Inserting "between X and Y" means minting a key
 * `X.orderKey < key < Y.orderKey`, and moving a block is a single LWW write of
 * its `orderKey`. This keeps ordering a pure function of per-block values, so it
 * converges under concurrency without any neighbour bookkeeping.
 *
 * Algorithm and structure (integer-length header + fractional tail, so keys
 * never collide on a shared prefix and stay short under repeated subdivision)
 * are the well-known scheme by David Greenspan / Figma, ported from the
 * MIT-licensed `fractional-indexing` package (github.com/rocicorp/fractional-indexing).
 * Vendored rather than depended-on to keep the editor core dependency-light and
 * to own the CRDT-critical ordering primitive directly.
 *
 * A key is `<integer part><fractional part>`. The integer part's first
 * character encodes its own length, so the boundary between integer and
 * fraction is self-describing. Lexicographic string comparison of whole keys
 * yields the intended numeric order.
 */

/** Base-62, already in ascending ASCII order so string compare == digit order. */
const BASE_62_DIGITS =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/**
 * Length of the integer part given its head character. Uppercase heads count
 * down from `Z` (shorter integers), lowercase heads count up from `a` (longer
 * integers); this lets the integer part grow unbounded in both directions while
 * staying self-delimiting.
 */
function getIntegerLength(head: string): number {
  if (head >= "a" && head <= "z") {
    return head.charCodeAt(0) - "a".charCodeAt(0) + 2;
  } else if (head >= "A" && head <= "Z") {
    return "Z".charCodeAt(0) - head.charCodeAt(0) + 2;
  }
  throw new Error("invalid order key head: " + head);
}

function getIntegerPart(key: string): string {
  const len = getIntegerLength(key.charAt(0));
  if (len > key.length) {
    throw new Error("invalid order key: " + key);
  }
  return key.slice(0, len);
}

function validateInteger(int: string): void {
  if (int.length !== getIntegerLength(int.charAt(0))) {
    throw new Error("invalid integer part of order key: " + int);
  }
}

function validateOrderKey(key: string, digits: string): void {
  // "A" + smallest digit repeated is reserved as the lower sentinel.
  if (key === "A" + digits.charAt(0).repeat(26)) {
    throw new Error("invalid order key: " + key);
  }
  const i = getIntegerPart(key);
  const f = key.slice(i.length);
  if (f.charAt(f.length - 1) === digits.charAt(0)) {
    // Fractional parts never end in the zero digit (it would be redundant and
    // break the strict-between invariant).
    throw new Error("invalid order key: " + key);
  }
}

function incrementInteger(x: string, digits: string): string | null {
  validateInteger(x);
  const [head, ...digs] = x.split("");
  let carry = true;
  for (let i = digs.length - 1; carry && i >= 0; i--) {
    const d = digits.indexOf(digs[i]) + 1;
    if (d === digits.length) {
      digs[i] = digits.charAt(0);
    } else {
      digs[i] = digits.charAt(d);
      carry = false;
    }
  }
  if (carry) {
    if (head === "Z") return "a" + digits.charAt(0);
    if (head === "z") return null;
    const h = String.fromCharCode(head.charCodeAt(0) + 1);
    if (h > "a") {
      digs.push(digits.charAt(0));
    } else {
      digs.pop();
    }
    return h + digs.join("");
  }
  return head + digs.join("");
}

function decrementInteger(x: string, digits: string): string | null {
  validateInteger(x);
  const [head, ...digs] = x.split("");
  let borrow = true;
  for (let i = digs.length - 1; borrow && i >= 0; i--) {
    const d = digits.indexOf(digs[i]) - 1;
    if (d === -1) {
      digs[i] = digits.charAt(digits.length - 1);
    } else {
      digs[i] = digits.charAt(d);
      borrow = false;
    }
  }
  if (borrow) {
    if (head === "a") return "Z" + digits.charAt(digits.length - 1);
    if (head === "A") return null;
    const h = String.fromCharCode(head.charCodeAt(0) - 1);
    if (h < "Z") {
      digs.push(digits.charAt(digits.length - 1));
    } else {
      digs.pop();
    }
    return h + digs.join("");
  }
  return head + digs.join("");
}

/**
 * Midpoint of the fractional parts `a` and `b` (both null-terminated open
 * bounds, `b === null` meaning "+infinity"). Returns a fractional string `f`
 * with `a < f < b`. Recurses past any shared prefix so keys stay short.
 */
function midpoint(a: string, b: string | null, digits: string): string {
  const zero = digits.charAt(0);
  if (b !== null && a >= b) {
    throw new Error(a + " >= " + b);
  }
  if (a.slice(-1) === zero || (b && b.slice(-1) === zero)) {
    throw new Error("trailing zero");
  }
  if (b) {
    // Strip the longest common prefix, padding `a` with zeros as needed.
    let n = 0;
    while ((a.charAt(n) || zero) === b.charAt(n)) {
      n++;
    }
    if (n > 0) {
      return b.slice(0, n) + midpoint(a.slice(n), b.slice(n), digits);
    }
  }
  const digitA = a ? digits.indexOf(a.charAt(0)) : 0;
  const digitB = b !== null ? digits.indexOf(b.charAt(0)) : digits.length;
  if (digitB - digitA > 1) {
    const midDigit = Math.round(0.5 * (digitA + digitB));
    return digits.charAt(midDigit);
  }
  if (b && b.length > 1) {
    return b.slice(0, 1);
  }
  // First digits are consecutive; descend into `a`'s tail.
  return digits.charAt(digitA) + midpoint(a.slice(1), null, digits);
}

/**
 * Generate a key strictly between `a` and `b` (string compare). `a === null`
 * means "before everything" (head), `b === null` means "after everything"
 * (tail). With both null, returns the canonical first key.
 *
 * @throws if `a >= b`.
 */
export function generateKeyBetween(
  a: string | null,
  b: string | null,
  digits: string = BASE_62_DIGITS,
): string {
  if (a !== null) validateOrderKey(a, digits);
  if (b !== null) validateOrderKey(b, digits);
  if (a !== null && b !== null && a >= b) {
    throw new Error(a + " >= " + b);
  }
  if (a === null) {
    if (b === null) {
      return "a" + digits.charAt(0);
    }
    const ib = getIntegerPart(b);
    const fb = b.slice(ib.length);
    if (ib === "A" + digits.charAt(0).repeat(26)) {
      return ib + midpoint("", fb, digits);
    }
    if (ib < b) {
      return ib;
    }
    const res = decrementInteger(ib, digits);
    if (res === null) throw new Error("cannot decrement any more");
    return res;
  }
  if (b === null) {
    const ia = getIntegerPart(a);
    const fa = a.slice(ia.length);
    const i = incrementInteger(ia, digits);
    return i === null ? ia + midpoint(fa, null, digits) : i;
  }
  const ia = getIntegerPart(a);
  const fa = a.slice(ia.length);
  const ib = getIntegerPart(b);
  const fb = b.slice(ib.length);
  if (ia === ib) {
    return ia + midpoint(fa, fb, digits);
  }
  const i = incrementInteger(ia, digits);
  if (i === null) throw new Error("cannot increment any more");
  if (i < b) {
    return i;
  }
  return ia + midpoint(fa, null, digits);
}

/**
 * Generate `n` keys evenly distributed strictly between `a` and `b`, in
 * ascending order. Used for the initial load chain and multi-block paste.
 */
export function generateNKeysBetween(
  a: string | null,
  b: string | null,
  n: number,
  digits: string = BASE_62_DIGITS,
): string[] {
  if (n === 0) return [];
  if (n === 1) return [generateKeyBetween(a, b, digits)];
  if (b === null) {
    let c = generateKeyBetween(a, b, digits);
    const result = [c];
    for (let i = 0; i < n - 1; i++) {
      c = generateKeyBetween(c, b, digits);
      result.push(c);
    }
    return result;
  }
  if (a === null) {
    let c = generateKeyBetween(a, b, digits);
    const result = [c];
    for (let i = 0; i < n - 1; i++) {
      c = generateKeyBetween(a, c, digits);
      result.push(c);
    }
    result.reverse();
    return result;
  }
  const mid = Math.floor(n / 2);
  const c = generateKeyBetween(a, b, digits);
  return [
    ...generateNKeysBetween(a, c, mid, digits),
    c,
    ...generateNKeysBetween(c, b, n - mid - 1, digits),
  ];
}
