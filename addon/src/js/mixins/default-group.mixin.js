
import * as Groups from '/js/groups.js';
import Messages from '/js/messages.js';

export default {
    data() {
        return {
            openEditDefaultGroup: false,
        };
    },
    methods: {
        async openDefaultGroup() {
            ({
                defaultGroup: this.defaultGroup,
                defaultCleanGroup: this.defaultCleanGroup,
            } = await Groups.getDefaults());

            this.openEditDefaultGroup = true;
        },

        saveDefaultGroup(changes) {
            this.openEditDefaultGroup = false;
            Messages.sendMessageModule('Groups.saveDefault', changes);
        },
    },
}
