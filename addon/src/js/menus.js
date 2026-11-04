
import Listeners from './listeners.js?menus.onClicked';
import {MENU_ITEM_BUTTON} from './constants-browser.js';
import Logger from './logger.js';
import Queue from './queue.js';
import runModule from './module-runner.js';

export const {ContextType, ItemType} = browser.menus;

const logger = new Logger('Menus', {debugOnly: true});

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
    using log = logger.start('onClicked', {info, tab});

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

        await runModule(menu.module, info, tab).catch(log.catch('execute module', menu.module, info, tab));
    }
}

async function loadAll() {
    const result = await browser.storage.session.get(STORAGE_KEY);
    return result[STORAGE_KEY] ?? {};
}

async function saveAll(menus) {
    await browser.storage.session.set({[STORAGE_KEY]: menus});
}

const writeQueue = new Queue('Menus');
const transactionQueue = new Queue('MenusTransaction');

// a batch of menu calls as one whole (docs/DESIGN-QUEUES.md §2); the log of the transaction closes with its turn
export async function transaction(name) {
    const stack = new DisposableStack();
    const log = stack.use(logger.start('transaction', name));

    stack.use(await transactionQueue.wait(name));

    log.log('started');

    return stack;
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
    using turn = await writeQueue.wait('create');

    const id = createProperties.id ??= crypto.randomUUID();

    using log = logger.start('create', createProperties);

    const menus = await loadAll();

    if (menus[id]) {
        throw log.error(`menu ${id} already exists`);
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
                reject(browser.runtime.lastError);
            } else {
                resolve();
            }
        });
    }).catch(log.catch("can't create", createProperties));

    createProperties.module = module;

    menus[id] = createProperties;
    await saveAll(menus);

    log.log(id);

    return id;
}

export async function createSeparator(parentId) {
    return create({
        parentId,
        type: ItemType.SEPARATOR,
    });
}

export async function update(id, updateProperties) {
    using turn = await writeQueue.wait('update');

    using log = logger.start('update', id, updateProperties);

    const menus = await loadAll();

    if (!menus[id]) {
        throw log.error(`menu ${id} doesn't exist`);
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
        await browser.menus.update(id, updateProperties).catch(log.catch("can't update", updateProperties));
    }

    if (module) {
        updateProperties.module = module;
    }

    Object.assign(menus[id], updateProperties);
    await saveAll(menus);
}

export async function remove(id) {
    using turn = await writeQueue.wait('remove');

    using log = logger.start('remove', id);

    const menus = await loadAll();

    if (!menus[id]) {
        throw log.error(`menu ${id} doesn't exist`);
    }

    await browser.menus.remove(id).catch(log.catch("can't remove", id));

    const descendantIds = collectDescendantIds(menus, id);

    delete menus[id];

    for (const descId of descendantIds) {
        delete menus[descId];
    }

    await saveAll(menus);
}

export async function removeChildren(parentId) {
    using turn = await writeQueue.wait('remove-children');

    using log = logger.start('removeChildren', parentId);

    const menus = await loadAll();

    const descendantIds = collectDescendantIds(menus, parentId);

    // Remove only direct children from browser (browser cascades to sub-children)
    for (const id of descendantIds) {
        if (menus[id].parentId === parentId) {
            await browser.menus.remove(id).catch(log.catch("can't remove child", id));
        }

        delete menus[id];
    }

    await saveAll(menus);
}

export async function removeAll() {
    using turn = await writeQueue.wait('remove-all');

    using log = logger.start('removeAll');

    await browser.menus.removeAll().catch(log.catch("can't remove all"));

    await saveAll({});
}

export function isControlPressed(info) {
    return info.modifiers.includes('Ctrl'); // TODO make util for modifier with MAC
}
