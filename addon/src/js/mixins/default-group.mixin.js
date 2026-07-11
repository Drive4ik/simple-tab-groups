
import * as Groups from '/js/groups-helpers.js';

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
            this.sendMessageModule('Groups.saveDefault', changes);
        },
    },
}
