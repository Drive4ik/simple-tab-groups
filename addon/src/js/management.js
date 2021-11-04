(function() {
    'use strict';

    let extensions = {};

    async function init() {
        console.log('START management.init');

        let addons = await browser.management.getAll();

        addons
            .filter(({type}) => type === browser.management.ExtensionType.EXTENSION)
            .forEach(ext => extensions[ext.id] = ext);

        browser.management.onEnabled.addListener(onEnabled);
        browser.management.onDisabled.addListener(onDisabled);
        browser.management.onInstalled.addListener(onInstalled);
        browser.management.onUninstalled.addListener(onUninstalled);

        console.log('STOP management.init');
    }

    function onEnabled({id}) {
        extensions[id].enabled = true;
    }

    function onDisabled({id}) {
        extensions[id].enabled = false;
    }

    function onInstalled(ext) {
        extensions[ext.id] = ext;
    }

    function onUninstalled({id}) {
        delete extensions[id];
    }

    function isEnabled(id) {
        if (extensions[id]?.enabled) {
            return true;
        }

        return false;
    }

    function getExtensionByUUID(uuid) {
        for (let i in extensions) {
            if (extensions[i]?.hostPermissions?.some(url => url.includes(uuid))) {
                if (!extensions[i].icon) {
                    if (Array.isArray(extensions[i].icons)) {
                        let maxSize = Math.max(...extensions[i].icons.map(({size}) => size)),
                            {url} = extensions[i].icons.find(icon => icon.size === maxSize);

                        extensions[i].icon = url;
                    } else {
                        extensions[i].icon = 'chrome://mozapps/skin/extensions/extensionGeneric.svg';
                    }
                }

                return extensions[i];
            }
        }
    }

    window.Management = {
        init,

        isEnabled,
        getExtensionByUUID,
    };

})();
