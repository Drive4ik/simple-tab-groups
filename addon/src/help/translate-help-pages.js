
const INNER_HTML = 'innerHTML';

document.querySelectorAll('[data-i18n-id]').forEach(node => {
    node[INNER_HTML] = browser.i18n.getMessage(node.dataset.i18nId);
});
