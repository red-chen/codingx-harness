// node-pty 1.1.0 macOS tarballs omit the spawn-helper executable bit.
// https://github.com/microsoft/node-pty/issues/919
import { createRequire } from 'node:module';
import { chmod, lstat } from 'node:fs/promises';
import path from 'node:path';
if (process.platform === 'darwin') {
  try {
    const require = createRequire(import.meta.url);
    const root = path.dirname(require.resolve('node-pty/package.json'));
    for (const relative of ['prebuilds/darwin-' + process.arch + '/spawn-helper', 'build/Release/spawn-helper']) {
      const helper = path.join(root, relative);
      try {
        const info = await lstat(helper);
        if (info.isFile() && (info.mode & 0o111) !== 0o111) await chmod(helper, (info.mode & 0o777) | 0o111);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  } catch (error) {
    process.stderr.write('codingx: PTY helper setup failed; PTY may be unavailable: ' + error.message + '\n');
  }
}
