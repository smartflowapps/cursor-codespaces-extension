import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { parse, modify, applyEdits, ParseError, printParseErrorCode } from 'jsonc-parser';
import { GhService, Codespace } from './ghService';

const execAsync = promisify(exec);

export class DevcontainerFixer {
	private static instance: DevcontainerFixer;

	private constructor() {}

	public static getInstance(): DevcontainerFixer {
		if (!DevcontainerFixer.instance) {
			DevcontainerFixer.instance = new DevcontainerFixer();
		}
		return DevcontainerFixer.instance;
	}

	/**
	 * Find an open workspace folder whose git `origin` remote matches the codespace's
	 * repository (owner/repo). Falls back to checking the folder's basename. Returns
	 * undefined if nothing matches — the caller should then refuse to write.
	 */
	private async findMatchingWorkspaceFolder(
		codespaceRepository: string
	): Promise<vscode.WorkspaceFolder | undefined> {
		const folders = vscode.workspace.workspaceFolders;
		if (!folders || folders.length === 0) {
			return undefined;
		}

		const expectedRepoName = codespaceRepository.split('/')[1]?.toLowerCase();
		const expectedFull = codespaceRepository.toLowerCase();

		for (const folder of folders) {
			try {
				const { stdout } = await execAsync('git remote get-url origin', {
					cwd: folder.uri.fsPath,
					encoding: 'utf-8',
					shell: process.platform === 'win32' ? undefined : '/bin/sh'
				});
				const url = stdout.trim().toLowerCase();
				// Match either git@github.com:owner/repo(.git) or https://github.com/owner/repo(.git)
				const match = url.match(/[/:]([^/:]+)\/([^/]+?)(?:\.git)?$/);
				if (match) {
					const fullName = `${match[1]}/${match[2]}`;
					if (fullName === expectedFull) {
						return folder;
					}
				}
			} catch {
				// not a git repo, or no origin — fall through to name check
			}

			if (expectedRepoName && path.basename(folder.uri.fsPath).toLowerCase() === expectedRepoName) {
				return folder;
			}
		}

		return undefined;
	}

	/**
	 * Offer to fix SSHD configuration in devcontainer.json for a specific codespace.
	 * The fix is purely local — the user must commit, push, and rebuild for it to
	 * affect the running codespace. We surface those steps explicitly and offer to
	 * trigger the rebuild ourselves.
	 */
	async offerSshdFix(codespace: Codespace): Promise<void> {
		const action = await vscode.window.showWarningMessage(
			`SSHD is not configured in the codespace for "${codespace.repository}". ` +
				'The fix requires editing devcontainer.json, committing & pushing, then rebuilding the codespace. Continue?',
			{ modal: true },
			'Fix Devcontainer'
		);

		if (action !== 'Fix Devcontainer') {
			return;
		}

		// Locate the matching workspace folder — refuse to write into an unrelated repo.
		const folder = await this.findMatchingWorkspaceFolder(codespace.repository);
		if (!folder) {
			const open = await vscode.window.showErrorMessage(
				`No open workspace folder matches "${codespace.repository}". ` +
					'Open that repo locally first so the devcontainer change goes to the right place.',
				'Open Folder...'
			);
			if (open === 'Open Folder...') {
				await vscode.commands.executeCommand('vscode.openFolder');
			}
			return;
		}

		const devcontainerPath = path.join(folder.uri.fsPath, '.devcontainer', 'devcontainer.json');
		const fileExisted = fs.existsSync(devcontainerPath);

		try {
			if (!fileExisted) {
				const devcontainerDir = path.dirname(devcontainerPath);
				if (!fs.existsSync(devcontainerDir)) {
					fs.mkdirSync(devcontainerDir, { recursive: true });
				}

				const basicConfig = {
					image: 'mcr.microsoft.com/devcontainers/base:ubuntu',
					features: {
						'ghcr.io/devcontainers/features/sshd:1': {}
					}
				};

				fs.writeFileSync(devcontainerPath, JSON.stringify(basicConfig, null, 2), 'utf-8');
			} else {
				const content = fs.readFileSync(devcontainerPath, 'utf-8');
				const errors: ParseError[] = [];
				const config = parse(content, errors, { allowTrailingComma: true });

				if (errors.length > 0) {
					const summary = errors
						.map(e => `${printParseErrorCode(e.error)} at offset ${e.offset}`)
						.join('; ');
					throw new Error(`devcontainer.json is not valid JSONC: ${summary}`);
				}

				if (config?.features && config.features['ghcr.io/devcontainers/features/sshd:1']) {
					// Already configured locally — the codespace just hasn't been rebuilt with it yet.
					await this.promptCommitAndRebuild(codespace, devcontainerPath, true);
					return;
				}

				const formattingOptions = { tabSize: 2, insertSpaces: true, eol: '\n' };
				const edits = modify(
					content,
					['features', 'ghcr.io/devcontainers/features/sshd:1'],
					{},
					{ formattingOptions }
				);
				const updated = applyEdits(content, edits);
				fs.writeFileSync(devcontainerPath, updated, 'utf-8');
			}

			const document = await vscode.workspace.openTextDocument(devcontainerPath);
			await vscode.window.showTextDocument(document);

			await this.promptCommitAndRebuild(codespace, devcontainerPath, false);
		} catch (error: any) {
			await vscode.window.showErrorMessage(
				`Failed to update devcontainer.json: ${error.message}`
			);
		}
	}

	/**
	 * Walk the user through the remaining manual steps (commit + push) and then
	 * trigger a rebuild via `gh codespace rebuild`.
	 */
	private async promptCommitAndRebuild(
		codespace: Codespace,
		devcontainerPath: string,
		alreadyConfigured: boolean
	): Promise<void> {
		const headline = alreadyConfigured
			? `SSHD is already in ${path.basename(devcontainerPath)} locally, but the codespace hasn't been rebuilt with it.`
			: `Added SSHD feature to ${path.basename(devcontainerPath)}.`;

		const action = await vscode.window.showInformationMessage(
			`${headline}\n\nNext: commit & push the change to "${codespace.repository}", then rebuild the codespace so the new feature is installed. ` +
				'Connecting before the rebuild completes will time out.',
			{ modal: true },
			'I\'ve pushed — Rebuild now',
			'Show me how'
		);

		if (action === 'Show me how') {
			await vscode.window.showInformationMessage(
				'Run these in the workspace, then re-open this dialog and click "Rebuild now":\n\n' +
					'  git add .devcontainer/devcontainer.json\n' +
					'  git commit -m "Add sshd devcontainer feature"\n' +
					'  git push\n\n' +
					'After the rebuild finishes, try connecting again.',
				{ modal: true }
			);
			return;
		}

		if (action !== 'I\'ve pushed — Rebuild now') {
			return;
		}

		try {
			await vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: 'Rebuilding codespace (this can take a few minutes)...',
					cancellable: false
				},
				async () => {
					await GhService.getInstance().rebuildCodespace(codespace.name);
				}
			);
			await vscode.window.showInformationMessage(
				'Rebuild started. Wait for the codespace to return to "Available" in the explorer, then try connecting again.'
			);
		} catch (error: any) {
			await vscode.window.showErrorMessage(
				`Failed to start rebuild: ${error.message}. You can rebuild from github.com instead.`
			);
		}
	}
}
