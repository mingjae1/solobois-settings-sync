import { promises as fs } from "fs";
import { spawn } from "child_process";
import * as path from "path";

/**
 * [프로토타입] 웹사이트의 특정 UI 요소(HTML + 계산된 CSS)를 Playwright로 추출해 VS Code 스니펫으로 변환한다.
 *
 * 사용법:
 *   1. 참고하고 싶은 웹사이트 URL과 대상 요소의 CSS 셀렉터를 준비한다.
 *      예: url = 'https://example.com', selector = '.hero-button'
 *   2. importWebSnippet({ url, selector, name: '버튼', prefix: 'hero-btn', outputPath: '...' }) 호출.
 *   3. outputPath에 VS Code 스니펫 JSON 파일을 생성한다.
 *   4. 생성된 파일을 VS Code 사용자 스니펫 디렉토리에 복사하면 바로 자동완성에서 사용 가능.
 *
 * 주의: Playwright(`playwright` npm 패키지)가 설치되어 있어야 한다.
 *
 * @prototype
 * @status:experimental
 */

export interface WebSnippetImportOptions {
  readonly url: string;
  readonly selector: string;
  readonly name: string;
  readonly prefix: string;
  readonly outputPath: string;
  readonly scope?: readonly string[];
  readonly timeoutMs?: number;
}

export interface ExtractedWebSnippetPayload {
  readonly html: string;
  readonly css: string;
  readonly sourceUrl: string;
  readonly selector: string;
}

export interface VSCodeSnippetDefinition {
  readonly prefix: string;
  readonly scope?: string;
  readonly description: string;
  readonly body: readonly string[];
}

export interface WebSnippetImportResult {
  readonly snippetName: string;
  readonly outputPath: string;
  readonly snippet: VSCodeSnippetDefinition;
}

export async function importWebSnippet(
  options: WebSnippetImportOptions,
): Promise<WebSnippetImportResult> {
  const payload = await extractSnippetPayload(options);
  const snippet = buildSnippetDefinition(options, payload);

  await fs.mkdir(path.dirname(options.outputPath), { recursive: true });
  await fs.writeFile(
    options.outputPath,
    `${JSON.stringify({ [options.name]: snippet }, null, 2)}\n`,
    "utf8",
  );

  return {
    snippetName: options.name,
    outputPath: options.outputPath,
    snippet,
  };
}

function buildSnippetDefinition(
  options: WebSnippetImportOptions,
  payload: ExtractedWebSnippetPayload,
): VSCodeSnippetDefinition {
  const body = [
    `<!-- Imported from ${payload.sourceUrl} (${payload.selector}) -->`,
    ...escapeSnippetBody(payload.html).split(/\r?\n/),
    "<style>",
    ...escapeSnippetBody(payload.css).split(/\r?\n/),
    "</style>",
  ];

  return {
    prefix: options.prefix,
    scope: options.scope?.join(","),
    description: `Prototype snippet imported from ${options.url}`,
    body,
  };
}

async function extractSnippetPayload(
  options: WebSnippetImportOptions,
): Promise<ExtractedWebSnippetPayload> {
  const script = [
    "const { chromium } = require('playwright');",
    "(async () => {",
    "  const browser = await chromium.launch({ headless: true });",
    "  const page = await browser.newPage();",
    "  await page.goto(" + JSON.stringify(options.url) + ", { waitUntil: 'networkidle', timeout: " +
      String(options.timeoutMs ?? 20000) +
      " });",
    "  const payload = await page.locator(" + JSON.stringify(options.selector) + ").evaluate((node) => {",
    "    const outerHTML = node.outerHTML;",
    "    const computed = window.getComputedStyle(node);",
    "    const css = Array.from(computed)",
    "      .map((name) => `  ${name}: ${computed.getPropertyValue(name)};`)",
    "      .join('\\n');",
    "    return { html: outerHTML, css: `:root-snippet {\\n${css}\\n}`, sourceUrl: window.location.href, selector: " +
      JSON.stringify(options.selector) +
      " };",
    "  });",
    "  process.stdout.write(JSON.stringify(payload));",
    "  await browser.close();",
    "})().catch((error) => { console.error(error instanceof Error ? error.stack : String(error)); process.exit(1); });",
  ].join("\n");

  const stdout = await spawnNodeScript(script);
  return JSON.parse(stdout) as ExtractedWebSnippetPayload;
}

function escapeSnippetBody(input: string): string {
  return input.replace(/\$/g, "\\$").replace(/\}/g, "\\}");
}

function spawnNodeScript(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", script], {
      stdio: "pipe",
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(stderr || `Playwright extraction exited with code ${code ?? -1}`));
    });
  });
}
