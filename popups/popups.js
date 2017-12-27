let Popups = {
    show: false,
};

(function() {
    'use strict';

    const BG = (function(bgWin) {
        return bgWin && bgWin.background && bgWin.background.inited ? bgWin.background : false;
    })(browser.extension.getBackgroundPage());

    if (!BG) {
        throw Error('background is not initialized');
    }

    const TEMPORARY_ID = 'temporary';

    let templates = {},
        lastData = null,
        $on = on.bind({});

    function loadTemplate(name) {
        if (templates[name]) {
            return Promise.resolve(templates[name]);
        }

        return fetch(`/popups/${name}.html`)
            .then(blob => blob.text())
            .then(function(text) {
                templates[name] = text;
                return text;
            });
    }

    function showPopup(parsedTemplate, key = 'innerHTML') {
        if (Popups.show) {
            throw Error('popup is showing now');
        }

        Popups.show = true;

        let div = document.createElement('div');
        div.id = TEMPORARY_ID;
        div[key] = parsedTemplate;
        document.body.appendChild(div);

        $('html').classList.add('no-scroll');

        translatePage();

        return div;
    }

    function hidePopup() {
        if (!Popups.show) {
            throw Error('popup is hidden now');
        }

        Popups.show = false;

        $('#' + TEMPORARY_ID).remove();
        $('html').classList.remove('no-scroll');
    }

    function doAction(action, data, event) {
        if ('close-popup' === action) {
            hidePopup();
        } else if ('submit-delete-group-popup' === action) {
            BG.removeGroup(lastData).then(hidePopup);
        } else if ('submit-edit-group-popup' === action) {
            let group = lastData;

            group.title = safeHtml($('#groupTitle').value.trim());
            group.iconColor = $('#groupIconColorCircle').style.backgroundColor; // safed color
            group.catchTabRules = $('#groupCatchTabRules').value.trim();
            group.catchTabRules
                .split(/\s*\n\s*/)
                .filter(Boolean)
                .forEach(function(regExpStr) {
                    try {
                        new RegExp(regExpStr);
                    } catch (e) {
                        notify(browser.i18n.getMessage('invalidRegExpRuleTitle', regExpStr));
                    }
                });

            BG.saveGroup(group, true);

            BG.getWindow()
                .then(function(win) {
                    if (group.windowId === win.id) {
                        BG.updateBrowserActionData(win.id);
                    }

                    hidePopup();
                });
        } else if ('set-random-group-color' === action) {
            event.preventDefault();
            $('#groupIconColor').value = randomColor();
            dispatchEvent('input', $('#groupIconColor'));
        }
    }

    $on('click', '[data-action]', (event, data) => doAction(data.action, data, event));

    $on('input', '#groupIconColor', function() {
        $('#groupIconColorCircle').style.backgroundColor = this.value.trim();
    });

    Popups.showEditGroup = function(group, popupDesign = 1) {
        lastData = group;

        return Promise.all([
                loadTemplate('edit-group-main'),
                loadTemplate('edit-group-' + popupDesign)
            ])
            .then(function([main, template]) {
                let parsedMainHtml = format(main, {
                    groupTitle: unSafeHtml(group.title),
                    groupIconColor: group.iconColor,
                    groupCatchTabRules: group.catchTabRules,
                });

                return format(template, {
                    mainHtml: parsedMainHtml,
                });
            })
            .then(showPopup);
    };

    Popups.showDeleteGroup = function(group) {
        lastData = group;

        return loadTemplate('delete-group')
            .then(function(template) {
                return format(template, {
                    groupId: group.id,
                    questionText: browser.i18n.getMessage('deleteGroupPopupBody', unSafeHtml(group.title)),
                });
            })
            .then(showPopup);
    };

})();
