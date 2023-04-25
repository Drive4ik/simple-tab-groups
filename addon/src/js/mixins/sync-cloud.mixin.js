
// import * as Constants from '/js/constants.js';
import Logger from '/js/logger.js';
import {GithubGist} from '/js/sync/cloud/cloud.js';

const logger = new Logger('cloud mixin');

export default {
    // data() {
    //     return {
    //         openEditDefaultGroup: false,
    //     };
    // },
    methods: {
        async syncCloud() {
            // logger.log('')
            const result = [];
            console.time('cloud');
            const GithubGistCloud = new GithubGist(localStorage.token, 'STG-backup.json');
            result.push(await GithubGistCloud.findGistId());
            result.push(await GithubGistCloud.getGist());
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
            console.timeEnd('cloud');
            console.debug('gist result', result)
        },
    },
}
