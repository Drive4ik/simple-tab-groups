
import * as Windows from '/js/windows.js';
import * as Groups from '/js/groups.js';

export default {
    methods: {
        async startUpData(includeThumbnail) {
            const log = logger.start('startUpData', {includeThumbnail});

            const [
                windows,
                currendWindow,
                {groups},
            ] = await Promise.all([
                Windows.load(true, true, includeThumbnail),
                Windows.get(),
                Groups.load(null, true, true, includeThumbnail),
            ]);

            const unSyncTabs = windows
                .reduce((acc, win) => {
                    win.tabs.forEach(tab => !tab.groupId && acc.push(tab));
                    delete win.tabs;
                    return acc;
                }, []);

            log.stop();

            return {
                windows,
                currendWindow,
                groups,
                unSyncTabs,
            };
        }
    },
};
