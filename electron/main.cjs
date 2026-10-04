const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');

let mainWindow = null;
let updater = null;
let updateStartupTimer = null;
let updateIntervalTimer = null;
let isQuitting = false;

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
}

function clearUpdaterTimers() {
  if (updateStartupTimer) {
    clearTimeout(updateStartupTimer);
    updateStartupTimer = null;
  }
  if (updateIntervalTimer) {
    clearInterval(updateIntervalTimer);
    updateIntervalTimer = null;
  }
}

function saveFilePath() {
  return path.join(app.getPath('userData'), 'save.json');
}

function updateConfigPath() {
  return path.join(__dirname, '..', 'update-config.json');
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#171717',
    title: 'Incident Command',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.setMenuBarVisibility(false);

  await mainWindow.loadFile(path.join(__dirname, '..', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Prevent accidental navigation away from the local app.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

ipcMain.handle('app:get-version', () => app.getVersion());

ipcMain.handle('save:write', async (_event, raw) => {
  try {
    if (typeof raw !== 'string') throw new Error('Invalid save payload');

    const target = saveFilePath();
    await fs.mkdir(path.dirname(target), { recursive: true });

    // Validate before touching the live save.
    JSON.parse(raw);

    const temp = `${target}.tmp`;
    await fs.writeFile(temp, raw, 'utf8');
    await fs.rename(temp, target);

    return { ok: true, path: target };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
});

ipcMain.handle('save:read', async () => {
  try {
    const target = saveFilePath();
    const raw = await fs.readFile(target, 'utf8');
    JSON.parse(raw);
    return { ok: true, raw, path: target };
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, raw: null };
    return { ok: false, error: String(error?.message || error) };
  }
});

ipcMain.handle('save:delete', async () => {
  try {
    await fs.rm(saveFilePath(), { force: true });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
});

ipcMain.handle('save:show-folder', async () => {
  const target = saveFilePath();
  await fs.mkdir(path.dirname(target), { recursive: true });
  await shell.openPath(path.dirname(target));
  return { ok: true };
});

ipcMain.handle('updates:check', async () => {
  if (!updater) return { ok: false, disabled: true };
  try {
    const result = await updater.checkForUpdates();
    return {
      ok: true,
      version: result?.updateInfo?.version || null
    };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
});

ipcMain.handle('updates:install', () => {
  if (!updater) return { ok: false, disabled: true };
  isQuitting = true;
  clearUpdaterTimers();
  updater.quitAndInstall(false, true);
  return { ok: true };
});

async function setupAutoUpdater() {
  // Keep updating disabled until update-config.json has a real GitHub repo.
  // This lets the Electron app work immediately without spamming errors.
  let config;
  try {
    config = JSON.parse(await fs.readFile(updateConfigPath(), 'utf8'));
  } catch {
    return;
  }

  if (
    !app.isPackaged ||
    !config?.enabled ||
    config?.provider !== 'github' ||
    !config?.owner ||
    !config?.repo
  ) {
    return;
  }

  try {
    const { NsisUpdater } = require('electron-updater');

    updater = new NsisUpdater({
      provider: 'github',
      owner: config.owner,
      repo: config.repo
    });

    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = true;

    updater.on('update-available', info => {
      mainWindow?.webContents.send('updates:status', {
        state: 'available',
        version: info.version
      });
    });

    updater.on('download-progress', progress => {
      mainWindow?.webContents.send('updates:status', {
        state: 'downloading',
        percent: Math.round(progress.percent || 0)
      });
    });

    updater.on('update-downloaded', info => {
      mainWindow?.webContents.send('updates:status', {
        state: 'downloaded',
        version: info.version
      });
    });

    updater.on('error', error => {
      mainWindow?.webContents.send('updates:status', {
        state: 'error',
        message: String(error?.message || error)
      });
    });

    // Check shortly after startup, then every 30 minutes.
    // Use checkForUpdates() instead of the native notification helper because
    // the renderer provides our own in-game update popup.
    updateStartupTimer = setTimeout(() => {
      updater?.checkForUpdates().catch(() => {});
    }, 4000);

    updateIntervalTimer = setInterval(() => {
      updater?.checkForUpdates().catch(() => {});
    }, 30 * 60 * 1000);
  } catch (error) {
    console.error('Auto updater setup failed:', error);
  }
}

if (gotSingleInstanceLock) {
  app.on('second-instance', async () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      if (app.isReady()) await createWindow();
      return;
    }

    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    await createWindow();
    await setupAutoUpdater();

    app.on('activate', async () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        await createWindow();
      }
    });
  });
}

app.on('before-quit', () => {
  isQuitting = true;
  clearUpdaterTimers();
});

app.on('will-quit', () => {
  clearUpdaterTimers();
  updater = null;
  mainWindow = null;
});

app.on('window-all-closed', () => {
  // Incident Command is a Windows desktop game, not a tray/background app.
  // Closing the last window should always terminate the Electron process.
  if (!isQuitting) isQuitting = true;
  clearUpdaterTimers();
  app.quit();
});
