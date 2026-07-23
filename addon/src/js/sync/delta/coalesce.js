import {deepClone} from './deep-clone.js';

const ADDITIVE_TAB_FLAGS = ['pinned', 'loaded'];

const TAB_UPSERT_OPS = new Set(['tab.add', 'tab.modify']);
const PINNED_UPSERT_OPS = new Set(['pinned.add', 'pinned.modify']);
const GROUP_UPSERT_OPS = new Set(['group.add', 'group.modify']);

function applyOrder(a, b) {
    const ta = a.ts ?? 0;
    const tb = b.ts ?? 0;
    if (ta !== tb) {
        return ta - tb;
    }
    return (a.seq ?? 0) - (b.seq ?? 0);
}

function targetKey(event) {
    switch (event.op) {
        case 'tab.add':
        case 'tab.modify':
            return event.tab?.uid == null ? null : `tab:${event.tab.uid}`;
        case 'tab.move':
        case 'tab.remove':
            return event.uid == null ? null : `tab:${event.uid}`;
        case 'pinned.add':
        case 'pinned.modify':
            return event.tab?.uid == null ? null : `pinned:${event.tab.uid}`;
        case 'pinned.move':
        case 'pinned.remove':
            return event.uid == null ? null : `pinned:${event.uid}`;
        case 'group.add':
        case 'group.modify':
            return event.group?.id == null ? null : `group:${event.group.id}`;
        case 'group.move':
        case 'group.remove':
            return event.groupId == null ? null : `group:${event.groupId}`;
        default:
            return null;
    }
}

function foldAdditiveFlags(tab, upserts) {
    for (const flag of ADDITIVE_TAB_FLAGS) {
        if (Object.hasOwn(tab, flag)) {
            continue;
        }
        for (let i = upserts.length - 1; i >= 0; i--) {
            if (Object.hasOwn(upserts[i].tab, flag)) {
                tab[flag] = deepClone(upserts[i].tab[flag]);
                break;
            }
        }
    }
}

function reduceTabLikeRun(run, isPinned) {
    if (run.length === 1) {
        return run;
    }

    const first = run[0];
    const last = run[run.length - 1];
    const uid = first.tab?.uid ?? first.uid;
    const stamp = {seq: last.seq, ts: last.ts};

    const upsertOps = isPinned ? PINNED_UPSERT_OPS : TAB_UPSERT_OPS;
    const addOp = isPinned ? 'pinned.add' : 'tab.add';
    const modifyOp = isPinned ? 'pinned.modify' : 'tab.modify';
    const moveOp = isPinned ? 'pinned.move' : 'tab.move';
    const removeOp = isPinned ? 'pinned.remove' : 'tab.remove';

    const startsWithAdd = first.op === addOp;

    if (last.op === removeOp) {
        if (startsWithAdd) {
            return [];
        }
        const event = {...stamp, op: removeOp, uid};
        if (!isPinned) {
            event.groupId = last.groupId;
        }
        return [event];
    }

    const upserts = run.filter(event => upsertOps.has(event.op));

    if (upserts.length === 0) {
        const event = {...stamp, op: moveOp, uid};
        if (!isPinned) {
            event.groupId = last.groupId;
        }
        if (last.toIndex !== undefined) {
            event.toIndex = last.toIndex;
        }
        return [event];
    }

    const lastUpsert = upserts[upserts.length - 1];
    const tab = deepClone(lastUpsert.tab);
    foldAdditiveFlags(tab, upserts);

    const finalIndex = last.op === moveOp ? last.toIndex : lastUpsert.tab.index;
    if (finalIndex === undefined) {
        delete tab.index;
    } else {
        tab.index = finalIndex;
    }

    const event = {...stamp, op: startsWithAdd ? addOp : modifyOp, tab};
    if (!isPinned) {
        event.groupId = last.op === moveOp ? last.groupId : lastUpsert.groupId;
    }
    return [event];
}

function reduceGroupRun(run) {
    if (run.length === 1) {
        return run;
    }

    const first = run[0];
    const last = run[run.length - 1];
    const groupId = first.group?.id ?? first.groupId;
    const stamp = {seq: last.seq, ts: last.ts};
    const startsWithAdd = first.op === 'group.add';

    if (last.op === 'group.remove') {
        if (startsWithAdd) {
            return [];
        }
        return [{...stamp, op: 'group.remove', groupId}];
    }

    if (run.every(event => GROUP_UPSERT_OPS.has(event.op))) {
        const merged = {};
        for (const event of run) {
            const group = event.group || {};
            for (const key of Object.keys(group)) {
                if (key === 'tabs') {
                    continue;
                }
                merged[key] = deepClone(group[key]);
            }
        }
        merged.id = groupId;

        const firstGroup = first.group || {};
        if (Object.hasOwn(firstGroup, 'tabs')) {
            merged.tabs = deepClone(firstGroup.tabs);
        }

        return [{...stamp, op: startsWithAdd ? 'group.add' : 'group.modify', group: merged}];
    }

    if (run.every(event => event.op === 'group.move')) {
        const event = {...stamp, op: 'group.move', groupId};
        if (last.toIndex !== undefined) {
            event.toIndex = last.toIndex;
        }
        return [event];
    }

    return run;
}

function reduceRun(run) {
    const op = run[0].op;
    if (op.startsWith('tab.')) {
        return reduceTabLikeRun(run, false);
    }
    if (op.startsWith('pinned.')) {
        return reduceTabLikeRun(run, true);
    }
    if (op.startsWith('group.')) {
        return reduceGroupRun(run);
    }
    return run;
}

export function coalesceEvents(events, floor = 0) {
    const safeFloor = Number.isFinite(floor) && floor > 0 ? floor : 0;

    const pushed = [];
    const unpushed = [];
    for (const event of events) {
        if ((event.seq ?? 0) > safeFloor) {
            unpushed.push(event);
        } else {
            pushed.push(event);
        }
    }

    if (unpushed.length < 2) {
        return events.slice();
    }

    const ordered = unpushed.slice().sort(applyOrder);

    const lastOptionByKey = new Map();
    for (const event of ordered) {
        if (event.op === 'option.set' && event.key != null) {
            const winner = lastOptionByKey.get(event.key);
            if (winner == null || applyOrder(winner, event) < 0) {
                lastOptionByKey.set(event.key, event);
            }
        }
    }

    const out = [];
    let run = [];
    let runKey = null;

    const flush = () => {
        if (run.length) {
            out.push(...reduceRun(run));
            run = [];
            runKey = null;
        }
    };

    for (const event of ordered) {
        if (event.op === 'option.set') {
            flush();
            if (event.key == null || lastOptionByKey.get(event.key) === event) {
                out.push(event);
            }
            continue;
        }

        const key = targetKey(event);
        if (key == null) {
            flush();
            out.push(event);
            continue;
        }

        if (key === runKey) {
            run.push(event);
        } else {
            flush();
            run = [event];
            runKey = key;
        }
    }

    flush();

    const combined = pushed.concat(out);
    combined.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    return combined;
}
