(function() {
    'use strict';

    const BG = (function(bgWin) {
        return bgWin && bgWin.background && bgWin.background.inited ? bgWin.background : false;
    })(browser.extension.getBackgroundPage());

    if (!BG) {
        return $('#simple-tab-groups-options')[INNER_HTML] = 'Please, update addon to latest version';
    }

    let templates = {},
        options = null,
        $on = on.bind({});

    function render(templateId, data) {
        if (!templates[templateId]) {
            templates[templateId] = $('#' + templateId).innerHTML;
        }

        return format(templates[templateId], data);
    }

    $on('change', '#' + onlyBoolOptionsKeys.join(', #'), async function() {
        let options = {};

        options[this.id] = this.checked;

        checkEnabledCheckboxes();

        await storage.set(options);

        if ('enableFastGroupSwitching' === this.id && !this.checked) {
            BG.updateNewTabUrls();
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

    function saveHotkeys() {
        let filteredHotkeys = options.hotkeys.filter(function(hotkey) {
            let ok = (hotkey.keyCode || hotkey.key) && hotkey.action.id && (hotkey.ctrlKey || hotkey.shiftKey || hotkey.altKey);

            if (ok && 'load-custom-group' === hotkey.action.id && !hotkey.action.groupId) {
                ok = false;
            }

            return ok;
        });

        storage.set({
            hotkeys: filteredHotkeys,
        });
    }

    $on('keydown', '[data-hotkey-input]', function(e) {
        let [hotkeyNode, hotkeyIndex] = getHotkeyNode(e),
            hotkey = options.hotkeys[hotkeyIndex];

        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();

        if ((e.ctrlKey || e.shiftKey || e.altKey) && ![16, 17, 18].includes(e.keyCode) &&
            !(
                hotkey.ctrlKey === e.ctrlKey &&
                hotkey.shiftKey === e.shiftKey &&
                hotkey.altKey === e.altKey &&
                (
                    (hotkey.keyCode && hotkey.keyCode === e.keyCode) ||
                    (!e.keyCode && !hotkey.keyCode && hotkey.key.toLowerCase() === e.key.toLowerCase())
                )
            )
        ) {
            Object.assign(hotkey, {
                ctrlKey: e.ctrlKey,
                shiftKey: e.shiftKey,
                altKey: e.altKey,
                key: e.key,
                keyCode: e.keyCode,
            });

            e.target.value = transformHotkeyToText(hotkey);

            saveHotkeys();
        }
    });

    $on('change', '[data-hotkey-action]', function(e) {
        let [hotkeyNode, hotkeyIndex] = getHotkeyNode(e),
            customGroupNode = hotkeyNode.querySelector('[data-hotkey-custom-group]'),
            descriptionNode = hotkeyNode.querySelector('[data-hotkey-action-description]');

        options.hotkeys[hotkeyIndex].action.id = e.target.value;

        if ('load-custom-group' === options.hotkeys[hotkeyIndex].action.id) {
            customGroupNode.classList.remove('is-hidden');
            options.hotkeys[hotkeyIndex].action.groupId = parseInt(customGroupNode.value, 10);
        } else {
            delete options.hotkeys[hotkeyIndex].action.groupId;
            customGroupNode.classList.add('is-hidden');
        }

        descriptionNode[INNER_HTML] = getDescriptionForHotkey(options.hotkeys[hotkeyIndex]);

        saveHotkeys();
    });

    $on('change', '[data-hotkey-custom-group]', function(e) {
        let [hotkeyNode, hotkeyIndex] = getHotkeyNode(e);

        options.hotkeys[hotkeyIndex].action.groupId = parseInt(e.target.value, 10);

        saveHotkeys();
    });

    $on('click', '#addHotKey', function() {
        let hotkey = createHotkey();

        options.hotkeys.push(hotkey);

        $('#hotkeys').appendChild(parseHtml(createHotkeyHtml(hotkey, BG.getGroups())));

        saveHotkeys();
    });

    $on('click', '[data-hotkey-delete-hotkey]', function(e) {
        let [hotkeyNode, hotkeyIndex] = getHotkeyNode(e);

        options.hotkeys.splice(hotkeyIndex, 1);
        hotkeyNode.remove();

        saveHotkeys();
    });

    function renderHotkeys() {
        let groups = BG.getGroups();

        $('#hotkeys')[INNER_HTML] = options.hotkeys.map(hotkey => createHotkeyHtml(hotkey, groups)).join('');
    }

    function getHotkeyNode(e) {
        let hotkeyNode = e.target.closest('[data-hotkey]'),
            hotkeyIndex = Array.from(hotkeyNode.parentNode.children).indexOf(hotkeyNode);

        return [hotkeyNode, hotkeyIndex];
    }

    function createHotkey() {
        return {
            key: '',
            action: {},
        };
    }

    function createHotkeyHtml(hotkey = {}, groups) {
        let hotkeyData = {
            hotkeyValue: transformHotkeyToText(hotkey),
            hotkeyActionsHtml: createHotkeyActionsHtml(hotkey),
            groupsSelectClass: 'load-custom-group' === hotkey.action.id ? '' : 'is-hidden',
            groupsOptionsHtml: createGroupsOptionsHtml(groups, hotkey),
            description: getDescriptionForHotkey(hotkey),
        };

        return render('hotkey-tmpl', hotkeyData);
    }

    function createHotkeyActionsHtml(hotkey) {
        let findSelectedAction = false,
            hotkeyActionsHtml = ['load-next-group', 'load-prev-group', 'load-first-group', 'load-last-group', 'load-custom-group', 'add-new-group', 'delete-current-group', 'open-manage-groups']
            .map(function(actionId) {
                let selected = actionId === hotkey.action.id ? 'selected' : '';

                if (selected) {
                    findSelectedAction = true;
                }

                return render('option-tmpl', {
                    title: browser.i18n.getMessage('hotkeyActionTitle' + capitalize(toCamelCase(actionId))),
                    value: actionId,
                    selected: selected,
                });
            });

        if (!findSelectedAction) {
            hotkeyActionsHtml.unshift(render('option-tmpl', {
                title: browser.i18n.getMessage('selectAction'),
                selected: 'selected disabled',
            }));
        }

        return hotkeyActionsHtml.join('');
    }

    function createGroupsOptionsHtml(groups, hotkey) {
        let findSelectedGroup = false,
            groupsHtmlArray = groups
            .map(function(group) {
                let selected = 'load-custom-group' === hotkey.action.id && group.id === hotkey.action.groupId ? 'selected' : '';

                if (selected) {
                    findSelectedGroup = true;
                }

                return render('option-tmpl', {
                    title: group.title, // TODO safeHtml/unSafeHtml
                    value: group.id,
                    selected: selected,
                });
            });

        if (!findSelectedGroup) {
            groupsHtmlArray.unshift(render('option-tmpl', {
                title: browser.i18n.getMessage('selectGroup'),
                selected: 'selected disabled',
            }));
        }

        return groupsHtmlArray.join('');
    }

    function transformHotkeyToText(hotkey) {
        let result = [],
            key = hotkey.key === ' ' ? 'Space' : hotkey.key;

        if (hotkey.ctrlKey) {
            result.push('Control');
        }

        if (hotkey.shiftKey) {
            result.push('Shift');
        }

        if (hotkey.altKey) {
            result.push('Alt');
        }

        result.push(1 === key.length ? key.toUpperCase() : key);

        return result.join(' + ');
    }

    function getDescriptionForHotkey(hotkey) {
        if ('delete-current-group' === hotkey.action.id) {
            return browser.i18n.getMessage('hotkeyActionDescriptionDeleteCurrentGroup');
        }

        return '';
        // return browser.i18n.getMessage('hotkeyActionDescription' + capitalize(toCamelCase(hotkey.action.id)));
    }

    function loadOptions() {
        storage.get(allOptionsKeys)
            .then(function(opt) {
                options = opt;

                onlyBoolOptionsKeys.forEach(function(key) {
                    $('#' + key).checked = options[key];
                });

                renderHotkeys();
            })
            .then(checkEnabledCheckboxes)
            .then(translatePage);
    }

    loadOptions();

})();
