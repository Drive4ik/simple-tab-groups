
/**
 * Pure URL classifiers shared by the delta capture + transport layers so they all
 * agree on WHICH tab URLs roam through delta sync, and how STG's "unsupported URL"
 * stub page maps back to the original URL it embeds.
 *
 * ## Why a separate predicate from `Utils.isUrlAllowToCreate`
 * `isUrlAllowToCreate` governs REAL tab creation: it deliberately rejects privileged
 * `about:` URLs (about:debugging, about:config, …) so that `Tabs.create` substitutes
 * the moz-extension "unsupported URL" stub page instead of failing. We must NOT broaden
 * it, or the stub substitution stops triggering.
 *
 * Sync, however, SHOULD carry those privileged `about:` URLs: the receiving machine
 * renders them as the stub (showing the original URL text) rather than silently dropping
 * the tab. So {@link isUrlSyncable} is a WIDER allow-list than `isUrlAllowToCreate`: it
 * admits non-trivial `about:` URLs on top of everything `isUrlAllowToCreate` admits, but
 * still rejects the trivial / default new-tab states (about:blank, about:newtab,
 * about:home, about:privatebrowsing) which are pure noise.
 *
 * ## Feedback-loop guard ({@link unwrapStubUrl})
 * After a receiving machine renders a synced `about:debugging` tab as the stub, that
 * tab's LIVE url becomes `moz-extension://<uuid>/help/stg-unsupported-url.html?url=about:debugging`
 * — which IS allowed by `isUrlAllowToCreate`, so capture would otherwise record it as a
 * competing tab record that diverges from the original `about:` identity. {@link unwrapStubUrl}
 * decodes the stub back to the embedded original `about:` URL so the captured record keeps
 * the original identity (no moz-extension divergence loop). It is the inverse of
 * `tabs.js` `createUnsupportedUrlPage` (which stores the original in the `?url=` param).
 *
 * ## Purity
 * No `browser.*` and no `constants.js` import (which is browser-dependent), so the pure
 * unit tests can import this module directly under node. The stub page is matched by its
 * stable path suffix (`/help/stg-unsupported-url.html`) rather than the per-install
 * moz-extension UUID, which keeps the match pure and install-independent.
 *
 * @module sync/delta/url-sync
 */

/**
 * Trivial / empty `about:` URLs that represent a default new-tab / blank state. These are
 * noise (every fresh tab is one of these) and must NOT sync, even though they are `about:`
 * URLs. `about:blank` additionally passes `Utils.isUrlAllowToCreate`, but it is still not
 * worth roaming.
 * @readonly
 */
export const NON_SYNCABLE_ABOUT_URLS = Object.freeze(new Set([
    'about:blank',
    'about:newtab',
    'about:home',
    'about:privatebrowsing',
]));

/** Path suffix of STG's "unsupported URL" stub page (see `tabs.js` createUnsupportedUrlPage). */
const STUB_PAGE_PATH_SUFFIX = '/help/stg-unsupported-url.html';

/**
 * Does this tab URL roam through delta sync? A WIDER allow-list than
 * `Utils.isUrlAllowToCreate`: everything that admits, PLUS non-trivial `about:` URLs
 * (about:debugging, about:config, about:addons, about:preferences, …) which the receiving
 * machine renders as the stub page. Excludes the trivial new-tab/blank `about:` states
 * ({@link NON_SYNCABLE_ABOUT_URLS}).
 *
 * Pure string predicate (no `browser.*`).
 *
 * @param {string} url
 * @returns {boolean}
 */
export function isUrlSyncable(url) {
    if (typeof url !== 'string' || !url) {
        return false;
    }

    if (NON_SYNCABLE_ABOUT_URLS.has(url)) {
        return false;
    }

    // non-trivial about: URL (about:debugging, about:config, …): syncable. The receiving
    // machine can't create it directly (isUrlAllowToCreate rejects it) so apply renders
    // the stub page — but the synced RECORD carries the real about: url for identity.
    if (url.startsWith('about:')) {
        return true;
    }

    // everything the real-creation allow-list admits (http, moz-extension, view-source,
    // about:blank). about:blank is already excluded above, so it never reaches here.
    return /^((http|moz-extension|view-source)|about:blank)/.test(url);
}

/**
 * If `url` is STG's moz-extension "unsupported URL" stub page, return the ORIGINAL url it
 * embeds (the `?url=` param); otherwise return `url` unchanged. Inverse of `tabs.js`
 * `createUnsupportedUrlPage`. Used by the capture layer so a synced `about:` tab whose
 * LIVE url is the stub is recorded under its original `about:` identity rather than the
 * moz-extension url (which would diverge from the originating machine).
 *
 * Pure (matches the stub by its stable path suffix, not the per-install UUID). Never
 * throws — a malformed url falls through to the original.
 *
 * @param {string} url
 * @returns {string}
 */
export function unwrapStubUrl(url) {
    if (typeof url !== 'string' || !url.startsWith('moz-extension://')) {
        return url;
    }

    try {
        const parsed = new URL(url);
        if (parsed.pathname.endsWith(STUB_PAGE_PATH_SUFFIX)) {
            const original = parsed.searchParams.get('url');
            if (original) {
                return original;
            }
        }
    } catch {
        // malformed url — fall through to original
    }

    return url;
}

