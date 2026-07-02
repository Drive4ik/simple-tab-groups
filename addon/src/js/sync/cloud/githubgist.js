
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

    // Latest SERVER time (ms) parsed from any gist response's `Date` header. The advisory
    // lock's TTL is computed against the SERVER clock (not this device's, which may be skewed)
    // so a stale lock is judged by the same clock every device sees. Refreshed on every
    // request that returns a `Date` header; null until the first such response. See
    // {@link GithubGist#getServerTimeMs} and {@link GithubGist#acquireLock}.
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
    static defaultHeaders = {
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
    };

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

    // -------------------------------------------------------------------------
    // Multi-file (delta-era) API — ADDITIVE. The single-file methods above keep
    // working unchanged for the current sync flow; these handle the new gist
    // layout (STG-sync-snapshot.json + per-device STG-sync-delta-*.json). Discovery
    // is by the gist NAME (#findGist), the same gist the single-file flow resolves,
    // so the delta files and the Cloud backup file share one named gist.
    // See `.project/DESIGN_DELTA_SYNC.md` and ../delta/layout.js.
    // -------------------------------------------------------------------------

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

    /**
     * Record the SERVER time from a response's `Date` header (RFC 1123) into
     * `#lastServerTimeMs`. Best-effort: a missing/unparseable header leaves the prior value
     * untouched. The advisory lock reads it via {@link GithubGist#getServerTimeMs}.
     * @param {Response} response
     */
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

    /**
     * The SERVER time (ms) most recently observed from a gist response's `Date` header, or
     * null if no response has carried one yet this session. Used by the advisory lock to
     * compute / judge TTLs against GitHub's clock rather than this device's (which may be
     * skewed). Callers fall back to `Date.now()` when this is null (see acquireLock).
     * @returns {?number}
     */
    getServerTimeMs() {
        return this.#lastServerTimeMs;
    }

    // Read+parse one gist file object, transparently following `raw_url` for files
    // GitHub truncates (mirrors getContent's large-file handling). Returns the
    // parsed JSON content. Caller maps a SyntaxError to 'githubInvalidGistContent'.
    async #readFileContent(file, progressFunc = null) {
        if (file.truncated) {
            return this.#request('GET', file.raw_url, undefined, undefined, progressFunc);
        }

        const content = JSON.parse(file.content);
        progressFunc?.(100);
        return content;
    }

    /**
     * List the names of every file currently in the (delta) gist.
     * @param {?function} progressFunc
     * @returns {Promise<string[]>} file names ([] if the gist does not exist yet).
     */
    async listFiles(progressFunc = null) {
        await this.#findDeltaGist();

        if (!this.hasGist) {
            return [];
        }

        const gist = await this.getInfo(undefined, progressFunc);

        return Object.keys(gist.files);
    }

    /**
     * Read and parse a single named file from the (delta) gist.
     * @param {string} name - file name (e.g. SNAPSHOT_FILE_NAME).
     * @param {?function} progressFunc
     * @param {?object} cycle - sync-cycle handle from {@link GithubGist#beginSyncCycle}.
     * @returns {Promise<?Object>} parsed content, or null if the file is absent.
     */
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

    /**
     * Read+parse every gist file whose name starts with `prefix` (e.g. the
     * DELTA_FILE_PREFIX to fetch all per-device delta logs). Truncated files are
     * followed via `raw_url` like {@link readFile}.
     * @param {string} prefix
     * @param {?function} progressFunc
     * @param {?object} cycle - sync-cycle handle from {@link GithubGist#beginSyncCycle}.
     * @returns {Promise<Array<{name: string, content: Object}>>} ([] if no gist).
     */
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
                // spread each file's read across the remaining 30..100 progress band
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

    /**
     * Write multiple files in a single PATCH (or POST to create the gist on first
     * write). `contents` is a `{ [fileName]: contentObject }` map; each value is
     * JSON-stringified by the request machinery. Per-device delta files mean
     * concurrent writers touch different files and never clobber each other.
     * @param {Object<string, Object>} contents
     * @param {?function} progressFunc
     * @param {?object} cycle - sync-cycle handle from {@link GithubGist#beginSyncCycle}.
     * @returns {Promise<Object>} the resulting gist info (incl. `lastUpdate`).
     */
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

    /**
     * Delete one file from the gist (PATCH with the file set to `null`, GitHub's
     * delete primitive).
     * @param {string} name
     * @param {?function} progressFunc
     * @returns {Promise<Object>} the resulting gist info.
     */
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

    // -------------------------------------------------------------------------
    // Advisory distributed lock (Part A) — serialize sync cycles across devices.
    // Best-effort, NOT compare-and-set (GitHub has no conditional write): acquire =
    // write-our-stamp THEN re-read to confirm we won any race; a crashed holder's stamp is
    // reclaimed via the server-clock TTL. Deferred self-truncation (compaction.js) is the
    // data-safety backstop. The lock file holds `{deviceId, expiresAt}` (server-clock ms).
    // See ../delta/lock.js for the pure decision helpers used here.
    // -------------------------------------------------------------------------

    /**
     * Try to ACQUIRE the advisory sync lock for `deviceId`. Protocol:
     *   1. Read the lock file (this refreshes the server clock from the response `Date`).
     *   2. If it is absent / stale / already ours → write our stamp `{deviceId, expiresAt}`
     *      with `expiresAt = serverNow + LOCK_TTL_MS`. If it is held, fresh, and another
     *      device's → DO NOT acquire (return false) without writing.
     *   3. After writing, wait a short confirm delay then RE-READ. We won iff the re-read
     *      stamp is still ours (a peer that wrote last in the race wins instead).
     *
     * Best-effort: ANY transport error returns false (caller skips this cycle and retries),
     * never throwing — the advisory lock must never be the thing that breaks a sync.
     *
     * @param {string} deviceId - this device's id (getDeviceId()).
     * @param {?function} progressFunc
     * @param {?object} cycle - sync-cycle handle from {@link GithubGist#beginSyncCycle}.
     * @returns {Promise<boolean>} true iff this device now holds the lock.
     */
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

    /**
     * RELEASE the advisory sync lock by deleting the lock file (GitHub's `{file: null}`
     * delete primitive, via {@link GithubGist#deleteFile}). Idempotent + best-effort: a
     * missing file or any transport error is swallowed, since a stale lock is reclaimed by
     * the TTL anyway. Always call this in a `finally` covering success, error, and the
     * apply-watchdog path.
     * @param {?function} progressFunc
     * @returns {Promise<void>}
     */
    async releaseLock(progressFunc = null) {
        try {
            await this.deleteFile(LOCK_FILE_NAME, progressFunc);
        } catch {
            // ignore: best-effort. The TTL reclaims a lock we failed to delete.
        }
    }

    async #request(method, url, body = null, options = {}, progressFunc = null) {
        const response = await this.#requestRaw(method, url, body, options, progressFunc);
        return response.json();
    }

    /**
     * Like {@link GithubGist#request} but resolves with the validated `Response`
     * object instead of its parsed JSON body, so a caller can read response HEADERS
     * (notably the `ETag` of a gist read/write). All status / rate-limit /
     * scope error mapping runs BEFORE returning, identical to `#request`, so a non-ok
     * response throws the same provider error it always did.
     *
     * @returns {Promise<Response>} the ok Response (body not yet consumed).
     */
    async #requestRaw(method, url, body = null, options = {}, progressFunc = null) {
        const isApi = url.startsWith(GithubGist.apiUrl);

        options.method = method;
        options.headers ??= {};

        if (isApi) {
            Object.assign(options.headers, GithubGist.defaultHeaders);
            options.headers.Authorization = `Bearer ${this.#token}`;
        }

        if (options.method === 'GET') {
            url = Utils.setUrlSearchParams(url, body ?? {});
            options.cache ??= 'no-store';
        } else if (body) {
            if (body.files) {
                for (const file of Object.values(body.files)) {
                    // a null file is GitHub's delete primitive (see deleteFile) - leave it
                    if (file && file.content && typeof file.content !== 'string') {
                        file.content = JSON.stringify(file.content, null, 2);
                    }
                }
            }

            options.body = JSON.stringify(body);
            options.headers['Content-Type'] = 'application/json';
        }

        const response = await this.#progressFetch(url, options, progressFunc);

        // Capture the SERVER clock from every response (ok or not) so the advisory lock's TTL
        // is judged against GitHub's clock, immune to this device's local clock skew.
        this.#captureServerTime(response);

        if (response.ok) {
            return response;
        }

        if (isApi) {
            const classicScopes = response.headers.get('x-oauth-scopes');
            if (classicScopes && !classicScopes.includes('gist')) {
                throw new Error('githubTokenNoAccess');
            }

            // const personalScopes = response.headers.get('x-accepted-github-permissions');
            // if (personalScopes && !personalScopes.includes('gists=write')) {
            //     throw new Error('githubTokenNoAccess');
            // }
        }

        if (response.status === 401) {
            throw new Error('githubInvalidToken');
        }

        // C3: rate limiting. GitHub signals it three ways, only the first of which was
        // handled before:
        //   1. PRIMARY limit: 403 with `x-ratelimit-remaining: 0` + `x-ratelimit-reset`.
        //   2. SECONDARY/abuse limit: 403 or 429 with a `Retry-After` header (seconds) and
        //      NO `x-ratelimit-remaining: 0` — previously mis-mapped to `githubTokenNoAccess`
        //      (a non-retryable auth error).
        //   3. 429 generally.
        // All map to a `githubRateLimit:<unixMs>` error the retry classifier treats as
        // retryable with backoff (respecting Retry-After when present).
        if (response.status === 403 || response.status === 429) {
            const retryAfter = response.headers.get('retry-after');
            const remaining = response.headers.get('x-ratelimit-remaining');

            if (remaining === '0') {
                const unix = response.headers.get('x-ratelimit-reset');
                throw new Error(`githubRateLimit:${unix}000`);
            }

            if (retryAfter !== null || response.status === 429) {
                // Retry-After is delta-seconds; convert to an absolute unix-ms "reset" the
                // CloudError formatter + retry classifier understand. Default to ~60s when the
                // header is absent (a 429 with no Retry-After).
                const seconds = Number(retryAfter);
                const delayMs = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 60_000;
                throw new Error(`githubRateLimit:${Date.now() + delayMs}`);
            }

            // a genuine 403 (forbidden / no gist scope) with no rate-limit signal
            throw new Error('githubTokenNoAccess');
        }

        if (response.status === 404) {
            throw new Error('githubNotFound');
        }

        // C1: `If-Match` precondition failed — a concurrent writer advanced the gist since
        // the ETag we sent. Surface a distinct marker so the snapshot-write caller can
        // re-pull the current revision and retry once (instead of clobbering the peer).
        if (response.status === 412) {
            throw new Error('githubPreconditionFailed', {cause: response});
        }

        // C4: a non-API host (e.g. a truncated file's raw_url on gist.githubusercontent.com)
        // never carries the JSON `{message, errors}` error envelope and may return an HTML
        // 5xx body. Parsing it as JSON below would throw a SyntaxError that the read callers
        // mis-map to `githubInvalidGistContent` (corruption) instead of a retryable transport
        // error. Surface the raw status so the failure stays retryable, not "corrupt".
        if (!isApi) {
            throw new Error(`${response.status}: github raw request failed`, {cause: response});
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
