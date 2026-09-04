import {isUrlSyncable, unwrapStubUrl, shouldNavigateLiveTabUrl} from './url-sync.js';

export const REFUSED_DISCARDED = 'discarded';
export const REFUSED_UNSYNCABLE_URL = 'unsyncableUrl';

export function buildTabContentCacheWrite(liveTab, contentPlan, target) {
    const live = liveTab || {};
    const props = target || {};

    return {
        ...live,
        url: contentPlan.url,
        title: contentPlan.title,
        favIconUrl: Object.hasOwn(props, 'favIconUrl') ? props.favIconUrl : live.favIconUrl,
    };
}

export function planTabContentApply(liveTab, target) {
    const live = liveTab || {};
    const props = target || {};

    const hasUrl = Object.hasOwn(props, 'url');
    const hasTitle = Object.hasOwn(props, 'title');

    const keepLiveContent = refusal => ({
        url: live.url,
        title: live.title,
        navigate: false,
        refusal,
    });

    if (!hasUrl && !hasTitle) {
        return keepLiveContent(null);
    }

    const nextTitle = hasTitle ? props.title : live.title;

    if (!hasUrl || !shouldNavigateLiveTabUrl(live.url, props.url)) {
        if (live.discarded === true && nextTitle !== live.title) {
            return keepLiveContent(REFUSED_DISCARDED);
        }

        return {url: live.url, title: nextTitle, navigate: false, refusal: null};
    }

    if (!isUrlSyncable(unwrapStubUrl(props.url))) {
        return keepLiveContent(REFUSED_UNSYNCABLE_URL);
    }

    if (live.discarded === true) {
        return keepLiveContent(REFUSED_DISCARDED);
    }

    return {url: props.url, title: nextTitle, navigate: true, refusal: null};
}
