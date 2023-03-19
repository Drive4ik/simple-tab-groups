
const INDENT_PX = 30;
let logIndentCount = 0;

function secondsToHHMMSS(sec) {
    let sec_num = parseInt(sec, 10),
        hours   = Math.floor(sec_num / 3600),
        minutes = Math.floor((sec_num - (hours * 3600)) / 60),
        seconds = sec_num - (hours * 3600) - (minutes * 60);

    return [hours, minutes, seconds].map(n => n.toString().padStart(2, '0')).join(':');
}

function errorEventHandler(event) {
    alert(event)
}

window.addEventListener('error', errorEventHandler);
Vue.config.errorHandler = errorEventHandler;

new Vue({
    el: '#app',
    data: {
        file: null,
    },
    filters: {
        json(value, expanded) {
            return expanded ? JSON.stringify(value, null, 4) : JSON.stringify(value);
        },
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
            let lastLogIndex = this.file.logs.findIndex(l => typeof l === 'string');
            return this.file.logs.slice(0, lastLogIndex - 1);
        },
        errors() {
            let lastLogIndex = this.file.logs.findIndex(l => typeof l === 'string');
            return this.file.logs.slice(lastLogIndex + 1);
        },
    },
    methods: {
        getConsoleKey(log) {
            return Object.keys(log).find(k => k.includes('console'));
        },
        getLogTitle(log) {
            let consoleKey = this.getConsoleKey(log),
                title;

            if (log[consoleKey]) {
                title = [log[consoleKey][0]];

                for (let i = 1, k; i < log[consoleKey].length; i++) {
                    k = log[consoleKey][i];

                    if (Number.isFinite(k) || k === null || this.isBool(k)) {
                        title.push(`<code>${k}</code>`);
                    } else if (typeof k === 'object') {
                        title.push(JSON.stringify(k));
                    } else {
                        title.push(k);
                    }
                }

                title = title.join(' ');
            } else {
                title = log.message;
            }

            if (consoleKey?.includes('info')) {
                title = `<span class="tag is-info">INFO</span> ` + title;
            } else if (consoleKey?.includes('warn')) {
                title = `<span class="tag is-warning">WARN</span> ` + title;
            } else if (!consoleKey || consoleKey.includes('error')) {
                title = `<span class="tag is-danger">ERROR</span> ` + title;
            }

            return title;
        },
        getLogIndent(log) {
            let consoleKey = this.getConsoleKey(log),
                indentCount = logIndentCount;

            if (log[consoleKey]?.[0]?.startsWith?.('START')) {
                logIndentCount++;
            } else if (log[consoleKey]?.[0]?.startsWith?.('STOP')) {
                logIndentCount--;
                indentCount--;
            }

            return (indentCount * INDENT_PX) + 'px';
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

            await Promise.all(file.info.extensions.map(async ext => {
                let req = await fetch(`https://services.addons.mozilla.org/api/v4/addons/addon/${ext.id}/?lang=en-US`);

                if (req.ok) {
                    ({
                        url: ext.url,
                        icon_url: ext.icon_url,
                    } = await req.json());
                }
            }));

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

        scrollTo(query, block = 'center') {
            let errorNode = document.querySelector(query);

            errorNode?.scrollIntoView({
                block,
                behavior: 'smooth',
            });
        },
    },
});
