(function() {
    'use strict';

    let background = browser.extension.getBackgroundPage().background;

    new Vue({
        el: '#stg',
        name: 'simple-tab-groups',
        data: {
            groups: [],
            currentGroupId: 0,

            activeTabIndex: -1,

            groupToShowId: 0,
            groupToEdit: null,
            groupToDeleteId: 0,

            searchTab: '',

            options: {
                closePopupAfterChangeGroup: true,
            },
        },
        computed: {
            groupToShow() {
                return this.groups.find(group => group.id === this.groupToShowId) || null;
            },
            groupToDelete() {
                return this.groups.find(group => group.id === this.groupToDeleteId) || null;
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

            openOptions() {
                browser.runtime.openOptionsPage();
            },

            expandGroup(group) {
                group.isExpanded = !group.isExpanded;
                background.saveGroup(group);
            },

            isTabVisibleInSearch(tab) {
                let search = this.searchTab.toLowerCase();

                return (tab.title || '').toLowerCase().indexOf(search) !== -1 || (tab.url || '').toLowerCase().indexOf(search) !== -1;
            },

            loadGroup(group, tabIndex) {
                if (!group.tabs.length) {
                    return;
                }

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
                    .then(function() {
                        this.groupToShowId = 0;
                        this.groupToDeleteId = 0;
                    }.bind(this));
            },

            openSettingsGroup(group) {
                this.groupToEdit = JSON.parse(JSON.stringify(group));
            },

            saveSettingsGroup() {
                background.saveGroup(this.groupToEdit)
                    .then(() => this.groupToEdit = null);
            },

            addTab() {
                background.addTab(this.groupToShow);
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
