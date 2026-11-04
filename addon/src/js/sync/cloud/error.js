import Logger from '/js/logger.js';
import Lang from '/js/lang.js';

const logger = new Logger('CloudError');

// ! Be careful: "instanceof" doesn't work in different contexts (cloud.js?can-do-synchronization) -
// the contract lives on the fields, inheritance only shares this constructor.
// The base error of every sync backend: the backend classifies its own failures and throws
// a subclass carrying lang with ready langArgs, temporary (the sync is worth retrying),
// retryAfter (when) and expected (a refusal, not a defect: written as warn) - the translation happens once, here
export default class CloudError extends Error {
    constructor(lang, {
        langArgs = [],
        message: rawMessage,
        temporary = false,
        expected = temporary,
        retryAfter = null,
        cause,
    } = {}) {
        const key = lang ?? rawMessage;
        const message = Lang(key, langArgs) || key;

        super(message, {cause});

        this.name = 'CloudError';
        this.lang = lang ?? undefined;
        this.temporary = temporary;
        this.retryAfter = retryAfter;

        logger[expected ? 'warn' : 'error'](key, this);
    }
}
