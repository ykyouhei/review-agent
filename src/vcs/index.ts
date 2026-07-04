import { Config } from '../config/index.js';
import { CodeCommitProvider } from './codecommit/provider.js';
import { GitHubProvider } from './github/provider.js';

export interface CreateProviderOptions {
  repoPath: string;
  repository?: string;
  region?: string;
}

export function createVcsProvider(config: Config, options: CreateProviderOptions) {
  switch (config.vcs) {
    case 'codecommit': {
      const repositoryName = options.repository ?? config.codecommit.repositoryName;
      if (!repositoryName) {
        throw new Error(
          'CodeCommit repository name is required (--repo, codecommit.repositoryName in .review-agent.yml, or CI auto-detection)',
        );
      }
      return new CodeCommitProvider({
        repositoryName,
        region: options.region ?? config.codecommit.region,
        repoPath: options.repoPath,
      });
    }
    case 'github':
      return new GitHubProvider();
    case 'gitlab':
      throw new Error('The gitlab provider is not implemented yet. Use `vcs: codecommit`.');
  }
}
