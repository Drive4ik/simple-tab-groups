
import Listeners from './listeners.js?menus.onClicked';
import {MENU_ITEM_BUTTON} from './constants-browser.js';
import Logger from './logger.js';
import runModule from './module-runner.js';

export const {ContextType, ItemType} = browser.menus;

const logger = new Logger('Menus').disable();

const STORAGE_KEY = 'menu';

if (new URL(import.meta.url).searchParams.has('addListeners')) {
    addListeners();
}

export function addListeners() {
    Listeners.menus.onClicked.add(onClicked);
}

export function removeListeners() {
    Listeners.menus.onClicked.remove(onClicked);
}

async function onClicked(info, tab) {
    const log = logger.start('onClicked', {info, tab});

    const {[info.menuItemId]: menu} = await loadAll();

    log.assert(menu?.module, 'menu', info.menuItemId, "doesn't exist");

    if (menu?.module) {
        info.button ??= 0;

        info.button = {
            LEFT: info.button === MENU_ITEM_BUTTON.LEFT,
            MIDDLE: info.button === MENU_ITEM_BUTTON.MIDDLE,
            RIGHT: info.button === MENU_ITEM_BUTTON.RIGHT,
        };

        log.log('execute module', menu.module);

        await runModule(menu.module, info, tab).catch(log.onCatch(['execute module', menu.module, info, tab]));
    }

    log.stop();
}

async function loadAll() {
    const result = await browser.storage.session.get(STORAGE_KEY);
    return result[STORAGE_KEY] ?? {};
}

async function saveAll(menus) {
    await browser.storage.session.set({[STORAGE_KEY]: menus});
}

function collectDescendantIds(menus, parentId) {
    const ids = [];

    for (const id in menus) {
        if (menus[id].parentId === parentId) {
            ids.push(id);
            ids.push(...collectDescendantIds(menus, id));
        }
    }

    return ids;
}

export async function has(id) {
    const menus = await loadAll();
    return id in menus;
}

export async function create(createProperties) {
    const id = createProperties.id ??= crypto.randomUUID();

    const log = logger.start('create', createProperties);

    const menus = await loadAll();

    if (menus[id]) {
        log.throwError([id, 'already exists']);
    }

    const {context} = createProperties;
    delete createProperties.context;
    if (context) {
        createProperties.contexts = [context];
    }

    const {icon} = createProperties;
    delete createProperties.icon;
    if (icon) {
        createProperties.icons = {16: icon};
    }

    const {module} = createProperties;
    delete createProperties.module;

    await new Promise((resolve, reject) => {
        browser.menus.create(createProperties, () => {
            if (browser.runtime.lastError) {
                reject(new Error(browser.runtime.lastError));
            } else {
                resolve();
            }
        });
    }).catch(log.onCatch(["can't create", createProperties]));

    createProperties.module = module;

    menus[id] = createProperties;
    await saveAll(menus);

    log.stop(id);

    return id;
}

export async function createSeparator(parentId) {
    return create({
        parentId,
        type: browser.menus.ItemType.SEPARATOR,
    });
}

export async function update(id, updateProperties) {
    const log = logger.start('update', id, updateProperties);

    const menus = await loadAll();

    if (!menus[id]) {
        log.throwError([id, "doesn't exist"]);
    }

    delete updateProperties.id; // for easy coding

    const {module} = updateProperties;
    delete updateProperties.module;

    if (updateProperties.context) {
        updateProperties.contexts = [updateProperties.context];
        delete updateProperties.context;
    }

    if (updateProperties.icon) {
        updateProperties.icons = {16: updateProperties.icon};
        delete updateProperties.icon;
    }

    if (Object.keys(updateProperties).length) {
        await browser.menus.update(id, updateProperties).catch(log.onCatch(["can't update", updateProperties]));
    }

    if (module) {
        updateProperties.module = module;
    }

    Object.assign(menus[id], updateProperties);
    await saveAll(menus);

    log.stop();
}

export async function remove(id, withReal = true) {
    const log = logger.start('remove', id, {withReal});

    const menus = await loadAll();

    if (!menus[id]) {
        log.throwError([id, "doesn't exist"]);
    }

    if (withReal) {
        await browser.menus.remove(id).catch(log.onCatch(["can't remove", id]));
    }

    const descendantIds = collectDescendantIds(menus, id);

    delete menus[id];

    for (const descId of descendantIds) {
        delete menus[descId];
    }

    await saveAll(menus);

    log.stop();
}

export async function removeChildren(parentId) {
    const log = logger.start('removeChildren', parentId);

    const menus = await loadAll();

    const descendantIds = collectDescendantIds(menus, parentId);

    // Remove only direct children from browser (browser cascades to sub-children)
    for (const id of descendantIds) {
        if (menus[id].parentId === parentId) {
            await browser.menus.remove(id).catch(log.onCatch(["can't remove child", id]));
        }

        delete menus[id];
    }

    await saveAll(menus);

    log.stop();
}

export async function removeAll() {
    const log = logger.start('removeAll');

    await browser.menus.removeAll().catch(log.onCatch("can't remove all"));

    await saveAll({});

    log.stop();
}

export function isControlPressed(info) {
    return info.modifiers.includes('Ctrl'); // TODO make util for modifier with MAC
}
