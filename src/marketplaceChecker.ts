import * as https from 'https';
import * as http from 'http';
import { Platform } from './platformDetector';
import { normalizeExtensionIds } from './utils';
import { OPEN_VSX_HOSTNAME, VS_MARKETPLACE_HOSTNAME } from './constants';

export interface ExtensionUpdateInfo {
    id: string;
    currentVersion: string;
    latestVersion: string;
    vsixUrl?: string;
    marketplaceDomain: string;
}

export type ExtensionAvailability = 'available' | 'unavailable' | 'unknown';

const BATCH_SIZE = 20;
const VS_MARKETPLACE_TIMEOUT_MS = 3000;

export async function checkOpenVSX(ids: string[]): Promise<Map<string, ExtensionAvailability>> {
    const result = new Map<string, ExtensionAvailability>();
    const normalized = normalizeExtensionIds(ids);

    for (const batch of chunk(normalized, BATCH_SIZE)) {
        const settled = await Promise.allSettled(batch.map(id => checkOneOpenVSX(id)));
        for (let i = 0; i < batch.length; i++) {
            const id = batch[i];
            const status = settled[i];
            result.set(id, status.status === 'fulfilled' ? status.value : 'unknown');
        }
    }

    return result;
}

export async function checkVSCodeMarketplace(ids: string[]): Promise<Map<string, ExtensionAvailability>> {
    const result = new Map<string, ExtensionAvailability>();
    const normalized = normalizeExtensionIds(ids);

    for (const batch of chunk(normalized, BATCH_SIZE)) {
        const settled = await Promise.allSettled(batch.map(id => checkOneVSCodeMarketplace(id)));
        for (let i = 0; i < batch.length; i++) {
            const id = batch[i];
            const status = settled[i];
            result.set(id, status.status === 'fulfilled' ? status.value : 'unknown');
        }
    }

    return result;
}

export async function checkMarketplaceForPlatform(
    ids: string[],
    platform: Platform
): Promise<Map<string, ExtensionAvailability>> {
    if (platform === 'antigravity') {
        return checkOpenVSX(ids);
    }

    if (platform === 'vscode') {
        return checkVSCodeMarketplace(ids);
    }

    const result = new Map<string, ExtensionAvailability>();
    for (const id of normalizeExtensionIds(ids)) {
        result.set(id, 'unknown');
    }
    return result;
}

function chunk<T>(items: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < items.length; i += size) {
        chunks.push(items.slice(i, i + size));
    }
    return chunks;
}

async function checkOneOpenVSX(id: string): Promise<ExtensionAvailability> {
    const parts = id.split('.');
    if (parts.length < 2) {
        return 'unknown';
    }

    const namespace = encodeURIComponent(parts[0]);
    const extensionName = encodeURIComponent(parts.slice(1).join('.'));
    const path = `/api/${namespace}/${extensionName}`;

    try {
        const res = await request({
            hostname: OPEN_VSX_HOSTNAME,
            method: 'GET',
            path,
            headers: {
                'User-Agent': 'Solobois-Settings-Sync',
                'Accept': 'application/json'
            }
        });

        if (res.statusCode === 200) { return 'available'; }
        if (res.statusCode === 404) { return 'unavailable'; }
        return 'unknown';
    } catch (err) {
        console.error(`[marketplaceChecker] OpenVSX check failed for ${id}:`, err);
        return 'unknown';
    }
}

async function checkOneVSCodeMarketplace(id: string): Promise<ExtensionAvailability> {
    const parts = id.split('.');
    if (parts.length < 2) {
        return 'unknown';
    }

    const publisher = parts[0];
    const extensionName = parts.slice(1).join('.');

    const body = JSON.stringify({
        filters: [{
            criteria: [
                { filterType: 7, value: publisher },
                { filterType: 8, value: extensionName }
            ]
        }],
        assetTypes: [],
        flags: 0x1 | 0x2 | 0x80
    });

    try {
        const res = await request({
            hostname: VS_MARKETPLACE_HOSTNAME,
            method: 'POST',
            path: '/_apis/public/gallery/extensionquery',
            headers: {
                'User-Agent': 'Solobois-Settings-Sync',
                'Accept': 'application/json;api-version=3.0-preview.1',
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body).toString()
            }
        }, body, VS_MARKETPLACE_TIMEOUT_MS);

        if (res.statusCode < 200 || res.statusCode >= 300 || !res.body) {
            return 'unknown';
        }

        const parsed: unknown = JSON.parse(res.body);
        if (!parsed || typeof parsed !== 'object') {
            return 'unknown';
        }

        const parsedObj = parsed as { results?: Array<{ extensions?: unknown[] }> };
        if (!Array.isArray(parsedObj.results)) {
            return 'unknown';
        }

        const count = Array.isArray(parsedObj.results[0]?.extensions) ? parsedObj.results[0]!.extensions!.length : 0;
        return count > 0 ? 'available' : 'unavailable';
    } catch (err) {
        console.error(`[marketplaceChecker] VS Marketplace check failed for ${id}:`, err);
        return 'unknown';
    }
}

function request(
    options: https.RequestOptions & { __useHttp?: boolean },
    body?: string,
    timeoutMs?: number
): Promise<{ statusCode: number; body: string }> {
    return new Promise((resolve, reject) => {
        const useHttp = options.__useHttp === true;
        const transport = useHttp ? http : https;
        const req = (transport as typeof https).request(options, res => {
            let data = '';
            res.on('data', chunk => {
                data += chunk;
            });
            res.on('end', () => {
                resolve({
                    statusCode: res.statusCode || 0,
                    body: data
                });
            });
        });

        req.on('error', reject);

        if (timeoutMs && timeoutMs > 0) {
            req.setTimeout(timeoutMs, () => {
                req.destroy(new Error(`Request timeout after ${timeoutMs}ms`));
            });
        }

        if (body) {
            req.write(body);
        }
        req.end();
    });
}
