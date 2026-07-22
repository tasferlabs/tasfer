import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");
const sectionCount = 100;
const outputPath = resolve(
  repositoryRoot,
  `test-documents/large-all-blocks-${sectionCount}.md`,
);

const sections = [];

for (let number = 1; number <= sectionCount; number++) {
  sections.push(`# Test section ${number}`);
  sections.push("");
  sections.push(`## Secondary heading ${number}`);
  sections.push("");
  sections.push(`### Tertiary heading ${number}`);
  sections.push("");
  sections.push(
    `Paragraph ${number} contains **bold ${number}**, *italic ${number}*, ~~strikethrough ${number}~~, \`inline code ${number}\`, [link ${number}](https://example.com/test/${number}), and inline math $x_${number} + y_${number} = z_${number}$.`,
  );
  sections.push("");
  sections.push(`- Bullet item ${number}`);
  sections.push(`  - Nested bullet item ${number}`);
  sections.push("");
  sections.push(`${number}. Numbered item ${number}`);
  sections.push(`  1. Nested numbered item ${number}`);
  sections.push("");
  sections.push(`- [ ] Unchecked task ${number}`);
  sections.push(`- [x] Checked task ${number}`);
  sections.push("");
  sections.push(`![Test image ${number}](../logo.png)`);
  sections.push("");
  sections.push("```ts");
  sections.push(`const testNumber = ${number};`);
  sections.push(
    `console.log(\`Code block \${testNumber} of ${sectionCount}\`);`,
  );
  sections.push("```");
  sections.push("");
  sections.push("$$");
  sections.push(
    `\\sum_{i=1}^{${number}} i = \\frac{${number}(${number} + 1)}{2}`,
  );
  sections.push("$$");
  sections.push("");
  sections.push("---");
  sections.push("");
}

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${sections.join("\n")}\n`, "utf8");

console.log(`Generated ${outputPath}`);
