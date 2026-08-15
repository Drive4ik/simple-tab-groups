
import * as Groups from '/js/groups.js';

export default {
    data() {
        return {
            openEditDefaultGroup: false,
        };
    },
    methods: {
        async openDefaultGroup() {
            ({defaultGroup: this.defaultGroup} = await Groups.getDefaults());

            this.openEditDefaultGroup = true;
        },

        saveDefaultGroup(changes) {
            this.openEditDefaultGroup = false;
            this.sendMessageModule('Groups.saveDefault', changes);
        },
    },
}
