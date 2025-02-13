
// import * as Constants from './constants.js';
import {MENU_ITEM_BUTTON, MenusContextType, MenusItemType} from './browser-constants.js';
import Logger, {catchFunc} from './logger.js';
import * as Utils from './utils.js';

const logger = new Logger('Menus').disable();

const menusMap = new Map;

browser.menus.onClicked.addListener(onMenuClick);

async function onMenuClick(info, tab) {
    const menu = menusMap.get(info.menuItemId);

    if (menu.onClick) {
        const log = logger.start('onMenuClick', info.menuItemId, {info, tab});

        info.button ??= 0;

        info.button = {
            LEFT: info.button === MENU_ITEM_BUTTON.LEFT,
            MIDDLE: info.button === MENU_ITEM_BUTTON.MIDDLE,
            RIGHT: info.button === MENU_ITEM_BUTTON.RIGHT,
        };

        await catchFunc(menu.onClick).call(menu, info, tab);

        log.stop();
    }
}

export async function create(createProperties) {
    const id = createProperties.id ??= String(Utils.getRandomInt(100000));

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

    await browser.menus.create(createProperties);

    createProperties.onClick = onClick;
    menusMap.set(id, createProperties);

    log.stop(id);

    return id;
}

export async function remove(id) {
    const log = logger.start('remove', id);

    if (!menusMap.has(id)) {
        log.throwError([id, 'doesn\'t exist']);
    }

    menusMap.delete(id);

    await browser.menus.remove(id);

    log.stop();
}

export async function removeAll() {
    const log = logger.start('removeAll');

    menusMap.clear();

    await browser.menus.removeAll();

    log.stop();
}

export async function update(id, updateProperties) {
    const log = logger.start('update', id, updateProperties);

    if (!menusMap.has(id)) {
        log.throwError([id, 'doesn\'t exist']);
    }

    await browser.menus.update(id, updateProperties);

    log.stop();
}

export async function enable(id) {
    const log = logger.start('enable', id);

    await update(id, {enabled: true});

    log.stop();
}

export async function disable(id) {
    const log = logger.start('disable', id);

    await update(id, {enabled: false});

    log.stop();
}

export {
    MenusContextType as ContextType,
    MenusItemType as ItemType,
}
