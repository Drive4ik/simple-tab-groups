
import '/js/prefixed-storage.js';
import * as Constants from '/js/constants.js';
import * as Utils from '/js/utils.js';
import {LOCK_FILE_NAME} from '../delta/layout.js';
import {canWriteLock, didWinLock, makeLockStamp, LOCK_CONFIRM_DELAY_MS} from '../delta/lock.js';
import {contentFingerprint} from '../delta/fingerprint.js';

const storage = localStorage.create(Constants.MODULES.CLOUD);

const GIST_ID_STORAGE_KEY = 'gistIdByName';

function readGistIdMap() {
    const map = storage[GIST_ID_STORAGE_KEY];
    return (map && typeof map === 'object') ? map : {};
}

function getStoredGistId(gistName) {
    return gistName ? (readGistIdMap()[gistName] ?? null) : null;
}

function setStoredGistId(gistName, gistId) {
    if (!gistName || !gistId) {
        return;
    }
    const map = readGistIdMap();
    map[gistName] = gistId;
    storage[GIST_ID_STORAGE_KEY] = map;
}

function clearStoredGistId(gistName) {
    if (!gistName) {
        return;
    }
    const map = readGistIdMap();
    if (gistName in map) {
        delete map[gistName];
        storage[GIST_ID_STORAGE_KEY] = map;
    }
}

const SYNC_MARKER_STORAGE_KEY = 'gistSyncMarker';

function readSyncMarkerMap() {
    const map = storage[SYNC_MARKER_STORAGE_KEY];
    return (map && typeof map === 'object') ? map : {};
}

function getStoredSyncMarker(gistId) {
    const marker = gistId ? readSyncMarkerMap()[gistId] : null;
    if (marker && typeof marker === 'object' && typeof marker.fingerprint === 'string') {
        return marker;
    }
    return null;
}

function setStoredSyncMarker(gistId, marker) {
    if (!gistId || typeof marker?.fingerprint !== 'string') {
        return;
    }
    const map = readSyncMarkerMap();
    map[gistId] = {etag: marker.etag ?? null, fingerprint: marker.fingerprint};
    storage[SYNC_MARKER_STORAGE_KEY] = map;
}

export default class GithubGist {
    #token = null;
    #fileName = null;
    #gistName = null;
    #gistId = null;

    #perPage = null; // max = 100

    #lastServerTimeMs = null;

    constructor(token, fileName, gistName = fileName, perPage = 30) {
        if (!token) {
            throw new Error('githubInvalidToken', {cause: {isEmpty: true}});
        } else if (!fileName) {
            throw new Error('githubInvalidFileName');
        } else if (!gistName) {
            throw new Error('githubInvalidGistName');
        } else if (perPage < 1 || perPage > 100) {
            throw new Error('githubInvalidPerPage');
        }

        this.#token = token;
        this.#fileName = fileName;
        this.#gistName = gistName;
        this.#perPage = perPage;
    }

    static apiUrl = 'https://api.github.com';
    static authorizedHosts = new Set(['api.github.com', 'gist.githubusercontent.com']);
    static defaultHeaders = {
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
    };

    static isAuthorizedHost(url) {
        try {
            return GithubGist.authorizedHosts.has(new URL(url).hostname);
        } catch {
            return false;
        }
    }

