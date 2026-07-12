export const NON_SYNCABLE_ABOUT_URLS = Object.freeze(new Set([
    'about:blank',
    'about:newtab',
    'about:home',
    'about:privatebrowsing',
]));

const STUB_PAGE_PATH_SUFFIX = '/help/stg-unsupported-url.html';

export function isUrlSyncable(url) {
    if (typeof url !== 'string' || !url) {
        return false;
    }

    if (NON_SYNCABLE_ABOUT_URLS.has(url)) {
        return false;
    }

    if (url.startsWith('about:')) {
        return true;
    }

    return /^((http|moz-extension|view-source)|about:blank)/.test(url);
}

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
        return url;
    }

    return url;
}

export function liveUrlMatchesSource(liveUrl, sourceUrl) {
    return liveUrl === sourceUrl || unwrapStubUrl(liveUrl) === sourceUrl;
}

export function shouldNavigateLiveTabUrl(liveUrl, targetUrl) {
    return unwrapStubUrl(liveUrl) !== targetUrl;
}

export const MAX_SYNCABLE_FAVICON_LENGTH = 50000;

export const MAX_FILE_FAVICON_LENGTH = 30000;

export function sanitizeFavIconUrlForFile(favIconUrl) {
    if (typeof favIconUrl !== 'string' || !favIconUrl.startsWith('data:')) {
        return undefined;
    }
    if (favIconUrl.length > MAX_FILE_FAVICON_LENGTH) {
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
        delete tab.favIconUrl;
    }

    return sanitized;
}
