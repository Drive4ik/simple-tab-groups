
import * as Constants from '/js/constants.js';
import * as Messages from '/js/messages.js';
import * as Storage from '/js/storage.js';
import * as Utils from '/js/utils.js';
import Logger from '/js/logger.js';

const MODULE_NAME = 'options.mixin';
const logger = new Logger(MODULE_NAME, [Utils.getNameFromPath(location.href)]);

const instances = new Set;

const {sendMessageModule} = Messages.connectToBackground(MODULE_NAME, 'options-updated', ({keys}) => {
    logger.info('got message', keys);

    for (const instance of instances) {
        if (instance.$options.name === Constants.MODULES.OPTIONS && keys.join() === 'hotkeys') {
            // do not update hotkeys on options page to prevent removing duplicated hotkeys
            logger.info('🛑 prevent update hotkeys into options page');
            return;
        }

        instance.optionsReload(keys);
    }
});

export default {
    data() {
        return {
            options: {},
        };
    },
    created() {
        instances.add(this);

        this.optionsLoadPromise = this.optionsReload();

        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => this.optionsUpdateColorScheme());
    },
    watch: {
        'options.colorScheme': 'optionsUpdateColorScheme',
    },
    beforeDestroy() {
        instances.delete(this);
    },
    methods: {
        async optionsReload(updateKeys = Constants.ALL_OPTION_KEYS) {
            this.optionsUnwatchers ??= new Set;
            this.optionsUnwatchers.forEach(unwatch => unwatch());
            this.optionsUnwatchers.clear();

            const options = await Storage.get(updateKeys);

            if (updateKeys === Constants.ALL_OPTION_KEYS) {
                this.options = options;
            } else {
                Object.assign(this.options, options);
            }

            const keys = this.optionsWatchKeys ?? [];

            for (const key of keys) {
                this.optionsWatch(key, value => value);
            }

            this.$emit('options-reloaded', {
                keys: updateKeys,
                options,
            });
        },
        optionsWatch(key, func, watchOptions = {}) {
            const unwatch = this.$watch(`options.${key}`, async (...args) => {
                const value = await func.call(this, ...args);

                if (value !== undefined) {
                    this.optionsSave(key, value);
                }
            }, watchOptions);

            this.optionsUnwatchers.add(unwatch);
        },
        async optionsSave(key, value) {
            return await sendMessageModule('BG.saveOptions', {[key]: value});
        },
        optionsUpdateColorScheme() {
            if (this.options.colorScheme === 'auto') {
                document.documentElement.dataset.theme = window.matchMedia('(prefers-color-scheme: dark)').matches
                    ? 'dark'
                    : 'light';
            } else {
                document.documentElement.dataset.theme = this.options.colorScheme;
            }
        },
    },
}
