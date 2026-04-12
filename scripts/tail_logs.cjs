const { Client } = require('C:/Users/User/AppData/Roaming/npm/node_modules/ssh2');

const HOST = '152.42.167.126';
const USER = 'root';
const PASS = 'goyimAgen9t';

const conn = new Client();
conn.on('ready', () => {
  conn.exec('pm2 logs goyim-agent --lines 50 --nostream 2>&1', (err, stream) => {
    if (err) { console.error(err); conn.end(); return; }
    stream.on('data', d => process.stdout.write(d));
    stream.stderr.on('data', d => process.stderr.write(d));
    stream.on('close', () => conn.end());
  });
}).on('error', err => {
  console.error('SSH error:', err.message);
}).connect({
  host: HOST, port: 22, username: USER, password: PASS,
  readyTimeout: 20000,
  algorithms: { serverHostKey: ['ssh-rsa','ecdsa-sha2-nistp256','ssh-ed25519'] },
});
