import * as https from 'https';

type RequestError = Error & {
    statusCode?: number;
    code?: string;
    retryAfterMs?: number;
};

export class GitHubHttpClient {
    private readonly REQUEST_TIMEOUT_MS = 15000;
    private readonly MAX_RETRIES = 2;

    async request(method: string, apiPath: string, token: string, body?: string): Promise<any> {
        for (let attempt = 0; ; attempt++) {
            try {
                return await this.requestOnce(method, apiPath, token, body);
            } catch (error) {
                const err = error as RequestError;
                if (!this.shouldRetry(err, err.statusCode) || attempt >= this.MAX_RETRIES) {
                    throw error;
                }
                await this.delay(this.getRetryDelayMs(err, attempt));
            }
        }
    }

    async requestRawText(url: string, token: string): Promise<string> {
        for (let attempt = 0; ; attempt++) {
            try {
                return await this.requestRawTextOnce(url, token);
            } catch (error) {
                const err = error as RequestError;
                if (!this.shouldRetry(err, err.statusCode) || attempt >= this.MAX_RETRIES) {
                    throw error;
                }
                await this.delay(this.getRetryDelayMs(err, attempt));
            }
        }
    }

    private requestOnce(method: string, apiPath: string, token: string, body?: string): Promise<any> {
        return new Promise((resolve, reject) => {
            let settled = false;
            const timer = setTimeout(() => {
                if (!settled) {
                    settled = true;
                    const err = Object.assign(new Error(
                        `GitHub API request timed out after ${this.REQUEST_TIMEOUT_MS}ms`
                    ), { name: 'AbortError' }) as RequestError;
                    reject(err);
                    req.destroy();
                }
            }, this.REQUEST_TIMEOUT_MS);

            const headers: Record<string, string> = {
                'User-Agent': 'Solobois-Settings-Sync',
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/vnd.github+json',
                'Content-Type': 'application/json',
            };
            if (body) {
                headers['Content-Length'] = Buffer.byteLength(body).toString();
            }

            const req = https.request({ hostname: 'api.github.com', path: apiPath, method, headers }, res => {
                let data = '';
                res.setEncoding('utf8');
                res.on('data', chunk => { data += chunk; });
                res.on('error', e => {
                    if (!settled) { settled = true; clearTimeout(timer); reject(e); }
                });
                res.on('end', () => {
                    if (settled) { return; }
                    settled = true;
                    clearTimeout(timer);
                    const statusCode = res.statusCode;
                    if (typeof statusCode !== 'number') {
                        return reject(new Error('GitHub API error: missing HTTP status code'));
                    }
                    if (statusCode >= 200 && statusCode < 300) {
                        if (!data) { return resolve(null); }
                        try { resolve(JSON.parse(data)); } catch {
                            reject(new Error('Failed to parse GitHub API response'));
                        }
                        return;
                    }
                    let errMsg = `GitHub API error ${statusCode}`;
                    try {
                        const parsed = JSON.parse(data);
                        if (parsed.message) { errMsg += `: ${parsed.message}`; }
                    } catch { /* ignore */ }
                    const err = Object.assign(new Error(errMsg), {
                        statusCode,
                        retryAfterMs: this.parseRetryAfterMs(res.headers['retry-after'])
                    }) as RequestError;
                    reject(err);
                });
            });
            req.on('error', e => {
                if (!settled) { settled = true; clearTimeout(timer); reject(e); }
            });
            if (body) { req.write(body); }
            req.end();
        });
    }

    private requestRawTextOnce(url: string, token: string): Promise<string> {
        return new Promise((resolve, reject) => {
            let settled = false;
            const parsedUrl = new URL(url);
            const timer = setTimeout(() => {
                if (!settled) {
                    settled = true;
                    const err = Object.assign(new Error(
                        `GitHub raw request timed out after ${this.REQUEST_TIMEOUT_MS}ms`
                    ), { name: 'AbortError' }) as RequestError;
                    reject(err);
                    req.destroy();
                }
            }, this.REQUEST_TIMEOUT_MS);

            const req = https.request({
                protocol: parsedUrl.protocol,
                hostname: parsedUrl.hostname,
                path: `${parsedUrl.pathname}${parsedUrl.search}`,
                method: 'GET',
                headers: {
                    'User-Agent': 'Solobois-Settings-Sync',
                    'Authorization': `Bearer ${token}`,
                    'Accept': 'application/vnd.github.raw',
                }
            }, res => {
                let data = '';
                res.setEncoding('utf8');
                res.on('data', chunk => { data += chunk; });
                res.on('error', e => {
                    if (!settled) { settled = true; clearTimeout(timer); reject(e); }
                });
                res.on('end', () => {
                    if (settled) { return; }
                    settled = true;
                    clearTimeout(timer);
                    const statusCode = res.statusCode;
                    if (typeof statusCode !== 'number') {
                        return reject(new Error('GitHub raw content error: missing HTTP status code'));
                    }
                    if (statusCode >= 200 && statusCode < 300) { return resolve(data); }
                    const err = Object.assign(
                        new Error(`GitHub raw content error ${statusCode}: ${data}`),
                        { statusCode, retryAfterMs: this.parseRetryAfterMs(res.headers['retry-after']) }
                    ) as RequestError;
                    reject(err);
                });
            });
            req.on('error', e => {
                if (!settled) { settled = true; clearTimeout(timer); reject(e); }
            });
            req.end();
        });
    }

    private shouldRetry(error: RequestError, statusCode?: number): boolean {
        if (error.name === 'AbortError') { return true; }
        if (error.code && ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND'].includes(error.code)) { return true; }
        if (statusCode === 429) { return true; }
        if (statusCode === 403 && error.retryAfterMs !== undefined) { return true; }
        return statusCode !== undefined && statusCode >= 500;
    }

    private getRetryDelayMs(error: RequestError, attempt: number): number {
        return error.retryAfterMs ?? 1000 * Math.pow(2, attempt);
    }

    private parseRetryAfterMs(header: string | string[] | undefined): number | undefined {
        const raw = Array.isArray(header) ? header[0] : header;
        if (!raw) { return undefined; }
        const seconds = Number(raw);
        if (Number.isFinite(seconds)) { return Math.max(0, seconds * 1000); }
        const ts = Date.parse(raw);
        return Number.isNaN(ts) ? undefined : Math.max(0, ts - Date.now());
    }

    private delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
