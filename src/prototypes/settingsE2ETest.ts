import { promises as fs } from "fs";
import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import * as os from "os";
import * as path from "path";

/**
 * [프로토타입] 격리된 임시 VS Code 인스턴스를 실행해 설정 적용 시 오류가 발생하는지 자동으로 테스트한다.
 *
 * 사용법:
 *   1. 테스트할 settings.json 내용을 Record<string, unknown> 형태로 준비한다.
 *   2. runSettingsE2ETest({
 *        vscodeExecutablePath: 'C:/path/to/Code.exe',  // VS Code 실행 파일 경로
 *        settings: { 'editor.fontSize': 9999 },        // 테스트할 설정값
 *        launchTimeoutMs: 8000                         // 8초 후 VS Code 자동 종료
 *      }) 호출.
 *   3. 반환된 errorLogMatches 배열에 'error', 'exception' 키워드가 포함된 로그 라인이 담긴다.
 *   4. 비어있으면 해당 설정이 오류 없이 정상 적용된 것.
 *
 * @prototype
 * @status:experimental
 */

export interface SettingsE2ETestOptions {
  readonly vscodeExecutablePath: string;
  readonly settings: Readonly<Record<string, unknown>>;
  readonly workspaceName?: string;
  readonly launchTimeoutMs?: number;
  readonly additionalArgs?: readonly string[];
}

export interface SettingsE2ETestResult {
  readonly userDataDir: string;
  readonly workspaceDir: string;
  readonly stderr: string;
  readonly errorLogMatches: readonly string[];
  readonly exitCode: number | null;
}

export async function runSettingsE2ETest(
  options: SettingsE2ETestOptions,
): Promise<SettingsE2ETestResult> {
  const sandboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ag-settings-e2e-"));
  const userDataDir = path.join(sandboxRoot, "user-data");
  const extensionsDir = path.join(sandboxRoot, "extensions");
  const workspaceDir = path.join(sandboxRoot, options.workspaceName ?? "workspace");
  const userSettingsDir = path.join(userDataDir, "User");
  const settingsPath = path.join(userSettingsDir, "settings.json");

  await Promise.all([
    fs.mkdir(userSettingsDir, { recursive: true }),
    fs.mkdir(extensionsDir, { recursive: true }),
    fs.mkdir(workspaceDir, { recursive: true }),
  ]);
  await fs.writeFile(settingsPath, `${JSON.stringify(options.settings, null, 2)}\n`, "utf8");

  const folderUri = `file:///${workspaceDir.replace(/\\/g, "/")}`;
  const args = [
    "--folder-uri",
    folderUri,
    "--user-data-dir",
    userDataDir,
    "--extensions-dir",
    extensionsDir,
    "--new-window",
    "--disable-workspace-trust",
    "--skip-add-to-recently-opened",
    ...(options.additionalArgs ?? []),
  ];

  const launchResult = await launchAndTerminateAfterDelay(
    options.vscodeExecutablePath,
    args,
    options.launchTimeoutMs ?? 8000,
  );
  const errorLogMatches = await collectErrorLogMatches(userDataDir);

  return {
    userDataDir,
    workspaceDir,
    stderr: launchResult.stderr,
    errorLogMatches,
    exitCode: launchResult.exitCode,
  };
}

async function launchAndTerminateAfterDelay(
  executablePath: string,
  args: readonly string[],
  delayMs: number,
): Promise<{ stderr: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executablePath, [...args], {
      stdio: "pipe",
    });

    let settled = false;
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      if (!child.killed) {
        child.kill();
      }
    }, delayMs);

    child.on("error", (error) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        resolve({
          stderr,
          exitCode: code,
        });
      }
    });
  });
}

async function collectErrorLogMatches(rootDir: string): Promise<readonly string[]> {
  const logFiles = await collectFilesRecursive(rootDir);
  const matches: string[] = [];

  for (const filePath of logFiles) {
    if (!/\.(log|txt|json)$/i.test(filePath)) {
      continue;
    }

    const contents = await fs.readFile(filePath, "utf8");
    const matchingLines = contents
      .split(/\r?\n/)
      .filter((line) => /\b(error|exception|uncaught)\b/i.test(line))
      .slice(0, 5)
      .map((line) => `${filePath}: ${line.trim()}`);
    matches.push(...matchingLines);
  }

  return matches;
}

async function collectFilesRecursive(rootDir: string): Promise<string[]> {
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const entryPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectFilesRecursive(entryPath));
      continue;
    }
    files.push(entryPath);
  }

  return files;
}
