const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { chromium } = require("playwright");

const rootDir = path.resolve(__dirname, "..");
const appIconDir = path.join(rootDir, "assets", "app-icon");
const sourceHtmlPath = path.join(appIconDir, "app-icon.html");

const TARGETS = [
  { path: path.join(appIconDir, "aso-icon.png"), size: 1024, type: "png" },
  { path: path.join(appIconDir, "aso-icon.jpg"), size: 1024, type: "jpeg", quality: 95 },
  { path: path.join(appIconDir, "aso-icon-readme.png"), size: 256, type: "png" },
  { path: path.join(rootDir, "cli", "dashboard-ui", "public", "aso-sidebar-icon.png"), size: 88, type: "png" },
  { path: path.join(rootDir, "cli", "dashboard-ui", "public", "favicon.png"), size: 64, type: "png" },
];

async function renderIcon() {
  if (!fs.existsSync(sourceHtmlPath)) {
    throw new Error(`Source icon HTML not found: ${sourceHtmlPath}`);
  }

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 1200 } });
    await page.goto(pathToFileURL(sourceHtmlPath).toString(), { waitUntil: "networkidle" });

    for (const target of TARGETS) {
      fs.mkdirSync(path.dirname(target.path), { recursive: true });

      await page.evaluate((size) => {
        const main = document.querySelector("main");
        if (!(main instanceof HTMLElement)) {
          throw new Error("Expected <main> icon container in assets/app-icon/app-icon.html");
        }
        document.documentElement.style.setProperty("--icon-size", `${size}px`);
        main.style.width = `${size}px`;
        main.style.height = `${size}px`;
      }, target.size);

      const iconElement = await page.$("main");
      if (!iconElement) {
        throw new Error("Unable to capture icon element from assets/app-icon/app-icon.html");
      }

      await iconElement.screenshot({
        path: target.path,
        type: target.type,
        quality: target.type === "jpeg" ? target.quality : undefined,
        omitBackground: target.type === "png",
      });
    }

    await page.close();
  } finally {
    await browser.close();
  }
}

renderIcon()
  .then(() => {
    console.log("Generated icon assets from assets/app-icon/app-icon.html");
    for (const target of TARGETS) {
      console.log(`- ${path.relative(rootDir, target.path)}`);
    }
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
