import {TabsTest} from './tabs.js';

export const OPENER_KEYS = ['openerTabId'];

// the domain class of the opener rounds (round-14, round-16, round-18): every cell prints the opener as a
// suffix right after the name - c1→p means c1.openerTabId points at p, no arrow - no opener
export class OpenerTest extends TabsTest {
    suffix(tab) {
        const opener = tab.openerTabId === undefined ? '' : `→${this.known(tab.openerTabId)}`;
        return opener + super.suffix(tab);
    }

    fingerprint(state) {
        return `${super.fingerprint(state)}|${state.tabs.map(tab => tab.openerTabId ?? '-').join(',')}`;
    }

    eventFormatters() {
        const formatters = super.eventFormatters();
        const onUpdated = formatters['tabs.onUpdated'];

        return {
            ...formatters,
            'tabs.onUpdated': ([tabId, changeInfo, tab], options) => {
                if (!Object.hasOwn(changeInfo, 'openerTabId')) {
                    return onUpdated([tabId, changeInfo, tab], options);
                }

                const value = changeInfo.openerTabId;
                const named = {...changeInfo, openerTabId: value === -1 ? 'none' : this.known(value)};

                return onUpdated([tabId, named, tab], options);
            },
        };
    }

    describeOpener(tab) {
        return tab.openerTabId === undefined ? 'absent' : this.known(tab.openerTabId);
    }

    async opener(name) {
        return this.describeOpener(await browser.tabs.get(this.id(name)));
    }

    async openers(windowId = this.win) {
        const tabs = (await browser.tabs.query({windowId})).sort((a, b) => a.index - b.index);

        return Object.fromEntries(tabs.map(tab => [this.nameOf(tab), this.describeOpener(tab)]));
    }

    async openersByName(windowId = this.win) {
        const openers = await this.openers(windowId);

        return Object.fromEntries(Object.keys(openers).sort().map(name => [name, openers[name]]));
    }

    async snapWindow(label, windowId) {
        const tabs = (await browser.tabs.query({windowId})).sort((a, b) => a.index - b.index);
        this.row(label, tabs.map(tab => this.cell(tab)));
    }

    async setOpener(child, opener) {
        return browser.tabs.update(this.id(child), {openerTabId: opener === null ? -1 : this.id(opener)});
    }

    async setOpeners(pairs, windowId = this.win) {
        for (const [child, opener] of pairs) {
            await this.setOpener(child, opener);
        }

        await this.settled();

        const actual = await this.openers(windowId);
        const wrong = pairs.filter(([child, opener]) => actual[child] !== opener);

        this.require('setup: openers set as requested', !wrong.length, wrong.map(([child]) => `${child}→${actual[child]}`).join(', '));
    }

    async tryStep(label, run, options) {
        return this.step(label, () => run().then(
            result => {
                this.note(`${label}: resolved`);
                return result;
            },
            error => {
                this.note(`${label}: rejected — ${error.message}`);
                return null;
            },
        ), options);
    }

    watchOpenerAt(spec) {
        const [namespace, event] = spec.split('.');
        const target = browser[namespace][event];

        const handler = async tabId => {
            const at = this.ms();
            const seen = await browser.tabs.get(tabId).then(
                tab => `opener ${this.describeOpener(tab)}${this.winTag(tab.windowId)}`,
                error => `tabs.get rejected — ${error.message}`,
            );

            this.record(`${spec}+get`, `${this.known(tabId)}  ${seen}`, at);
        };

        target.addListener(handler);
        this.listeners.push({target, handler});
    }
}
