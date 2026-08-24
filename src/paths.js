
const path = require('path');

let DEFAULT_DIR;
try { DEFAULT_DIR = require('electron').ipcRenderer.sendSync('get-default-data-dir'); } catch (e) {}
if (!DEFAULT_DIR) DEFAULT_DIR = path.join(__dirname, '..');

function getDataDir() {
    try { return localStorage.getItem('sshell.dataDir') || DEFAULT_DIR; }
    catch (e) { return DEFAULT_DIR; }
}
function setDataDir(dir) { try { localStorage.setItem('sshell.dataDir', dir); } catch (e) {} }
function sessionsPath() { return path.join(getDataDir(), 'sessions.json'); }
function configPath() { return path.join(getDataDir(), 'config.json'); }

module.exports = { getDataDir, setDataDir, sessionsPath, configPath, DEFAULT_DIR };
