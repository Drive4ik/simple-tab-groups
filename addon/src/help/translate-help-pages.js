
const INNER_HTML = 'innerHTML';

const LINK_REGEXP = /<a\s+([^=>\s]+)\s*>\s*([^<>]+)\s*<\/a\s*>/gm;

// TODO move it to lang.js
export function replaceLinks(langId, message, data) {
    return message.replace(LINK_REGEXP, (match, key, str) => {
        !data[key] && alert(`not found "${key}" link into lang "${langId}"`);

        const attrs = Object.entries(data[key]).map(([attr, value]) => `${attr}="${value}"`).join(' ');
        return `<a ${attrs}>${str}</a>`;
    });
}

document.querySelectorAll('[data-i18n-id]').forEach(node => {
    let message = browser.i18n.getMessage(node.dataset.i18nId);

    const linksData = {};

    for (const attr of node.attributes) {
        if (attr.name.startsWith('data-i18n-link')) {
            const [linkName, linkAttr] = attr.name.split('-').slice(3);
            linksData[linkName] ??= {};
            linksData[linkName][linkAttr] = attr.value;
        }
    }

    message = replaceLinks(node.dataset.i18nId, message, linksData);

    node[INNER_HTML] = message;
});
