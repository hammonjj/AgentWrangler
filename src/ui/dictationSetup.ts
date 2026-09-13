import * as fs from 'node:fs';
import * as https from 'node:https';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { defaultModelPath, DictationSetupError } from '../core/dictation';

/**
 * What to do when dictation is asked for and a piece of it is missing.
 *
 * The pieces are ordinary Homebrew tools, so the honest thing is to say which
 * one is missing and offer the command — installing software behind someone's
 * back is not a thing an editor extension should do. The model is different:
 * it has one correct location and one correct file, so that one is offered as a
 * download.
 */

/** Where the default model comes from — the whisper.cpp author's own upload. */
const MODEL_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin';

export async function offerDictationSetup(err: DictationSetupError): Promise<void> {
  if (err.remedy === 'download-model') {
    const pick = await vscode.window.showErrorMessage(
      `Agent Wrangler: ${err.message}`,
      'Download base.en (141 MB)',
      'Choose a model…',
    );
    if (pick === 'Download base.en (141 MB)') await downloadModel();
    else if (pick === 'Choose a model…') await pickModel();
    return;
  }

  const formula = err.remedy === 'install-whisper' ? 'whisper-cpp' : 'ffmpeg';
  const pick = await vscode.window.showErrorMessage(
    `Agent Wrangler: ${err.message}`,
    `Install with Homebrew`,
    'Copy command',
  );
  const command = `brew install ${formula}`;
  if (pick === 'Install with Homebrew') {
    // Its own terminal, run in front of the user: a Homebrew install asks
    // questions sometimes, and a silent background one that stalled on a prompt
    // would look like a hang.
    const term = vscode.window.createTerminal({ name: `Install ${formula}` });
    term.show();
    term.sendText(command);
  } else if (pick === 'Copy command') {
    await vscode.env.clipboard.writeText(command);
  }
}

/** Let the user point at a model they already have (a larger one, or another language). */
async function pickModel(): Promise<void> {
  const chosen = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    openLabel: 'Use this model',
    filters: { 'Whisper model': ['bin'] },
  });
  const file = chosen?.[0]?.fsPath;
  if (!file) return;
  await vscode.workspace
    .getConfiguration('agentWrangler')
    .update('dictation.modelPath', file, vscode.ConfigurationTarget.Global);
}

export async function downloadModel(): Promise<boolean> {
  const target = defaultModelPath();
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Agent Wrangler: downloading Whisper model', cancellable: true },
    async (progress, token) => {
      try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        // Downloaded beside the target and moved into place, so an interrupted
        // download can never be mistaken for a usable model on the next run.
        const part = `${target}.part`;
        await get(MODEL_URL, part, progress, token);
        if (token.isCancellationRequested) {
          fs.rmSync(part, { force: true });
          return false;
        }
        fs.renameSync(part, target);
        void vscode.window.showInformationMessage('Agent Wrangler: dictation is ready.');
        return true;
      } catch (e) {
        void vscode.window.showErrorMessage(`Agent Wrangler: model download failed — ${(e as Error).message}`);
        return false;
      }
    },
  );
}

function get(
  url: string,
  dest: string,
  progress: vscode.Progress<{ message?: string; increment?: number }>,
  token: vscode.CancellationToken,
  redirects = 0,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('too many redirects'));
    const req = https.get(url, (res) => {
      // Hugging Face serves the file itself from a CDN behind a 302.
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        resolve(get(res.headers.location, dest, progress, token, redirects + 1));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const total = Number(res.headers['content-length'] ?? 0);
      let done = 0;
      let lastPct = 0;
      const file = fs.createWriteStream(dest);
      token.onCancellationRequested(() => {
        req.destroy();
        file.close();
      });
      res.on('data', (chunk: Buffer) => {
        done += chunk.length;
        if (!total) return;
        const pct = Math.floor((done / total) * 100);
        if (pct > lastPct) {
          progress.report({ increment: pct - lastPct, message: `${pct}%` });
          lastPct = pct;
        }
      });
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve()));
      file.on('error', reject);
    });
    req.on('error', reject);
  });
}
