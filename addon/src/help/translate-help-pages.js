
const INNER_HTML = 'innerHTML';

document.querySelectorAll('[i18n]').forEach(function(node) {
    node[INNER_HTML] = browser.i18n.getMessage(node.getAttribute('i18n'));
});
