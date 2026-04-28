import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { parse, modify, applyEdits, ParseError, printParseErrorCode } from 'jsonc-parser';

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
	 * Offer to fix SSHD configuration in devcontainer.json
	 */
	async offerSshdFix(workspaceFolder?: vscode.WorkspaceFolder): Promise<void> {
		const action = await vscode.window.showWarningMessage(
			'SSHD is not configured in your Codespace. Would you like to add it to your devcontainer configuration?',
			'Fix Devcontainer',
			'Cancel'
		);

		if (action !== 'Fix Devcontainer') {
			return;
		}

		// Find workspace folder
		const folder = workspaceFolder || 
			(vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0]);

		if (!folder) {
			await vscode.window.showErrorMessage(
				'No workspace folder found. Please open a folder first.'
			);
			return;
		}

		const devcontainerPath = path.join(folder.uri.fsPath, '.devcontainer', 'devcontainer.json');

		// Check if devcontainer.json exists
		if (!fs.existsSync(devcontainerPath)) {
			// Create .devcontainer directory if it doesn't exist
			const devcontainerDir = path.dirname(devcontainerPath);
			if (!fs.existsSync(devcontainerDir)) {
				fs.mkdirSync(devcontainerDir, { recursive: true });
			}

			// Create a basic devcontainer.json
			const basicConfig = {
				image: 'mcr.microsoft.com/devcontainers/base:ubuntu',
				features: {
					'ghcr.io/devcontainers/features/sshd:1': {}
				}
			};

			fs.writeFileSync(
				devcontainerPath,
				JSON.stringify(basicConfig, null, 2),
				'utf-8'
			);

			await vscode.window.showInformationMessage(
				'Created devcontainer.json with SSHD feature. Please commit and rebuild your Codespace.'
			);
			return;
		}

		// Read existing devcontainer.json (JSONC: tolerates comments and trailing commas)
		try {
			const content = fs.readFileSync(devcontainerPath, 'utf-8');
			const errors: ParseError[] = [];
			const config = parse(content, errors, { allowTrailingComma: true });

			if (errors.length > 0) {
				const summary = errors
					.map(e => `${printParseErrorCode(e.error)} at offset ${e.offset}`)
					.join('; ');
				throw new Error(`devcontainer.json is not valid JSONC: ${summary}`);
			}

			// Check if SSHD feature already exists
			if (config?.features && config.features['ghcr.io/devcontainers/features/sshd:1']) {
				await vscode.window.showInformationMessage(
					'SSHD feature is already configured in devcontainer.json.'
				);
				return;
			}

			// Surgically insert the SSHD feature, preserving comments and formatting
			const formattingOptions = { tabSize: 2, insertSpaces: true, eol: '\n' };
			const edits = modify(
				content,
				['features', 'ghcr.io/devcontainers/features/sshd:1'],
				{},
				{ formattingOptions }
			);
			const updated = applyEdits(content, edits);

			fs.writeFileSync(devcontainerPath, updated, 'utf-8');

			// Open the file for user to review
			const document = await vscode.workspace.openTextDocument(devcontainerPath);
			await vscode.window.showTextDocument(document);

			await vscode.window.showInformationMessage(
				'Added SSHD feature to devcontainer.json. Please commit and rebuild your Codespace.'
			);
		} catch (error: any) {
			await vscode.window.showErrorMessage(
				`Failed to update devcontainer.json: ${error.message}`
			);
		}
	}
}

