
// import * as Constants from './constants.js';
import {MENU_ITEM_BUTTON, MenusContextType, MenusItemType} from './browser-constants.js';
import Logger, {catchFunc} from './logger.js';
import * as Utils from './utils.js';

const logger = new Logger('Menus').disable();

const menusMap = new Map;

export async function create(createProperties) {
    const id = createProperties.id ??= String(Utils.getRandomInt(100000));

    const log = logger.start('create', createProperties);

    if (menusMap.has(id)) {
        log.throwError([id, 'id already exist']);
        return;
    }

    const {icon, onClick} = createProperties;

    delete createProperties.icon;
    delete createProperties.onClick;

    if (icon) {
        createProperties.icons = {16: icon};
    }

    await browser.menus.create(createProperties);

    const menuListenerOptions = {
        id,
        onClick: onClick ? catchFunc(onClick) : null,
    };

    menuListenerOptions.onMenuClick = onMenuClick.bind(menuListenerOptions);

    menusMap.set(id, menuListenerOptions);

    browser.menus.onClicked.addListener(menuListenerOptions.onMenuClick);

    return log.stop(id);
}

async function onMenuClick(info, tab) {
    if (this.id === info.menuItemId) {
        const log = logger.start('onMenuClick', {info, tab});

        info.button ??= 0;

        info.button = {
            LEFT: info.button === MENU_ITEM_BUTTON.LEFT,
            MIDDLE: info.button === MENU_ITEM_BUTTON.MIDDLE,
            RIGHT: info.button === MENU_ITEM_BUTTON.RIGHT,
        };

        await this.onClick?.(info, tab);

        log.stop();
    }
}

export async function remove(id) {
    const log = logger.start('remove', id);

    if (!menusMap.has(id)) {
        log.throwError([id, 'doesn\'t exist']);
        return;
    }

    await browser.menus.remove(id).catch(() => {});

    browser.menus.onClicked.removeListener(menusMap.get(id).onMenuClick);
    menusMap.delete(id);

    return log.stop(id);
}

export async function update(id, updateProperties) {
    // const log = logger.start('update', id, updateProperties);

    if (!menusMap.has(id)) {
        // log.throwError([id, 'doesn\'t exist']);
        return;
    }

    await browser.menus.update(id, updateProperties).catch(() => {});

    // log.stop();
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
