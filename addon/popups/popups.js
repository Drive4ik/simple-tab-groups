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
            // 'icon-color-tmpl': '<span id="groupIconColorCircle" style="background-color: {{iconColor}}"></span>',
            // 'icon-img-tmpl': '<img id="groupIconImg" src="{{iconUrl}}" class="is-inline-block size-16 h-margin-left-5" alt="" />',
            'group-icon-tmpl': `
                <div class="control">
                    <button data-action="group-change-icon-style" data-view-style="{{styleName}}" class="button {{className}}">
                        <figure class="image is-16x16">
                            <img src="{{iconUrl}}" />
                        </figure>
                    </button>
                </div>
            `,
            'catch-container-tmpl': `
                <div class="field">
                    <div class="control">
                        <label class="checkbox">
                            <input type="checkbox" id="{{cookieStoreId}}" data-container {{checked}} />
                            <img src="{{iconUrl}}" class="size-16 align-bottom" style="fill: {{colorCode}};" />
                            {{name}}
                        </label>
                    </div>
                </div>
            `,
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

        $('html').classList.add('is-clipped');

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
        $('html').classList.remove('is-clipped');
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
                updateData = {
                    iconColor: group.iconColor,
                };

            if (lastOptions.viewStyle) {
                updateData.iconViewType = lastOptions.viewStyle;
                updateData.iconColor = $('#groupIconColor').value;
                updateData.iconUrl = null;
            } else {
                updateData.iconViewType = null;
                updateData.iconUrl = $('#groupIconImg').src;
            }

            updateData.title = createGroupTitle($('#groupTitle').value, group.id);

            updateData.catchTabRules = $('#groupCatchTabRules').value.trim();
            updateData.catchTabRules
                .split(/\s*\n\s*/)
                .filter(Boolean)
                .forEach(function(regExpStr) {
                    try {
                        new RegExp(regExpStr);
                    } catch (e) {
                        notify(browser.i18n.getMessage('invalidRegExpRuleTitle', regExpStr));
                    }
                });

            updateData.catchTabContainers = $$('[data-container]')
                .filter(n => n.checked)
                .map(n => n.id);

            updateData.isSticky = $('#isStickyGroup').checked;

            BG.updateGroup(group.id, updateData);

            let win = await BG.getWindow();

            if (group.windowId === win.id) {
                BG.updateBrowserActionData(win.id);
                BG.updateMoveTabMenus(win.id);
            }

            hidePopup();
        } else if ('set-random-group-color' === action) {
            $('#groupIconColor').value = randomColor();
            dispatchEvent('change', '#groupIconColor');
        } else if ('group-change-icon-style' === action) {
            lastOptions.viewStyle = data.viewStyle;
            dispatchEvent('change', '#groupIconColor');
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

                lastOptions.viewStyle = null;
                setActiveIconButton();
                $('#groupIconImg').src = resizedIconUrl;
            };
            img.src = iconUrl;
        }
    }

    $on('click', '[data-action]', (event, data) => doAction(data.action, data, event));

    $on('change', '#groupIconColor', async function() {
        if (!lastOptions.viewStyle) {
            lastOptions.viewStyle = 'main-squares';
        }

        this.value = safeColor(this.value);

        $('#groupIconImg').src = await getGroupIconUrl({
            iconViewType: lastOptions.viewStyle,
            iconColor: this.value,
        });

        setActiveIconButton();
    });

    function setActiveIconButton() {
        $$('[data-action="group-change-icon-style"]')
            .forEach(function(styleNode) {
                if (styleNode.dataset.viewStyle === lastOptions.viewStyle) {
                    styleNode.classList.add('is-focused');
                } else {
                    styleNode.classList.remove('is-focused');
                }
            });
    }

    async function showEditGroup(group, options = {}) {
        lastData = group;
        lastOptions = options;

        let mainTemplate = await loadTemplate('edit-group-main'),
            wrapperTemplate = await loadTemplate('edit-group-' + options.popupDesign);

        let containers = await loadContainers(),
            containersHtml = containers
            .map(function(container) {
                container.checked = group.catchTabContainers.includes(container.cookieStoreId) ? 'checked' : '';
                return format(templates['catch-container-tmpl'], container);
            })
            .join('');

        let iconsStyleHtml = await Promise.all(['main-squares', 'circle', 'squares']
            .map(async function(styleName) {
                return format(templates['group-icon-tmpl'], {
                    styleName: styleName,
                    className: (!group.iconUrl && styleName === group.iconViewType) ? 'is-focused' : '',
                    iconUrl: await getGroupIconUrl({
                        iconViewType: styleName,
                        iconColor: group.iconColor || 'rgb(66, 134, 244)',
                    }),
                });
            }));

        let parsedMainTemplate = format(mainTemplate, {
            groupTitleRaw: unSafeHtml(group.title),
            groupIconColor: group.iconColor,
            iconUrl: await getGroupIconUrl(group),
            iconsStyleHtml: iconsStyleHtml.join(''),
            groupCatchTabRules: group.catchTabRules,
            containersClass: containers.length ? '' : 'is-hidden',
            containersHtml: containersHtml,
            isStickyChecked: group.isSticky ? 'checked' : '',
        });

        let popupNode = showPopup(format(wrapperTemplate, {
            mainHtml: parsedMainTemplate,
        }));

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
