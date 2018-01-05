(function() {
    'use strict';

    const BG = (function(bgWin) {
        return bgWin && bgWin.background && bgWin.background.inited ? bgWin.background : false;
    })(browser.extension.getBackgroundPage());

    if (!BG) {
        let key = 'innerHTML';
        return $('#simple-tab-groups-options')[key] = 'Please, update addon to latest version';
    }

    let $on = on.bind({});

    $on('change', '#' + onlyOptionsKeys.join(', #'), function() {
        let options = {};

        onlyOptionsKeys.forEach(function(key) {
            options[key] = $('#' + key).checked;
        });

        storage.set(options).then(BG.initBrowserCommands);
    });

    $on('click', '#importSettingsOldTabGroupsAddon', async function() {
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

    $on('click', '#importAddonSettings', async function() {
        if (confirm(browser.i18n.getMessage('importAddonSettingsWarning'))) {
            try {
                let data = await importFromFile();
                await storage.set(data);
                BG.reloadGroups();
                notify('Groups and settings are successfully imported!');
            } catch (e) {
                if (e) {
                    notify(e);
                }
            }
        }
    });

    $on('click', '#exportAddonSettings', async function() {
        let options = await storage.get(null);

        exportToFile(options);
    });

    storage.get(onlyOptionsKeys)
        .then(function(options) {
            onlyOptionsKeys.forEach(function(key) {
                $('#' + key).checked = options[key];
            });
        })
        .then(translatePage);

})();
