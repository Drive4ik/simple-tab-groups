
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

window.addEventListener('error', errorEventHandler);
Vue.config.errorHandler = errorEventHandler;

function getConsoleKey(log) {
    return Object.keys(log).find(k => k.includes('console'));
}

const indentConfig = {
    // indentSymbol: '   ',
    startSymbol: '▷', // 🔻⚡️
    stopSymbol: '◁', // 🔺⭕️
    index: 0,
    indexByKey: {},
    regExp: /(START|STOP|SCOPE) (\d+)/,
};
const getIndent = function(log) {
    let indentCount = this.index,
        {action, key} = getLogAction(log);

    if (action === 'START') {
        indentCount = this.indexByKey[key] = this.index++;
    } else if (action === 'STOP') {
        indentCount = this.indexByKey[key];

        if (this.index > 0) {
            this.index--;
        }
    } else if (action === 'SCOPE') {
        indentCount = this.indexByKey[key];
    }

    return indentCount * INDENT_PX;
}.bind(indentConfig);

const getLogAction = function(log) {
    let action, key;

    log[log.consoleKey].some(arg => {
        [, action, key] = this.regExp.exec(arg) || [];
        return action;
    });

    return {action, key};
}.bind(indentConfig)

const excludeExtensions = new Set([
    'addons-search-detection@mozilla.com',
]);

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
        info() {
            return this.file.info;
        },
        upTime() {
            let [sec] = /\d+/.exec(this.info.upTime) || [];

            return sec ? secondsToHHMMSS(sec) : this.info.upTime;
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

                if (Number.isFinite(k) || k === null || this.isBool(k)) {
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
                    title.push('<code>' + JSON.stringify(k).replaceAll(this.file.info.UUID, '') + '</code>');
                } else if (k?.startsWith?.('START')) {
                    title.push(indentConfig.startSymbol);
                } else if (k?.startsWith?.('STOP')) {
                    title.push(indentConfig.stopSymbol);
                } else if (k?.startsWith?.('SCOPE')) {
                    // do nothing
                } else {
                    title.push(k);
                }
            }

            return title.join(' ');
        },
        formatTime({time}) {
            let [hms, ms] = time.slice(11, -1).split('.');
            return `${hms} <span class="is-size-6 has-text-weight-semibold is-family-monospace">${ms}</span>`;
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

        async changeFile({target}) {
            let file = await new Promise((resolve, reject) => {
                let file = target.files[0];

                if (0 === file.size) {
                    reject('empty file');
                    return;
                }

                if (file.size > 700e6) {
                    reject('700MB backup? I don\'t believe you');
                    return;
                }

                let reader = new FileReader();

                reader.addEventListener('loadend', () => resolve(JSON.parse(reader.result)));
                reader.addEventListener('error', reject);

                reader.readAsText(file, 'utf-8');
            });

            this.logsIndent = 0;
            indentConfig.index = 0;
            indentConfig.indexByKey = {};

            file.info.extensions = await Promise.all(file.info.extensions
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

            function formatLog(log) {
                log.showStack = false;
                log.consoleKey = getConsoleKey(log);
                log.indent = getIndent(log) + 'px';
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

                log[log.consoleKey] = messages;

                if (stacks.length) {
                    log.stacks = ['From message:', ...stacks, 'Native:', log.stack];
                } else {
                    log.stacks = [log.stack];
                }
            }

            file.logs.forEach(formatLog);
            file.errorLogs.forEach(formatLog);

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
