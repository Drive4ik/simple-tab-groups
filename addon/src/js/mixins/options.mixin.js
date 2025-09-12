
import * as Constants from '/js/constants.js';
import * as Messages from '/js/messages.js';
import * as Storage from '/js/storage.js';
import * as Utils from '/js/utils.js';
import * as File from '/js/file.js';
import Logger from '/js/logger.js';

const MODULE_NAME = 'options.mixin';
const logger = new Logger(MODULE_NAME, [Utils.getNameFromPath(location.href)]);

const instances = new Set;

const {sendMessageModule} = Messages.connectToBackground(MODULE_NAME, 'options-updated', ({keys}) => {
    logger.info('updated keys:', keys);

    for (const instance of instances) {
        if (instance.$options.name === Constants.MODULES.OPTIONS && keys.join() === 'hotkeys') {
            // do not update hotkeys on options page to prevent removing duplicated hotkeys
            logger.info('prevent update hotkeys');
            return;
        }

        instance.optionsReload();
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
        async optionsReload() {
            this.optionsUnwatchers ??= new Set;
            this.optionsUnwatchers.forEach(unwatch => unwatch());
            this.optionsUnwatchers.clear();

            const options = await Storage.get(Constants.ALL_OPTION_KEYS);

            options.autoBackupFolderName = await File.getAutoBackupFolderName();

            this.options = options;

            const keys = this.optionsWatchKeys ?? [];

            for (const key of keys) {
                this.optionsWatch(key, value => value);
            }

            this.$emit('options-reloaded');
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
