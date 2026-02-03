
import Listeners from './listeners.js?menus.onClicked';
import * as Constants from './constants.js';
import {MENU_ITEM_BUTTON} from './constants-browser.js';
import Logger, {catchFunc} from './logger.js';
import * as Utils from './utils.js';

export const {ContextType, ItemType} = browser.menus;

const logger = new Logger('Menus').disable();

const menusMap = new Map;

if (Constants.IS_BACKGROUND_PAGE) {
    Listeners.menus.onClicked(catchFunc(onClicked, logger));
}

async function onClicked(info, tab = undefined) {
    const log = logger.start('onClicked', info.menuItemId, {info, tab});

    const menu = menusMap.get(info.menuItemId);

    if (menu.onClick) {
        info.button ??= 0;

        info.button = {
            LEFT: info.button === MENU_ITEM_BUTTON.LEFT,
            MIDDLE: info.button === MENU_ITEM_BUTTON.MIDDLE,
            RIGHT: info.button === MENU_ITEM_BUTTON.RIGHT,
        };

        log.log('execute onClick', info);

        await menu.onClick.call(menu, info, tab);
    }

    log.stop();
}

export function has(id) {
    return menusMap.has(id);
}

export async function create(createProperties) {
    const id = createProperties.id ??= String(Utils.getRandomInt(100_000));

    const log = logger.start('create', createProperties);

    if (menusMap.has(id)) {
        log.throwError([id, 'id already exist']);
    }

    const {icon, onClick} = createProperties;

    delete createProperties.icon;
    delete createProperties.onClick;

    if (icon) {
        createProperties.icons = {16: icon};
    }

    await new Promise((resolve, reject) => {
        browser.menus.create(createProperties, () => {
            if (browser.runtime.lastError) {
                reject(new Error(browser.runtime.lastError));
            } else {
                resolve();
            }
        });
    }).catch(log.onCatch(["can't create", createProperties]));

    createProperties.onClick = onClick;
    menusMap.set(id, createProperties);

    log.stop(id);

    return id;
}

export async function remove(id) {
    const log = logger.start('remove', id);

    const menu = menusMap.get(id);

    if (!menu) {
        log.throwError([id, 'doesn\'t exist']);
    } else if (menu.parentId && !menusMap.has(menu.parentId)) {
        log.throwError(['parentId', `"${menu.parentId}"`, 'of', `"${id}"`, 'already removed']);
    }

    await browser.menus.remove(id)
        .catch(log.onCatch(["can't remove", id]));

    menusMap.delete(id);

    for (const [menuId, menuProperties] of menusMap) {
        if (menuProperties.parentId === id) {
            menusMap.delete(menuId);
        }
    }

    log.stop();
}

/* export async function removeAll() {
    const log = logger.start('removeAll');

    for (const id of menusMap.keys()) {
        if (!menusMap.has(id)) {
            continue;
        }

        if (!id.startsWith(Constants.CONTEXT_MENU_PREFIX_UNDO_REMOVE_GROUP)) {
            await remove(id);
        }
    }

    // await browser.menus.removeAll().catch(log.onCatch("can't remove all"));
    // menusMap.clear();

    log.stop();
} */

export async function update(id, updateProperties) {
    const log = logger.start('update', id, updateProperties);

    if (!menusMap.has(id)) {
        log.throwError([id, 'doesn\'t exist']);
    }

    await browser.menus.update(id, updateProperties)
        .catch(log.onCatch(["can't update all", id, updateProperties]));

    log.stop();
}
