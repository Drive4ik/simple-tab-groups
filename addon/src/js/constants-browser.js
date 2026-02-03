
export const MENU_ITEM_BUTTON = Object.freeze({
    LEFT: 0,
    MIDDLE: 1,
    RIGHT: 2,
});

export function getContainerIconUrl(icon) {
    return `resource://usercontext-content/${icon}.svg`;
}

export const DEFAULT_FAVICON = 'chrome://branding/content/icon32.png';
