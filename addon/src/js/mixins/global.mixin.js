import * as Messages from '/js/messages.js';
import Logger from '/js/logger.js';
import * as Utils from '/js/utils.js';

const MODULE_NAME = 'global.mixin';
const logger = new Logger(MODULE_NAME, [Utils.getNameFromPath(location.href)]);

let rootInstance = null;

const {
    sendMessage,
    sendMessageModule,
    disconnect,
} = Messages.connectToBackground(MODULE_NAME, ['lock-addon', 'options-updated'], (message) => {
    logger.info('got message', message.action, message);

    if (message.action === 'lock-addon') {
        disconnect();
    }

    rootInstance?.$emit(message.action, message);
});

export default {
    created() {
        rootInstance ??= this.$root;
    },
    methods: {
        sendMessage,
        sendMessageModule,

        openDebugPage() {
            this.sendMessage('open-debug-page');
        },
        openManageGroups() {
            this.sendMessage('open-manage-groups');
            this.closeWindow?.();
        },
        openOptionsPage(section) {
            this.sendMessage('open-options-page', {section});
            this.closeWindow?.();
        },
        openSyncDiffPage(entry) {
            this.sendMessage('open-sync-diff-page', {entry});
            this.closeWindow?.();
        },
    },
};
