import * as fs from 'fs';
import { GitHubHttpClient } from './gist/githubHttpClient';

export interface GistFile {
    filename: string;
    content: string;
}

export interface GistData {
    id: string;
    description: string;
    updated_at: string;
    files: Record<string, { filename: string; content: string }>;
}

/**
 * GitHub Gist API service — create, read, and update Gists.
 * HTTP transport is handled by GitHubHttpClient.
 */
export class GistService {
    private readonly GISTS_PER_PAGE = 100;
    private readonly MAX_GIST_PAGES = 5;
    private readonly http = new GitHubHttpClient();
    private token?: string;

    async getUserGists(token: string): Promise<any[]> {
        this.token = token;
        const gists: any[] = [];

        for (let page = 1; page <= this.MAX_GIST_PAGES; page++) {
            const pageResults = await this.http.request(
                'GET',
                `/gists?per_page=${this.GISTS_PER_PAGE}&page=${page}`,
                token,
            );
            if (!Array.isArray(pageResults) || pageResults.length === 0) { break; }
            gists.push(...pageResults);
            if (pageResults.length < this.GISTS_PER_PAGE) { break; }
        }

        return gists;
    }

    async getGist(gistId: string, token: string): Promise<GistData> {
        this.token = token;
        return this.http.request('GET', `/gists/${gistId}`, token);
    }

    async getGistHistory(gistId: string, token: string): Promise<any[]> {
        this.token = token;
        const gist = await this.http.request('GET', `/gists/${gistId}`, token);
        if (!gist || typeof gist !== 'object' || !Array.isArray((gist as any).history)) {
            return [];
        }
        return (gist as any).history;
    }

    async getGistRevision(gistId: string, sha: string, token: string): Promise<GistData> {
        this.token = token;
        return this.http.request('GET', `/gists/${gistId}/${sha}`, token);
    }

    async createGist(
        description: string,
        files: Record<string, { content: string }>,
        token: string,
        isPublic = false,
    ): Promise<GistData> {
        this.token = token;
        return this.http.request('POST', '/gists', token, JSON.stringify({ description, public: isPublic, files }));
    }

    async updateGist(
        gistId: string,
        files: Record<string, { content: string }>,
        token: string,
        description?: string,
        filesToDelete: string[] = [],
    ): Promise<GistData> {
        this.token = token;
        const requestFiles: Record<string, { content: string } | null> = { ...files };
        for (const filename of filesToDelete) {
            requestFiles[filename] = null;
        }
        const body: any = { files: requestFiles };
        if (description) { body.description = description; }
        return this.http.request('PATCH', `/gists/${gistId}`, token, JSON.stringify(body));
    }

    async uploadPrivateVsix(gistId: string, extId: string, vsixPath: string, token: string): Promise<string> {
        const base64Content = fs.readFileSync(vsixPath).toString('base64');
        const fileKey = `private-ext-${extId.replace(/\./g, '-')}.vsix.b64`;
        await this.http.request('PATCH', `/gists/${gistId}`, token, JSON.stringify({
            files: { [fileKey]: { content: base64Content } }
        }));
        return fileKey;
    }

    async downloadPrivateVsix(gistId: string, gistFileKey: string, destPath: string): Promise<void> {
        const token = this.requireToken();
        const gist = await this.http.request('GET', `/gists/${gistId}`, token);
        const fileEntry = gist?.files?.[gistFileKey];
        if (!fileEntry) {
            throw new Error(`Gist file not found: ${gistFileKey}`);
        }
        let base64Content = typeof fileEntry.content === 'string' ? fileEntry.content : '';
        if (typeof fileEntry.raw_url === 'string' && fileEntry.raw_url.length > 0) {
            base64Content = await this.http.requestRawText(fileEntry.raw_url, token);
        }
        fs.writeFileSync(destPath, Buffer.from(base64Content, 'base64'));
    }

    private requireToken(): string {
        if (!this.token) {
            throw new Error('GitHub token is not set. Call a tokenized GistService method first.');
        }
        return this.token;
    }
}
