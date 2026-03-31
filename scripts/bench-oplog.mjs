/**
 * Op log size benchmark
 * Estimates SQLite ops table size for realistic Cypher usage patterns.
 *
 * Run: node scripts/bench-oplog.mjs
 */

// Realistic ID shapes matching current implementation
const PEER_ID = "aZbY3xKm9pQ2wR4t";  // nanoid(16)
const PAGE_ID = "aBcDeFgHiJ";  // nanoid(10)
const BLOCK_ID = `b-${PEER_ID}:0`;

// ---------------------------------------------------------------------------
// Op generators
// ---------------------------------------------------------------------------

function makeTextInsert(counter, afterCounter) {
  return {
    id: `${PEER_ID}:${counter}`,
    clock: { counter, peerId: PEER_ID },
    pageId: PAGE_ID,
    op: "text_insert",
    blockId: BLOCK_ID,
    afterCharId: afterCounter === null ? null : `${PEER_ID}:${afterCounter}`,
    charRuns: [
      { peerId: PEER_ID, startCounter: counter, text: "a", deletedMask: 0 },
    ],
  };
}

function makeTextDelete(counter, targetCounter) {
  return {
    id: `${PEER_ID}:${counter}`,
    clock: { counter, peerId: PEER_ID },
    pageId: PAGE_ID,
    op: "text_delete",
    blockId: BLOCK_ID,
    charIds: [`${PEER_ID}:${targetCounter}`],
  };
}

function makeBlockInsert(counter) {
  return {
    id: `${PEER_ID}:${counter}`,
    clock: { counter, peerId: PEER_ID },
    pageId: PAGE_ID,
    op: "block_insert",
    afterBlockId: null,
    blockId: `b-${PEER_ID}:${counter}`,
    blockType: "paragraph",
  };
}

function makeFormatSet(counter, targetCounter) {
  return {
    id: `${PEER_ID}:${counter}`,
    clock: { counter, peerId: PEER_ID },
    pageId: PAGE_ID,
    op: "format_set",
    blockId: BLOCK_ID,
    charIds: [`${PEER_ID}:${targetCounter}`],
    format: "bold",
    value: true,
  };
}

// ---------------------------------------------------------------------------
// Measure serialized size (what goes into the data BLOB column)
// ---------------------------------------------------------------------------

function opBytes(op) {
  return new TextEncoder().encode(JSON.stringify(op)).length;
}

// SQLite row overhead beyond the data blob:
// INTEGER pk (8), scope_id TEXT (10+varint), peer_id TEXT (6+varint),
// clock INTEGER (8), type TEXT (~12+varint), timestamp INTEGER (8),
// target_key TEXT (nullable, ~10+varint), page/row header (~20).
// Conservative estimate: ~80 bytes per row excluding data blob.
const SQLITE_ROW_OVERHEAD = 80;

