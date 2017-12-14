(function() {
    'use strict';

    const BG = (function(bgWin) {
        return bgWin && bgWin.background.inited ? bgWin.background : false;
    })(browser.extension.getBackgroundPage());

    if (!BG) {
        return $('#simple-tab-groups-options').classList.add('is-hidden');
    }

    let $on = on.bind({});

    function saveOptions() {
        let options = {};

        onlyOptionsKeys.forEach(function(key) {
            options[key] = $('#' + key).checked;
        });

        return storage.set(options).then(BG.initBrowserCommands);
    }

    $on('change', '#' + onlyOptionsKeys.join(', #'), saveOptions);

    $on('click', '#importSettingsOldTabGroupsAddon', function() {
        Promise.all([
                storage.get(['groups', 'lastCreatedGroupPosition']),
                importFromFile()
            ])
            .then(function([result, oldOptions]) {
                let newGroups = {};

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
                            result.lastCreatedGroupPosition++;

                            newGroups[oldGroup.id] = BG.createGroup(result.lastCreatedGroupPosition);
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
                    .sort((a, b) => String(a.slot).localeCompare(String(b.slot)))
                    .map(function(group) {
                        delete group.slot;
                        return group;
                    });

                if (groups.length) {
                    result.groups = result.groups.concat(groups);
                    storage.set(result)
                        .then(function() {
                            notify('Old "Tab Groups" groups are imported successfully!');
                        });
                } else {
                    notify('Nothig imported');
                }
            });
    });

    storage.get(defaultOptions)
        .then(function(options) {
            onlyOptionsKeys.forEach(function(key) {
                $('#' + key).checked = options[key];
            });
        })
        .then(translatePage);

})();
