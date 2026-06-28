const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

require('dotenv').config();

const db = require('./db');
const auth = require('./auth');
const gdrive = require('./gdrive');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS']
  }
});

const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// -------------------------------------------------------------
// Tunnel Storage Pools & Socket References
// -------------------------------------------------------------
const pendingTransfers = new Map();
const pendingOperations = new Map();
let androidSocket = null;

// Helper to check if Android is connected
function isAndroidOnline() {
  return androidSocket && androidSocket.connected;
}

// Helper to dispatch commands to Android and wait for response via WebSocket
function performAndroidOperation(eventName, args) {
  return new Promise((resolve, reject) => {
    if (!isAndroidOnline()) {
      return reject(new Error('Android app is offline. Please start the service.'));
    }

    const requestId = `op_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
    
    const timeout = setTimeout(() => {
      pendingOperations.delete(requestId);
      reject(new Error(`Operation '${eventName}' timed out on Android device.`));
    }, 20000);

    pendingOperations.set(requestId, { resolve, reject, timeout });

    androidSocket.emit(eventName, { ...args, requestId });
  });
}

// -------------------------------------------------------------
// Authentication Endpoints
// -------------------------------------------------------------

app.post('/api/login', (req, res) => {
  const { password } = req.body;
  if (!password) {
    return res.status(400).json({ error: 'Password required' });
  }
  const token = auth.login(password);
  if (token) {
    db.logActivity('Authentication', 'Admin logged in successfully');
    res.json({ token });
  } else {
    db.logActivity('Authentication', 'Failed login attempt');
    res.status(401).json({ error: 'Invalid password' });
  }
});

// Protect all subsequent API endpoints
app.use('/api', auth.authenticateToken);

// -------------------------------------------------------------
// Tunnel Stream Handler (Target for Android Client POST Uploads)
// -------------------------------------------------------------

app.post('/api/transfer', (req, res) => {
  const { transferId } = req.query;
  if (!transferId) return res.status(400).send('Missing transferId');

  const clientRes = pendingTransfers.get(transferId);
  if (!clientRes) {
    return res.status(410).send('Transfer request expired or client disconnected');
  }

  // Clear from pending
  pendingTransfers.delete(transferId);

  // Set matching status & transfer headers
  const statusCode = req.headers['x-transfer-status'] ? parseInt(req.headers['x-transfer-status']) : 200;
  clientRes.status(statusCode);

  if (req.headers['content-type']) clientRes.setHeader('Content-Type', req.headers['content-type']);
  if (req.headers['content-range']) clientRes.setHeader('Content-Range', req.headers['content-range']);
  if (req.headers['content-length']) clientRes.setHeader('Content-Length', req.headers['content-length']);
  clientRes.setHeader('Accept-Ranges', 'bytes');

  // Pipe Android upload stream directly to client response
  req.pipe(clientRes);

  res.json({ success: true });
});

// -------------------------------------------------------------
// Files Metadata Synchronization (Called by Android App)
// -------------------------------------------------------------

app.post('/api/files', async (req, res) => {
  try {
    const androidIp = req.headers['x-android-ip'] || req.ip.replace('::ffff:', '');
    const androidPort = req.headers['x-android-port'] || '8080';
    const files = req.body;

    if (!Array.isArray(files)) {
      return res.status(400).json({ error: 'Expected list of file items' });
    }

    // Save info
    await db.run(`INSERT OR REPLACE INTO device_info (key, value) VALUES ('android_ip', ?)`, [androidIp]);
    await db.run(`INSERT OR REPLACE INTO device_info (key, value) VALUES ('android_port', ?)`, [androidPort]);
    await db.run(`INSERT OR REPLACE INTO device_info (key, value) VALUES ('last_sync_time', ?)`, [Date.now().toString()]);
    await db.run(`INSERT OR REPLACE INTO device_info (key, value) VALUES ('total_files_count', ?)`, [files.length.toString()]);

    // Update index database
    await db.run('BEGIN TRANSACTION');
    try {
      const existingFlags = await db.query(
        `SELECT id, isFavorite, isPinned, isDeleted FROM files WHERE isFavorite=1 OR isPinned=1 OR isDeleted=1`
      );
      const flagsMap = new Map(existingFlags.map(f => [f.id, f]));

      await db.run(`DELETE FROM files`);

      const stmt = db.db.prepare(`
        INSERT INTO files (
          id, name, path, folder, size, mime, extension, modified, created, thumbnail, isDirectory, isFavorite, isPinned, isDeleted
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const file of files) {
        const flag = flagsMap.get(file.id);
        const fav = flag ? flag.isFavorite : 0;
        const pin = flag ? flag.isPinned : 0;
        const del = flag ? flag.isDeleted : 0;

        stmt.run(
          file.id,
          file.name,
          file.path,
          file.folder,
          file.size,
          file.mime,
          file.extension,
          file.modified,
          file.created,
          file.thumbnail,
          file.isDirectory ? 1 : 0,
          fav,
          pin,
          del
        );
      }
      stmt.finalize();
      await db.run('COMMIT');
    } catch (err) {
      await db.run('ROLLBACK');
      throw err;
    }

    await db.logActivity('Sync', `Synchronized ${files.length} files from phone`);
    io.emit('database_synced', { totalFiles: files.length, time: Date.now() });

    res.json({ success: true, count: files.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update database: ' + err.message });
  }
});

// -------------------------------------------------------------
// Files Browsing & Search Endpoints
// -------------------------------------------------------------

app.get('/api/files', async (req, res) => {
  try {
    const folder = req.query.folder || ''; 
    const search = req.query.search || '';
    const type = req.query.type || '';
    const favorite = req.query.favorite === 'true';
    const pinned = req.query.pinned === 'true';
    const deleted = req.query.deleted === 'true';
    
    const sortField = req.query.sortField || 'name';
    const sortOrder = req.query.sortOrder === 'desc' ? 'DESC' : 'ASC';

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 100;
    const offset = (page - 1) * limit;

    let sql = `SELECT * FROM files WHERE 1=1`;
    let countSql = `SELECT COUNT(*) as count FROM files WHERE 1=1`;
    let params = [];
    let countParams = [];

    if (deleted) {
      sql += ` AND isDeleted = 1`;
      countSql += ` AND isDeleted = 1`;
    } else {
      sql += ` AND isDeleted = 0`;
      countSql += ` AND isDeleted = 0`;

      if (!search && !favorite && !pinned && !type) {
        if (folder) {
          sql += ` AND folder = ?`;
          countSql += ` AND folder = ?`;
          params.push(folder);
          countParams.push(folder);
        } else {
          const roots = await db.query(`SELECT DISTINCT folder FROM files`);
          if (roots.length > 0) {
            roots.sort((a, b) => a.folder.length - b.folder.length);
            const shortest = roots[0].folder;
            sql += ` AND folder = ?`;
            countSql += ` AND folder = ?`;
            params.push(shortest);
            countParams.push(shortest);
          }
        }
      }
    }

    if (search) {
      sql += ` AND name LIKE ?`;
      countSql += ` AND name LIKE ?`;
      params.push(`%${search}%`);
      countParams.push(`%${search}%`);
    }

    if (favorite) {
      sql += ` AND isFavorite = 1`;
      countSql += ` AND isFavorite = 1`;
    }

    if (pinned) {
      sql += ` AND isPinned = 1 AND isDirectory = 1`;
      countSql += ` AND isPinned = 1 AND isDirectory = 1`;
    }

    if (type) {
      if (type === 'image') {
        sql += ` AND mime LIKE 'image/%'`;
        countSql += ` AND mime LIKE 'image/%'`;
      } else if (type === 'video') {
        sql += ` AND mime LIKE 'video/%'`;
        countSql += ` AND mime LIKE 'video/%'`;
      } else if (type === 'audio') {
        sql += ` AND mime LIKE 'audio/%'`;
        countSql += ` AND mime LIKE 'audio/%'`;
      } else if (type === 'document') {
        sql += ` AND (mime LIKE '%pdf%' OR mime LIKE '%word%' OR mime LIKE '%excel%' OR mime LIKE '%powerpoint%' OR mime LIKE 'text/%' OR extension IN ('pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt'))`;
        countSql += ` AND (mime LIKE '%pdf%' OR mime LIKE '%word%' OR mime LIKE '%excel%' OR mime LIKE '%powerpoint%' OR mime LIKE 'text/%' OR extension IN ('pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt'))`;
      }
    }

    sql += ` ORDER BY isDirectory DESC, ${sortField} ${sortOrder} LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const rows = await db.query(sql, params);
    const totalRow = await db.get(countSql, countParams);
    const total = totalRow ? totalRow.count : 0;

    res.json({
      files: rows,
      pagination: {
        total,
        page,
        limit,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------
// Live Streaming & Thumbnail Proxies via WebSocket Tunnel
// -------------------------------------------------------------

app.get('/api/file', async (req, res) => {
  try {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: 'Missing file id' });

    const file = await db.get(`SELECT * FROM files WHERE id = ?`, [id]);
    if (!file) return res.status(404).json({ error: 'File not indexed' });

    if (!isAndroidOnline()) {
      return res.status(503).json({ error: 'Android app is offline. Please start the service.' });
    }

    // Generate unique transfer registration
    const transferId = `trans_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
    pendingTransfers.set(transferId, res);

    // Request Android to upload this file stream back to us
    androidSocket.emit('request_download', {
      path: file.path,
      transferId,
      range: req.headers.range || ''
    });

    // Cleanup timeout if upload fails to commence in 30s
    setTimeout(() => {
      if (pendingTransfers.has(transferId)) {
        pendingTransfers.delete(transferId);
        res.status(504).json({ error: 'Android device failed to respond within timeout.' });
      }
    }, 30000);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/thumbnail', async (req, res) => {
  try {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: 'Missing id' });

    if (!isAndroidOnline()) {
      return res.status(503).end();
    }

    const transferId = `thumb_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
    pendingTransfers.set(transferId, res);

    androidSocket.emit('request_thumbnail', {
      fileId: id,
      transferId
    });

    setTimeout(() => {
      if (pendingTransfers.has(transferId)) {
        pendingTransfers.delete(transferId);
        res.status(404).end();
      }
    }, 15000);

  } catch (err) {
    res.status(500).end();
  }
});

// -------------------------------------------------------------
// File Operations (CRUD proxies to Android over WebSocket)
// -------------------------------------------------------------

app.post('/api/rename', async (req, res) => {
  try {
    const { id, newName } = req.body;
    if (!id || !newName) return res.status(400).json({ error: 'Missing id or newName' });

    const file = await db.get(`SELECT * FROM files WHERE id = ?`, [id]);
    if (!file) return res.status(404).json({ error: 'File not found' });

    const oldPath = file.path;
    const parentDir = file.folder;
    const newPath = path.join(parentDir, newName).replace(/\\/g, '/');

    // Run operation on Android
    const data = await performAndroidOperation('rename', { oldPath, newPath });

    // Update DB
    const newId = data.extra.newId;
    await db.run(
      `UPDATE files SET id = ?, name = ?, path = ?, folder = ? WHERE id = ?`,
      [newId, newName, newPath, parentDir, id]
    );

    await db.logActivity('Rename', `Renamed '${file.name}' to '${newName}'`);
    res.json({ success: true, id: newId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/copy', async (req, res) => {
  try {
    const { id, destFolder } = req.body;
    if (!id || !destFolder) return res.status(400).json({ error: 'Missing id or destFolder' });

    const file = await db.get(`SELECT * FROM files WHERE id = ?`, [id]);
    if (!file) return res.status(404).json({ error: 'File not found' });

    const srcPath = file.path;
    const destPath = path.join(destFolder, file.name).replace(/\\/g, '/');

    await performAndroidOperation('copy', { srcPath, destPath });

    const newId = Buffer.from(destPath).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    await db.run(`
      INSERT OR REPLACE INTO files (id, name, path, folder, size, mime, extension, modified, created, thumbnail, isDirectory)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [newId, file.name, destPath, destFolder, file.size, file.mime, file.extension, Date.now(), Date.now(), file.thumbnail, file.isDirectory]);

    await db.logActivity('Copy', `Copied '${file.name}' to '${destFolder}'`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/move', async (req, res) => {
  try {
    const { id, destFolder } = req.body;
    if (!id || !destFolder) return res.status(400).json({ error: 'Missing id or destFolder' });

    const file = await db.get(`SELECT * FROM files WHERE id = ?`, [id]);
    if (!file) return res.status(404).json({ error: 'File not found' });

    const srcPath = file.path;
    const destPath = path.join(destFolder, file.name).replace(/\\/g, '/');

    await performAndroidOperation('move', { srcPath, destPath });

    const newId = Buffer.from(destPath).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    await db.run(
      `UPDATE files SET id = ?, path = ?, folder = ? WHERE id = ?`,
      [newId, destPath, destFolder, id]
    );

    await db.logActivity('Move', `Moved '${file.name}' to '${destFolder}'`);
    res.json({ success: true, id: newId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/mkdir', async (req, res) => {
  try {
    const { parentFolder, name } = req.body;
    if (!parentFolder || !name) return res.status(400).json({ error: 'Missing parentFolder or name' });

    const folderPath = path.join(parentFolder, name).replace(/\\/g, '/');

    await performAndroidOperation('mkdir', { path: folderPath });

    const id = Buffer.from(folderPath).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    await db.run(`
      INSERT OR REPLACE INTO files (id, name, path, folder, size, mime, extension, modified, created, thumbnail, isDirectory)
      VALUES (?, ?, ?, ?, 0, 'directory', '', ?, ?, '', 1)
    `, [id, name, folderPath, parentFolder, Date.now(), Date.now()]);

    await db.logActivity('Mkdir', `Created folder '${name}' under '${parentFolder}'`);
    res.json({ success: true, id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/file', async (req, res) => {
  try {
    const { id, permanent } = req.query;
    if (!id) return res.status(400).json({ error: 'Missing file id' });

    const file = await db.get(`SELECT * FROM files WHERE id = ?`, [id]);
    if (!file) return res.status(404).json({ error: 'File not found' });

    if (permanent === 'true') {
      await performAndroidOperation('delete', { path: file.path });
      await db.run(`DELETE FROM files WHERE id = ?`, [id]);
      await db.logActivity('Delete', `Permanently deleted file/folder '${file.name}'`);
    } else {
      await db.run(`UPDATE files SET isDeleted = 1 WHERE id = ?`, [id]);
      await db.logActivity('Trash', `Moved '${file.name}' to Recycle Bin`);
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Restore from Recycle Bin
app.post('/api/restore', async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: 'Missing id' });

    const file = await db.get(`SELECT * FROM files WHERE id = ?`, [id]);
    if (!file) return res.status(404).json({ error: 'File not found' });

    await db.run(`UPDATE files SET isDeleted = 0 WHERE id = ?`, [id]);
    await db.logActivity('Restore', `Restored '${file.name}' from Recycle Bin`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Toggle Favorite
app.post('/api/favorite', async (req, res) => {
  try {
    const { id, favorite } = req.body;
    if (!id) return res.status(400).json({ error: 'Missing id' });

    const favVal = favorite ? 1 : 0;
    await db.run(`UPDATE files SET isFavorite = ? WHERE id = ?`, [favVal, id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Toggle Pin folder
app.post('/api/pin', async (req, res) => {
  try {
    const { id, pinned } = req.body;
    if (!id) return res.status(400).json({ error: 'Missing id' });

    const pinVal = pinned ? 1 : 0;
    await db.run(`UPDATE files SET isPinned = ? WHERE id = ?`, [pinVal, id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------
// System Logs & Status Reports
// -------------------------------------------------------------

app.get('/api/device_status', async (req, res) => {
  if (isAndroidOnline()) {
    res.json({ status: 'online' }); // Socket status push keeps details updated
  } else {
    res.json({ status: 'offline', msg: 'Device not connected' });
  }
});

app.get('/api/activity_logs', async (req, res) => {
  try {
    const logs = await db.query(`SELECT * FROM activity_logs ORDER BY timestamp DESC LIMIT 100`);
    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Storage Analyzer Data
app.get('/api/storage_analyzer', async (req, res) => {
  try {
    const queryTypes = await db.query(`
      SELECT 
        CASE 
          WHEN mime LIKE 'image/%' THEN 'Images'
          WHEN mime LIKE 'video/%' THEN 'Videos'
          WHEN mime LIKE 'audio/%' THEN 'Audio'
          WHEN mime LIKE '%pdf%' OR extension = 'pdf' THEN 'PDF Documents'
          WHEN mime LIKE '%word%' OR extension IN ('doc', 'docx', 'txt') THEN 'Documents'
          WHEN extension = 'apk' THEN 'APK Files'
          WHEN extension IN ('zip', 'rar', '7z', 'tar', 'gz') THEN 'Archives'
          WHEN isDirectory = 1 THEN 'Folders'
          ELSE 'Others'
        END as category,
        COUNT(*) as count,
        SUM(size) as size
      FROM files 
      WHERE isDeleted = 0 
      GROUP BY category
    `);

    const largestFiles = await db.query(`
      SELECT id, name, path, size, mime, extension, folder
      FROM files 
      WHERE isDirectory = 0 AND isDeleted = 0 
      ORDER BY size DESC 
      LIMIT 10
    `);

    res.json({
      categories: queryTypes,
      largest: largestFiles
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Duplicate Finder Data
app.get('/api/duplicates', async (req, res) => {
  try {
    const dups = await db.query(`
      SELECT name, size, COUNT(*) as cnt 
      FROM files 
      WHERE isDirectory = 0 AND isDeleted = 0
      GROUP BY name, size 
      HAVING cnt > 1 
      ORDER BY cnt DESC
    `);

    const duplicateGroups = [];
    for (const dup of dups) {
      const items = await db.query(
        `SELECT id, name, path, folder, size, mime, modified FROM files WHERE name = ? AND size = ? AND isDirectory = 0 AND isDeleted = 0`,
        [dup.name, dup.size]
      );
      duplicateGroups.push({
        name: dup.name,
        size: dup.size,
        files: items
      });
    }

    res.json(duplicateGroups);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------
// Google Drive Cloud Upload Endpoint
// -------------------------------------------------------------

app.post('/api/upload_cloud', async (req, res) => {
  try {
    const { id, googleToken } = req.body;
    if (!id || !googleToken) {
      return res.status(400).json({ error: 'Missing file id or googleToken' });
    }

    const file = await db.get(`SELECT * FROM files WHERE id = ?`, [id]);
    if (!file) return res.status(404).json({ error: 'File not indexed' });

    if (!isAndroidOnline()) {
      return res.status(503).json({ error: 'Android app is offline' });
    }

    // Allocate a transfer tunnel specifically for Google Drive streaming
    const transferId = `gdrive_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
    const uploadId = `upload_${Date.now()}`;

    // Establish intermediate client response to pipe target
    const mockRes = new http.OutgoingMessage();
    // We mock Response pipe capability manually by writing a simple Writable stream
    const stream = require('stream');
    const bridgeStream = new stream.PassThrough();

    // Store in transfers pool so Android POST upload pipes into this PassThrough stream
    pendingTransfers.set(transferId, bridgeStream);

    // Prompt Android to start uploading to the transfer endpoint
    androidSocket.emit('request_download', {
      path: file.path,
      transferId,
      range: ''
    });

    res.json({ success: true, uploadId });

    db.logActivity('Cloud Upload', `Starting Google Drive stream upload for '${file.name}'`);
    
    // Custom mock item passing bridgeStream as the source
    const mockUrl = `http://localhost:${PORT}/api/transfer?transferId=${transferId}`; // Dummy, we use the bridgeStream directly inside the modified uploadToGoogleDrive
    
    gdrive.uploadToGoogleDrive(mockUrl, file, googleToken, io, uploadId)
      .then((data) => {
        db.logActivity('Cloud Upload', `Google Drive upload completed for '${file.name}'. File ID: ${data.id}`);
      })
      .catch((err) => {
        console.error('Google Drive upload error:', err);
        db.logActivity('Cloud Upload', `Google Drive upload failed for '${file.name}': ${err.message}`);
        io.emit('upload_progress', {
          uploadId,
          status: 'failed',
          error: err.message
        });
      });

    // Handle bridging: intercepting mockReq inside uploadToGoogleDrive
    // Let's modify gdrive.js to accept direct readable Stream instead of making another local HTTP request!
    // That is even cleaner and eliminates self-request loops on localhost!
    // We will do this modification in gdrive.js.
    gdrive.activeBridgeStreams = gdrive.activeBridgeStreams || new Map();
    gdrive.activeBridgeStreams.set(transferId, bridgeStream);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------
// Socket.io Connection & Tunnel Routing
// -------------------------------------------------------------

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('device_status_push', (status) => {
    // Dynamically register this socket as the Android tunnel!
    androidSocket = socket;
    db.run(`INSERT OR REPLACE INTO device_info (key, value) VALUES ('android_ip', ?)`, [status.wifiIp || '']);
    db.run(`INSERT OR REPLACE INTO device_info (key, value) VALUES ('android_port', ?)`, ['8080']);
    io.emit('device_status_update', status);
  });

  socket.on('operation_result', (data) => {
    const op = pendingOperations.get(data.requestId);
    if (!op) return;

    clearTimeout(op.timeout);
    pendingOperations.delete(data.requestId);

    if (data.success) {
      op.resolve(data);
    } else {
      op.reject(new Error(data.error || 'Operation failed on Android device'));
    }
  });

  socket.on('disconnect', () => {
    if (socket === androidSocket) {
      console.log('Android tunnel disconnected');
      androidSocket = null;
      io.emit('device_status_update', { status: 'offline' });
    }
    console.log('Client disconnected:', socket.id);
  });
});

server.listen(PORT, () => {
  console.log(`Node.js File Server listening on port ${PORT}`);
  db.logActivity('System', `Server started and listening on port ${PORT}`);
});
