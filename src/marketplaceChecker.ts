import * as https from 'https';
import { Platform } from './platformDetector';

export type ExtensionAvailability = 'available' | 'unavailable' | 'unknown';

const BATCH_SIZE = 20;
const VS_MARKETPLACE_TIMEOUT_MS = 3000;

export async function checkOpenVSX(ids: string[]): Promise<Map<string, ExtensionAvailability>> {
    const result = new Map<string, ExtensionAvailability>();
    const normalized = normalizeIds(ids);

    for (const batch of chunk(normalized, BATCH_SIZE)) {
        const settled = await Promise.allSettled(batch.map(id => checkOneOpenVSX(id)));
        for (let i = 0; i < batch.length; i++) {
            const id = batch[i];
            const status = settled[i];
            if (status.status === 'fulfilled') {
                result.set(id, status.value);
            } else {
                result.set(id, 'unknown');
            }
        }
    }

    return result;
}

export async function checkVSCodeMarketplace(ids: string[]): Promise<Map<string, ExtensionAvailability>> {
    const result = new Map<string, ExtensionAvailability>();
    const normalized = normalizeIds(ids);

    for (const batch of chunk(normalized, BATCH_SIZE)) {
        const settled = await Promise.allSettled(batch.map(id => checkOneVSCodeMarketplace(id)));
        for (let i = 0; i < batch.length; i++) {
            const id = batch[i];
            const status = settled[i];
            if (status.status === 'fulfilled') {
                result.set(id, status.value);
            } else {
                result.set(id, 'unknown');
            }
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

    const fallback = new Map<string, ExtensionAvailability>();
    for (const id of normalizeIds(ids)) {
        fallback.set(id, 'unknown');
    }
    return fallback;
}

function normalizeIds(ids: string[]): string[] {
    const seen = new Set<string>();
    const normalized: string[] = [];

    for (const raw of ids) {
        const id = (raw || '').trim().toLowerCase();
        if (!id || seen.has(id)) {
            continue;
        }
        seen.add(id);
        normalized.push(id);
    }

    return normalized;
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
            hostname: 'open-vsx.org',
            method: 'GET',
            path,
            headers: {
                'User-Agent': 'Solobois-Settings-Sync',
                'Accept': 'application/json'
            }
        });

        if (res.statusCode === 200) {
            return 'available';
        }
        if (res.statusCode === 404) {
            return 'unavailable';
        }
        return 'unknown';
    } catch {
        return 'unknown';
    }
}

async function checkOneVSCodeMarketplace(id: string): Promise<ExtensionAvailability> {
    const body = JSON.stringify({
        filters: [
            {
                criteria: [
                    { filterType: 7, value: id }
                ],
                pageNumber: 1,
                pageSize: 1,
                sortBy: 0,
                sortOrder: 0
            }
        ],
        assetTypes: [],
        flags: 0
    });

    try {
        const res = await request({
            hostname: 'marketplace.visualstudio.com',
            method: 'POST',
            path: '/_apis/public/gallery/extensionquery',
            headers: {
                'User-Agent': 'Solobois-Settings-Sync',
                'Accept': 'application/json;api-version=3.0-preview.1',
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body).toString()
            }
        }, body, VS_MARKETPLACE_TIMEOUT_MS);

        if (!res.body) {
            return 'unknown';
        }

        const parsed = JSON.parse(res.body);
        const count = parsed?.results?.[0]?.extensions?.length ?? 0;
        return count > 0 ? 'available' : 'unavailable';
    } catch {
        return 'unknown';
    }
}

function request(
    options: https.RequestOptions,
    body?: string,
    timeoutMs?: number
): Promise<{ statusCode: number; body: string }> {
    return new Promise((resolve, reject) => {
        const req = https.request(options, res => {
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
