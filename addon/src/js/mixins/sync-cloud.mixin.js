
import '/js/prefixed-storage.js';
import {objectToNativeError} from '/js/logger.js';
import * as Constants from '/js/constants.js';
import * as Utils from '/js/utils.js';
import * as Cloud from '/js/sync/cloud/cloud-helpers.js';

// const MODULE_NAME = 'sync-cloud.mixin';
// const logger = new Logger(MODULE_NAME, [Utils.getNameFromPath(location.href)]);

const storage = localStorage.create(Constants.MODULES.CLOUD);

export default {
    data() {
        return {
            syncCloudLastUpdateAgo: null,

            syncCloudInProgress: false,
            syncCloudProgress: 0,
            syncCloudErrorMessage: '',
        };
    },
    created() {
        this.syncCloudUpdateInfo();
        const list = this.syncCloudOffListeners = new Set();

        list.add(Cloud.onSyncUiRequestListener());

        list.add(Cloud.on(['sync-start', 'sync-progress', 'sync-end', 'sync-error', 'sync-finish'], () => {
            this.syncCloudInProgress = true; // any action means that progress is being made
            this.syncCloudClearTimers();
        }));

        list.add(Cloud.on('sync-start', () => {
            this.syncCloudErrorMessage = '';
        }));

        list.add(Cloud.on('sync-progress', ({progress}) => {
            this.syncCloudProgress = progress;
        }));

        list.add(Cloud.on('sync-end', () => {
            // nothing to do
        }));

        list.add(Cloud.on('sync-error', e => {
            this.syncCloudErrorMessage = String(objectToNativeError(e));
        }));

        list.add(Cloud.on('sync-finish', ({ok}) => {
            this.syncCloudProgressTimer = setTimeout(() => {
                this.syncCloudProgress = 0;
            }, ok ? 600 : 5000);

            this.syncCloudInProgressTimer = setTimeout(() => {
                this.syncCloudInProgress = false;
            }, 500);

            this.syncCloudUpdateInfo();
        }));
    },
    beforeDestroy() {
        this.syncCloudOffListeners.forEach(off => off());
        this.syncCloudOffListeners.clear();
        this.syncCloudClearTimers();
    },
    methods: {
        syncCloudClearTimers() {
            clearTimeout(this.syncCloudUpdateInfoTimer);
            clearTimeout(this.syncCloudProgressTimer);
            clearTimeout(this.syncCloudInProgressTimer);
        },
        async syncCloud() {
            return await this.sendMessageModule('BG.cloudSync');
        },
        syncCloudUpdateInfo() {
            if (storage.lastUpdate) {
                this.syncCloudLastUpdateAgo = Utils.relativeTime(storage.lastUpdate);
            }

            this.syncCloudErrorMessage = storage.lastError || '';

            this.syncCloudUpdateInfoTimer = setTimeout(() => this.syncCloudUpdateInfo(), 30_000);
        },
    },
}
