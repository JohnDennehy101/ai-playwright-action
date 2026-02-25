export class GitHubClient {
    constructor(octokit, context) {
        this.octokit = octokit;
        this.context = context;
    }

    get repoOwner() {
        return this.context.repo.owner;
    }

    get repoName() {
        return this.context.repo.repo;
    }

    get prNumber() {
        return this.context.payload.pull_request?.number;
    }

    #ensurePullRequest() {
        if (!this.prNumber) {
            throw new Error('No pull_request in context');
        }
    }

    async #fetchPullRequest(extraOptions = {}) {
        this.#ensurePullRequest();
        const { data } = await this.octokit.rest.pulls.get({
            owner: this.repoOwner,
            repo: this.repoName,
            pull_number: this.prNumber,
            ...extraOptions,
        });
        return data;
    }

    async getPullRequest() {
        return this.#fetchPullRequest();
    }

    async getPullRequestDiff() {
        return this.#fetchPullRequest({ mediaType: { format: 'diff' } });
    }

    async getBaseRef() {
        const pr = await this.getPullRequest();
        return pr.base.ref;
    }

    async getHeadRef() {
        const pr = await this.getPullRequest();
        return pr.head.sha;
    }

    async getFileContent(path, ref) {
        try {
            const { data } = await this.octokit.rest.repos.getContent({
                owner: this.repoOwner,
                repo: this.repoName,
                path,
                ref,
            });

            if (!data) {
                return null;
            }

            if (!('content' in data)) {
                return null;
            }

            if (!data.content) {
                return null;
            }

            const content = Buffer.from(data.content, 'base64').toString('utf-8');
            return { path, content };
        } catch (err) {
            if (err.status === 404) {
                return null;
            }

            throw err;
        }
    }

    async createComment(body) {
        if (!this.prNumber) {
            throw new Error('No pull_request in context');
        }
        await this.octokit.rest.issues.createComment({
            owner: this.repoOwner,
            repo: this.repoName,
            issue_number: this.prNumber,
            body,
        });
    }

    async findFileByName(fileName) {
        const q = `filename:${fileName} repo:${this.repoOwner}/${this.repoName}`;
        const { data } = await this.octokit.rest.search.code({ q });

        return data.items.length > 0 ? data.items[0].path : null;
    }
}