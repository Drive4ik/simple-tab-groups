
// import * as Constants from '/js/constants.js';
import Logger from '/js/logger.js';
import Messages from '/js/messages.js';
// import * as Storage from '/js/storage.js';
// import * as Groups from '/js/groups.js';
// import * as Utils from '/js/utils.js';
// import * as Cache from '/js/cache.js';
// import JSON from '/js/json.js';
// import * as SyncStorage from '/js/sync/sync-storage.js';
// import {GithubGist, syncData} from '/js/sync/cloud/cloud.js';

const logger = new Logger('cloud mixin');

export default {
    // data() {
    //     return {
    //         openEditDefaultGroup: false,
    //     };
    // },
    methods: {
        async syncCloud() {
            // const log = logger.start('sync button');
            console.clear();
            let res2 = await Messages.sendMessageModule('BG.cloudSync');
            console.debug('res2', res2);
            // const result = [];
            // console.time('cloud');
            // const syncOptions = await SyncStorage.get();
            // const GithubGistCloud = new GithubGist(syncOptions.githubGistToken, syncOptions.githubGistFileName, syncOptions.githubGistId);
            // console.debug(await GithubGistCloud.findGistId());
            // let localData = await Storage.get();
            // let {groups} = await Groups.load(null, true);
            // // const allTabs = Utils.concatTabs(groups);
            // // await Promise.all(allTabs.map(tab => browser.sessions.setTabValue(tab.id, 'syncId', 16879931)))
            // // console.debug('finish')
            // // return;
            // console.debug('groups:', groups);
            // localData.groups = groups;
            // let cloud = await GithubGistCloud.getGist();
            // let cloudData = JSON.parse(cloud.content);
            // console.debug('cloudData:', JSON.clone(cloudData));
            // console.debug('before', JSON.clone(localData.groups), JSON.clone(cloudData.groups));
            // await syncData(localData, cloudData);
            // console.debug('after', localData.groups, cloudData.groups);
            // const result = await GitHub.findFileId(localStorage.token, 'STG-backup.json')
            // let id = await github.foundStgGistId();
            // let data = await github.getGist();
            // let createdata = await github.createGist(utils.stringify({
            //     aaa: 123,
            //     bbb: [1, '3', '@'],
            // }, 2));
            // let result = await github.updateGist(utils.stringify({
            //     aaa: 123,
            //     bbb: [2, '4', '99999'],
            // }, 2));

            // console.debug('gist id', id)
            // console.debug('get gist data', data)
            // console.debug('create gist data', createdata)
            // console.timeEnd('cloud');
            // console.debug('gist result', result)
        },
    },
}
