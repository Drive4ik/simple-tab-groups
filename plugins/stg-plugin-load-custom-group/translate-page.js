
document.querySelectorAll('[data-i18n-id]').forEach(node => {
    const translate = browser.i18n.getMessage(node.dataset.i18nId);

    if (node.dataset.i18nAttr) {
        node.setAttribute(node.dataset.i18nAttr, translate);
    } else {
        node.innerText = translate;
    }
});