/**
 * STUB-AWARE url match used by the sync-apply uid STAMPING step ({@link module:sync/delta/delta-sync}):
 * does a freshly-created live tab's url correspond to a create source's url?
 *
 * A privileged `about:` source (about:debugging, about:memory, …) is created as STG's
 * moz-extension "unsupported URL" stub, so the live tab's url is the stub while the source url is
 * the original `about:…`. Without decoding, the stamp's url match FAILS for such tabs, leaving them
 * UNSTAMPED → re-created every cycle (the about:/stub re-flood). Comparing the live url BOTH raw and
 * stub-decoded fixes that. Pure (delegates to {@link unwrapStubUrl}).
 *
 * @param {string} liveUrl - the created tab's live url (may be the stub).
 * @param {string} sourceUrl - the sync record's url.
 * @returns {boolean}
 */
export function liveUrlMatchesSource(liveUrl, sourceUrl) {
    return liveUrl === sourceUrl || unwrapStubUrl(liveUrl) === sourceUrl;
}

/**
 * NO-OP CONVERGENCE GUARD for the content-update apply ({@link module:sync/delta/delta-sync}
 * `applyTabContentUpdate`): should the transport actually navigate a LOADED tab to `targetUrl`,
 * or is it already there (so navigating would be a wasteful re-load — the "loads infinitely"
 * spinner when the planner re-emits the same url every cycle)?
 *
 * Navigate ONLY when the tab's CURRENT url (stub-decoded so a stub-rendered about: tab compares by
 * its embedded identity, which is what the target carries) differs from the target. Equal ⇒ no-op.
 * Pure (delegates to {@link unwrapStubUrl}).
 *
 * @param {string} liveUrl - the live tab's current url.
 * @param {string} targetUrl - the url the update wants the tab to be at.
 * @returns {boolean} true ⇒ navigate; false ⇒ already converged, do nothing.
 */
export function shouldNavigateLiveTabUrl(liveUrl, targetUrl) {
    return unwrapStubUrl(liveUrl) !== targetUrl;
}

/**
 * Maximum length of a `favIconUrl` reference (http(s)/moz-extension URL) we are willing to
 * carry in a synced record. Inline `data:` favicons are dropped outright (see
 * {@link sanitizeFavIconUrl}); this cap only guards against a pathologically long URL
 * reference. ~50 000 chars comfortably clears any real favicon URL.
 * @readonly
 */
export const MAX_SYNCABLE_FAVICON_LENGTH = 50000;

/**
 * Sanitize a `favIconUrl` for storage in a delta event / snapshot record.
 *
 * Inline `data:` favicons are DROPPED (returns undefined): a single base64 PNG blob is
 * 2–50 KB and, cloned into a tab/pinned record per tab on the bootstrap/compaction path,
 * it inflated `syncDeltaLog` into multiple GB of RAM. Only small URL references
 * (http(s)/moz-extension) are kept; the receiving machine re-fetches the actual icon from
 * the live page on load. Favicons are cosmetic, so dropping the inline blob never affects
 * tab identity (url/title/group/pinned).
 *
 * Pure string function (no `browser.*`). Returns `undefined` when the favicon must be
 * dropped, so callers can simply assign the result (an `undefined` field is omitted by
 * structured clone / JSON).
 *
 * @param {string|undefined} favIconUrl
 * @returns {string|undefined} the favicon url to store, or undefined to drop it.
 */
export function sanitizeFavIconUrl(favIconUrl) {
    if (typeof favIconUrl !== 'string' || !favIconUrl) {
        return undefined;
    }
    if (favIconUrl.startsWith('data:')) {
        return undefined;
    }
    if (favIconUrl.length > MAX_SYNCABLE_FAVICON_LENGTH) {
        return undefined;
    }
    return favIconUrl;
}

export function sanitizeGroupIconUrl(iconUrl) {
    if (typeof iconUrl !== 'string' || !iconUrl) {
        return undefined;
    }
    if (iconUrl.length > MAX_SYNCABLE_FAVICON_LENGTH) {
        return undefined;
    }
    return iconUrl;
}

export function sanitizeGroupRecordForSync(group) {
    if (!group || typeof group !== 'object') {
        return group;
    }

    const sanitized = structuredClone(group);

    if (typeof sanitized.iconUrl === 'string' && sanitizeGroupIconUrl(sanitized.iconUrl) === undefined) {
        delete sanitized.iconUrl;
    }

    for (const tab of Array.isArray(sanitized.tabs) ? sanitized.tabs : []) {
        if (!tab || typeof tab !== 'object') {
            continue;
        }
        delete tab.thumbnail;
        if (Object.hasOwn(tab, 'favIconUrl')) {
            const favIconUrl = sanitizeFavIconUrl(tab.favIconUrl);
            if (favIconUrl === undefined) {
                delete tab.favIconUrl;
            } else {
                tab.favIconUrl = favIconUrl;
            }
        }
    }

    return sanitized;
}
