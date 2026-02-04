
// import * as Constants from '/js/constants.js';
// import * as Windows from '/js/windows.js';
import * as Messages from '/js/messages.js';

export default {
    methods: {
        openDebugPage() {
            Messages.sendMessage('open-debug-page');
        },
        openManageGroups() {
            Messages.sendMessage('open-manage-groups');
            this.closeWindow?.();
        },
        openOptionsPage(section) {
            Messages.sendMessage('open-options-page', {section});
            this.closeWindow?.();
        },
    },
}
