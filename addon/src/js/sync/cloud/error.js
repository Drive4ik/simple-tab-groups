import Logger from '/js/logger.js';
import Lang from '/js/lang.js';

const logger = new Logger('CloudError');

// ! Be careful: "instanceof" doesn't work in different contexts (cloud.js?can-do-synchronization) -
// the contract lives on the fields, inheritance only shares this constructor.
// The base error of every sync backend: the backend classifies its own failures and throws
// a subclass carrying langId with ready langArgs, temporary (the sync is worth retrying)
// and retryAfter (when) - the translation happens once, here
export default class CloudError extends Error {
    constructor(langId, {langArgs = [], temporary = false, retryAfter = null, message: rawMessage, cause} = {}) {
        const key = langId ?? rawMessage;

        logger.error(key);

        const message = Lang(key, langArgs) || key;

        super(message, {cause});

        this.name = 'CloudError';
        this.langId = key === message ? null : key;
        this.temporary = temporary;
        this.retryAfter = retryAfter;
    }
}
