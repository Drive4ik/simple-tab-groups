
const $ = document.querySelector.bind(document);
const INDENT_PX = 30;

function secondsToHHMMSS(sec) {
    let sec_num = parseInt(sec, 10),
        hours   = Math.floor(sec_num / 3600),
        minutes = Math.floor((sec_num - (hours * 3600)) / 60),
        seconds = sec_num - (hours * 3600) - (minutes * 60);

    return [hours, minutes, seconds].map(n => n.toString().padStart(2, '0')).join(':');
}

function errorEventHandler(event) {
    console.error(event);
    alert(event)
}

const UUID_REGEXP = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function isUUID(uuid) {
    return UUID_REGEXP.test(uuid);
}

window.addEventListener('error', errorEventHandler);
Vue.config.errorHandler = errorEventHandler;

function getConsoleKey(log) {
    return Object.keys(log).find(k => k.includes('console'));
}

const indentConfig = {
    startSymbol: '▷', // 🔻⚡️
    stopSymbol: '◁', // 🔺⭕️
    regExp: /(START|STOP|SCOPE) (\d+)/,
};

function getLogAction(log) {
    let action, key;

    log[log.consoleKey].some(arg => {
        [, action, key] = indentConfig.regExp.exec(arg) || [];
        return action;
    });

    return {action, key};
}

const excludeExtensions = new Set([
    'addons-search-detection@mozilla.com',
]);

const htmlTagArgumentRegExp = /^[A-Z\d\-\_]+#[a-z\-]+$/;

