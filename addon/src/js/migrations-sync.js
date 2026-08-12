
export default [/* {
    version: '7',
    remove: ['githubGistToken'],
    async migration(data) {
        if (Object.hasOwn(data, 'githubGistToken') && !Object.hasOwn(data, 'githubToken')) {
            data.githubToken = data.githubGistToken;
        }
    },
} */];
