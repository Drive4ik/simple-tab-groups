
import * as Constants from '/js/constants.js';
import * as Messages from '/js/messages.js';
import * as Storage from '/js/storage.js';
import * as Utils from '/js/utils.js';
import * as File from '/js/file.js';

export default {
    data() {
        return {
            options: {},
        };
    },
    created() {
        const {disconnect} = Messages.connectToBackground(
            'options.mixin',
            'options-updated',
            () => this.optionsReload()
        );
        window.addEventListener('unload', disconnect);

        this.optionsLoadPromise = this.optionsReload();

        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => this.updateTheme());
    },
    watch: {
        'options.theme': 'updateTheme',
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
            return await Messages.sendMessageModule('BG.saveOptions', {[key]: value});
        },
        updateTheme() {
            document.documentElement.dataset.theme = Utils.getThemeApply(this.options.theme);
        },
    },
}
