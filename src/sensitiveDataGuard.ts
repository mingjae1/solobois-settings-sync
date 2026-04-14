export type RedactionLevel = 'private' | 'public';

export interface RedactionReport {
    redactedKeys: string[];
    redactedValues: string[];
    totalRemoved: number;
}

type KeyPattern = {
    pattern: RegExp;
    minLevel: RedactionLevel;
};

type ValuePattern = {
    pattern: RegExp;
    name: string;
};

export class SensitiveDataGuard {
    private static readonly KEY_PATTERNS: KeyPattern[] = [
        { pattern: /token/i, minLevel: 'private' },
        { pattern: /secret/i, minLevel: 'private' },
        { pattern: /password/i, minLevel: 'private' },
        { pattern: /api[_-]?key/i, minLevel: 'private' },
        { pattern: /passphrase/i, minLevel: 'private' },
        { pattern: /client[_-]?secret/i, minLevel: 'private' },
        { pattern: /private[_-]?key/i, minLevel: 'private' },
        { pattern: /refresh[_-]?token/i, minLevel: 'private' },
        { pattern: /access[_-]?token/i, minLevel: 'private' },
        { pattern: /id[_-]?token/i, minLevel: 'private' },
        { pattern: /auth/i, minLevel: 'public' },
        { pattern: /authorization/i, minLevel: 'public' },
        { pattern: /cookie/i, minLevel: 'public' },
        { pattern: /session/i, minLevel: 'public' },
        { pattern: /bearer/i, minLevel: 'public' },
        { pattern: /jwt/i, minLevel: 'public' },
        { pattern: /oauth/i, minLevel: 'public' },
        { pattern: /saml/i, minLevel: 'public' },
    ];

    private static readonly VALUE_PATTERNS: ValuePattern[] = [
        { pattern: /\bghp_[a-zA-Z0-9]{36}\b/, name: 'GitHub PAT' },
        { pattern: /\bgithub_pat_[a-zA-Z0-9_]{40,}\b/, name: 'GitHub fine-grained PAT' },
        { pattern: /\bAKIA[0-9A-Z]{16}\b/, name: 'AWS Access Key' },
        { pattern: /\bsk-[a-zA-Z0-9_-]{20,}\b/, name: 'OpenAI API Key' },
        { pattern: /\bxoxb-[0-9]+-[a-zA-Z0-9-]+\b/, name: 'Slack Bot Token' },
        { pattern: /\bpostgres(?:ql)?:\/\/[^:\s]+:[^@\s]+@/i, name: 'DB connection string' },
        { pattern: /\bmysql:\/\/[^:\s]+:[^@\s]+@/i, name: 'MySQL connection string' },
    ];

    public redactObject<T extends object>(obj: T, level: RedactionLevel): { result: T; report: RedactionReport } {
        const report: RedactionReport = {
            redactedKeys: [],
            redactedValues: [],
            totalRemoved: 0,
        };

        const result = this.redactNode(obj, level, '', report) as T;
        report.totalRemoved = report.redactedKeys.length + report.redactedValues.length;

        return { result, report };
    }

    public redactJsonString(jsonText: string, level: RedactionLevel): { result: string; report: RedactionReport } {
        try {
            const parsed = JSON.parse(jsonText) as object;
            const { result, report } = this.redactObject(parsed, level);
            return {
                result: JSON.stringify(result, null, 4),
                report,
            };
        } catch {
            const report: RedactionReport = {
                redactedKeys: [],
                redactedValues: [],
                totalRemoved: 0,
            };

            let redactedText = jsonText;
            for (const valuePattern of SensitiveDataGuard.VALUE_PATTERNS) {
                const regex = this.toGlobalRegExp(valuePattern.pattern);
                const matches = redactedText.match(regex);
                if (matches && matches.length > 0) {
                    redactedText = redactedText.replace(regex, '[REDACTED]');
                    report.redactedValues.push(`${valuePattern.name} in raw text`);
                }
            }

            report.totalRemoved = report.redactedKeys.length + report.redactedValues.length;
            return { result: redactedText, report };
        }
    }

    private redactNode(node: unknown, level: RedactionLevel, path: string, report: RedactionReport): unknown {
        if (typeof node === 'string') {
            return this.redactStringValue(node, path || '(root)', report);
        }

        if (Array.isArray(node)) {
            return node.map((item, index) => this.redactNode(item, level, `${path}[${index}]`, report));
        }

        if (!this.isPlainObject(node)) {
            return node;
        }

        const result: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(node)) {
            const keyPath = path ? `${path}.${key}` : key;
            if (this.shouldRedactKey(key, level)) {
                report.redactedKeys.push(keyPath);
                continue;
            }

            result[key] = this.redactNode(value, level, keyPath, report);
        }

        return result;
    }

    private redactStringValue(input: string, location: string, report: RedactionReport): string {
        let output = input;

        for (const valuePattern of SensitiveDataGuard.VALUE_PATTERNS) {
            const regex = this.toGlobalRegExp(valuePattern.pattern);
            const matches = output.match(regex);
            if (!matches || matches.length === 0) {
                continue;
            }

            output = output.replace(regex, '[REDACTED]');
            report.redactedValues.push(...matches.map(() => `${valuePattern.name} at key '${location}'`));
        }

        return output;
    }

    private shouldRedactKey(key: string, level: RedactionLevel): boolean {
        return SensitiveDataGuard.KEY_PATTERNS.some((entry) => {
            if (level === 'private') {
                return entry.minLevel === 'private' && entry.pattern.test(key);
            }

            return entry.pattern.test(key);
        });
    }

    private isPlainObject(value: unknown): value is Record<string, unknown> {
        return typeof value === 'object' && value !== null && !Array.isArray(value);
    }

    private toGlobalRegExp(pattern: RegExp): RegExp {
        const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
        return new RegExp(pattern.source, flags);
    }
}

export const sensitiveDataGuard = new SensitiveDataGuard();
