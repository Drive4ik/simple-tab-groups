
import * as Constants from './constants.js';

export const MENU_ITEM_BUTTON = Object.freeze({
    LEFT: 0,
    MIDDLE: 1,
    RIGHT: 2,
});

export const MenusContextType = {
    ...browser.menus.ContextType,
    ACTION: Constants.MANIFEST.manifest_version === 3
        ? browser.menus.ContextType.ACTION
        : browser.menus.ContextType.BROWSER_ACTION,
};
export const MenusItemType = browser.menus.ItemType;

export function getContainerIconUrl(icon) {
    return `resource://usercontext-content/${icon}.svg`;
}

export const DEFAULT_FAVICON = 'chrome://branding/content/icon32.png';
