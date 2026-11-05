
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

const ACTION = Object.freeze({
    START: 'START',
    STOP: 'STOP',
});

const indentConfig = {
    actionSymbol: {
        [ACTION.START]: '▷', // 🔻⚡️
        [ACTION.STOP]: '◁', // 🔺⭕️
    },
    regExp: new RegExp(`(${ACTION.START}|${ACTION.STOP}|SCOPE) (\\d+)`),
};

// logs of version < 6: the level and the arguments are one key `console.<level>`, the prefix is the first argument
function takeConsoleKey(log) {
    const key = Object.keys(log).find(key => key.startsWith('console.'));

    log.level = key ? key.slice('console.'.length) : 'error';
    log.args = key ? log[key] : [];
    log.prefix = log.args.shift() ?? '';
    delete log[key];
}

// logs of version < 6: the scope of a line is a mark among its arguments, it becomes the fields action and scope
function takeLogAction(log) {
    const args = log.args;
    let action, key;

    const index = args.findIndex(arg => {
        [, action, key] = indentConfig.regExp.exec(arg) || [];
        return action;
    });

    if (index === -1) {
        log.action = null;
        log.scope = null;
        return;
    }

    args.splice(index, 1);

    log.action = action === 'SCOPE' ? null : action;
    log.scope = Number(key);
}

const excludeExtensions = new Set([
    'addons-search-detection@mozilla.com',
]);

// the functions of every stack of a line, without the columns: two lines share a function when the sets intersect
function stackFuncs(log) {
    return new Set(
        log.stacks
            .flat(Infinity)
            .filter(s => !s.startsWith?.('From') && !s.startsWith?.('Native'))
            .map(s => s.stack || s)
            .flat(Infinity)
            .map(s => s.replace(/(:\d+):\d+/, '$1'))
    );
}

const htmlTagArgumentRegExp = /^[^\s]+#[^\s]+$/;

const app = window.Vue.createApp({
    data() {
        return {
            file: null,
            fileName: null,
            fileLoading: false,

            logsIndent: 0,

            highlightedLogs: [],
        };
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
        highlightedScopes() {
            return new Set(this.highlightedLogs.map(log => log.scope));
        },
        // the lines of a highlighted scope that share a function of the stack with the highlighted line, found once per change of the highlight, not per line per render
        highlightedByStack() {
            const found = new Set;

            for (const hLog of this.highlightedLogs) {
                const startIndex = this.logs.findIndex(log => log.scope === hLog.scope && log.action === ACTION.START);
                const stopIndex = this.logs.findIndex(log => log.scope === hLog.scope && log.action === ACTION.STOP);

                if (stopIndex === -1) {
                    continue;
                }

                for (const log of this.logs.slice(Math.max(startIndex, 0), stopIndex + 1)) {
                    if (log.indentIndex >= hLog.indentIndex && log.stackFuncs.intersection(hLog.stackFuncs).size) {
                        found.add(log);
                    }
                }
            }

            return found;
        },
    },
    methods: {
        json(value) {
            return JSON.stringify(value, null, 4);
        },
        getLogTitle(log) {
            let title = [],
                args = [log.prefix, ...log.args];

            if (log.level === 'info') {
                title.push(`<span class="tag is-info">INFO</span> `);
            } else if (log.level === 'warn') {
                title.push(`<span class="tag is-warning">WARN</span> `);
            } else if (log.level === 'error' || log.level === 'assert') {
                title.push(`<span class="tag is-danger">${log.level.toUpperCase()}</span> `);
            }

            for (let i = 0, k; i < args.length; i++) {
                k = args[i];

                if (Number.isFinite(k) || k === null || this.isBool(k) || isUUID(k)) {
                    title.push(`<code>${k}</code>`);
                } else if (typeof k === 'object' && k.stack !== undefined) {
                    try {
                        let err = JSON.parse(k.message);
                        title.push(err.message,
                            'file:',
                            `${err.fileName}:${err.lineNumber}:${err.columnNumber}`,
                            'stack:',
                            err.stack.split('\n').filter(Boolean).join(` ◁ `) || '<em>[empty]</em>'
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
        hasTimeGap(log, index) {
            if (index === 0) {
                return false;
            }

            return log.time - this.logs[index - 1].time > 4000;
        },
        getStackToView(stack) {
            try {
                // const oldStack = stack.stack;
                Object.assign(stack, JSON.parse(stack.message));
                stack.stack = stack.stack.split('\n').filter(Boolean);
                // stack.stack = ['Stack from logger arguments:', ...stack.stack.split('\n'), 'native:', ...oldStack];
            } catch { }

            return JSON.stringify(stack, null, 4);
        },

        toggleShowStack(log) {
            log.showStack = !log.showStack;
            this.calculateIndentLineHeight();
        },
        toggleHighlight(log) {
            if (this.highlightedScopes.has(log.scope)) {
                this.highlightedLogs = this.highlightedLogs.filter(l => l.scope !== log.scope);
            } else {
                this.highlightedLogs.push(log);

                this.calculateIndentLineHeight();
            }
        },
        async calculateIndentLineHeight() {
            await this.$nextTick();

            for (const hLog of this.highlightedLogs) {
                const log = this.logs.find(l => l.scope === hLog.scope && l.action === ACTION.START);

                if (!log) {
                    continue;
                }

                let startNode = $(`.log[data-action="${ACTION.START}"][data-scope="${log.scope}"]`),
                    stopNode = $(`.log[data-action="${ACTION.STOP}"][data-scope="${log.scope}"]`);

                if (!startNode || !stopNode) {
                    continue;
                }

                log.indentLineHeight = (stopNode.offsetTop - startNode.offsetTop - startNode.clientHeight) + 'px';
            }
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
            this.fileLoading = true;
            await this.$nextTick();

            let file;

            try {
                this.fileName = target.files[0].name;
                file = await this.readFile(target);
            } catch (e) {
                alert(`can't read JSON log file: ${e}`);
                console.log(e);
                this.fileLoading = false;
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
                log.indent = (log.indentIndex * INDENT_PX) + 'px';
                log.indentLineHeight = 0;

                // logs of version < 6, each by its own sign
                if (!Object.hasOwn(log, 'level')) {
                    takeConsoleKey(log);
                }

                if (!Object.hasOwn(log, 'action')) {
                    takeLogAction(log);
                }

                let messages = [],
                    stacks = [];

                log.args.forEach(consoleValue => {
                    if (consoleValue?.stack !== undefined) {
                        // if (typeof consoleValue.stack === 'string') {
                        //     consoleValue.stack = consoleValue.stack.split('\n');
                        // }
                        stacks.push(consoleValue);
                        messages.push(consoleValue.lang ? `${consoleValue.message} [${consoleValue.lang}]` : consoleValue.message);
                    } else {
                        messages.push(consoleValue);
                    }
                });

                if (log.action) {
                    messages.unshift(indentConfig.actionSymbol[log.action]);
                }

                if (stacks.length) {
                    messages.push(`<span class="tag is-danger is-light">additional stack</span>`);
                }

                log.args = messages;

                if (stacks.length) {
                    log.stacks = ['Errors:', ...stacks, 'Native stack:', log.stack];
                } else {
                    log.stacks = [log.stack];
                }

                log.stackFuncs = window.Vue.markRaw(stackFuncs(log)); // a Set behind a reactive proxy has no intersection
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
            await this.$nextTick();
            await this.$nextTick();
            this.fileLoading = false;
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

app.config.errorHandler = errorEventHandler;
app.mount('#app');
