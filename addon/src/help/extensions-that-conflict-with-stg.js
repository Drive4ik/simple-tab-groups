
import './translate-help-pages.js';

import * as Constants from '/js/constants.js';
import * as Management from '/js/management.js';

const $ = window.document.querySelector.bind(window.document);

function createExtensionBlock(ext) {
    const img = document.createElement('img');
    // img.addEventListener('error', () => img.remove())
    // img.src = Management.getExtensionIcon(ext); // can't have permission to read other addon icon :((
    img.src = '/icons/extension-generic.svg';

    const text = document.createElement('span');
    text.innerText = ext.name;

    const ignoredText = document.createElement('em');
    ignoredText.classList.add('ignored-text');
    ignoredText.classList.add('hidden');
    ignoredText.innerText = browser.i18n.getMessage('ignoreConflictedExtIgnoredText');

    const block = document.createElement('div');
    block.classList.add('block-content');
    block.appendChild(img);
    block.appendChild(text);
    block.appendChild(ignoredText);

    const buttons = document.createElement('div');
    buttons.classList.add('block-content-buttons');

    if (ext.enabled) {
        const button = document.createElement('button');
        button.classList.add('primary');

        const setContent = () => {
            const isIgnored = Management.isIgnoredConflictedExtension(ext.id);

            if (isIgnored) {
                button.innerText = browser.i18n.getMessage('ignoreConflictedExtDontIgnore');
            } else {
                button.innerText = browser.i18n.getMessage('ignoreConflictedExtIgnore');
            }

            ignoredText.classList.toggle('hidden', !isIgnored);
            button.classList.toggle('danger-button', !isIgnored);
        };

        setContent(ext.id);

        button.addEventListener('click', () => {
            if (Management.isIgnoredConflictedExtension(ext.id)) {
                Management.dontIgnoreConflictedExtension(ext.id);
                setContent();
            } else if (confirm(browser.i18n.getMessage('ignoreConflictedExtConfirm'))) {
                Management.ignoreConflictedExtension(ext.id);
                setContent();
            }
        });

        buttons.appendChild(button);
    }

    if (buttons.children.length) {
        block.appendChild(buttons);
    }

    return block;
}

async function showConflictedExtensions() {
    let addons = await browser.management.getAll(),
        conflictedExtensions = addons.filter(addon => Constants.CONFLICTED_EXTENSIONS.includes(addon.id)),
        $enabledExt = $('#enabled-conflicted-extensions'),
        $disabledExt = $('#disabled-conflicted-extensions');

    if (!conflictedExtensions.some(ext => ext.enabled)) {
        let {id} = await browser.tabs.getCurrent();

        browser.tabs.remove(id);
        return;
    }

    $enabledExt.textContent = $disabledExt.textContent = '';

    conflictedExtensions.forEach(ext => {
        if (ext.enabled) {
            $enabledExt.appendChild(createExtensionBlock(ext));
        } else {
            $disabledExt.appendChild(createExtensionBlock(ext));
        }
    });
}

function init() {
    browser.management.onEnabled.addListener(showConflictedExtensions);
    browser.management.onDisabled.addListener(showConflictedExtensions);
    browser.management.onInstalled.addListener(showConflictedExtensions);
    browser.management.onUninstalled.addListener(showConflictedExtensions);

    showConflictedExtensions();

    window.addEventListener('unload', function() {
        browser.management.onEnabled.removeListener(showConflictedExtensions);
        browser.management.onDisabled.removeListener(showConflictedExtensions);
        browser.management.onInstalled.removeListener(showConflictedExtensions);
        browser.management.onUninstalled.removeListener(showConflictedExtensions);
    });
}

init();
