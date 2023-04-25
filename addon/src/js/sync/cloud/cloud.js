
import * as Constants from '/js/constants.js';
import * as Tabs from '/js/tabs.js';
import * as Groups from '/js/groups.js';
import JSON from '/js/json.js';

export {
    default as GithubGist,
} from './githubgist.js';

// const SYNC_VECTOR_EQUAL = 'equal';
// const SYNC_VECTOR_TO_CLOUD = 'to-cloud';
// const SYNC_VECTOR_TO_LOCAL = 'to-local';

const TRUTH_LOCAL = 'local';
const TRUTH_CLOUD = 'cloud';

export async function syncData(localData, cloudData = null) {
    // autoBackupCloudIncludeTabFavIcons

    self.localStorage.START_TIME ??= Date.now();

    cloudData ??= JSON.clone(localData);

    const localChanges = {
        tabsToCreate: [], // array of objects
    };

    const sourceOfTruth = cloudData.autoBackupCloudTimeStamp > localData.autoBackupCloudTimeStamp ? TRUTH_CLOUD : TRUTH_LOCAL;

    await syncGroups(localData, cloudData, sourceOfTruth, localChanges);
}

async function syncGroups(localData, cloudData, sourceOfTruth, localChanges) {
    const localGroups = localData.groups;
    const cloudGroups = cloudData.groups;

    const resultLocalGroups = [],
        resultCloudGroups = [];

    const START_TIME = +self.localStorage.START_TIME;

    if (sourceOfTruth === TRUTH_LOCAL) {
        localGroups.forEach(localGroup => {
            const resultLocalGroup = localGroup;
            const resultCloudGroup = {...localGroup}; // unlink tabs array

            if (resultCloudGroup.isArchive) {
                resultCloudGroup.tabs = resultLocalGroup.tabs.map(tab => {
                    const tabToCloud = {...tab};
                    delete tabToCloud.thumbnail;
                    delete tabToCloud.groupId; // ???? TODO check need it?
                    return tabToCloud;
                });
            } else {
                resultCloudGroup.tabs = Tabs.prepareForSave(resultLocalGroup.tabs, false, localData.autoBackupCloudIncludeTabFavIcons);
            }

            resultLocalGroups.push(resultLocalGroup);
            resultCloudGroups.push(resultCloudGroup);
        });
    } else if (sourceOfTruth === TRUTH_CLOUD) {
        const localTabsToRemove = new Set;

        cloudGroups.forEach(cloudGroup => {
            const resultCloudGroup = cloudGroup;
            let resultLocalGroup;

            // if first sync - add cloud group as new. This will duplicate groups, sorry ¯\_(ツ)_/¯
            // it is impossible otherwise, because the id of the group on one computer
            // and the same id on another computer do not mean the same groups
            if (localData.autoBackupCloudTimeStamp === Constants.DEFAULT_OPTIONS.autoBackupCloudTimeStamp) {
                // nevertheless, we are trying to find a group with the same name and the same id,
                // this will happen when restoring groups from a backup on different computers with data cleansing
                // (then the id of the groups are saved)
                resultLocalGroup = localGroups.find(localGroup => localGroup.id === cloudGroup.id && localGroup.title === cloudGroup.title);
            } else {
                // found local group
                resultLocalGroup = localGroups.find(localGroup => localGroup.id === cloudGroup.id);
            }

            // if not found, create it
            if (!resultLocalGroup) {
                // TODO work with group id => to random
                resultLocalGroup = {...cloudGroup};
                /* localChanges.tabsToCreate.push({
                    tabs: Groups.setNewTabsParams(resultLocalGroup.tabs, resultLocalGroup),
                    hideTabs: true,
                }); */
            }

            // const tabsToCreate = [];

            if (cloudGroup.isArchive !== resultLocalGroup.isArchive) {
                //
            } else if (cloudGroup.isArchive && resultLocalGroup.isArchive) {
                //
            } else if (!cloudGroup.isArchive && !resultLocalGroup.isArchive) {
                const resultLocalTabs = [];

                cloudGroup.tabs.forEach(cloudTab => {
                    let localTab = resultLocalGroup.tabs.find(localTab => {
                        if (resultLocalTabs.includes(localTab)) {
                            return false;
                        }

                        if (localTab.url !== cloudTab.url) {
                            return false;
                        }

                        if (Containers.isTemporary(localTab.cookieStoreId)) {
                            return cloudTab.cookieStoreId === Constants.TEMPORARY_CONTAINER;
                        }

                        // if cloudTab.cookieStoreId is temp - always return false
                        return cloudTab.cookieStoreId === localTab.cookieStoreId;
                    });

                    localTab ??= {...cloudTab, new: true};

                    resultLocalTabs.push(localTab);
                });

                resultLocalGroup.tabs.forEach(localTab => {
                    if (localTab.new || resultLocalTabs.includes(localTab)) {
                        return;
                    }

                    if (localTab.lastAccessed < cloudData.autoBackupCloudTimeStamp) {
                        localTabsToRemove.add(localTab);
                    } // TODO
                });

                resultLocalGroup.tabs = resultLocalTabs;
            }

            // assign group keys
            assignGroupKeys(resultCloudGroup, resultLocalGroup);
        });
    } else {
        throw Error('WTF?!');
    }

    localData.groups = resultLocalGroups;
    cloudData.groups = resultCloudGroups;

}

function assignGroupKeys(fromGroup, toGroup) {
    for (const [key, value] of Object.entries(fromGroup)) {
        if (key === 'tabs') {
            continue;
        }

        toGroup[key] = value;
    }
}

// function assignTabs(fromGroup, toGroup) {
//     const resultTabs = [];
//     fromGroup.tabs.
//     for (const [key, value] of Object.entries(fromGroup)) {
//         if (key === 'tabs') {
//             continue;
//         }

//         toGroup[key] = value;
//     }
// }
