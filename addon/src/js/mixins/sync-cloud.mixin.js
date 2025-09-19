
import '/js/prefixed-storage.js';
import Logger from '/js/logger.js';
import * as Constants from '/js/constants.js';
import * as Utils from '/js/utils.js';
import * as Messages from '/js/messages.js';

const MODULE_NAME = 'sync-cloud.mixin';
const logger = new Logger(MODULE_NAME, [Utils.getNameFromPath(location.href)]);

const storage = localStorage.create(Constants.MODULES.CLOUD);

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
        return {
            syncCloudLastUpdateAgo: null,
            syncCloudHasError: false,

            syncCloudInProgress: false,
            syncCloudProgress: 0,
            syncCloudErrorMessage: '',
        };
    },
    created() {
        instances.add(this);

        this.syncCloudUpdateInfo();
        this.syncCloudUpdateInfoTimer = setInterval(() => this.syncCloudUpdateInfo(), 30_000);

        this
            .$on(['sync-start', 'sync-progress', 'sync-end', 'sync-error', 'sync-finish'], () => {
                clearTimeout(this.syncCloudProgressTimer);
                clearTimeout(this.syncCloudInProgressTimer);
            })
            .$on('sync-start', () => {
                this.syncCloudErrorMessage = '';
                this.syncCloudInProgress = true;
            })
            .$on('sync-progress', ({progress}) => {
                this.syncCloudProgress = progress;
            })
            .$on('sync-end', () => {
                //
            })
            .$on('sync-error', ({name, message}) => {
                this.syncCloudErrorMessage = `${name}: ${message}`;
            })
            .$on('sync-finish', ({ok}) => {
                const hideProgressMs = ok ? 600 : 5000;
                this.syncCloudProgressTimer = setTimeout(() => this.syncCloudProgress = 0, hideProgressMs);

                this.syncCloudInProgressTimer = setTimeout(() => this.syncCloudInProgress = false, 500);

                this.syncCloudUpdateInfo();
            });
    },
    beforeDestroy() {
        instances.delete(this);
        clearInterval(this.syncCloudUpdateInfoTimer);
    },
    methods: {
        async syncCloud(trust, revision) {
            if (!this.syncCloudInProgress) {
                return await sendMessageModule('BG.cloudSync', false, trust, revision);
            }
        },
        syncCloudUpdateInfo() {
            if (storage.lastUpdate) {
                this.syncCloudLastUpdateAgo = Utils.relativeTime(storage.lastUpdate);
            }

            this.syncCloudHasError = !!storage.hasError;
        },
    },
}
