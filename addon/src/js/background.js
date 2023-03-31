
import * as Constants from './constants.js';

let backgroundSelf;

if (Constants.IS_BACKGROUND_PAGE) {
    backgroundSelf = self;
} else {
    backgroundSelf = browser.extension.getBackgroundPage();
}

export default backgroundSelf;
