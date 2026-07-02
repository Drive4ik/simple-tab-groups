
import '/js/prefixed-storage.js';
import * as Constants from '/js/constants.js';
import * as Utils from '/js/utils.js';
import {LOCK_FILE_NAME} from '../delta/layout.js';
import {canWriteLock, didWinLock, makeLockStamp, LOCK_CONFIRM_DELAY_MS} from '../delta/lock.js';

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

// Per-gist persisted ETag for conditional pulls (delta-sync fast path). Stored in the
// synchronous CLOUD localStorage (same store as `lastUpdate`) so it survives restarts.
// Keyed by gist id so a token re-pointed at a different gist never reuses a stale ETag.
// Value is GitHub's opaque ETag string captured from the last gist GET / write response.
// See {@link GithubGist#isUnchangedSince} and the delta-sync conditional fast path.
const ETAG_STORAGE_KEY = 'gistEtag';

function readEtagMap() {
    const map = storage[ETAG_STORAGE_KEY];
    return (map && typeof map === 'object') ? map : {};
}

function getStoredEtag(gistId) {
    return gistId ? (readEtagMap()[gistId] ?? null) : null;
}

function setStoredEtag(gistId, etag) {
    if (!gistId || !etag) {
        return;
    }
    const map = readEtagMap();
    map[gistId] = etag;
    storage[ETAG_STORAGE_KEY] = map;
}

export default class GithubGist {
    #token = null;
    #fileName = null;
    #gistName = null;
    #gistId = null;

    #perPage = null; // max = 100

    // Set true once a write RESPONSE's ETag has been captured into the store for the current
    // gist revision (C2). While set, refreshEtagFromWrite() must NOT re-read via a follow-up
    // GET — that GET could observe a THIRD device's interleaved write and overwrite our
    // exact-revision marker, re-introducing the very skip-a-real-change bug C2 fixes.
    #haveFreshWriteEtag = false;

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

        // Capture the write-response ETag (C2) for the next conditional PULL. We do NOT send
        // If-Match here: GitHub does not support conditional requests on unsafe methods (PATCH),
        // and rejects them with a bare 400 — see #patchOrCreate.
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

