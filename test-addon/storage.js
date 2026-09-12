import {Test} from './test.js';

export const KEY = 'testKey';

// the change object property as the browser delivered it: absent, or its type and value -
// a property present with the value undefined prints as "undefined undefined"
const shape = (change, prop) => prop in change ? `${typeof change[prop]} ${JSON.stringify(change[prop])}` : 'absent';

export class StorageTest extends Test {
    constructor(options) {
        super(options);
        this.seen = []; // the change objects delivered since the last action, as printed
    }

    // a storage event counts against the quiet window, the way tab events do in TabsTest
    onEvent(spec, args, updatedKeys) {
        this.bump();
        super.onEvent(spec, args, updatedKeys);
    }

    eventFormatters() {
        return {
            'storage.onChanged': ([changes, areaName]) => this.formatChanges('storage.onChanged', changes, `areaName:${areaName}  `),
            'storage.local.onChanged': ([changes]) => this.formatChanges('storage.local.onChanged', changes, ''),
        };
    }

    formatChanges(spec, changes, tag) {
        return Object.entries(changes).map(([key, change]) => {
            const seen = {spec, key, keys: Object.keys(change), oldValue: shape(change, 'oldValue'), newValue: shape(change, 'newValue')};

            this.seen.push(seen);

            return `${seen.key}  ${tag}keys:[${seen.keys.join(', ')}]  oldValue: ${seen.oldValue}  newValue: ${seen.newValue}`;
        }).join('; ');
    }

    // there is no state table for storage: the action goes into the event log as its own line,
    // so the events that follow are read under the action that caused them
    act(text) {
        super.act(text);
        this.seen = [];
        this.record('action', text, 0);
    }

    // what both listeners delivered for the last action, in one shape for expect
    delivered() {
        return this.seen.map(({spec, keys, oldValue, newValue}) => `${spec}: keys:[${keys.join(', ')}] oldValue: ${oldValue} newValue: ${newValue}`);
    }

    async close() {
        await browser.storage.local.remove(KEY).catch(() => {});
    }
}
