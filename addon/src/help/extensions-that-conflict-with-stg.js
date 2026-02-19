
import Lang from '/js/lang.js?translate-page';
import * as Extensions from '/js/extensions.js';

const $ = window.document.querySelector.bind(window.document);

function createExtensionBlock(ext) {
    const img = document.createElement('img');
    img.src = '/icons/extension-generic.svg';
    Extensions.loadIconUrl(ext.id, img.src).then(icon => img.src = icon);

    const text = document.createElement('span');
    text.innerText = ext.name;

    const ignoredText = document.createElement('em');
    ignoredText.classList.add('ignored-text');
    ignoredText.classList.add('hidden');
    ignoredText.innerText = Lang('ignoreConflictedExtIgnoredText');

    const block = document.createElement('div');
    block.classList.add('block-content');
    block.appendChild(img);
    block.appendChild(text);
    block.appendChild(ignoredText);

    const buttons = document.createElement('div');
    buttons.classList.add('block-content-buttons');

    if (Extensions.isEnabled(ext.id)) {
        const button = document.createElement('button');
        button.classList.add('primary');

        const setContent = () => {
            const isIgnored = Extensions.isIgnoredConflicted(ext.id);

            if (isIgnored) {
                button.innerText = Lang('ignoreConflictedExtDontIgnore');
            } else {
                button.innerText = Lang('ignoreConflictedExtIgnore');
            }

            ignoredText.classList.toggle('hidden', !isIgnored);
            button.classList.toggle('danger-button', !isIgnored);
        };

        setContent();

        button.addEventListener('click', () => {
            if (Extensions.isIgnoredConflicted(ext.id)) {
                Extensions.dontIgnoreConflicted(ext.id);
                setContent();
            } else if (confirm(Lang('ignoreConflictedExtConfirm'))) {
                Extensions.ignoreConflicted(ext.id);
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
    const conflictedExtensions = Extensions.getConflicted();

    if (!conflictedExtensions.some(ext => Extensions.isEnabled(ext.id))) {
        window.close();
        return;
    }

    const $enabledExt = $('#enabled-conflicted-extensions');
    const $disabledExt = $('#disabled-conflicted-extensions');

    $enabledExt.textContent = $disabledExt.textContent = '';

    for (const ext of conflictedExtensions) {
        const block = createExtensionBlock(ext);

        if (Extensions.isEnabled(ext.id)) {
            $enabledExt.appendChild(block);
        } else {
            $disabledExt.appendChild(block);
        }
    }
}

Extensions.onChanged(showConflictedExtensions);

showConflictedExtensions();