    /**
     * Conditional "did the gist change since our last pull?" probe for the delta-sync
     * fast path. Does a single `GET /gists/:id` carrying `If-None-Match: <stored ETag>`;
     * GitHub answers `304 Not Modified` (empty body, NOT counted against the rate limit)
     * when nothing changed, or `200` with the gist + a fresh ETag when it did.
     *
     * FAIL-SAFE = "changed" (returns false): correctness must be identical to an
     * unconditional sync, so ANY doubt forces a full fetch. We return `false` when there
     * is no gist yet, no stored ETag (first sync / discovery), or on ANY transport/HTTP
     * error. The skip is purely an optimization layered on top — never a correctness gate.
     *
     * On a 200 the new ETag is persisted immediately, so even when the caller proceeds to
     * a full fetch the next cycle's probe is primed. (A successful write also refreshes the
     * stored ETag via {@link GithubGist#refreshEtagFromWrite}.)
     *
     * @param {?function} progressFunc
     * @returns {Promise<boolean>} `true` ONLY when GitHub confirmed 304 (safe to skip the
     *   pull/apply); `false` in every other case (caller must do a full fetch).
     */
    async isUnchangedSince(progressFunc = null) {
        try {
            await this.#findDeltaGist();

            if (!this.hasGist) {
                return false; // no gist discovered yet ⇒ full fetch (first sync / discovery)
            }

            const storedEtag = getStoredEtag(this.#gistId);
            if (!storedEtag) {
                return false; // nothing to compare against ⇒ full fetch, then capture below
            }

            const {status, etag} = await this.#conditionalGet(this.#gistUrl, storedEtag, progressFunc);

            if (status === 304) {
                return true; // confirmed unchanged ⇒ safe to skip pull/apply
            }

            // 200 (or anything else 2xx): the gist changed. Capture the fresh ETag so the
            // upcoming full fetch's result is primed for the next cycle, then report changed.
            if (etag) {
                setStoredEtag(this.#gistId, etag);
            }

            return false;
        } catch {
            // transport / parse / HTTP error ⇒ fail safe to a full fetch. The optimization
            // never suppresses a real remote change; worst case is one extra unconditional pull.
            return false;
        }
    }

    /**
     * After a successful write (push), refresh the stored ETag from the gist's current
     * state so the NEXT cycle's {@link GithubGist#isUnchangedSince} probe compares against
     * the post-push revision (otherwise our own push would always read back as "changed").
     * Best-effort: a failure just means the next probe does a full fetch (fail-safe).
     * @param {?function} progressFunc
     * @returns {Promise<void>}
     */
    async refreshEtagFromWrite(progressFunc = null) {
        try {
            if (!this.hasGist) {
                return;
            }
            // C2: if our last write already captured its response ETag, that marker pins the
            // EXACT revision we produced. A follow-up GET here could instead observe a THIRD
            // device's write that landed in between and store ITS ETag as "ours" — making the
            // next probe 304 against a revision we never applied (the bug C2 fixes). So skip
            // the GET entirely when the write-response ETag is already in hand.
            if (this.#haveFreshWriteEtag) {
                this.#haveFreshWriteEtag = false;
                return;
            }
            const {etag} = await this.#conditionalGet(this.#gistUrl, null, progressFunc);
            if (etag) {
                setStoredEtag(this.#gistId, etag);
            }
        } catch {
            // ignore: a missing ETag only costs one extra full fetch next cycle (fail-safe).
        }
    }

    /**
     * Low-level conditional GET that, unlike {@link GithubGist#getInfo}, reads the response
     * HEADERS (for the ETag) and tolerates an empty `304` body. Bypasses `#progressFetch`'s
     * streaming JSON wrapper (which would throw on a bodyless 304) and `#request` (which
     * discards headers). Sends `If-None-Match` when `etag` is provided. Returns the status
     * + the response ETag; never parses the body (we only need "changed or not" + the tag).
     * @param {string} url - the gist API url.
     * @param {?string} etag - prior ETag to send as `If-None-Match`, or null for an unconditional read.
     * @param {?function} progressFunc
     * @returns {Promise<{status: number, etag: ?string}>}
     */
    async #conditionalGet(url, etag, progressFunc = null) {
        const headers = {
            ...GithubGist.defaultHeaders,
            Authorization: `Bearer ${this.#token}`,
        };
        if (etag) {
            headers['If-None-Match'] = etag;
        }

        // no-store so the browser HTTP cache can't shortcut the conditional request before
        // it reaches GitHub (mirrors `#request`'s GET cache policy).
        const response = await fetch(url, {method: 'GET', headers, cache: 'no-store'});

        this.#captureServerTime(response);

        progressFunc?.(100);

        return {
            status: response.status,
            etag: response.headers.get('etag'),
        };
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
     * @returns {Promise<?Object>} parsed content, or null if the file is absent.
     */
    async readFile(name, progressFunc = null) {
        try {
            const progressApiFunc = this.#createProgress(0, 50, progressFunc);
            const progressRawFunc = this.#createProgress(50, 100, progressFunc);

            await this.#findDeltaGist();

            if (!this.hasGist) {
                return null;
            }

            const gist = await this.getInfo(undefined, progressApiFunc);
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
     * @returns {Promise<Array<{name: string, content: Object}>>} ([] if no gist).
     */
    async readAllMatching(prefix, progressFunc = null) {
        try {
            const progressApiFunc = this.#createProgress(0, 30, progressFunc);

            await this.#findDeltaGist();

            if (!this.hasGist) {
                return [];
            }

            const gist = await this.getInfo(undefined, progressApiFunc);

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
     * @returns {Promise<Object>} the refreshed gist info (incl. `lastUpdate`).
     */
    async writeFiles(contents, progressFunc = null) {
        await this.#findDeltaGist();

        const files = {};
        for (const [name, content] of Object.entries(contents)) {
            files[name] = {content};
        }

        const progressSend = this.#createProgress(0, 70, progressFunc);
        const progressGet = this.#createProgress(70, 100, progressFunc);

        // No If-Match guard: GitHub does not support conditional requests on unsafe methods
        // (PATCH/POST/DELETE) and rejects an If-Match'd gist PATCH with a bare 400 (the ETag it
        // returns is weak, which If-Match forbids anyway). Snapshot clobbering between two
        // simultaneously-compacting devices is harmless — per-device delta files use disjoint
        // keys and are never clobbered, so the next compaction simply re-folds them; the sync
        // re-pulls + re-merges every cycle. The write-response ETag is still captured (C2) for
        // the conditional PULL fast path (If-None-Match on GET, which GitHub DOES support).
        await this.#patchOrCreate({files}, progressSend);

        // refresh info after write (GitHub sometimes back-dates updated_at by 1s)
        return await this.getInfo(undefined, progressGet);
    }

    /**
     * Execute one PATCH-or-POST write to the gist and capture the resulting ETag (C2): the
     * ETag stored as "our last-known" must pin EXACTLY the revision we produced, so we read
     * it from the write RESPONSE — never from a follow-up GET, which a third device could
     * have advanced between our write and that GET. Sets the gist id on first create.
     *
     * @param {Object} body - the request body (`{files, ...}`).
     * @param {?function} progressSend
     * @returns {Promise<void>}
     */
    async #patchOrCreate(body, progressSend) {
        let response;

        if (this.hasGist) {
            // No If-Match: GitHub rejects conditional requests on unsafe methods (PATCH) with a
            // bare 400 Bad Request, and the ETag it returns is weak (invalid in If-Match anyway).
            response = await this.#requestRaw('PATCH', this.#gistUrl, body, undefined, progressSend);
        } else {
            response = await this.#requestRaw('POST', this.#mainUrl, {
                public: false,
                description: this.#gistName,
                ...body,
            }, undefined, progressSend);

            const gist = await response.clone().json();
            this.#gistId = gist.id;
            setStoredGistId(this.#gistName, this.#gistId);
        }

        // C2: pin the stored conditional-pull marker to the exact revision THIS write produced.
        const etag = response.headers.get('etag');
        if (etag) {
            setStoredEtag(this.#gistId, etag);
            this.#haveFreshWriteEtag = true; // suppress the redundant refreshEtagFromWrite GET
        }
    }

    /**
     * Delete one file from the gist (PATCH with the file set to `null`, GitHub's
     * delete primitive). Used by P4 compaction to trim folded delta files.
     * @param {string} name
     * @param {?function} progressFunc
     * @returns {Promise<Object>} the refreshed gist info.
     */
    async deleteFile(name, progressFunc = null) {
        await this.#findDeltaGist();

        if (!this.hasGist) {
            throw new Error('githubNotFound');
        }

        const progressSend = this.#createProgress(0, 70, progressFunc);
        const progressGet = this.#createProgress(70, 100, progressFunc);

        // Compaction GC only deletes per-device delta files (never the shared snapshot), so
        // no If-Match guard is needed; still capture the write-response ETag (C2) so the next
        // conditional probe pins the post-delete revision.
        await this.#patchOrCreate({
            files: {
                [name]: null,
            },
        }, progressSend);

        return await this.getInfo(undefined, progressGet);
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
     * @returns {Promise<boolean>} true iff this device now holds the lock.
     */
    async acquireLock(deviceId, progressFunc = null) {
        let stamped = false;

        try {
            const lock = await this.readFile(LOCK_FILE_NAME, progressFunc);
            const serverNow = this.getServerTimeMs() ?? Date.now();

            if (!canWriteLock(lock, deviceId, serverNow)) {
                return false;
            }

            await this.writeFiles({
                [LOCK_FILE_NAME]: makeLockStamp(deviceId, serverNow),
            });

            stamped = true;

            await Utils.wait(LOCK_CONFIRM_DELAY_MS);

            const confirmed = await this.readFile(LOCK_FILE_NAME, progressFunc);
            return didWinLock(confirmed, deviceId);
        } catch {
            if (stamped) {
                await this.releaseLock();
            }
            return false;
        }
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
     * (notably the `ETag` produced by a write — see C2). All status / rate-limit /
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
