
import Logger from '/js/logger.js';
import Messages from '/js/messages.js';

const logger = new Logger('sync.cloud-mixin');

const allowedInstanceNames = new Set([
    'popup-page',
    'github-gist',
]);

const instances = new Set;

const {disconnect} = Messages.connectToBackground('sync-progress-mixin', [
    'sync-start',
    'sync-progress',
    'sync-end',
    'sync-error',
    'sync-finish',
], (syncEvent) => {
    logger.log(syncEvent.action, syncEvent);

    for (const instance of instances) {
        instance.$emit(syncEvent.action, syncEvent);
    }
});

window.addEventListener('unload', disconnect);

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
        async syncCloud() {
            if (!this.synchronisationInProgress) {
                return await Messages.sendMessageModule('BG.cloudSync');
            }
        },
    },
}
