
export default new Map([
    ['browser', () => browser],
    ['tabs', () => import('./tabs.js')],
    ['windows', () => import('./windows.js')],
    ['groups', () => import('./groups.js')],
    ['menus-main', () => import('./menus-main.js')],
    ['menus-tab', () => import('./menus-tab.js')],
    ['menus-link', () => import('./menus-link.js')],
    ['menus-bookmark', () => import('./menus-bookmark.js')],
]);
