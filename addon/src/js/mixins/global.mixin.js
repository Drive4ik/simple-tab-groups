import * as Messages from '/js/messages.js';
import Logger from '/js/logger.js';
import * as Constants from '/js/constants.js';

const MODULE_NAME = 'global.mixin';
const logger = new Logger(MODULE_NAME, {prefixes: [Constants.PAGES.current]});

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
    },
};
