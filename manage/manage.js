(function() {
    'use strict';

    let background = browser.extension.getBackgroundPage().background,
        templates = {},
        options = null,
        allData = null,
        allGroupsNodes = null,
        allTabsNodes = null,
        $on = on.bind({});

    storage.get(['closePopupAfterChangeGroup', 'openGroupAfterChange', 'showGroupCircleInSearchedTab', 'showUrlTooltipOnTabHover', 'showNotificationAfterMoveTab'])
        .then(result => options = result)
        .then(loadData);

    addEvents();

    function addEvents() {

        $on('click', '[data-action]', (data, event) => doAction(data.action, data, event));

        function doAction(action, data, event) {
            if ('load-group' === action) {
                //
            }
        }

        // $on('mousedown', 'input[type="text"]', function(data, event) {
        //     // event.preventDefault();
        //     event.stopPropagation();
        //     // this.focus();
        // });

        // $on('dragstart', 'input[type="text"]', function(data, event) {
        //     event.preventDefault();
        //     event.stopPropagation();
        //     this.focus();
        // });

        // setTabEventsListener
        let loadDataTimer = null,
            listener = function(request, sender, sendResponse) {
                if (request.storageUpdated) {
                    clearTimeout(loadDataTimer);
                    loadDataTimer = setTimeout(loadData, 100);
                }
                sendResponse(':)');
            };

        browser.runtime.onMessage.addListener(listener);
        window.addEventListener('unload', () => browser.runtime.onMessage.removeListener(listener));
    }



    function addDragAndDropEvents() {
        // groups
        let groupSelector = '[data-is-group]';

        DragAndDrop.create({
            selector: '[data-is-group]',
            group: {
                name: 'groups',
                put: ['groups', 'tabs'],
            },
            draggableElements: '.body, [data-is-group], .group-circle, .tabs-count',
            onStart() {
                $('#result').classList.add('drag-group');
            },
            onDrop() {},
            onEnd() {
                $('#result').classList.remove('drag-group');
            },
        });

        DragAndDrop.create({
            selector: '[data-is-tab]',
            group: {
                name: 'tabs',
                put: ['tabs'],
            },
            draggableElements: '[data-is-tab], .icon, .screenshot, .delete-tab-button, .container, .title',
            onStart() {
                $('#result').classList.add('drag-tab');
            },
            onDrop() {},
            onEnd() {
                $('#result').classList.remove('drag-tab');
            },
        });

        // allGroupsNodes = Array.from(document.querySelectorAll(groupSelector));

        // allGroupsNodes.forEach(function(group) {
        //     group.addEventListener('dragstart', groupHandleDragStart, false);
        //     group.addEventListener('dragenter', groupHandleDragEnter, false);
        //     group.addEventListener('dragover', groupHandleDragOver, false);
        //     group.addEventListener('dragleave', groupHandleDragLeave, false);
        //     group.addEventListener('drop', groupHandleDrop, false);
        //     group.addEventListener('dragend', groupHandleDragEnd, false);
        // });

        // tabs
        // let tabSelector = '[data-is-tab]';

        // allTabsNodes = Array.from(document.querySelectorAll(tabSelector));

        // allTabsNodes.forEach(function(tab) {
        //     tab.addEventListener('dragstart', tabHandleDragStart, false);
        //     tab.addEventListener('dragenter', tabHandleDragEnter, false);
        //     tab.addEventListener('dragover', tabHandleDragOver, false);
        //     tab.addEventListener('dragleave', tabHandleDragLeave, false);
        //     tab.addEventListener('drop', tabHandleDrop, false);
        //     tab.addEventListener('dragend', tabHandleDragEnd, false);
        // });

        // $on('mousedown mouseup', groupSelector, function(data, event) {
        //     this.draggable = event.type === 'mousedown';
        // });

    }


    // GROUPS
//     let dragGroupNode = null,
//         dragTabNode = null,
//         prevOverElement = null;

//     function groupHandleDragStart(e) {
//         console.log('groupHandleDragStart', this, e.target);

//         this.classList.add('moving');

//         dragGroupNode = this;

//         e.dataTransfer.effectAllowed = 'move';
//         e.dataTransfer.setData('text/html', this.innerHTML);
//     }

//     function groupHandleDragEnter(e) {
//         console.log('groupHandleDragEnter', this, e);
//         if (!dragGroupNode) {
//             return;
//         }
//         let groupNode = getGroupNodeFromChild(this);

//         // remove over class from rev over element;
//         if (prevOverElement) {
//             let prevGroupNode = getGroupNodeFromChild(prevOverElement);
//             if (prevGroupNode && prevGroupNode !== groupNode) {
//                 prevGroupNode.classList.remove('over');
//             }
//         }

//         if (groupNode) {
//             groupNode.classList.add('over');
//         }
//     }

//     function groupHandleDragLeave(e) {
//         if (!dragGroupNode) {
//             return;
//         }
// console.log('groupHandleDragLeave', this, e);
//         prevOverElement = e.target;

//         let groupNode = getGroupNodeFromChild(e.target);

//         if (groupNode) {
//             groupNode.classList.remove('over');
//         }
//     }

//     function groupHandleDragOver(e) {
//         if (!dragGroupNode) {
//             return;
//         }
// // console.log('groupHandleDragOver', this, e);
//         e.preventDefault();
//         e.dataTransfer.dropEffect = 'move';
//         return false;
//     }

//     function groupHandleDrop(e) {
// console.log('groupHandleDrop', this, e);
//         if (!dragGroupNode) {
//             return;
//         }

//         e.stopPropagation(); // stops the browser from redirecting.

//         if (dragGroupNode != this) {
//             console.log('groupHandleDrop', e);
//             dragGroupNode.innerHTML = this.innerHTML;
//             this.innerHTML = e.dataTransfer.getData('text/html');

//             // TODO move group dataTransfer
//         }

//         return false;
//     }

//     function groupHandleDragEnd(e) {
// console.log('groupHandleDragEnd', this, e);
//         if (!dragGroupNode) {
//             return;
//         }

//         // console.log('groupHandleDragEnd', e);
//         prevOverElement = dragGroupNode = null;

//         allGroupsNodes.forEach(function(group) {
//             group.draggable = false;
//             group.classList.remove('over', 'moving');
//         });
//     }





    // TABS
    // let dragSrcEl = null,
    //     prevOverElement = null;

    // function tabHandleDragStart(e) {
    //     console.log('tabHandleDragStart', this, e.target);

    //     e.stopPropagation();

    //     this.classList.add('moving');

    //     dragTabNode = this;

    //     e.dataTransfer.effectAllowed = 'move';
    //     e.dataTransfer.setData('text/html', this.innerHTML);
    // }

    // function tabHandleDragEnter(e) {
    //     if (!dragTabNode) {
    //         return;
    //     }

    //     console.log('dragEnter e.target:', e.target);
    //     console.log('dragEnter this:', this);
    //     console.log('dragEnter this === e.target:', this === e.target);

    //     let tabNode = getTabNodeFromChild(this);

    //     // remove over class from rev over element;
    //     if (prevOverElement) {
    //         let prevTabNode = getTabNodeFromChild(prevOverElement);
    //         console.log('prevTabNode', prevTabNode);
    //         if (prevTabNode && prevTabNode !== tabNode) {
    //             prevTabNode.classList.remove('over');
    //         }
    //     }

    //     if (tabNode) {
    //         tabNode.classList.add('over');
    //     }
    // }

    // function tabHandleDragLeave(e) {
    //     if (!dragTabNode) {
    //         return;
    //     }

    //     prevOverElement = e.target;

    //     console.log('tabHandleDragLeave prevOverElement', prevOverElement);

    //     // if (e.target.matches && e.target.matches('[data-is-tab]')) {
    //     //     this.classList.remove('over');
    //     // }
    // }

    // function tabHandleDragOver(e) {
    //     if (!dragTabNode) {
    //         return;
    //     }

    //     e.preventDefault();
    //     e.dataTransfer.dropEffect = 'move';
    //     return false;
    // }

    // function tabHandleDrop(e) {
    //     if (!dragTabNode) {
    //         return;
    //     }

    //     e.stopPropagation(); // stops the browser from redirecting.

    //     if (dragTabNode != this) {
    //         console.log('tabHandleDrop', e);
    //         dragTabNode.innerHTML = this.innerHTML;
    //         this.innerHTML = e.dataTransfer.getData('text/html');

    //         // TODO move tab dataTransfer
    //     }

    //     return false;
    // }

    // function tabHandleDragEnd(e) {
    //     if (!dragTabNode) {
    //         return;
    //     }

    //     // console.log('groupHandleDragEnd', e);
    //     prevOverElement = dragTabNode = null;

    //     allTabsNodes.forEach(function(tab) {
    //         tab.classList.remove('over', 'moving');
    //     });
    // }















/*

    function getGroupNodeFromChild(child) {
        if (child.nodeName !== '#text' && child.matches('[data-is-group]')) {
            return child;
        }

        while (child.parentNode) {
            if (child.parentNode.matches('[data-is-group]')) {
                return child.parentNode;
            }

            child = child.parentNode;
        }
    }



    function getTabNodeFromChild(child) {
        if (child.nodeName !== '#text' && child.matches('[data-is-tab]')) {
            return child;
        }

        while (child.parentNode) {
            if (child.parentNode.matches && child.parentNode.matches('[data-is-tab]')) {
                return child.parentNode;
            }

            child = child.parentNode;
        }
    }


*/











    function getGroupById(groupId) {
        return allData.groups.find(group => group.id === groupId);
    }

    function render(templateId, data) {
        let tmplHtml = null;

        if (templates[templateId]) {
            tmplHtml = templates[templateId];
        } else {
            tmplHtml = templates[templateId] = $('#' + templateId).innerHTML;
        }

        return format(tmplHtml, data);
    }

    function showResultHtml(html, doTranslatePage = true) {
        setHtml('result', html);

        if (doTranslatePage) {
            translatePage();
        }
    }

    function setHtml(id, html) {
        $('#' + id).innerHTML = html;
    }

    function getContainers() {
        return new Promise(function(resolve) {
            browser.contextualIdentities.query({})
                .then(resolve, () => resolve([]));
        });
    }

    function loadData() {
        console.log('loadData');
        return Promise.all([
                background.getData(undefined, false),
                getContainers()
            ])
            .then(function([result, containers]) {
                allData = {
                    groups: result.groups,
                    currentGroup: result.currentGroup,
                    currentWindowId: result.windowId,
                    activeTabIndex: result.tabs.findIndex(tab => tab.active),
                    containers,
                };
            })
            .then(renderGroupsCards)
            .then(addDragAndDropEvents);
    }

    function prepareTabToView(groupId, tab, tabIndex) {
        let container = {},
            urlTitle = '';

        if (tab.cookieStoreId && tab.cookieStoreId !== DEFAULT_COOKIE_STORE_ID) {
            container = allData.containers.find(container => container.cookieStoreId === tab.cookieStoreId);
        }

        if (options.showUrlTooltipOnTabHover) {
            if (tab.title) {
                urlTitle = safeHtml(unSafeHtml(tab.title)) + '\n' + tab.url;
            } else {
                urlTitle = tab.url;
            }
        }

        return {
            urlTitle: urlTitle,
            classList: (groupId === allData.currentGroup.id && tabIndex === allData.activeTabIndex) ? 'is-active' : '',
            tabIndex: tabIndex,
            groupId: groupId,
            title: safeHtml(unSafeHtml(tab.title || tab.url)),
            url: tab.url,

            favIconClass: tab.favIconUrl ? '' : 'is-hidden',
            favIconUrl: tab.favIconUrl,

            containerClass: container.cookieStoreId ? '' : 'is-hidden',
            containerIconUrl: container.iconUrl,
            containerColorCodeFillStyle: container.cookieStoreId ? `fill: ${container.colorCode};` : '',
            containerColorCodeBorderStyle: container.cookieStoreId ? `border-color: ${container.colorCode};` : '',

            thumbnailClass: '',
            thumbnail: tab.thumbnail || '/test.jpg',
        };
    }

    function getTabsHtml(group) {
        return group.tabs
            .map(function(tab, tabIndex) {
                return render('tab-tmpl', prepareTabToView(group.id, tab, tabIndex));
            })
            .concat([render('new-tab-tmpl', {
                groupId: group.id,
            })])
            .join('');
    }

    function renderGroupsCards() {
        let groupsHtml = allData.groups.map(function(group) {
                let customData = {
                    classList: '',
                    colorCircleHtml: render('color-circle-tmpl', group),
                    tabsHtml: getTabsHtml(group),
                };

                return render('group-tmpl', Object.assign({}, group, customData));
            })
            .concat([render('new-group-tmpl')])
            .join('');

        showResultHtml(groupsHtml);
    }

})();