    get #mainUrl() {
        return `${GithubGist.apiUrl}/gists`;
    }

    get #gistUrl() {
        return `${this.#mainUrl}/${this.#gistId}`;
    }

    get hasGist() {
        return this.#gistId !== null;
    }

    #processInfo(gist) {
        storage.lastUpdate = gist.lastUpdate = gist.updated_at;
        return gist;
    }

    async checkToken() {
        try {
            await this.#request('POST', this.#mainUrl);
        } catch (e) {
            if (e.cause?.status === 422) {
                return true;
            }

            throw e;
        }
    }

    async #findGist() {
        this.#gistId = null;

        const cachedId = getStoredGistId(this.#gistName);

        if (cachedId) {
            const gist = await this.#getGistById(cachedId);
            if (gist) {
                this.#gistId = gist.id;
                this.#processInfo(gist);
                return;
            }
            clearStoredGistId(this.#gistName);
        }

        const gist = await this.#findGistByName();

        if (gist) {
            this.#gistId = gist.id;
            setStoredGistId(this.#gistName, gist.id);
            this.#processInfo(gist);
        }
    }

    #matchesGistName(gist) {
        return !!gist && !gist.public && gist.description === this.#gistName;
    }

    #holdsConfiguredFile(gist) {
        return !!gist && !gist.public && !!gist.files?.[this.#fileName];
    }

    async #getGistById(gistId) {
        try {
            const gist = await this.#request('GET', `${this.#mainUrl}/${gistId}`);
            const usable = this.#matchesGistName(gist) || this.#holdsConfiguredFile(gist);
            return usable ? gist : null;
        } catch {
            return null;
        }
    }

    async #findGistByName(page = 1, fileMatch = null) {
        const gists = await this.#request('GET', this.#mainUrl, {
            page,
            per_page: this.#perPage,
        });

        const named = gists.find(g => this.#matchesGistName(g));

        if (named) {
            return named;
        }

        fileMatch ??= gists.find(g => this.#holdsConfiguredFile(g)) ?? null;

        if (gists.length === this.#perPage) {
            return this.#findGistByName(page + 1, fileMatch);
        }

        return fileMatch;
    }

    async getInfo(revision = null, progressFunc = null) {
        this.hasGist || await this.#findGist();

        if (!this.hasGist) {
            throw new Error('githubNotFound');
        }

        let gistUrl = this.#gistUrl;

        if (revision) {
            gistUrl += `/${revision}`;
        }

        const gist = await this.#request('GET', gistUrl, undefined, undefined, progressFunc);

        return this.#processInfo(gist);
    }

    async getContent(revision, withInfo = false, progressFunc = null) {
        try {
            const progressApiFunc = this.#createProgress(0, 50, progressFunc);
            const progressRawFunc = this.#createProgress(50, 100, progressFunc);

            const gist = await this.getInfo(revision, progressApiFunc);

            const file = gist.files[this.#fileName];

            if (!file) {
                throw new Error('githubGistFileNotInRevision');
            }

            const content = await this.#readFileContent(file, progressRawFunc);

            return withInfo ? [content, gist] : content;
        } catch (e) {
            if (e instanceof SyntaxError) {
                throw new Error('githubInvalidGistContent', {cause: e});
            }

            throw e;
        }
    }

    async setContent(content, progressFunc = null) {
        this.hasGist || await this.#findGist();

        const files = {
            [this.#fileName]: {content},
        };

        const progressSend = this.#createProgress(0, 70, progressFunc);
        const progressGet = this.#createProgress(70, 100, progressFunc);

        await this.#patchOrCreate({files}, progressSend);

        // sometimes git make wrong update the field "updated_at" minus 1 second :(
        // thats why we have to get info after update gist
        return await this.getInfo(undefined, progressGet);
    }

    async rename(filename) {
        this.hasGist || await this.#findGist();

        if (!this.hasGist) {
            throw new Error('githubNotFound');
        }

        const gist = await this.#request('PATCH', this.#gistUrl, {
            files: {
                [this.#fileName]: {filename},
            },
        });

        this.#fileName = filename;

        return this.#processInfo(gist);
    }

    async #findDeltaGist() {
        this.hasGist || await this.#findGist();
    }

    async beginSyncCycle(progressFunc = null) {
        const cycle = {unchanged: false, gist: null, etag: null};

        try {
            await this.#findDeltaGist();

            if (!this.hasGist) {
                return cycle;
            }

            const marker = getStoredSyncMarker(this.#gistId);
            const {status, etag, gist} = await this.#conditionalGet(this.#gistUrl, marker?.etag, progressFunc);

            if (status === 304) {
                cycle.unchanged = true;
                cycle.etag = marker.etag;
                return cycle;
            }

            if (gist) {
                cycle.gist = this.#processInfo(gist);
                cycle.etag = etag;
                cycle.unchanged = !!marker && contentFingerprint(gist.files) === marker.fingerprint;
            }

            return cycle;
        } catch {
            return cycle;
        }
    }

    commitSyncCycle(cycle) {
        if (!cycle?.gist || !this.hasGist) {
            return;
        }

        setStoredSyncMarker(this.#gistId, {
            etag: cycle.etag,
            fingerprint: contentFingerprint(cycle.gist.files),
        });
    }

    async #conditionalGet(url, etag, progressFunc = null) {
        const headers = {
            ...GithubGist.defaultHeaders,
            Authorization: `Bearer ${this.#token}`,
        };
        if (etag) {
            headers['If-None-Match'] = etag;
        }

        const response = await fetch(url, {method: 'GET', headers, cache: 'no-store'});

        this.#captureServerTime(response);

        const gist = response.ok ? await response.json() : null;

        progressFunc?.(100);

        return {
            status: response.status,
            etag: response.headers.get('etag'),
            gist,
        };
    }

    async #fetchGistState(progressFunc = null) {
        this.hasGist || await this.#findGist();

        if (!this.hasGist) {
            throw new Error('githubNotFound');
        }

        const response = await this.#requestRaw('GET', this.#gistUrl, undefined, undefined, progressFunc);
        const gist = this.#processInfo(await response.json());

        return {gist, etag: response.headers.get('etag')};
    }

    async #cycleGist(cycle, progressFunc = null) {
        if (cycle?.gist) {
            progressFunc?.(100);
            return cycle.gist;
        }

        const {gist, etag} = await this.#fetchGistState(progressFunc);

        if (cycle) {
            cycle.gist = gist;
            cycle.etag = etag;
        }

        return gist;
    }

    #captureServerTime(response) {
        const dateHeader = response?.headers?.get?.('date');
        if (!dateHeader) {
            return;
        }
        const ms = Date.parse(dateHeader);
        if (Number.isFinite(ms)) {
            this.#lastServerTimeMs = ms;
        }
    }

    getServerTimeMs() {
        return this.#lastServerTimeMs;
    }

    async #readFileContent(file, progressFunc = null) {
        if (file.truncated) {
            return this.#request('GET', file.raw_url, undefined, undefined, progressFunc);
        }

        const content = JSON.parse(file.content);
        progressFunc?.(100);
        return content;
    }

    async listFiles(progressFunc = null) {
        await this.#findDeltaGist();

        if (!this.hasGist) {
            return [];
        }

        const gist = await this.getInfo(undefined, progressFunc);

        return Object.keys(gist.files);
    }

    async readFile(name, progressFunc = null, cycle = null) {
        try {
            const progressApiFunc = this.#createProgress(0, 50, progressFunc);
            const progressRawFunc = this.#createProgress(50, 100, progressFunc);

            await this.#findDeltaGist();

            if (!this.hasGist) {
                return null;
            }

            const gist = await this.#cycleGist(cycle, progressApiFunc);
            const file = gist.files[name];

            if (!file) {
                progressRawFunc(100);
                return null;
            }

            return await this.#readFileContent(file, progressRawFunc);
        } catch (e) {
            if (e instanceof SyntaxError) {
                throw new Error('githubInvalidGistContent', {cause: e});
            }

            throw e;
        }
    }

    async readAllMatching(prefix, progressFunc = null, cycle = null) {
        try {
            const progressApiFunc = this.#createProgress(0, 30, progressFunc);

            await this.#findDeltaGist();

            if (!this.hasGist) {
                return [];
            }

            const gist = await this.#cycleGist(cycle, progressApiFunc);

            const matching = Object.entries(gist.files).filter(([name]) => name.startsWith(prefix));

            const results = [];
            for (const [index, [name, file]] of matching.entries()) {
                const from = 30 + Math.floor((index / matching.length) * 70);
                const to = 30 + Math.floor(((index + 1) / matching.length) * 70);
                const content = await this.#readFileContent(file, this.#createProgress(from, to, progressFunc));
                results.push({name, content});
            }

            return results;
        } catch (e) {
            if (e instanceof SyntaxError) {
                throw new Error('githubInvalidGistContent', {cause: e});
            }

            throw e;
        }
    }

    async writeFiles(contents, progressFunc = null, cycle = null) {
        await this.#findDeltaGist();

        const files = {};
        for (const [name, content] of Object.entries(contents)) {
            files[name] = {content};
        }

        const {gist, etag} = await this.#patchOrCreate({files}, progressFunc);

        if (cycle) {
            cycle.gist = gist;
            cycle.etag = etag;
        }

        return gist;
    }

    async #patchOrCreate(body, progressFunc) {
        let response;
        const creating = !this.hasGist;

        if (creating) {
            response = await this.#requestRaw('POST', this.#mainUrl, {
                public: false,
                description: this.#gistName,
                ...body,
            }, undefined, progressFunc);
        } else {
            response = await this.#requestRaw('PATCH', this.#gistUrl, body, undefined, progressFunc);
        }

        const gist = this.#processInfo(await response.json());

        if (creating) {
            this.#gistId = gist.id;
            setStoredGistId(this.#gistName, this.#gistId);
        }

        return {gist, etag: response.headers.get('etag')};
    }

    async deleteFile(name, progressFunc = null) {
        await this.#findDeltaGist();

        if (!this.hasGist) {
            throw new Error('githubNotFound');
        }

        const {gist} = await this.#patchOrCreate({
            files: {
                [name]: null,
            },
        }, progressFunc);

        return gist;
    }

    async acquireLock(deviceId, progressFunc = null, cycle = null) {
        let stamped = false;

        try {
            const lock = await this.readFile(LOCK_FILE_NAME, progressFunc, cycle);
            const serverNow = this.getServerTimeMs() ?? Date.now();

            if (!canWriteLock(lock, deviceId, serverNow)) {
                return false;
            }

            await this.writeFiles({
                [LOCK_FILE_NAME]: makeLockStamp(deviceId, serverNow),
            });

            stamped = true;

            await Utils.wait(LOCK_CONFIRM_DELAY_MS);

            const confirmed = await this.#confirmLock(cycle, progressFunc);
            return didWinLock(confirmed, deviceId);
        } catch {
            if (stamped) {
                await this.releaseLock();
            }
            return false;
        }
    }

    async #confirmLock(cycle, progressFunc = null) {
        const {gist, etag} = await this.#fetchGistState(progressFunc);

        if (cycle) {
            cycle.gist = gist;
            cycle.etag = etag;
        }

        const file = gist.files[LOCK_FILE_NAME];
        return file ? await this.#readFileContent(file) : null;
    }

    async releaseLock(progressFunc = null) {
        try {
            await this.deleteFile(LOCK_FILE_NAME, progressFunc);
        } catch {
        }
    }

    async #request(method, url, body = null, options = {}, progressFunc = null) {
        const response = await this.#requestRaw(method, url, body, options, progressFunc);
        return response.json();
    }

    async #requestRaw(method, url, body = null, options = {}, progressFunc = null) {
        const isApi = url.startsWith(GithubGist.apiUrl);

        options.method = method;
        options.headers ??= {};

        if (isApi) {
            Object.assign(options.headers, GithubGist.defaultHeaders);
        }

        if (GithubGist.isAuthorizedHost(url)) {
            options.headers.Authorization = `Bearer ${this.#token}`;
        }

        if (options.method === 'GET') {
            url = Utils.setUrlSearchParams(url, body ?? {});
            options.cache ??= 'no-store';
        } else if (body) {
            if (body.files) {
                for (const file of Object.values(body.files)) {
                    if (file && file.content && typeof file.content !== 'string') {
                        file.content = JSON.stringify(file.content, null, 2);
                    }
                }
            }

            options.body = JSON.stringify(body);
            options.headers['Content-Type'] = 'application/json';
        }

        const response = await this.#progressFetch(url, options, progressFunc);

        this.#captureServerTime(response);

        if (response.ok) {
            return response;
        }

        if (!isApi) {
            let host;
            try {
                host = new URL(url).host;
            } catch {
                host = 'raw content host';
            }
            throw new Error(`GitHub ${method} ${host} failed: HTTP ${response.status}`, {cause: response});
        }

        const classicScopes = response.headers.get('x-oauth-scopes');
        if (classicScopes && !classicScopes.includes('gist')) {
            throw new Error('githubTokenNoAccess');
        }

        if (response.status === 401) {
            throw new Error('githubInvalidToken');
        }

        if (response.status === 403 || response.status === 429) {
            const retryAfter = response.headers.get('retry-after');
            const remaining = response.headers.get('x-ratelimit-remaining');

            if (remaining === '0') {
                const unix = response.headers.get('x-ratelimit-reset');
                throw new Error(`githubRateLimit:${unix}000`);
            }

            if (retryAfter !== null || response.status === 429) {
                const seconds = Number(retryAfter);
                const delayMs = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 60_000;
                throw new Error(`githubRateLimit:${Date.now() + delayMs}`);
            }

            throw new Error('githubTokenNoAccess');
        }

        if (response.status === 404) {
            throw new Error('githubNotFound');
        }

        const result = await response.clone().json();
        const errors = result.errors?.map(err => err.message) ?? [];
        const errorsMessage = errors.length ? `. Errors: ${errors.join(', ')}` : '';

        if (response.status === 422) {
            if (['contents', 'large'].every(s => errorsMessage.includes(s))) {
                const bytes = Object.values(body.files)
                    .map(file => file?.content ? Utils.encodeToBytes(file.content).length : 0)
                    .reduce((acc, fSize) => acc + fSize, 0);

                throw new Error(`githubContentsTooLarge:${bytes}`);
            }
        }

        throw new Error(`${response.status}: ${result.message}${errorsMessage}`, {cause: response});
    }

    #createProgress(currentProgress, progressDuration, progressFunc = null) {
        return progress => this.#callProgress(currentProgress, progressDuration, progress, progressFunc);
    }

    #callProgress(currentProgress, progressDuration, progress, progressFunc = null) {
        const durationPart = (progressDuration - currentProgress) / 100;
        const mainPercent = currentProgress + Math.floor(progress * durationPart);
        progressFunc?.(mainPercent);
    }

    async #progressFetch(url, options, progressFunc = null) {
        const cacheUrlKey = await Utils.sha256Hex([this.#fileName, options.method, url].join(''));
        const cache = storage.create('cache').create(cacheUrlKey.slice(0, 5));

        if (options.method === 'GET') {
            const response = await fetch(url, options);

            const stream = new ReadableStream({
                start: async controller => {
                    let length = +response.headers.get('content-length') || cache.responseLength || 0;
                    let received = 0;

                    for await (const chunk of response.body) {
                        controller.enqueue(chunk);

                        received += chunk.length;

                        if (length <= 0) {
                            length = received * 7;
                        } else if (length < received) {
                            length = received;
                        }

                        const percent = Math.floor(received / length * 100);
                        this.#callProgress(0, 100, percent, progressFunc);
                    }

                    if (response.ok) {
                        cache.responseLength = length;
                    }

                    controller.close();
                },
            });

            return new Response(stream, response);
        } else { // POST, PATCH, ...
            // use XMLHttpRequest for upload progress
            // because fetch doesn't support upload progress now :(
            // https://developer.mozilla.org/en-US/docs/Web/API/Request/body

            const createXHRProgess = (currentProgress, progressDuration) => {
                let total;
                return event => {
                    total ??= event.lengthComputable
                        ? event.total
                        : (event.target instanceof XMLHttpRequest ? (cache.responseLength || 0) : null);

                    if (total <= 0) {
                        total = event.loaded * 7;
                    } else if (total < event.loaded) {
                        total = event.loaded;
                    }

                    const xhrProgress = Math.floor(event.loaded / total * 100);
                    this.#callProgress(currentProgress, progressDuration, xhrProgress, progressFunc);
                };
            }

            const xhr = await new Promise(resolve => {
                const xhr = new XMLHttpRequest();

                xhr.open(options.method, url, true);

                for (const [key, value] of Object.entries(options.headers)) {
                    xhr.setRequestHeader(key, value);
                }

                xhr.upload.onprogress = createXHRProgess(0, 70);
                xhr.onprogress = createXHRProgess(70, 100);
                xhr.onload = xhr.onerror = xhr.onabort = () => resolve(xhr);

                xhr.send(options.body);
            });

            if (xhr.status >= 200 && xhr.status < 204) {
                cache.responseLength = xhr.responseText.length;
            }

            const headers = xhr.getAllResponseHeaders().trim().split(/[\r\n]+/).reduce((acc, line) => {
                const sep = line.indexOf(': ');
                if (sep !== -1) {
                    acc.push([line.slice(0, sep), line.slice(sep + 2)]);
                }
                return acc;
            }, []);

            return new Response(xhr.responseText, {
                status: xhr.status,
                statusText: xhr.statusText,
                headers: new Headers(headers),
            });
        }
    }

    /* createProgressBody(bodyStr, progressFunc) {
        // options.duplex = 'half'; // TODO: not supported by firefox now :(
        // https://developer.mozilla.org/en-US/docs/Web/API/Request/duplex

        const jsonBytes = new TextEncoder().encode(bodyStr); // Uint8Array
        const length = jsonBytes.byteLength;
        let uploaded = 0;

        const onProgress = uploaded => {
            const percent = Math.floor(uploaded / length * 100);
            progressFunc(percent);
        };

        const readableStream = new ReadableStream({
            start(controller) {
                const chunkSize = 1024 * 256; // 256 KB
                for (let i = 0; i < length; i += chunkSize) {
                    controller.enqueue(jsonBytes.slice(i, i + chunkSize));
                }
                controller.close();
            }
        });

        const transformStream = new TransformStream({
            transform(chunk, controller) { // chunk is Uint8Array
                uploaded += chunk.byteLength;
                onProgress(uploaded);
                controller.enqueue(chunk);
            }
        });

        return readableStream.pipeThrough(transformStream);
    } */
}



// const compressFormat = 'gzip'; // gzip compress, now it doesn't support by github :(
// const blob = new Blob([bodyStr], {type: 'application/json'});
// const stream = blob.stream();
// const compressedReadableStream = stream.pipeThrough(new CompressionStream(compressFormat));
// const compressedResponse = new Response(compressedReadableStream);
// options.body = await compressedResponse.blob();
// options.headers['Content-Encoding'] = compressFormat;
