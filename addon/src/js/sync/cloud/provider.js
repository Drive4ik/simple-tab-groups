
import GithubGist from './githubgist.js';

export const PROVIDER_GITHUB_GIST = 'github-gist';

export function createCloudProvider(providerType, syncOptions) {
    switch (providerType) {
        case PROVIDER_GITHUB_GIST:
        default:
            return new GithubGist(
                syncOptions.githubGistToken,
                syncOptions.githubGistFileName,
                syncOptions.githubGistName
            );
    }
}
