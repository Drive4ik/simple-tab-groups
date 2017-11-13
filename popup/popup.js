(function() {
    'use strict';

    let background = browser.extension.getBackgroundPage().background;

    new Vue({
        el: '#simple-tab-groups',
        name: 'simple-tab-groups',
        data: {
            groups: [],
            currentGroupId: 0,

            activeTabIndex: -1,

            groupToEdit: null,
            groupToDelete: null,

            options: {
                closePopupAfterChangeGroup: true,
            },
        },
        created() {
            this.loadData();
            this.loadOptions();
            this.setTabEventsListener();
        },
        methods: {
            getMessage: browser.i18n.getMessage,

            loadData() {
                Promise.all([
                        background.getCurrentData(),
                        background.getNotPinnedTabs(true)
                    ])
                    .then(function(result) {
                        let [data, tabs] = result;

                        this.groups = data.groups;
                        this.currentGroupId = data.currentGroup.id;

                        tabs.some(function(tab, tabIndex) {
                            if (tab.active) {
                                this.activeTabIndex = tabIndex;
                                return true;
                            }
                        }, this);
                    }.bind(this));
            },

            loadOptions() {
                storage.get({
                        closePopupAfterChangeGroup: true,
                    })
                    .then(options => this.options = options);
            },

            expandGroup(group) {
                group.isExpanded = !group.isExpanded;
                background.saveGroup(group);
            },

            loadGroup(group, tabIndex) {
                let isCurrentGroup = group.id === this.currentGroupId;

                background.loadGroup(group, isCurrentGroup, tabIndex)
                    .then(function() {
                        if (this.options.closePopupAfterChangeGroup && !isCurrentGroup) {
                            return window.close();
                        }

                        if (isCurrentGroup) {
                            this.activeTabIndex = tabIndex;
                        }
                    }.bind(this));
            },

            createNewGroup() {
                background.addGroup();
            },

            removeGroup() {
                background.removeGroup(this.groupToDelete)
                    .then(() => this.groupToDelete = null);
            },

            openSettingsGroup(group) {
                this.groupToEdit = JSON.parse(JSON.stringify(group));
            },

            saveSettingsGroup() {
                background.saveGroup(this.groupToEdit)
                    .then(() => this.groupToEdit = null);
            },

            addTab(group) {
                background.addTab(group);
            },

            removeTab(tab, tabIndex, group) {
                background.removeTab(tab, tabIndex, group, group.id === this.currentGroupId);
            },


            setTabEventsListener() {
                let listener = function(request, sender, sendResponse) {
                    if (request.storageUpdated) {
                        this.loadData();
                    }
                }.bind(this);

                browser.runtime.onMessage.addListener(listener);
                window.addEventListener('unload', () => browser.runtime.onMessage.removeListener(listener));
            },
        },
    });

})();