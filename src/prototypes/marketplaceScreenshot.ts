import { promises as fs } from "fs";
import { spawn } from "child_process";
import * as path from "path";

/**
 * [프로토타입] VS Code 마켓플레이스 아이템을 헤드리스 Playwright로 자동 스크린샷 촬영한다.
 *
 * 사용법:
 *   1. captureMarketplaceScreenshot({ extensionId: 'soloboi.solobois-settings-sync', outputPath: 'screenshots/marketplace.png' }) 호출.
 *   2. outputPath에 전체 페이지 PNG 파일이 저장된다.
 *   3. publish.bat 등 배포 파이프라인에 연결하면 마켓플레이스 이미지를 배포 시마다 자동 갱신 가능.
 *
 * 주의: Playwright(`playwright` npm 패키지)가 설치되어 있어야 한다.
 *
 * @prototype
 * @status:experimental
 */

export interface MarketplaceScreenshotOptions {
  readonly extensionId: string;
  readonly outputPath: string;
  readonly viewport?: {
    readonly width: number;
    readonly height: number;
  };
  readonly fullPage?: boolean;
  readonly timeoutMs?: number;
}

export interface MarketplaceScreenshotResult {
  readonly extensionId: string;
  readonly outputPath: string;
  readonly marketplaceUrl: string;
}

export async function captureMarketplaceScreenshot(
  options: MarketplaceScreenshotOptions,
): Promise<MarketplaceScreenshotResult> {
  const marketplaceUrl = `https://marketplace.visualstudio.com/items?itemName=${encodeURIComponent(options.extensionId)}`;
  await fs.mkdir(path.dirname(options.outputPath), { recursive: true });

  const script = [
    "const { chromium } = require('playwright');",
    "(async () => {",
    "  const browser = await chromium.launch({ headless: true });",
    "  const page = await browser.newPage({ viewport: " +
      JSON.stringify(options.viewport ?? { width: 1440, height: 1200 }) +
      " });",
    "  await page.goto(" + JSON.stringify(marketplaceUrl) + ", { waitUntil: 'networkidle', timeout: " +
      String(options.timeoutMs ?? 20000) +
      " });",
    "  await page.screenshot({",
    "    path: " + JSON.stringify(options.outputPath) + ",",
    "    fullPage: " + String(options.fullPage ?? true),
    "  });",
    "  await browser.close();",
    "})().catch((error) => { console.error(error instanceof Error ? error.stack : String(error)); process.exit(1); });",
  ].join("\n");

  await spawnNodeScript(script);

  return {
    extensionId: options.extensionId,
    outputPath: options.outputPath,
    marketplaceUrl,
  };
}

function spawnNodeScript(script: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", script], {
      stdio: "pipe",
    });

    let stderr = "";
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr || `Marketplace screenshot exited with code ${code ?? -1}`));
    });
  });
}
