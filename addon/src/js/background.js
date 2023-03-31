
import * as Constants from './constants.js';

let backgroundSelf;

if (Constants.IS_BACKGROUND_PAGE) {
    backgroundSelf = self;
} else {
    backgroundSelf = await browser.extension.getBackgroundPage();
}

export default backgroundSelf;
