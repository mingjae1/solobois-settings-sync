import * as https from "https";

/**
 * [프로토타입] VS Code 마켓플레이스에서 익스텐션의 상태(활성/미활성/deprecated)를 HTTPS GET으로 확인한다.
 *
 * 사용법:
 *   1. 확인할 익스텐션 목록을 { publisher, name } 형태로 준비한다.
 *      예: [{ publisher: 'soloboi', name: 'solobois-settings-sync' }]
 *   2. checkMarketplaceHealth({ extensions }) 호출.
 *   3. 결과의 status를 확인:
 *      - 'active'    : 마켓플레이스에 정상적으로 존재
 *      - 'deprecated': deprecated/unpublished 된 익스텐션
 *      - 'missing'   : 404 또는 찾을 수 없음
 *      - 'unknown'   : 네트워크 오류 또는 판단 불가
 *
 * 실제 익스텐션 적용 시 동기화된 extensions.json의 ID 목록과 이 헬스체크를 연결하면
 * 더 이상 존재하지 않는 익스텐션을 자동으로 감지할 수 있다.
 *
 * @prototype
 * @status:experimental
 */

export type MarketplaceHealthStatus = "active" | "deprecated" | "missing" | "unknown";

export interface MarketplaceExtensionTarget {
  readonly publisher: string;
  readonly name: string;
}

export interface MarketplaceHealthCheckOptions {
  readonly extensions: readonly MarketplaceExtensionTarget[];
  readonly timeoutMs?: number;
}

export interface MarketplaceHealthCheckResult {
  readonly extensionId: string;
  readonly status: MarketplaceHealthStatus;
  readonly url: string;
  readonly httpStatusCode: number;
}

export async function checkMarketplaceHealth(
  options: MarketplaceHealthCheckOptions,
): Promise<readonly MarketplaceHealthCheckResult[]> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const results: MarketplaceHealthCheckResult[] = [];

  for (const extension of options.extensions) {
    const extensionId = `${extension.publisher}.${extension.name}`;
    const url = buildMarketplaceUrl(extension);
    try {
      const response = await requestText(url, timeoutMs, 3);
      results.push({
        extensionId,
        status: classifyMarketplaceBody(response.statusCode, response.body),
        url,
        httpStatusCode: response.statusCode,
      });
    } catch {
      results.push({
        extensionId,
        status: "unknown",
        url,
        httpStatusCode: 0,
      });
    }
  }

  return results;
}

function buildMarketplaceUrl(target: MarketplaceExtensionTarget): string {
  return `https://marketplace.visualstudio.com/items?itemName=${encodeURIComponent(target.publisher)}.${encodeURIComponent(target.name)}`;
}

function classifyMarketplaceBody(statusCode: number, body: string): MarketplaceHealthStatus {
  if (statusCode === 404) {
    return "missing";
  }
  if (statusCode < 200 || statusCode >= 300) {
    return "unknown";
  }

  const normalized = body.toLowerCase();
  if (normalized.includes("we could not find the extension")) {
    return "missing";
  }
  if (normalized.includes("deprecated")
    || normalized.includes("this extension is no longer maintained")
    || normalized.includes("unpublished")) {
    return "deprecated";
  }
  if (normalized.includes("overview")
    || normalized.includes("version history")
    || normalized.includes("publisher")) {
    return "active";
  }
  return "unknown";
}

function requestText(
  url: string,
  timeoutMs: number,
  redirectsRemaining: number,
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const request = https.request({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port,
      path: `${parsed.pathname}${parsed.search}`,
      method: "GET",
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent": "antigravity-sync/prototype",
      },
      timeout: timeoutMs,
    }, (response) => {
      const statusCode = response.statusCode ?? 0;
      const location = response.headers.location;
      if (location && statusCode >= 300 && statusCode < 400 && redirectsRemaining > 0) {
        response.resume();
        resolve(requestText(new URL(location, parsed).toString(), timeoutMs, redirectsRemaining - 1));
        return;
      }

      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        body += chunk;
      });
      response.on("end", () => {
        resolve({ statusCode, body });
      });
    });

    request.on("error", reject);
    request.on("timeout", () => {
      request.destroy(new Error(`Marketplace GET timeout after ${timeoutMs}ms`));
    });
    request.end();
  });
}
