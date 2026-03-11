const fs = require("fs");
const path = require("path");

const contentDir = path.join(__dirname, "../mcp/content");
const generatedDir = path.join(__dirname, "../mcp/generated");

if (!fs.existsSync(generatedDir)) {
  fs.mkdirSync(generatedDir, { recursive: true });
}

function generateTsFromMd(mdFileName, exportName) {
  const mdPath = path.join(contentDir, mdFileName);
  if (!fs.existsSync(mdPath)) {
    console.error(`Error: ${mdPath} does not exist.`);
    process.exit(1);
  }
  const content = fs.readFileSync(mdPath, "utf8");
  const tsContent = `export const ${exportName} = ${JSON.stringify(content)};\n`;
  const tsPath = path.join(generatedDir, `${exportName}.ts`);
  fs.writeFileSync(tsPath, tsContent);
  console.log(`Generated ${tsPath}`);
}

generateTsFromMd("rules.md", "rulesContent");
generateTsFromMd("guidelines.md", "guidelinesContent");

console.log("MCP content generation complete.");
