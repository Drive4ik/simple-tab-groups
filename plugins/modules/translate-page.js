
document.querySelectorAll('[data-i18n-id]').forEach(node => {
    node.innerText = browser.i18n.getMessage(node.dataset.i18nId);
});
