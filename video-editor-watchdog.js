const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const appDir = __dirname;
const url = 'http://127.0.0.1:3210/';
const logPath = path.join(appDir, 'video-editor-watchdog.log');

let openedBrowser = false;
let starting = false;

function log(message) {
  fs.appendFile(
    logPath,
    `${new Date().toISOString().replace('T', ' ').slice(0, 19)} ${message}\n`,
    () => {}
  );
}

function isReady() {
  return new Promise(resolve => {
    const req = http.get(url, res => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 500);
    });
    req.setTimeout(3000, () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
  });
}

function startServer() {
  if (starting) return;
  starting = true;
  log('server not ready, starting node server');
  const child = spawn(process.execPath, ['server.js'], {
    cwd: appDir,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  setTimeout(() => { starting = false; }, 5000);
}

function openBrowser() {
  if (openedBrowser) return;
  openedBrowser = true;
  log(`opening browser: ${url}`);
  const child = spawn('cmd.exe', ['/c', 'start', '', url], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
}

async function tick() {
  const ready = await isReady();
  if (!ready) {
    startServer();
    return;
  }
  openBrowser();
}

log('watchdog started');
tick();
setInterval(tick, 30000);
