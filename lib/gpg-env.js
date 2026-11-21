'use strict';
// Reads the .env that is kept encrypted with gpg (gpg --symmetric): gpg asks for the passphrase on the terminal, the
// decrypted text goes straight into process.env and is never written to disk. Variables that are already set in the
// environment are not overridden (same rule as loadEnvFile).
const fs = require('fs');
const tty = require('tty');
const { spawnSync } = require('child_process');
const { applyEnv } = require('./env');

function loadGpgEnv(file) {
  if (!fs.existsSync(file)) throw new Error(`nie ma pliku z tokenem: ${file} (inna ścieżka: ALLCHAT_TOKEN_FILE=/sciezka/.env.gpg)`);
  const env = Object.assign({}, process.env);
  if (!env.GPG_TTY && tty.isatty(0)) { // so that pinentry knows where to ask for the passphrase
    const t = spawnSync('tty', { stdio: ['inherit', 'pipe', 'ignore'], encoding: 'utf8' });
    if (t.status === 0 && t.stdout) env.GPG_TTY = t.stdout.trim();
  }
  const r = spawnSync('gpg', ['--quiet', '--decrypt', file], { env, stdio: ['inherit', 'pipe', 'inherit'], encoding: 'utf8' });
  if (r.error) throw new Error(r.error.code === 'ENOENT' ? 'nie znaleziono polecenia gpg (apt install gnupg)' : r.error.message);
  if (r.status !== 0) throw new Error('gpg nie odszyfrował pliku (złe hasło albo przerwano)');
  if (!r.stdout.trim()) throw new Error(`plik ${file} jest po odszyfrowaniu pusty`);
  applyEnv(r.stdout);
}

module.exports = { loadGpgEnv };
