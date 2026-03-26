export class GitHubClient {
    // Constructor takes in octokit instance and context from
    // Github action to allow for API calls to GitHub
    constructor(octokit, context) {
        this.octokit = octokit;
        this.context = context;
    }

    // Getter for getting repo owner from the context
    get repoOwner() {
        return this.context.repo.owner;
    }

    // Getter for getting repo name from the context
    get repoName() {
        return this.context.repo.repo;
    }

    // Getter for getting pull request number from the context
    get prNumber() {
        return this.context.payload.pull_request?.number;
    }

    // Private function to check that pull request number is available
    // in the context (needed for a lot of the API calls)
    #ensurePullRequest() {
        // If no PR number found in context, throw error
        if (!this.prNumber) {
            throw new Error('No pull_request in context');
        }
    }

    // Private function to get pull request data
    async #fetchPullRequest(extraOptions = {}) {
        // First ensure PR number is available
        this.#ensurePullRequest();

        // API call to get the pull request data
        const { data } = await this.octokit.rest.pulls.get({
            owner: this.repoOwner,
            repo: this.repoName,
            pull_number: this.prNumber,
            ...extraOptions,
        });

        // Return API response data
        return data;
    }

    // Public function which uses the private function to get the
    // pull request information
    async getPullRequest() {
        return this.#fetchPullRequest();
    }

    // Public function to get the pull request diff
    // Note use of the mediaType option for specifying that diff is wanted
    async getPullRequestDiff() {
        return this.#fetchPullRequest({ mediaType: { format: 'diff' } });
    }

    // Public function to get the base ref of the pull request
    // Used for getting correct file versions
    async getBaseRef() {
        const pr = await this.getPullRequest();
        return pr.base.ref;
    }

    // Public function to get the head ref of the pull request
    // Used for getting latest commit message and checking for file existence
    async getHeadRef() {
        const pr = await this.getPullRequest();
        return pr.head.sha;
    }

    // Public function to get the content of a file for a given ref (branch or commit)
    async getFileContent(path, ref) {
        try {
            // Try API call for the file path
            const { data } = await this.octokit.rest.repos.getContent({
                owner: this.repoOwner,
                repo: this.repoName,
                path,
                ref,
            });

            // If no content found, return null
            if (!data) {
                return null;
            }

            // If content is not in the response, return null
            if (!('content' in data)) {
                return null;
            }

            // If content is empty, return null
            if (!data.content) {
                return null;
            }

            // Decode base64 response and return the content as a string
            const content = Buffer.from(data.content, 'base64').toString('utf-8');

            // Return the file path and content
            return { path, content };
        } catch (err) {
            // If 404 error, return null to indicate file doesn't exist
            if (err.status === 404) {
                return null;
            }

            // Otherwise, throw the error to be handled
            throw err;
        }
    }

    // Public function to get the latest commit message on the pull request
    async getLatestCommitMessage() {
        // First ensure PR number is available
        this.#ensurePullRequest();

        // List commits but only fetch the latest one
        const { data: commits } = await this.octokit.rest.pulls.listCommits({
            owner: this.repoOwner,
            repo: this.repoName,
            pull_number: this.prNumber,
            per_page: 1,
        });

        // If no commits found, return empty string
        if (commits.length === 0) return '';

        // Return latest commit message
        return commits[commits.length - 1].commit.message;
    }

    // Public function to check if a file exists on the pull request branch
    async fileExistsOnBranch(filePath) {
        // First ensure PR number is available
        this.#ensurePullRequest();

        // Check if file path exists on the pull request ref
        const pullRequest = await this.getPullRequest();
        try {
            // Try get file content for passed file path
            await this.octokit.rest.repos.getContent({
                owner: this.repoOwner,
                repo: this.repoName,
                path: filePath,
                ref: pullRequest.head.ref,
            });

            // If successfull, then it already exists
            return true;
        } catch (err) {
            // If 404, the file doesn't exist
            if (err.status === 404) return false;

            // If a different error, bubble it up
            throw err;
        }
    }

    // Public function that deletes a file from the pull request branch
    // Used to delete generated test file if it already exists
    // To ensure fresh tests are generated on each commit
    async deleteFile(filePath, message) {
        // First ensure PR number is available
        this.#ensurePullRequest();

        // Get pull request info for the branch name
        const pullRequest = await this.getPullRequest();
        const branch = pullRequest.head.ref;

        // Get the file's SHA
        const { data } = await this.octokit.rest.repos.getContent({
            owner: this.repoOwner,
            repo: this.repoName,
            path: filePath,
            ref: branch,
        });

        // Delete the file via the GitHub API
        await this.octokit.rest.repos.deleteFile({
            owner: this.repoOwner,
            repo: this.repoName,
            path: filePath,
            message,
            sha: data.sha,
            branch,
        });
    }

    // Public function to create or update a file on the pull request branch with the passed content and commit message
    async createOrUpdateFile(filePath, content, message) {
        // First ensure PR number is available
        this.#ensurePullRequest();

        // Get pull request info
        const pullRequest = await this.getPullRequest();

        // Extract branch name from pull request info
        const branch = pullRequest.head.ref;

        // Default to existing sha as null for new files
        let existingSha = null;
        try {
            // Check if the file already exists
            const { data } = await this.octokit.rest.repos.getContent({
                owner: this.repoOwner,
                repo: this.repoName,
                path: filePath,
                ref: branch,
            });
            // If it does, store the sha ref for the update
            existingSha = data.sha;
        } catch (err) {
            // If 404, file doesn't exist, proceed with creation of the file
            if (err.status !== 404) throw err;
        }

        // Define parameters for hte createOrUpdateFile API call
        const params = {
            owner: this.repoOwner,
            repo: this.repoName,
            path: filePath,
            message,
            content: Buffer.from(content).toString('base64'),
            branch,
        };

        // If existing file, include the sha of the file within the params
        if (existingSha) {
            params.sha = existingSha;
        }

        // Make API call to create or update the file on the current branch
        const { data } = await this.octokit.rest.repos.createOrUpdateFileContents(params);

        // Return data response from the API
        return data;
    }

    // Public function to create a review on the pull request with the passed body content and event type (defaults to comment)
    async createReview(body, event = 'COMMENT') {
        // First ensure PR number is available
        this.#ensurePullRequest();

        // API call to create review on the pull request
        // with the passed body and event type which defaults to comment
        await this.octokit.rest.pulls.createReview({
            owner: this.repoOwner,
            repo: this.repoName,
            pull_number: this.prNumber,
            body,
            event,
        });
    }

    // Public function to find a file in the repository by name and return its path if found
    async findFileByName(fileName) {
        // Construct search query for the GitHub code search API
        const query = `filename:${fileName} repo:${this.repoOwner}/${this.repoName}`;

        // API call to search for code matching the query
        const { data } = await this.octokit.rest.search.code({ q: query });

        // Return the path of the first matching file, or null if no matches found
        return data.items.length > 0 ? data.items[0].path : null;
    }
}
