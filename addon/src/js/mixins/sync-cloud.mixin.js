
import Logger from '/js/logger.js';
import Messages from '/js/messages.js';

const logger = new Logger('sync.cloud-mixin');

let instance,
    clearProgressTimer;

const {disconnect} = Messages.connectToBackground('sync-progress-mixin', [
    'sync-start',
    'sync-progress',
    'sync-end',
    'sync-error',
], ({action, progress, message}) => {
    logger.assert(instance, 'instance of vue not found');
    logger.log(action, progress, message);

    if (!instance) {
        return;
    }

    clearTimeout(clearProgressTimer);

    if (action === 'sync-start') {
        instance.synchronisationError = '';
        instance.synchronisationInProgress = true;
    } if (action === 'sync-progress') {
        instance.synchronisationProgress = progress;
        instance.synchronisationInProgress = true;
    } else if (action === 'sync-end') {
        // instance.synchronisationError = '';
        instance.synchronisationInProgress = false;
    } else if (action === 'sync-error') {
        instance.synchronisationError = message;
        instance.synchronisationInProgress = false;
        clearProgressTimer = setTimeout(() => instance.synchronisationProgress = 0, 5000);
    }
});

window.addEventListener('unload', disconnect);

export default {
    data() {
        return {
            synchronisationInProgress: false,
            synchronisationProgress: 0,
            synchronisationError: '',
        };
    },
    methods: {
        async syncCloud() {
            instance = this;
            await Messages.sendMessageModule('BG.cloudSync');
        },
    },
}
