import { execSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as core from '@actions/core';

export class TestRunnerService {
    // This service handles writing generated test code
    // running tests, etc.
    constructor(config) {
        // App directory is where action writes the generated test file
        // Install command is what should be used to install dependencies
        // Dev server command is command to actually start the app
        // Test output path is where generated test file is written
        // Dev server process is stored here so it can be accessed and stopped after tests
        this.appDirectory = config.appDirectory;
        this.installCommand = config.installCommand;
        this.devServerCommand = config.devServerCommand;
        this.devServerUrl = config.devServerUrl;
        this.testOutputPath = config.testOutputPath;
        this.devServerProcess = null;
    }

    // Public function to write the generated test code to disk at the specified output path
    writeTestFile(testCode) {
        // Construct file path for the generated test file
        const fullPath = path.resolve(this.appDirectory, this.testOutputPath);

        // Directory may not exist for the above path
        const directory = path.dirname(fullPath);

        // If it doesn't exist, create it
        if (!fs.existsSync(directory)) {
            fs.mkdirSync(directory, { recursive: true });
        }

        // Write generated test code to the file at the path
        fs.writeFileSync(fullPath, testCode, 'utf-8');

        // Log for debuggin
        core.info(`Wrote generated test to ${fullPath}`);

        // Return the full path where the test file was written
        return fullPath;
    }

    // Public function to install required dependencies for
    // running the app
    installDependencies() {
        // Log for debugging
        core.info(`Running: ${this.installCommand}`);

        // Execute the provided install commmand
        // In a subprocess
        execSync(this.installCommand, {
            cwd: this.appDirectory,
            stdio: 'inherit',
            timeout: 300000,
        });

        // Log for debugging
        core.info('Dependencies installed');
    }

    // Public function to install Playwright browsers
    installPlaywrightBrowsers() {
        // Log for debugging
        core.info('Installing Playwright Chromium browser');

        // Execute the Playwright install command in a subprocess
        execSync('npx playwright install chromium', {
            cwd: this.appDirectory,
            stdio: 'inherit',
            timeout: 300000,
        });

        // Log for debugging
        core.info('Playwright browsers installed');
    }

    // Public function to start the dev server in a subprocess and wait for it to be ready before returning
    async startDevServer() {
        // Log for debugging
        core.info(`Starting dev server: ${this.devServerCommand}`);

        // Start the dev server in a subprocess
        const [command, ...args] = this.devServerCommand.split(' ');
        this.devServerProcess = spawn(command, args, {
            cwd: this.appDirectory,
            stdio: 'pipe',
            shell: true,
            detached: true,
        });

        // Keep track and log the output from dev server
        // for debugging
        this.devServerProcess.stdout.on('data', (data) => {
            core.info(`[dev-server] ${data.toString().trim()}`);
        });

        // Also log standard error in case there are issues
        this.devServerProcess.stderr.on('data', (data) => {
            core.info(`[dev-server:err] ${data.toString().trim()}`);
        });

        // Log if error thrown when starting the process for the dev server
        this.devServerProcess.on('error', (err) => {
            core.warning(`Dev server error: ${err.message}`);
        });

        // Wait for the server to be ready before returning
        await this.waitForServer();
        core.info('Dev server is ready');
    }

    // Helper function to poll the dev server URL until it responds or timeout is reached
    async waitForServer(maxRetries = 30, intervalMs = 2000) {
        // Dynamically import axios here to avoid including it in the bundle for the rest of the service functions
        const { default: axios } = await import('axios');

        // Loop and try to make a request to the dev server until it responds or max number of retries reached
        for (let i = 0; i < maxRetries; i++) {
            try {
                // Simple request to the dev server
                await axios.get(this.devServerUrl, { timeout: 2000 });

                // If successful, return
                return;
            } catch {
                // If request fails, wait for the specified interval before trying again
                if (i === maxRetries - 1) {
                    throw new Error(
                        `Dev server at ${this.devServerUrl} did not respond after ${(maxRetries * intervalMs) / 1000}s`
                    );
                }
                // Use a promise to delay the next retry
                await new Promise((r) => setTimeout(r, intervalMs));
            }
        }
    }

    // Public function to run the generated tests using Playwright Test and return the results
    runTests() {
        // Construct the path to the generated test file
        const testFile = path.resolve(this.appDirectory, this.testOutputPath);

        // Get the path relative to app directory
        const relativeTestFile = path.relative(this.appDirectory, testFile);

        // Log for debugging
        core.info(`Running: npx playwright test ${relativeTestFile}`);

        try {
            // Execute the Playwright test command in a subprocess and capture the output
            const output = execSync(`npx playwright test ${relativeTestFile} --reporter=list`, {
                cwd: this.appDirectory,
                encoding: 'utf-8',
                timeout: 300000,
                env: {
                    ...process.env,
                    CI: 'true',
                },
            });

            // If successful, return that tests passed along with the output
            return {
                passed: true,
                exitCode: 0,
                output: output,
            };
        } catch (err) {
            // Otherwise, return that tests failed along with the output and error code
            return {
                passed: false,
                exitCode: err.status || 1,
                output: (err.stdout || '') + '\n' + (err.stderr || ''),
            };
        }
    }

    // Public function to clean up after tests are run by killing the dev server and removing the generated test file
    cleanup() {
        // Remove the generated test file
        const fullPath = path.resolve(this.appDirectory, this.testOutputPath);
        if (fs.existsSync(fullPath)) {
            fs.unlinkSync(fullPath);
            core.info(`Cleaned up ${fullPath}`);
        }

        // Kill the process running the dev server
        if (this.devServerProcess) {
            try {
                process.kill(-this.devServerProcess.pid, 'SIGTERM');
            } catch {
                // Process may already be dead here so silently swallow this
            }

            // Set the dev server process to null after killing to clean up reference
            this.devServerProcess = null;

            // Log for debugging
            core.info('Dev server stopped');
        }
    }
}
