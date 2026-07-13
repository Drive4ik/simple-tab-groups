import {closedTabCapturePlan} from './close-capture.js';

const TAB_OPS = new Set(['tab.add', 'tab.modify', 'tab.move', 'tab.remove']);
const PINNED_OPS = new Set(['pinned.add', 'pinned.modify', 'pinned.move', 'pinned.remove']);

function eventUid(event) {
    return event.uid ?? event.tab?.uid ?? null;
}

export function planStartupReconcile({events, lastPushedSeq, aliveUids, isPinnedGroupId}) {
    const latestTabEventByUid = new Map();
    const latestPinnedEventByUid = new Map();
    const unpushedUids = new Set();

    for (const event of events || []) {
        const uid = eventUid(event);
        if (uid == null) {
            continue;
        }

        if (TAB_OPS.has(event.op)) {
            latestTabEventByUid.set(uid, event);
        } else if (PINNED_OPS.has(event.op)) {
            latestPinnedEventByUid.set(uid, event);
        } else {
            continue;
        }

        if (event.seq > lastPushedSeq) {
            unpushedUids.add(uid);
        }
    }

    const items = [];

    for (const uid of unpushedUids) {
        if (aliveUids.has(uid)) {
            continue;
        }

        const tabEvent = latestTabEventByUid.get(uid);
        const pinnedEvent = latestPinnedEventByUid.get(uid);
        const groupId = tabEvent && tabEvent.op !== 'tab.remove' ? tabEvent.groupId : null;
        const hasLivePinnedRecord = pinnedEvent != null && pinnedEvent.op !== 'pinned.remove';

        if (groupId == null && !hasLivePinnedRecord) {
            continue;
        }

        const plan = closedTabCapturePlan({uid, groupId, wasPinned: true}, isPinnedGroupId);

        if (plan.removeFromGroupId) {
            items.push({op: 'tab.remove', groupId: plan.removeFromGroupId, uid});
        }
        if (plan.retirePinnedUid) {
            items.push({op: 'pinned.remove', uid: plan.retirePinnedUid});
        }
    }

    return items;
}
