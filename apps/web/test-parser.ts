import { loadPage } from "./src/deserializer/loadPage";
import tokenizePage, { stringifyToken } from "./src/deserializer/tokenizer";

const testContent = `# Heading 1
This is **bold text** and this is *italic text*.

## Heading 2
You can also have **bold with *nested italic* text** here.

### Heading 3
Here is ~~strikethrough~~ and \`code text\` formatting.

This is a paragraph with **bold**, *italic*, ~~strikethrough~~, and \`code\` all together.`;

console.log("=== Testing Tokenizer ===\n");
const tokens = tokenizePage(testContent);
console.log("Tokens:");
tokens.forEach((token, i) => {
  console.log(`${i}: ${stringifyToken(token)}`);
});

console.log("\n=== Testing Parser ===\n");
const page = loadPage(testContent);
console.log("Parsed Page:");
console.log(JSON.stringify(page, null, 2));

console.log("\n=== Block Details ===\n");
page.blocks.forEach((block, i) => {
  console.log(`Block ${i} (${block.type}):`);
  block.content.forEach((text, j) => {
    console.log(`  Text ${j}:`, {
      content: text.content,
      formats: text.formats || 'none'
    });
  });
  console.log();
});

