import Logger from '/js/logger.js';
import * as Cache from '/js/cache.js';
import * as DeltaCapture from './delta-capture.js';
import {planPendingNavOnTabUpdate} from './pending-nav.js';
import {getPendingNavTarget, clearPendingNavTarget} from './pending-nav-store.js';

const logger = new Logger('DeltaPendingNav');

async function navigateToDeferredTarget(tab, plan) {
    DeltaCapture.markAppliedNavigation(tab.id, plan.url);

    return DeltaCapture.runApplying(async () => {
        try {
            await browser.tabs.update(tab.id, {url: plan.url});
            return true;
        } catch (e) {
            DeltaCapture.clearAppliedNavigation(tab.id);
            logger.onCatch(['cant apply deferred navigation', tab.id], false)(e);
            return false;
        }
    });
}

export async function resolvePendingNav(tab, {woke = false, contentChanged = false} = {}) {
    const uid = Cache.getTabUid(tab.id);
    if (!uid) {
        return false;
    }

    const entry = getPendingNavTarget(uid);
    if (!entry) {
        return false;
    }

    const plan = planPendingNavOnTabUpdate(entry, tab, {woke, contentChanged, now: Date.now()});
    if (!plan.clear) {
        return false;
    }

    clearPendingNavTarget(uid);

    if (!plan.navigate) {
        logger.log('deferred navigation dropped', {tabId: tab.id, uid, reason: plan.reason});
        return false;
    }

    const navigated = await navigateToDeferredTarget(tab, plan);

    if (navigated) {
        logger.log('deferred navigation applied on wake', {tabId: tab.id, uid, url: plan.url});
    }

    return navigated;
}
