
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
            let localGroup;

            // if first sync - add cloud group as new. This will duplicate groups, sorry ¯\_(ツ)_/¯
            // it is impossible otherwise, because the id of the group on one computer
            // and the same id on another computer do not mean the same groups
            if (localData.autoBackupCloudTimeStamp === Constants.DEFAULT_OPTIONS.autoBackupCloudTimeStamp) {
                // nevertheless, we are trying to find a group with the same name and the same id,
                // this will happen when restoring groups from a backup on different computers with data cleansing
                // (then the id of the groups are saved)
                localGroup = localGroups.find(localGroup => localGroup.id === cloudGroup.id && localGroup.title === cloudGroup.title);
            } else {
                // found local group
                localGroup = localGroups.find(localGroup => localGroup.id === cloudGroup.id);
            }

            // if not found, create it
            if (!localGroup) {
                // TODO work with group id => to random
                localGroup = {...cloudGroup};
                /* localChanges.tabsToCreate.push({
                    tabs: Groups.setNewTabsParams(localGroup.tabs, localGroup),
                    hideTabs: true,
                }); */
            }

            const resultCloudGroup = cloudGroup;
            const resultLocalGroup = localGroup;

            // const tabsToCreate = [];

            if (cloudGroup.isArchive !== resultLocalGroup.isArchive) {
                if (cloudGroup.isArchive) {
                    //
                } else if (resultLocalGroup.isArchive) {
                    //
                }
            } else if (cloudGroup.isArchive && resultLocalGroup.isArchive) {
                //
            } else if (!cloudGroup.isArchive && !resultLocalGroup.isArchive) {
                const resultCloudTabs = cloudGroup.tabs;
                const resultLocalTabs = [];

                cloudGroup.tabs.forEach(cloudTab => {
                    let localTab = resultLocalGroup.tabs.find(localTab => {
                        if (resultLocalTabs.includes(localTab)) {
                            return false;
                        }

                        if (localTab.url !== cloudTab.url) {
                            return false;
                        }

                        // temporary containers must be different beetween different computers
                        if (Containers.isTemporary(localTab.cookieStoreId)) {
                            return cloudTab.cookieStoreId === Constants.TEMPORARY_CONTAINER;
                        }

                        // if cloudTab.cookieStoreId is temp - always return false
                        return cloudTab.cookieStoreId === localTab.cookieStoreId;
                    });

                    localTab ??= {...cloudTab, new: true};

                    resultLocalTabs.push(localTab);
                });

                resultLocalGroup.tabs.forEach((localTab, localTabIndex) => {
                    if (resultLocalTabs.includes(localTab)) {
                        return;
                    }

                    // decide which tabs to delete locally and which to keep and add to the cloud

                    // if tab has sync id equal with last local sync id
                    // delete the tab, it was already in the cloud and on another computer
                    if (localTab.syncId === localData.autoBackupCloudTimeStamp) {
                        localTabsToRemove.add(localTab);
                    } else if (!localTab.syncId) {
                        // if a tab has no sync id, it means it has not yet been in the cloud and on another computer
                        // i.e. it is new. leave it and add it to the cloud

                        // it may be necessary to check in the future if the insertion position can be improved
                        resultCloudTabs.splice(localTabIndex, 0, localTab);
                        resultLocalTabs.splice(localTabIndex, 0, localTab);
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
