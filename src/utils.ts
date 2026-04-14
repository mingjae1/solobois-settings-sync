export function toErrorMessage(err: unknown): string {
    if (!err) {
        return 'Unknown error';
    }
    if (err instanceof Error) {
        return err.message;
    }
    if (typeof err === 'string') {
        return err;
    }
    try {
        return JSON.stringify(err);
    } catch {
        return String(err);
    }
}

export function normalizeIgnoredSettings(keys: string[]): string[] {
    const seen = new Set<string>();
    const normalized: string[] = [];

    for (const raw of keys) {
        const key = (raw || '').trim();
        if (!key || seen.has(key)) {
            continue;
        }
        seen.add(key);
        normalized.push(key);
    }

    return normalized;
}

export function parseGistIdFromInput(value: string): string | null {
    const input = (value || '').trim();
    if (!input) {
        return null;
    }

    const directMatch = input.match(/^[a-f0-9]{8,}$/i);
    if (directMatch) {
        return directMatch[0];
    }

    try {
        const url = new URL(input);
        const host = url.hostname.toLowerCase();
        if (host === 'gist.github.com' || host === 'www.gist.github.com' || host === 'gist.githubusercontent.com') {
            const segments = url.pathname.split('/').filter(Boolean);
            for (let index = segments.length - 1; index >= 0; index--) {
                const segment = segments[index];
                if (/^[a-f0-9]{8,}$/i.test(segment)) {
                    return segment;
                }
            }
        }
    } catch {
        // Not a URL, continue to regex fallback.
    }

    const embeddedMatch = input.match(/([a-f0-9]{8,})/i);
    return embeddedMatch ? embeddedMatch[1] : null;
}

export function normalizeExtensionIds(ids: string[]): string[] {
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

export function parseJsonc(content: string): any | null {
    try {
        // Comment remover that respects strings (to avoid breaking URLs)
        let isInsideString = false;
        let isInsideSingleLineComment = false;
        let isInsideMultiLineComment = false;
        let cleaned = '';

        for (let i = 0; i < content.length; i++) {
            const char = content[i];
            const nextChar = content[i + 1];

            if (isInsideSingleLineComment) {
                if (char === '\n') {
                    isInsideSingleLineComment = false;
                    cleaned += char;
                }
                continue;
            }

            if (isInsideMultiLineComment) {
                if (char === '*' && nextChar === '/') {
                    isInsideMultiLineComment = false;
                    i++; // skip /
                }
                continue;
            }

            if (isInsideString) {
                cleaned += char;
                if (char === '"' && content[i - 1] !== '\\') {
                    isInsideString = false;
                }
                continue;
            }

            if (char === '"') {
                isInsideString = true;
                cleaned += char;
                continue;
            }

            if (char === '/' && nextChar === '/') {
                isInsideSingleLineComment = true;
                i++;
                continue;
            }

            if (char === '/' && nextChar === '*') {
                isInsideMultiLineComment = true;
                i++;
                continue;
            }

            cleaned += char;
        }

        // Strip trailing commas before } or ]
        cleaned = cleaned.replace(/,\s*([\]}])/g, '$1');
        const trimmed = cleaned.trim();
        if (!trimmed) { return {}; }
        return JSON.parse(trimmed);
    } catch (err: any) {
        console.error('Antigravity Sync: JSONC Parse Error', err);
        return null;
    }
}

export function parseTimestamp(timestamp: string | null | undefined): number | null {
    if (!timestamp) {
        return null;
    }

    const parsed = Date.parse(timestamp);
    return Number.isFinite(parsed) ? parsed : null;
}
