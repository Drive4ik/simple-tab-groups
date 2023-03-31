
import * as Constants from './constants.js';
import Logger from './logger.js';
import * as Utils from './utils.js';

const logger = new Logger('Menus');

const menusMap = new Map;

export function create(createProperties) {
    const id = createProperties.id ??= String(Utils.getRandomInt(100000,  Number.MAX_SAFE_INTEGER));

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

    browser.menus.create(createProperties);

    const menuListenerOptions = {
        id,
        onClick: onClick ? Utils.catchFunc(onClick) : null,
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
            LEFT: info.button === 0,
            MIDDLE: info.button === 1,
            RIGHT: info.button === 2,
        };

        await this.onClick?.(info, tab);

        log.stop();
    }
}

export function remove(id) {
    const log = logger.start('remove', id);

    if (!menusMap.has(id)) {
        log.throwError([id, 'doesn\'t exist']);
        return;
    }

    browser.menus.onClicked.removeListener(menusMap.get(id).onMenuClick);
    menusMap.delete(id);

    return log.stop(id);
}

export function update(id, updateProperties) {
    const log = logger.start('update', id, updateProperties);

    if (!menusMap.has(id)) {
        log.throwError([id, 'doesn\'t exist']);
        return;
    }

    browser.menus.update(id, updateProperties);

    log.stop();
}

export function enable(id) {
    const log = logger.start('enable', id);

    update(id, {
        enabled: true,
    });

    log.stop();
}

export function disable(id) {
    const log = logger.start('disable', id);

    update(id, {
        enabled: false,
    });

    log.stop();
}

export const ContextType = {
    ...browser.menus.ContextType,
    ACTION: Constants.MANIFEST.manifest_version === 3
        ? browser.menus.ContextType.ACTION
        : browser.menus.ContextType.BROWSER_ACTION,
};
export const ItemType = browser.menus.ItemType;

// export const LEFT_BUTTON = 0;
// export const MIDDLE_BUTTON = 1;
// export const RIGHT_BUTTON = 2;