new Vue({
    el: '#app',
    data: {
        file: null,

        logsIndent: 0,

        highlightedLogs: [],
    },
    filters: {
        json(value, expanded = true) {
            return expanded ? JSON.stringify(value, null, 4) : JSON.stringify(value);
        },
    },
    watch: {
        logsIndent: 'calculateIndentLineHeight',
    },
    computed: {
        addon() {
            return this.file.addon;
        },
        upTime() {
            let [sec] = /\d+/.exec(this.addon.upTime) || [];

            return sec ? secondsToHHMMSS(sec) : this.addon.upTime;
        },
        options() {
            return Object.keys(this.addon.storage)
                .filter(key => key !== 'groups')
                .reduce((acc, key) => (acc[key] = this.addon.storage[key], acc), {});
        },
        groups() {
            return this.addon.storage.groups;
        },
        tabsWithoutGroup() {
            return this.file.tabs.filter(t => !t?.groupId);
        },
        logs() {
            return this.file.logs;
        },
        errorLogs() {
            return this.file.errorLogs;
        },
    },
    methods: {
        getLogTitle(log) {
            let title = [],
                consoleFuncStr = log.consoleKey.split('.').pop();

            if (consoleFuncStr === 'info') {
                title.push(`<span class="tag is-info">INFO</span> `);
            } else if (consoleFuncStr === 'warn') {
                title.push(`<span class="tag is-warning">WARN</span> `);
            } else if (consoleFuncStr === 'error' || consoleFuncStr === 'assert') {
                title.push(`<span class="tag is-danger">${consoleFuncStr.toUpperCase()}</span> `);
            }

            for (let i = 0, k; i < log[log.consoleKey].length; i++) {
                k = log[log.consoleKey][i];

                if (Number.isFinite(k) || k === null || this.isBool(k) || isUUID(k)) {
                    title.push(`<code>${k}</code>`);
                } else if (typeof k === 'object' && k.stack !== undefined) {
                    try {
                        let err = JSON.parse(k.message);
                        title.push(err.message,
                            'file:',
                            `${err.fileName}:${err.lineNumber}:${err.columnNumber}`,
                            'stack:',
                            err.stack.split('\n').join(` ◁ `) || '<em>[empty]</em>'
                        );
                    } catch {
                        title.push(JSON.stringify(k));
                    }
                } else if (typeof k === 'object') {
                    let jsoned = JSON.stringify(k),
                        isBig = jsoned.length > 70,
                        codeAttrs = '';

                    if (isBig) {
                        jsoned = JSON.stringify(k, null, 4);
                        codeAttrs = ' class="expanded-on-focus" tabindex="-1"';
                    }

                    title.push(`<code ${codeAttrs}>` + jsoned.replaceAll(this.file.addon.UUID, '') + '</code>');
                } else if (k?.startsWith?.('START')) {
                    title.push(indentConfig.startSymbol);
                } else if (k?.startsWith?.('STOP')) {
                    title.push(indentConfig.stopSymbol);
                } else if (k?.startsWith?.('SCOPE')) {
                    // do nothing
                } else if (htmlTagArgumentRegExp.test(k)) {
                    let [action, message] = k.split('#');
                    title.push(`
                    <div class="is-inline-block">
                        <div class="tags has-addons">
                            <span class="tag is-dark">${action}</span>
                            <span class="tag is-info">${message}</span>
                        </div>
                    </div>
                    `);
                } else {
                    title.push(k);
                }
            }

            return title.join(' ');
        },
        formatTime({time}, full = false) {
            let hms, ms,
                date = new Date(time),
                ISOStr = date.toISOString().slice(0, -1);

            if (full) {
                hms = ISOStr.slice(0, -4).split('T').join(' ');
                ms = ISOStr.slice(-3);
            } else {
                [hms, ms] = ISOStr.slice(11).split('.');
            }
            return `${hms} <span class="is-size-6 has-text-weight-semibold is-family-monospace">${ms}</span>`;
        },
        getStackToView(stack) {
            try {
                const oldStack = stack.stack;
                Object.assign(stack, JSON.parse(stack.message));
                stack.stack = ['From message:', ...stack.stack.split('\n'), ...oldStack];
            } catch (e) { }

            return JSON.stringify(stack, null, 4);
        },

        toggleShowStack(log) {
            log.showStack = !log.showStack;
            this.calculateIndentLineHeight();
        },
        isHighlighted(log) {
            return this.highlightedLogs.includes(log.key);
        },
        toggleHighlight(log) {
            if (this.highlightedLogs.includes(log.key)) {
                this.highlightedLogs.splice(this.highlightedLogs.indexOf(log.key), 1);
            } else {
                this.highlightedLogs.push(log.key);

                this.calculateIndentLineHeight();
            }
        },
        calculateIndentLineHeight() {
            this.$nextTick(() => {
                this.highlightedLogs.forEach(key => {
                    const log = this.logs.find(l => l.key === key && l.action === 'START');

                    if (!log) {
                        return;
                    }

                    let startNode = $(`.log[data-action="START"][data-key="${log.key}"]`),
                        stopNode = $(`.log[data-action="STOP"][data-key="${log.key}"]`);

                    if (!startNode || !stopNode) {
                        return;
                    }

                    log.indentLineHeight = (stopNode.offsetTop - startNode.offsetTop - startNode.clientHeight) + 'px';
                });
            });
        },

        async readFile(inputTag) {
            const result = await new Promise((resolve, reject) => {
                let file = inputTag.files[0];

                if (0 === file.size) {
                    reject('empty file');
                    return;
                }

                if (file.size > 700e6) {
                    reject('700MB backup? I don\'t believe you');
                    return;
                }

                let reader = new FileReader();

                reader.addEventListener('loadend', () => resolve(reader.result));
                reader.addEventListener('error', reject);

                reader.readAsText(file, 'utf-8');
            });

            return JSON.parse(result);
        },

        async changeFile({target}) {
            let file;

            try {
                file = await this.readFile(target);
            } catch (e) {
                alert(`can't read JSON log file: ${e}`);
                console.log(e);
                return;
            }

            this.logsIndent = 0;

            file.browserInfo.extensions = await Promise.all(
                file.browserInfo.extensions
                .filter(ext => !excludeExtensions.has(ext.id))
                .map(async ext => {
                    let req = await fetch(`https://services.addons.mozilla.org/api/v4/addons/addon/${ext.id}/?lang=en-US`);

                    if (req.ok) {
                        ({
                            url: ext.url,
                            icon_url: ext.icon_url,
                        } = await req.json());
                    }

                    return ext;
                })
            );

            try {
                file.windows.forEach(win => {
                    win.tabs = file.tabs.filter(tab => tab?.windowId === win.id);
                });
            } catch (e) {
                alert(e);
                file.windows = [e.message, file.windows].flat();
            }

            try {
                file.addon.storage ??= {};

                file.addon.storage.groups.forEach(group => {
                    if (!group.isArchive) {
                        group.tabs = file.tabs.filter(tab => tab?.groupId === group.id);
                    }
                });
            } catch (e) {
                alert(e);
                file.addon.storage.groups = [e.message, file.addon.storage.groups].flat();
            }

            function formatLog(log) {
                log.showStack = false;
                log.consoleKey = getConsoleKey(log);
                if (!log.consoleKey) {
                    log.consoleKey = 'console.error';
                    log[log.consoleKey] = [];
                }
                log.indent = (log.indentIndex * INDENT_PX) + 'px';
                log.indentLineHeight = 0;

                let {action, key} = getLogAction(log);
                log.action = action || false;
                log.key = key || false;

                let messages = [],
                    stacks = [];

                log[log.consoleKey].forEach(consoleValue => {
                    if (consoleValue?.message !== undefined && consoleValue?.time !== undefined && consoleValue?.fileName !== undefined) {
                        stacks.push(consoleValue);
                    } else {
                        messages.push(consoleValue);
                    }
                });

                if (stacks.length) {
                    messages.push(`<span class="tag is-danger is-light">additional stack</span>`);
                }

                log[log.consoleKey] = messages;

                if (stacks.length) {
                    log.stacks = ['From message:', ...stacks, 'Native:', log.stack];
                } else {
                    log.stacks = [log.stack];
                }
            }

            function sortTime(a, b) {
                if (a.time < b.time) {
                    return -1;
                } else if (a.time > b.time) {
                    return 1;
                }

                return 0;
            }

            (file.logs || []).sort(sortTime).forEach(formatLog);
            (file.errorLogs || []).sort(sortTime).forEach(formatLog);

            this.file = file;
        },

        isBool(val) {
            return val === Boolean(val);
        },
        isString(val) {
            return typeof val === 'string';
        },
        isNumber(val) {
            return typeof val === 'number';
        },

        scrollTo: function(query, block = 'center', round, negative) {
            let errorNode = null;

            if (round) {
                let nodes = document.querySelectorAll(query),
                    nextIndex = negative ? --this.selectorNodeIndex[query] : ++this.selectorNodeIndex[query];

                if (nodes[nextIndex]) {
                    this.selectorNodeIndex[query] = nextIndex;
                } else {
                    this.selectorNodeIndex[query] = negative ? nodes.length - 1 : 0;
                }

                errorNode = nodes[this.selectorNodeIndex[query]];
            } else {
                errorNode = document.querySelector(query);
            }

            errorNode?.scrollIntoView({
                block,
                behavior: 'smooth',
            });
        }.bind({
            selectorNodeIndex: {},
        }),
    },
});
