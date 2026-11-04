
import * as Constants from '/js/constants.js';
import * as Storage from '/js/storage.js';
import Logger from '/js/logger.js';

const MODULE_NAME = 'options.mixin';
const logger = new Logger(MODULE_NAME, {prefixes: [Constants.PAGES.current]});

let colorSchemeMediaListenerAdded = false;

export default {
    data() {
        return {
            options: {},
        };
    },
    created() {
        if (!colorSchemeMediaListenerAdded) {
            colorSchemeMediaListenerAdded = true;
            window.matchMedia('(prefers-color-scheme: dark)')
                .addEventListener('change', () => this.optionsUpdateColorScheme());
        }

        this.$root.$on('options-updated', ({keys = []} = {}) => {
            if (this.$options.name === Constants.MODULES.OPTIONS && keys.join() === 'hotkeys') {
                logger.info('🛑 prevent update hotkeys into options page');
                return;
            }

            logger.info('options-updated event, keys:', keys);
            this.optionsReload(keys);
        });

        this.optionsLoadPromise = this.optionsReload();
    },
    watch: {
        'options.colorScheme': 'optionsUpdateColorScheme',
    },
    beforeDestroy() {
        // remove any local listeners
        this.optionsUnwatchers.forEach(unwatch => unwatch());
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
            if (key.includes('.')) {
                throw new Error('only root level option keys supported');
            }

            const unwatch = this.$watch(`options.${key}`, async (...args) => {
                const value = await func.call(this, ...args);

                if (value !== undefined) {
                    this.optionsSave(key, value);
                }
            }, watchOptions);

            this.optionsUnwatchers.add(unwatch);
        },
        async optionsSave(key, value) {
            return await this.sendMessageModule('BG.saveOptions', {[key]: value});
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
