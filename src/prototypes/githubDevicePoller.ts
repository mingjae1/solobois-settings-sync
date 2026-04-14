import * as https from "https";

/**
 * [프로토타입] GitHub 디바이스 코드 인증 폴링 헬퍼.
 * 자격증명(비밀번호/OTP) 입력이 원활히 작동하지 않을 때 직접 토큰 발급 상태를 주기적으로 확인한다.
 *
 * 사용법:
 *   1. GitHub OAuth App에서 디바이스 코드를 요청해 deviceCode, intervalSeconds, expiresInSeconds를 받는다.
 *   2. vscode.env.openExternal()을 사용하여 브라우저를 열어 직접 인증하게 한다.
 *   3. pollGitHubDeviceAuthorization(options) 호출 시 status가 'approved'가 될 때까지 자동으로 폴링.
 *   4. status === 'approved'이면 accessToken을 이용해 API를 호출할 수 있다.
 *
 * @prototype
 * @status:experimental
 */

export interface AbortSignalLike {
  readonly aborted: boolean;
  addEventListener?(type: "abort", listener: () => void): void;
  removeEventListener?(type: "abort", listener: () => void): void;
}

export interface GitHubDevicePollOptions {
  readonly clientId: string;
  readonly deviceCode: string;
  readonly intervalSeconds: number;
  readonly expiresInSeconds: number;
  readonly endpoint?: string;
  readonly signal?: AbortSignalLike;
}

export type GitHubDevicePollStatus =
  | "pending"
  | "slow_down"
  | "approved"
  | "expired"
  | "cancelled"
  | "error";

export interface GitHubDevicePollResult {
  readonly status: GitHubDevicePollStatus;
  readonly accessToken?: string;
  readonly tokenType?: string;
  readonly scope?: string;
  readonly error?: string;
}

interface GitHubDeviceTokenResponse {
  readonly access_token?: string;
  readonly token_type?: string;
  readonly scope?: string;
  readonly error?: string;
  readonly error_description?: string;
  readonly error_uri?: string;
}

const GITHUB_DEVICE_TOKEN_ENDPOINT = "https://github.com/login/oauth/access_token";
const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

export async function pollGitHubDeviceAuthorization(
  options: GitHubDevicePollOptions,
): Promise<GitHubDevicePollResult> {
  const startedAt = Date.now();
  const expiresAt = startedAt + (options.expiresInSeconds * 1000);
  let intervalMs = Math.max(1000, options.intervalSeconds * 1000);

  while (Date.now() < expiresAt) {
    if (options.signal?.aborted) {
      return {
        status: "cancelled",
        error: "Polling cancelled by caller.",
      };
    }

    const response = await requestDeviceToken(options);
    if (response.access_token) {
      return {
        status: "approved",
        accessToken: response.access_token,
        tokenType: response.token_type,
        scope: response.scope,
      };
    }

    switch (response.error) {
      case "authorization_pending":
        await delay(intervalMs, options.signal);
        break;
      case "slow_down":
        intervalMs += 5000;
        await delay(intervalMs, options.signal);
        break;
      case "expired_token":
        return {
          status: "expired",
          error: response.error_description ?? response.error,
        };
      case "access_denied":
        return {
          status: "cancelled",
          error: response.error_description ?? response.error,
        };
      default:
        return {
          status: response.error === "slow_down" ? "slow_down" : "error",
          error: response.error_description ?? response.error ?? "Unknown polling error.",
        };
    }
  }

  return {
    status: "expired",
    error: "Polling window expired before approval.",
  };
}

async function requestDeviceToken(
  options: GitHubDevicePollOptions,
): Promise<GitHubDeviceTokenResponse> {
  const body = new URLSearchParams({
    client_id: options.clientId,
    device_code: options.deviceCode,
    grant_type: DEVICE_GRANT_TYPE,
  }).toString();

  const endpoint = new URL(options.endpoint ?? GITHUB_DEVICE_TOKEN_ENDPOINT);

  return new Promise((resolve, reject) => {
    const request = https.request({
      protocol: endpoint.protocol,
      hostname: endpoint.hostname,
      port: endpoint.port,
      path: `${endpoint.pathname}${endpoint.search}`,
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(body).toString(),
        "User-Agent": "antigravity-sync/prototype",
      },
    }, (response) => {
      let responseBody = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        responseBody += chunk;
      });
      response.on("end", () => {
        try {
          resolve(JSON.parse(responseBody) as GitHubDeviceTokenResponse);
        } catch (error) {
          reject(error);
        }
      });
    });

    request.on("error", reject);
    request.write(body);
    request.end();
  });
}

function delay(durationMs: number, signal?: AbortSignalLike): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, durationMs);

    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(new Error("Polling cancelled."));
    };

    const cleanup = () => {
      signal?.removeEventListener?.("abort", onAbort);
    };

    signal?.addEventListener?.("abort", onAbort);
  });
}