function rowBytes(op) {
  return opBytes(op) + SQLITE_ROW_OVERHEAD;
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

/**
 * Simulate realistic ops for a document of `charCount` characters.
 * Editing ratio: ~10% of chars get deleted and retyped (normal editing).
 * Format ratio: ~5% of chars get a format op.
 * Block ratio: 1 block per ~50 chars.
 */
function simulateDocument(charCount) {
  const ops = [];
  let counter = 0;
  const blockCount = Math.max(1, Math.floor(charCount / 50));

  // Block inserts
  for (let b = 0; b < blockCount; b++) {
    ops.push(makeBlockInsert(counter++));
  }

  // Text inserts (character by character, as per keystroke)
  const insertCounters = [];
  for (let i = 0; i < charCount; i++) {
    const afterCounter = i === 0 ? null : counter - 1;
    ops.push(makeTextInsert(counter, afterCounter));
    insertCounters.push(counter);
    counter++;
  }

  // Deletes (~10% of chars)
  const deleteCount = Math.floor(charCount * 0.1);
  for (let i = 0; i < deleteCount; i++) {
    const targetCounter = insertCounters[Math.floor(Math.random() * insertCounters.length)];
    ops.push(makeTextDelete(counter++, targetCounter));
  }

  // Format ops (~5% of chars)
  const formatCount = Math.floor(charCount * 0.05);
  for (let i = 0; i < formatCount; i++) {
    const targetCounter = insertCounters[Math.floor(Math.random() * insertCounters.length)];
    ops.push(makeFormatSet(counter++, targetCounter));
  }

  return ops;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatNum(n) {
  return n.toLocaleString();
}

// ---------------------------------------------------------------------------
// Run benchmarks
// ---------------------------------------------------------------------------

console.log("\n=== Cypher Op Log Size Benchmark ===\n");

// Per-op type sizes
console.log("--- Single op sizes (data BLOB only) ---");
const sampleInsert = makeTextInsert(1234, 1233);
const sampleDelete = makeTextDelete(1235, 1234);
const sampleBlock  = makeBlockInsert(1236);
const sampleFormat = makeFormatSet(1237, 1234);
console.log(`text_insert  : ${opBytes(sampleInsert)} bytes  (+ ${SQLITE_ROW_OVERHEAD}B row overhead = ${rowBytes(sampleInsert)}B total)`);
console.log(`text_delete  : ${opBytes(sampleDelete)} bytes  (+ ${SQLITE_ROW_OVERHEAD}B row overhead = ${rowBytes(sampleDelete)}B total)`);
console.log(`block_insert : ${opBytes(sampleBlock)} bytes  (+ ${SQLITE_ROW_OVERHEAD}B row overhead = ${rowBytes(sampleBlock)}B total)`);
console.log(`format_set   : ${opBytes(sampleFormat)} bytes  (+ ${SQLITE_ROW_OVERHEAD}B row overhead = ${rowBytes(sampleFormat)}B total)`);

// Note redundancy
const insertJson = JSON.stringify(sampleInsert);
const redundantFields = JSON.stringify({ scope_id: PAGE_ID, peer_id: PEER_ID, clock: 1234, type: "text_insert" });
console.log(`\nNote: ${redundantFields.length}B in data blob duplicates SQLite columns (pageId, peerId, clock, op)`);

console.log("\n--- Document scale projections ---");
console.log(
  "Chars".padEnd(12),
  "Pages".padEnd(8),
  "Ops".padEnd(10),
  "Data BLOBs".padEnd(14),
  "Total (w/ overhead)"
);
console.log("-".repeat(60));

const scales = [
  { label: "tiny note",      chars: 500,    pages: 1 },
  { label: "medium page",    chars: 3_000,  pages: 1 },
  { label: "large page",     chars: 10_000, pages: 1 },
  { label: "10 pages",       chars: 3_000,  pages: 10 },
  { label: "100 pages",      chars: 3_000,  pages: 100 },
  { label: "1000 pages",     chars: 3_000,  pages: 1000 },
  { label: "heavy (10k×100)",chars: 10_000, pages: 100 },
];

for (const scale of scales) {
  const singlePageOps = simulateDocument(scale.chars);
  const totalOps = singlePageOps.length * scale.pages;
  const blobBytes = singlePageOps.reduce((s, op) => s + opBytes(op), 0) * scale.pages;
  const totalBytes = singlePageOps.reduce((s, op) => s + rowBytes(op), 0) * scale.pages;

  console.log(
    `${scale.label}`.padEnd(20),
    `${formatNum(totalOps)} ops`.padEnd(14),
    formatBytes(blobBytes).padEnd(14),
    formatBytes(totalBytes)
  );
}

console.log("\n--- Typing speed break-even ---");
// At 60 WPM, 5 chars/word = 300 chars/min = 18,000 chars/hour of continuous typing
const charsPerHour = 18_000;
const singleOps = simulateDocument(charsPerHour);
const bytesPerHour = singleOps.reduce((s, op) => s + rowBytes(op), 0);
console.log(`60 WPM for 1 hour  → ${formatNum(singleOps.length)} ops → ${formatBytes(bytesPerHour)}/hour of active editing`);
console.log(`60 WPM for 8 hours → ${formatBytes(bytesPerHour * 8)} (heavy writing day)`);

console.log("\n--- When snapshots start to matter ---");
// Snapshot threshold: when do we want to compact?
const thresholds = [10, 50, 100, 500].map(mb => {
  const bytes = mb * 1024 * 1024;
  const avgOpSize = rowBytes(sampleInsert); // ~200B
  const ops = Math.floor(bytes / avgOpSize);
  const chars = Math.floor(ops / 1.15); // ~1.15x ops per char (inserts + overhead)
  return { mb, ops, chars };
});
for (const { mb, ops, chars } of thresholds) {
  console.log(`${mb} MB → ~${formatNum(ops)} ops → ~${formatNum(chars)} net characters written`);
}

console.log("\nConclusion:");
console.log("  • A typical user (100 pages × 3K chars) uses ~10-15 MB — no concern.");
console.log("  • A power user (1000 pages × 3K chars) reaches ~100-150 MB — still fine for local SQLite.");
console.log("  • Snapshots become worth it around 500MB+ (multi-year heavy use).");
console.log("  • Main redundancy: data BLOB re-encodes fields already in columns (~80B/op wasted).");
console.log("");
