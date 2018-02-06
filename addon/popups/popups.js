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

    let templates = {
            'icon-color-tmpl': '<span id="groupIconColorCircle" style="background-color: {{iconColor}}"></span>',
            'icon-img-tmpl': '<img id="groupIconImg" src="{{iconUrl}}" class="is-inline-block size-16 h-margin-left-5" alt="" />',
        },
        lastData = null,
        lastOptions = null,
        $on = on.bind({});

    async function loadTemplate(name) {
        if (templates[name]) {
            return templates[name];
        }

        let blob = await fetch(`/popups/${name}.html`)
        templates[name] = await blob.text();

        return templates[name];
    }

    function showPopup(parsedTemplate) {
        if (Popups.show) {
            throw Error('popup is showing now');
        }

        Popups.show = true;

        let div = document.createElement('div');
        div.id = TEMPORARY_ID;
        div[INNER_HTML] = parsedTemplate;
        document.body.appendChild(div);

        $('html').classList.add('no-scroll');

        translatePage();

        let autoFocusEl = $('#' + TEMPORARY_ID).querySelector('[data-auto-focus]');
        autoFocusEl && autoFocusEl.focus();

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

    async function doAction(action, data, event) {
        if ('close-popup' === action) {
            hidePopup();

            if (data.afterHidePopupAction && lastOptions[data.afterHidePopupAction]) {
                lastOptions[data.afterHidePopupAction](data.afterHidePopupData);
            }
        } else if ('submit-delete-group-popup' === action) {
            hidePopup();
            BG.removeGroup(lastData.id);
        } else if ('submit-edit-group-popup' === action) {
            let group = lastData,
                groupIconWrapper = $('#groupIconWrapper');

            if ('image' === groupIconWrapper.dataset.iconType) {
                group.iconUrl = $('#groupIconImg').src;
            } else if ('color' === groupIconWrapper.dataset.iconType) {
                group.iconColor = $('#groupIconColorCircle').style.backgroundColor; // safed color
                group.iconUrl = null;
            }

            group.title = createGroupTitle($('#groupTitle').value, group.id);

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

            BG.saveGroup(group);

            let win = await BG.getWindow();

            if (group.windowId === win.id) {
                BG.updateBrowserActionData(win.id);
                BG.updateMoveTabMenus(win.id);
            }

            hidePopup();
        } else if ('set-random-group-color' === action) {
            event.preventDefault();

            let groupIconWrapper = $('#groupIconWrapper'),
                newColor = randomColor();

            $('#groupIconColor').value = newColor;

            groupIconWrapper[INNER_HTML] = format(templates['icon-color-tmpl'], {
                iconColor: newColor,
            });

            groupIconWrapper.dataset.iconType = 'color';

        } else if ('select-user-group-icon' === action) {
            if (1 === lastOptions.popupDesign) { // maybe temporary solution
                if (window.confirm(browser.i18n.getMessage('selectUserGroupIconWarnText'))) {
                    dispatchEvent('click', $('[data-action="open-manage-page"]'));
                }

                return;
            }

            let iconUrl = await new Promise(function(resolve) {
                let fileInput = document.createElement('input');

                fileInput.type = 'file';
                fileInput.accept = '.ico,.png,.jpg,.svg';
                fileInput.initialValue = fileInput.value;
                fileInput.onchange = function() {
                    if (fileInput.value !== fileInput.initialValue) {
                        let file = fileInput.files[0];
                        if (file.size > 100e6) {
                            reject();
                            return;
                        }

                        let reader = new FileReader();
                        reader.addEventListener('loadend', function() {
                            fileInput.remove();
                            resolve(reader.result);
                        });
                        reader.readAsDataURL(file);
                    } else {
                        reject();
                    }
                };
                fileInput.click();
            });

            let img = new Image();
            img.onload = function() {
                let resizedIconUrl = iconUrl;

                if (img.height > 16 || img.width > 16) {
                    resizedIconUrl = resizeImage(img, 16, 16);
                }

                let groupIconWrapper = $('#groupIconWrapper');

                groupIconWrapper[INNER_HTML] = format(templates['icon-img-tmpl'], {
                    iconUrl: resizedIconUrl,
                });
                groupIconWrapper.dataset.iconType = 'image';
            };
            img.src = iconUrl;
        }
    }

    $on('click', '[data-action]', (event, data) => doAction(data.action, data, event));

    $on('input', '#groupIconColor', function() {
        let groupIconWrapper = $('#groupIconWrapper');

        groupIconWrapper[INNER_HTML] = format(templates['icon-color-tmpl'], {
            iconColor: this.value.trim(),
        });

        groupIconWrapper.dataset.iconType = 'color';
    });

    async function showEditGroup(group, options = {}) {
        lastData = group;
        lastOptions = options;

        let mainTemplate = await loadTemplate('edit-group-main'),
            wrapperTemplate = await loadTemplate('edit-group-' + options.popupDesign),
            iconHtml = null;

        if (group.iconUrl) {
            iconHtml = format(templates['icon-img-tmpl'], group);
        } else {
            iconHtml = format(templates['icon-color-tmpl'], group);
        }

        let parsedMainTemplate = format(mainTemplate, {
            groupTitle: unSafeHtml(group.title),
            groupIconColor: group.iconColor,
            iconHtml: iconHtml,
            groupCatchTabRules: group.catchTabRules,
        });

        let popupNode = showPopup(format(wrapperTemplate, {
            mainHtml: parsedMainTemplate,
        }));

        if (group.iconUrl) {
            $('#groupIconWrapper').dataset.iconType = 'image';
        } else {
            $('#groupIconWrapper').dataset.iconType = 'color';
        }

        return popupNode;
    };

    async function confirm(text, header = '', resolveButtonTextKey = 'ok', resolveButtonClass = 'is-primary') {
        let confirmTemplate = await loadTemplate('confirm');

        showPopup(format(confirmTemplate, {
            header,
            text,
            resolveButtonTextKey,
            resolveButtonClass,
        }));

        return new Promise(function(resolve, reject) {
            lastOptions = {
                resolve,
                reject,
            };
        });
    };

    Popups.showEditGroup = showEditGroup;
    Popups.confirm = confirm;

})();
