
import Logger from '/js/logger.js';
import Messages from '/js/messages.js';

const logger = new Logger('sync.cloud-mixin');

const instances = new Set;

const {disconnect} = Messages.connectToBackground('sync-progress-mixin', [
    'sync-start',
    'sync-progress',
    'sync-end',
    'sync-error',
], ({action, progress, message}) => {
    logger.log(action, progress, message);

    instances.forEach(instance => instance.$emit(action, {progress, message}));
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
    created() {
        instances.add(this);

        this
            .$on(['sync-start', 'sync-progress', 'sync-end', 'sync-error'], () => {
                clearTimeout(this.clearProgressTimer);
            })
            .$on('sync-start', () => {
                this.synchronisationError = '';
                this.synchronisationInProgress = true;
            })
            .$on('sync-progress', ({progress}) => {
                this.synchronisationProgress = progress;
                this.synchronisationInProgress = true;
            })
            .$on('sync-end', () => {
                this.synchronisationInProgress = false;
                this.$emit('sync-finish');
            })
            .$on('sync-error', ({message}) => {
                this.synchronisationError = message;
                this.synchronisationInProgress = false;
                this.clearProgressTimer = setTimeout(() => this.synchronisationProgress = 0, 5000);
                this.$emit('sync-finish');
            });
    },
    methods: {
        async syncCloud() {
            return await Messages.sendMessageModule('BG.cloudSync');
        },
    },
}
