(function() {
    'use strict';

    let $on = on.bind({}),
        allCheckBoxes = Object.keys(defaultOptions).filter(key => 'boolean' === type(defaultOptions[key]));

    function saveOptions() {
        let options = {};

        allCheckBoxes.forEach(function(key) {
            options[key] = $('#' + key).checked;
        });

        return storage.set(options);
    }

    $on('change', '#' + allCheckBoxes.join(', #'), saveOptions);

    $on('click', '#importSettingsOldTabGroupsAddon', function() {
        Promise.all([
                storage.get(['groups', 'lastCreatedGroupPosition']),
                importFromFile()
            ])
            .then(function([result, oldOptions]) {
                let background = browser.extension.getBackgroundPage().background,
                    newGroups = {};

                oldOptions.windows.forEach(function(win) {
                    let oldGroups = {};

                    try {
                        oldGroups = JSON.parse(win.extData['tabview-group']);
                    } catch (e) {
                        return console.error('Cannot parse groups', e);
                    }

                    Object.keys(oldGroups).forEach(function(key) {
                        let oldGroup = oldGroups[key];

                        if (!newGroups[oldGroup.id]) {
                            result.lastCreatedGroupPosition++;

                            newGroups[oldGroup.id] = background.createGroup(result.lastCreatedGroupPosition);
                            newGroups[oldGroup.id].title = oldGroup.title || browser.i18n.getMessage('newGroupTitle', newGroups[oldGroup.id].id);
                            newGroups[oldGroup.id].moveNewTabsToThisGroupByRegExp = (oldGroup.catchRules || '');
                            newGroups[oldGroup.id].slot = oldGroup.slot;
                        }
                    });

                    win.tabs.forEach(function(oldTab) {
                        let oldGroupId = null;

                        try {
                            let extData = JSON.parse(oldTab.extData['tabview-tab']);
                            if (!extData || !extData.groupID) {
                                return console.error('Cannot parse tab extData', oldTab);
                            }
                            oldGroupId = extData.groupID;
                        } catch (e) {
                            return console.error('Cannot parse groups', e);
                        }


                        if (!newGroups[oldGroupId]) {
                            return console.error('not found group', oldGroupId);
                        }

                        oldTab.entries.forEach(function(t) {
                            if (isAllowUrl(t.url)) {
                                newGroups[oldGroupId].tabs.push(background.mapTab({
                                    title: (t.title || t.url),
                                    url: t.url,
                                    favIconUrl: oldTab.image || '',
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
            allCheckBoxes.forEach(function(key) {
                $('#' + key).checked = options[key];
            });
        })
        .then(translatePage);

})();
