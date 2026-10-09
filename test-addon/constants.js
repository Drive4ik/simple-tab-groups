export const TAB_GROUP_ID_NONE = -1;
export const SQUARES = ['🟥', '🟩', '🟦', '🟨', '🟪', '⬛'];
export const SCENE_URL = browser.runtime.getURL('tab.html');
export const NAVIGATE_URL = browser.runtime.getURL('navigate.html');
export const MANAGEMENT_URL = browser.runtime.getURL('management.html');
export const SENDER_URL = browser.runtime.getURL('sender.html');
export const CONTENT_SCRIPT_URL = browser.runtime.getManifest().content_scripts[0].matches[0].slice(0, -1);
export const NETWORK_URL = 'https://example.com/';
export const READER_URL = 'https://en.wikipedia.org/wiki/Main_Page';
export const NEW_TAB_POSITIONS = ['atEnd', 'afterCurrent', 'relatedAfterCurrent'];

export const SETTING_WAIT = 100;
export const QUIET_WAIT = 200;
export const OTHER_ADDON_WAIT = 2000;
export const POLL_WAIT = 250;
export const TIGHT_POLL_WAIT = 25;
export const ACTION_WAIT = 500;
export const HOLD_WAIT = 500;
export const WINDOW_READ_WAIT = 1000;
export const MANAGEMENT_READ_WAIT = 50;
export const BACKGROUND_TAB_TIMER = 1000;
export const LOAD_WAIT = 2000;
export const SETTLE_TIMEOUT = 20000;
export const BATCH_GAP = 1500;

export const TABS_CREATE_URL_LIMIT = 1048572;

export const BOOKMARKS_PARENT_ID = 'unfiled_____';
export const BOOKMARKS_FOLDER = 'stg-behavior-tests';

export const NOISY_UPDATE_KEYS =['status', 'url', 'title', 'favIconUrl', 'isArticle', 'audible', 'attention'];

export const ROUNDS = ['round-01', 'round-02', 'round-03', 'round-04', 'round-05', 'round-06', 'round-07', 'round-08', 'round-09', 'round-10', 'round-11', 'round-12', 'round-13', 'round-14', 'round-15', 'round-16', 'round-18', 'round-19', 'round-20', 'round-21', 'round-22', 'round-23', 'round-24', 'round-25', 'round-26', 'round-27', 'round-29', 'round-30', 'round-31'];

export const RUN_KEY = 'testRun';
export const LOGS_KEY = 'testLogs';
