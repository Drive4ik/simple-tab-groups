import {StorageTest, KEY} from '../storage.js';

export const note = `Round 25 — storage.onChanged: what the change object carries when a key of storage.local is
written for the FIRST time (no previous value), written again with the same value, changed, and
removed, and whether the two listeners the API offers, storage.onChanged (with areaName) and
storage.local.onChanged, report the same. In the event log every action is its own line and the
events under it are the ones it caused; no line under an action means no event. "absent" means the
property is not on the change object at all, a property present with the value undefined prints
as "undefined undefined". The facts behind Storage.isChangedKey in storage-utils.js. One test per value
type: boolean (R25.01), string (R25.02), number (R25.03), array (R25.04), object (R25.05).`;

export const testClass = StorageTest;

const SPECS = ['storage.onChanged', 'storage.local.onChanged'];

const shown = value => `${typeof value} ${JSON.stringify(value)}`;

// the same change object from both listeners (STORAGE-BEHAVIOR.md §3)
function both(keys, oldValue, newValue) {
    return SPECS.map(spec => `${spec}: keys:[${keys.join(', ')}] oldValue: ${oldValue} newValue: ${newValue}`);
}

async function sequence(t, first, second) {
    t.require('the key is absent before the test', !Object.hasOwn(await browser.storage.local.get(KEY), KEY), 'a previous run left it behind');

    t.watch(SPECS);

    await t.step(`storage.local.remove(${KEY}) while the key is absent`, () => browser.storage.local.remove(KEY));
    t.expect('a removal of an absent key fires nothing (STORAGE-BEHAVIOR.md §1)', t.delivered(), []);

    await t.step(`storage.local.set({${KEY}: ${JSON.stringify(first)}}) - the first write`, () => browser.storage.local.set({[KEY]: first}));
    t.expect('the first write carries oldValue present as undefined (§1)', t.delivered(), both(['oldValue', 'newValue'], 'undefined undefined', shown(first)));

    await t.step(`storage.local.set({${KEY}: ${JSON.stringify(first)}}) - the same value again, a fresh copy`, () => browser.storage.local.set({[KEY]: structuredClone(first)}));
    t.expect('the same value again still fires, with equal oldValue and newValue (§2)', t.delivered(), both(['oldValue', 'newValue'], shown(first), shown(first)));

    await t.step(`storage.local.set({${KEY}: ${JSON.stringify(second)}}) - a changed value`, () => browser.storage.local.set({[KEY]: second}));
    t.expect('a changed value carries both (§1)', t.delivered(), both(['oldValue', 'newValue'], shown(first), shown(second)));

    await t.step(`storage.local.remove(${KEY})`, () => browser.storage.local.remove(KEY));
    t.expect('a removal carries no newValue at all (§1)', t.delivered(), both(['oldValue'], shown(second), 'absent'));
}

export const tests = [

{
    id: 'R25.01',
    title: 'a boolean key: first write, the same value again, a change, removal - what storage.onChanged reports',
    run: t => sequence(t, true, false),
},

{
    id: 'R25.02',
    title: 'a string key: first write, the same value again, a change, removal',
    run: t => sequence(t, 'first', 'second'),
},

{
    id: 'R25.03',
    title: 'a number key: first write, the same value again, a change, removal',
    run: t => sequence(t, 1, 2),
},

{
    id: 'R25.04',
    title: 'an array key: first write, the same content in a NEW array again, a change, removal',
    run: t => sequence(t, [1, 2], [1, 2, 3]),
},

{
    id: 'R25.05',
    title: 'an object key: first write, the same content in a NEW object again, a change, removal',
    run: t => sequence(t, {a: 1}, {a: 2}),
},

];
