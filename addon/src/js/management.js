(function() {
    'use strict';

    let extensions = {};

    async function init() {
        console.log('START management.init');

        await reloadExtensions();

        browser.management.onEnabled.addListener(onChanged);
        browser.management.onDisabled.addListener(onChanged);
        browser.management.onInstalled.addListener(onChanged);
        browser.management.onUninstalled.addListener(onChanged);

        console.log('STOP management.init');
    }

    async function reloadExtensions() {
        await utils.wait(100);

        let addons = await browser.management.getAll(),
            _extensions = addons.filter(({type}) => type === browser.management.ExtensionType.EXTENSION);

        extensions = utils.arrayToObj(_extensions, 'id');
    }

    async function onChanged({type}) {
        if (type === browser.management.ExtensionType.EXTENSION) {
            await reloadExtensions();
            await detectConflictedExtensions();
        }
    }

    function isEnabled(id) {
        return extensions[id]?.enabled;
    }

    async function detectConflictedExtensions() {
        if (CONFLICTED_EXTENSIONS.some(isEnabled)) {
            await openHelp('extensions-that-conflict-with-stg');
        }
    }

    // can't have permission to read other addon icon :((
    /* function getExtensionIcon({icons} = {}) {
        if (Array.isArray(icons)) {
            let maxSize = Math.max(...icons.map(({size}) => size)),
                {url} = icons.find(icon => icon.size === maxSize);

            return url;
        }

        return '/icons/extension-generic.svg';
    } */

    function getExtensionByUUID(uuid) {
        if (!uuid) {
            return;
        }

        for (let i in extensions) {
            if (extensions[i]?.hostPermissions?.some(url => url.includes(uuid))) {
                return extensions[i];
            }
        }
    }

    window.Management = {
        init,

        isEnabled,
        detectConflictedExtensions,
        // getExtensionIcon,
        getExtensionByUUID,
    };

})();
