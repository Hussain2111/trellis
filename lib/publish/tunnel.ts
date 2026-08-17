import { spawn, type ChildProcess } from 'node:child_process';
import { which } from '../media/audio';

/**
 * Meta fetches media from a public HTTPS URL — it will not read localhost. A
 * cloudflared quick tunnel gives one for free, with no account.
 *
 * The URL is ephemeral and changes every run, so it is resolved at publish time
 * and never stored. A stored tunnel URL is a stale tunnel URL.
 */

let current: { process: ChildProcess; url: string } | null = null;

export function cloudflaredAvailable(): boolean {
  return which('cloudflared') !== null;
}

export async function openQuickTunnel(port: number, timeoutMs = 30_000): Promise<string> {
  if (current) return current.url;

  const binary = which('cloudflared');
  if (!binary) {
    throw new Error(
      'cloudflared not found on PATH. Install it (winget install Cloudflare.cloudflared) — ' +
        'Meta cannot fetch media from localhost.',
    );
  }

  const child = spawn(binary, ['tunnel', '--url', `http://localhost:${port}`], {
    windowsHide: true,
  });

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('cloudflared did not report a URL within 30s'));
    }, timeoutMs);

    const onData = (chunk: Buffer): void => {
      const match = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i.exec(chunk.toString());
      if (match) {
        clearTimeout(timer);
        current = { process: child, url: match[0] };
        resolve(match[0]);
      }
    };

    child.stdout.on('data', onData);
    child.stderr.on('data', onData); // cloudflared prints the URL to stderr
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code) => {
      current = null;
      clearTimeout(timer);
      reject(new Error(`cloudflared exited with code ${code}`));
    });
  });
}

export function closeTunnel(): void {
  current?.process.kill();
  current = null;
}

export function currentTunnelUrl(): string | null {
  return current?.url ?? null;
}
