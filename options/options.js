(function() {
    'use strict';

    const BG = (function(bgWin) {
        return bgWin && bgWin.background && bgWin.background.inited ? bgWin.background : false;
    })(browser.extension.getBackgroundPage());

    if (!BG) {
        return $('#simple-tab-groups-options')[INNER_HTML] = 'Please, update addon to latest version';
    }

    let $on = on.bind({});

    $on('change', '#' + onlyOptionsKeys.join(', #'), async function() {
        let options = {};

        options[this.id] = this.checked;

        checkEnabledCheckboxes();

        await storage.set(options);

        if ('enableFastGroupSwitching' === this.id && !this.checked) {
            BG.updateNewTabUrls();
        }

        if (['enableKeyboardShortcutLoadNextPrevGroup', 'enableKeyboardShortcutLoadByIndexGroup'].includes(this.id)) {
            BG.initBrowserCommands();
        }
    });

    $on('click', '#importAddonSettings', async function() {
        try {
            let data = await importFromFile();

            if ('object' !== type(data) || !Array.isArray(data.groups)) {
                throw Error('This is wrong backup!');
            }

            let resultMigration = {};
            data = await BG.runMigrateForData(data, resultMigration);

            if (resultMigration.errorMessage) {
                throw Error(resultMigration.errorMessage);
            }

            let groupIndex = data.groups.findIndex(group => group.windowId !== null);

            if (-1 !== groupIndex) {
                data.groups[groupIndex].windowId = null;
            }

            await storage.set(data);
            await BG.reloadGroups();

            if (-1 !== groupIndex) {
                let win = await BG.getWindow();
                await BG.loadGroup(win.id, groupIndex);
            }

            loadOptions();

            notify('Groups and settings are successfully imported!');
        } catch (e) {
            if (e) {
                notify(e);
            }
        }
    });

    $on('click', '#exportAddonSettings', async function() {
        let data = await storage.get(null),
            includeTabThumbnailsIntoBackup = $('#includeTabThumbnailsIntoBackup').checked;

        if (!includeTabThumbnailsIntoBackup) {
            data.groups = data.groups.map(function(group) {
                group.tabs = group.tabs.map(function(tab) {
                    delete tab.thumbnail;
                    return tab;
                });

                return group;
            });
        }

        exportToFile(data);
    });

    $on('click', '#importSettingsOldTabGroupsAddonButton', async function() {
        let oldOptions = null;

        try {
            oldOptions = await importFromFile();
        } catch (e) {
            return notify(e);
        }

        let data = await storage.get(['groups', 'lastCreatedGroupPosition']),
            newGroups = {};

        oldOptions.windows.forEach(function(win) {
            let oldGroups = {};

            try {
                oldGroups = JSON.parse(win.extData['tabview-group']);
            } catch (e) {
                return notify('Cannot parse groups: ' + e);
            }

            Object.keys(oldGroups).forEach(function(key) {
                let oldGroup = oldGroups[key];

                if (!newGroups[oldGroup.id]) {
                    data.lastCreatedGroupPosition++;

                    newGroups[oldGroup.id] = BG.createGroup(data.lastCreatedGroupPosition);
                    newGroups[oldGroup.id].title = oldGroup.title || browser.i18n.getMessage('newGroupTitle', newGroups[oldGroup.id].id);
                    newGroups[oldGroup.id].catchTabRules = (oldGroup.catchRules || '');
                    newGroups[oldGroup.id].slot = oldGroup.slot;
                }
            });

            win.tabs.forEach(function(oldTab) {
                let extData = {};

                if (oldTab.pinned && oldTab.entries[0] && oldTab.entries[0].url && isAllowUrl(oldTab.entries[0].url)) {
                    return browser.tabs.create({
                        url: oldTab.entries[0].url,
                        pinned: true,
                    });
                }

                try {
                    extData = JSON.parse(oldTab.extData['tabview-tab'] || '{}');
                    if (!extData || !extData.groupID) {
                        return;
                    }
                } catch (e) {
                    return notify('Cannot parse groups: ' + e);
                }

                oldTab.entries.forEach(function(t) {
                    if (isAllowUrl(t.url) && newGroups[extData.groupID]) {
                        newGroups[extData.groupID].tabs.push(BG.mapTab({
                            title: (t.title || t.url),
                            url: t.url,
                            favIconUrl: oldTab.image || '',
                            active: Boolean(extData.active),
                        }));
                    }
                });
            });
        });

        let groups = Object.values(newGroups)
            .sort((a, b) => String(a.slot).localeCompare(String(b.slot), [], { numeric: true }))
            .map(function(group) {
                delete group.slot;
                return group;
            });

        if (groups.length) {
            data.groups = data.groups.concat(groups);
            storage.set(data)
                .then(BG.reloadGroups)
                .then(function() {
                    notify('Old "Tab Groups" groups are imported successfully!');
                });
        } else {
            notify('Nothig imported');
        }
    });

    function checkEnabledCheckboxes() {
        $('#enableFavIconsForNotLoadedTabs').disabled = !$('#enableFastGroupSwitching').checked;
        $('#openGroupAfterChange').disabled = $('#closePopupAfterChangeGroup').checked;
    }

    function loadOptions() {
        storage.get(onlyOptionsKeys)
            .then(function(options) {
                onlyOptionsKeys.forEach(function(key) {
                    $('#' + key).checked = options[key];
                });
            })
            .then(checkEnabledCheckboxes)
            .then(translatePage);
    }

    loadOptions();

})();
