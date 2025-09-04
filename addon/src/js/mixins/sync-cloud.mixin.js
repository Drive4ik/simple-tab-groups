
import Logger from '/js/logger.js';
import * as Utils from '/js/utils.js';
import * as Messages from '/js/messages.js';

const MODULE_NAME = Utils.capitalize(Utils.getNameFromPath(import.meta.url));
const logger = new Logger(MODULE_NAME, [Utils.getNameFromPath(location.href)]);

const allowedInstanceNames = new Set([
    'popup-page',
    'github-gist',
]);

const instances = new Set;

const {sendMessageModule} = Messages.connectToBackground(MODULE_NAME, [
    'sync-start',
    'sync-progress',
    'sync-end',
    'sync-error',
    'sync-finish',
], (syncEvent) => {
    logger.info(syncEvent.action, syncEvent);

    for (const instance of instances) {
        instance.$emit(syncEvent.action, syncEvent);
    }
});

export default {
    data() {
        if (!allowedInstanceNames.has(this.$options.name)) {
            return {};
        }

        return {
            synchronisationInProgress: false,
            synchronisationProgress: 0,
            synchronisationError: '',
        };
    },
    created() {
        if (!allowedInstanceNames.has(this.$options.name)) {
            return;
        }

        instances.add(this);

        this
            .$on(['sync-start', 'sync-progress', 'sync-end', 'sync-error', 'sync-finish'], () => {
                clearTimeout(this.synchronisationProgressTimer);
                clearTimeout(this.synchronisationInProgressTimer);
            })
            .$on('sync-start', () => {
                this.synchronisationError = '';
                this.synchronisationInProgress = true;
            })
            .$on('sync-progress', ({progress}) => {
                this.synchronisationProgress = progress;
            })
            .$on('sync-end', () => {
                //
            })
            .$on('sync-error', ({name, message}) => {
                this.synchronisationError = `${name}: ${message}`;
            })
            .$on('sync-finish', ({ok}) => {
                const hideProgressMs = ok ? 600 : 5000;
                this.synchronisationProgressTimer = setTimeout(() => this.synchronisationProgress = 0, hideProgressMs);

                this.synchronisationInProgressTimer = setTimeout(() => this.synchronisationInProgress = false, 500);
            });
    },
    beforeDestroy() {
        instances.delete(this);
    },
    methods: {
        async syncCloud(trust) {
            if (!this.synchronisationInProgress) {
                return await sendMessageModule('BG.cloudSync', false, trust);
            }
        },
    },
}
