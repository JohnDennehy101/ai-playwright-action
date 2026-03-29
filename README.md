# AI Playwright Action

A custom GitHub action which uses AI models to generate Playwright E2E tests from PR diffs.

## Features

- Auto-generates Playwright tests by extracting diffs from pull requests and filtering to relevant changes
- Supports multiple providers: self-hosted GPU servers (for Hugging Face models), Hugging Face inference API, Anthropic API
- Model Context Protocol Integration (MCP) for Claude model enables the model to interactively explore the running application.
- Self-healing implemented: if generated tests fail, tries to get the model to fix itself by sending back error code and generated tests again to the model
- If generated tests run successfully, commits them to the PR as a file and posts a comment on the PR with a link to the newly added file
- Also added dry-run mode for validation of diff extraction (to limit costs for AI inferencing)

## Structure

Here are some key folders for guidance around the project

- **providers/** - LLM provider implementations (Claude, Hugging Face Inference API, self-hosted). Each provider handles the model interactions. The `ProviderFactory` selects the provider based on the value provided for `llm-host`.
- **services/** -
    - The LLMService handles prompt building, test generation, self healing functionality
    - The TestRunnerService handles Playwright test execution of generated tests, starting dev server before tests etc.
    - The ContextService handles obtaining relevant test and source files from the repo in which the action is triggered in
    - The MCPService handles MCP server connecvtions and tool calls
    - The GitHubClientService handles interactions with the GitHub API
    - The RequestService is used for external requests with retry logic in place there for reliability
- **utils/** - Helper utilities for parsing diffs, obtaining test paths, extracting test code from the generated responses, generating comment content for pull request after completion.
- **data/** - A sample of the react app and test file already there for it
- **dist/** - Contains the bundled output after the build with ESBuild. The GitHub action loads in the code from the bundle in this directory

## Using the action

Add the action within your pipeline as a job, set the following permissions in the workflow.

For a full-workflow example, see it defined in this [repo](https://github.com/JohnDennehy101/devops-atu-disruptive-devops-assignment/blob/main/.github/workflows/ai-playwright.yml)

```
contents: write
pull-requests: write
```

- Contents write needed to write the generated test code file to the PR
- Pull-Requests write needed to write a comment to the PR with the results of the action

Also make sure the repo the pipeline is used in is checked out before running this job. For example

```
- uses: actions/checkout@v5
```

### Anthropic (Sonnet)

The below triggers the action for Anthropic API (static prompt version)

```
- uses: JohnDennehy101/ai-playwright-action@main
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    llm-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
    llm-host: "claude"
    model-id: "claude-sonnet-4-20250514"
    run-tests: "true"
    app-directory: "."
    install-command: "npm ci"
    dev-server-command: "npm run dev"
    dev-server-url: "http://localhost:5173"
    test-output-path: "e2e/ai-generated.spec.ts"

```

If using claude provider, MCP can also be enabled by using the below

```
- uses: JohnDennehy101/ai-playwright-action@main
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    llm-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
    llm-host: "claude"
    model-id: "claude-sonnet-4-20250514"
    run-tests: "true"
    app-directory: "."
    install-command: "npm ci"
    dev-server-command: "npm run dev"
    dev-server-url: "http://localhost:5173"
    test-output-path: "e2e/ai-generated.spec.ts"
    mcp-servers: '{"playwright": {"command": "npx", "args": ["@playwright/mcp@latest"]}}'

```

### Hugging Face Inference API

```
- uses: JohnDennehy101/ai-playwright-action@main
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    llm-api-key: ${{ secrets.HF_TOKEN }}
    llm-host: "huggingface"
    model-id: "Qwen/Qwen2.5-Coder-7B-Instruct"
    run-tests: "true"
    app-directory: "."
    install-command: "npm ci"
    dev-server-command: "npm run dev"
    dev-server-url: "http://localhost:5173"
    test-output-path: "e2e/ai-generated.spec.ts"
```

### Self-Hosted GPU (with Hugging Face Model downloaded)

Note llm-host should be ip address where gpu is available
This was working when configured with Digital Ocean
but shortage of GPUs there recently

```
- uses: JohnDennehy101/ai-playwright-action@main
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    llm-api-key: ${{ secrets.GPU_API_KEY }}
    llm-host: "192.168.1.100"
    model-id: "Qwen/Qwen2.5-Coder-7B-Instruct"
    run-tests: "true"
    app-directory: "."
    install-command: "npm ci"
    dev-server-command: "npm run dev"
    dev-server-url: "http://localhost:5173"
    test-output-path: "e2e/ai-generated.spec.ts"
```

## Available Inputs

| Input                  | Required | Default                      | Description                                                                                 |
| ---------------------- | -------- | ---------------------------- | ------------------------------------------------------------------------------------------- |
| github-token           | Yes      | -                            | GitHub token for api access                                                                 |
| llm-api-key            | Yes      | -                            | API key for chosen API provider                                                             |
| llm-host               | Yes      | -                            | Provider identifier: `claude`, `huggingface` or server ip address                           |
| model-id               | Yes      | -                            | Model Id to use                                                                             |
| exclude-pattern        | No       | -                            | Regex pattern to exclude files from diff analysis                                           |
| include-existing-tests | No       | false                        | Whether to fetch existing test files and provide as context to model                        |
| include-source-files   | No       | false                        | Whether to fetch existing source files and provide as context to model                      |
| test-file-suffixes     | No       | .spec,.test,.e2e,.playwright | CSV list of testing naming conventions in repo (for search for tests)                       |
| test-file-roots        | No       | src,app,packages/app         | Where existing E2E test files re stored in repo                                             |
| run-tests              | No       | false                        | Whether to run generated tests within action                                                |
| app-directory          | No       | .                            | root of project                                                                             |
| install-command        | No       | npm ci                       | command to install dependencies (if running tests within action)                            |
| dev-server-command     | No       | npm run dev                  | command to start React web app (if running tests within action)                             |
| dev-server-url         | No       | http://localhost:5175        | where React web app will run (if running tests within action)                               |
| start-dev-server       | No       | true                         | Whether to start the React web app within the action                                        |
| test-output-path       | No       | e2e/ai-generated.spec.ts     | Where to write the newly generated test file                                                |
| mcp-servers            | No       | -                            | Configuration to run MCP servers (used if Claude is provider)                               |
| dry-run                | No       | false                        | If true, doesn't do AI inferencing - useful for diff validation and context retrieval piece |

## Typical Flow

- On run of the action, GitHub api used to extract the changed files and diff filtered to relevant changes
- Context gathered (source code files and any existing source test files)
- AI inferencing (calls LLM with chain-of-thought prompt with context injected into prompt)
- Then copy of the app is started locally
- Generated tests are run against this app with Playwright
- If failing, self-healing attempts to resolve (note limit to 2 to avoid infinite loop)
- Post results to the PR in a comment - if successful also commit the tests in a new file
