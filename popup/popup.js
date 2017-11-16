(function() {
    'use strict';

    const VIEW_GROUPS = 'groups',
        VIEW_SEARCH_TABS = 'search-tabs',
        VIEW_GROUP_TABS = 'group-tabs';

    let $ = document.querySelector.bind(document),
        background = browser.extension.getBackgroundPage().background,
        getMessage = browser.i18n.getMessage,
        options = null,
        allData = null,
        state = {
            view: VIEW_GROUPS,
        };

    storage.get({
            closePopupAfterChangeGroup: true,
        })
        .then(result => options = result);

    loadData();
    addEvents();

    function on(event, query, func, stopPropagation) {
        document.body.addEventListener(event, function(e) {
            let el = e.target;

            // let node = document.querySelector(query);

            if (el.matches(query)) {
                // if (stopPropagation || undefined === stopPropagation) {
                //     e.stopPropagation();
                // }

                func.call(el, el.dataset);
                translatePage();
            } else {
                // while (el.parentNode) {
                //     // let node = el.parentNode;

                //     if (el.parentNode.matches(query)) {
                //         if (stopPropagation || undefined === stopPropagation) {
                //             e.stopPropagation();
                //         }

                //         func.call(el.parentNode, el.parentNode.dataset);
                //         translatePage();
                //         break;
                //     }

                //     el = el.parentNode;
                // }

                // let node = Array.from(document.querySelectorAll(query))
                //     .find(n => n.contains(el));

                // if (node) {
                //     if (stopPropagation || undefined === stopPropagation) {
                //         e.stopPropagation();
                //     }

                //     func.call(node, node.dataset);
                //     translatePage();
                // }
            }

            //  else if (node && node.contains(el)) {
            //     func.call(node, node.dataset);
            //     translatePage();
            // }

        }, false);
    }

    function addEvents() {
        on('click', '[data-load-group-id]', function(data) {
            let group = getGroupById(data.loadGroupId),
                isCurrentGroup = group.id === allData.currentGroupId,
                tabIndex = parseInt(data.tabIndex, 10) || 0;

            background.loadGroup(group, isCurrentGroup, tabIndex)
                .then(loadData);

            if (options.closePopupAfterChangeGroup && !isCurrentGroup) {
                window.close();
            }
        });

        on('click', '#settings', function() {
            browser.runtime.openOptionsPage();
        });

        on('click', '[data-show-group-id]', function(data) {
            renderTabsList(data.showGroupId);
        });

        on('click', '[data-show-groups-list]', function(data) {
            renderGroupsList();
        });

        on('click', '[data-remove-tab-index]', function(data) {
            let group = getGroupById(state.groupId),
                tabIndex = parseInt(data.removeTabIndex, 10),
                tab = group.tabs.find((tab, index) => index == tabIndex);

            background.removeTab(tab, tabIndex, group, group.id === allData.currentGroupId);
        });

        on('click', '[data-add-tab]', function(data) {
            let group = getGroupById(state.groupId);

            background.addTab(group);
        });

        on('click', '[data-open-group-settings-popup]', function(data) {
            let group = getGroupById(state.groupId);
            // background.addTab(group);
        });

        on('click', '[data-show-delete-group-popup]', function(data) {
            let group = getGroupById(state.groupId);
            // background.addTab(group);
        });

        // setTabEventsListener
        let listener = function(request, sender, sendResponse) {
            if (request.storageUpdated) {
                loadData();
            }
        };

        browser.runtime.onMessage.addListener(listener);
        window.addEventListener('unload', () => browser.runtime.onMessage.removeListener(listener));
    }

    function getGroupById(groupId) {
        console.log(allData, allData.groups, groupId);
        return allData.groups.find(group => String(group.id) === String(groupId));
    }

    function render(templateId, data) {
        return format($('#' + templateId).innerHTML, data);
    }

    function showHtmlResult(html) {
        $('#result').innerHTML = html;
        translatePage();
    }

    function loadData() {
        return Promise.all([
                background.getCurrentData(),
                background.getNotPinnedTabs(true)
            ])
            .then(function(result) {
                let [curData, tabs] = result;

                allData = {
                    groups: curData.groups,
                    currentGroupId: curData.currentGroup.id,
                    activeTabIndex: tabs.findIndex(tab => tab.active),
                };

                window.allData = allData;
            })
            .then(selectRender);
    }

    function selectRender() {
        if (state.view === VIEW_SEARCH_TABS) {
            renderSearchTabsList();
        } else if (state.view === VIEW_GROUPS) {
            renderGroupsList();
        } else if (state.view === VIEW_GROUP_TABS) {
            renderTabsList(state.groupId || allData.currentGroupId);
        }

        // translatePage();
    }


    function renderSearchTabsList() {
        state.view = VIEW_SEARCH_TABS;

        let searchStr = $('#searchTab').value.trim().toLowerCase(),
            showTabs = [];

        state.searchStr = searchStr;

        if (!searchStr.length) {
            return showTabs;
        }

        allData.groups.forEach(function(group) {
            group.tabs.forEach(function(tab, tabIndex) {
                if ((tab.title || '').toLowerCase().indexOf(search) !== -1 || (tab.url || '').toLowerCase().indexOf(search) !== -1) {
                    tab.isActive = (group.id === allData.currentGroupId && tabIndex === allData.activeTabIndex);
                    tab.tabIndex = tabIndex;
                    tab.groupId = group.id;
                    tab.title = tab.title || tab.url;
                    tab.favIconUrl = tab.favIconUrl || '/icons/tab.svg';
                    showTabs.push(tab);
                }
            });
        });

        let searchHtml = render('search-tabs', {
            tabs: showTabs,
        });

        showHtmlResult(searchHtml);
    }

    function renderGroupsList() {
        state.view = VIEW_GROUPS;

        let groupsHtml = allData.groups.map(function(group) {
                let classList = [];

                if (group.id === allData.currentGroupId) {
                    classList.push('is-active');
                }

                if (!group.tabs.length) {
                    classList.push('no-hover');
                }

                group.classList = classList.join(' ');

                return render('show-groups-group', group);
            })
            .join('');

        let showGroupsHtml = render('show-groups', {
            groups: groupsHtml,
        });

        showHtmlResult(showGroupsHtml);
    }

    function renderTabsList(groupId) {
        state.view = VIEW_GROUP_TABS;
        state.groupId = groupId;

        let group = getGroupById(groupId);

        let tabsList = '';

        if (group.tabs.length) {
            let tabs = group.tabs.map(function(tab, tabIndex) {
                    let classList = [];

                    if (group.id === allData.currentGroupId && tabIndex === allData.activeTabIndex) {
                        classList.push('is-active');
                    }

                    tab.classList = classList.join(' ');
                    tab.groupId = group.id;
                    tab.tabIndex = tabIndex;
                    tab.favIconUrl = tab.favIconUrl || '/icons/tab.svg';
                    tab.title = tab.title || tab.url;

                    return render('group-tab', tab);
                })
                .join('');

            tabsList = render('group-tabs-list', {
                tabs,
            });
        }

        let result = render('tabs-list', {
            group,
            tabsList,
        });

        showHtmlResult(result);
    }


    /*
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
    /**/

})();
