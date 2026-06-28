// Authentication check
const token = localStorage.getItem('server_jwt');
if (!token && window.location.pathname !== '/login.html') {
  window.location.href = '/login.html';
}

// Global Variables
let currentFolder = '';
let currentSearch = '';
let currentFilterType = '';
let currentSortField = 'name';
let currentSortOrder = 'asc';
let currentPage = 1;
let currentViewMode = 'grid'; // grid or list

let socket = null;
let storageChart = null;

// Initialize App
document.addEventListener('DOMContentLoaded', () => {
  if (token) {
    initSocket();
    setupTabNavigation();
    setupBrowserEventListeners();
    setupCloudEventListeners();
    loadFiles();
    updateDeviceStatsWidget();
  }
});

// -------------------------------------------------------------
// Socket.io Connection
// -------------------------------------------------------------
function initSocket() {
  socket = io();

  socket.on('device_status_update', (data) => {
    updateWidgetUI(data);
  });

  socket.on('database_synced', (data) => {
    addLogToConsole('System', `Database synchronized! Total files: ${data.totalFiles}`);
    if (document.getElementById('tab-browser').classList.contains('active')) {
      loadFiles();
    }
  });

  socket.on('upload_progress', (data) => {
    const progressBlock = document.getElementById('cloudProgressBlock');
    const progressBar = document.getElementById('cloudProgressBar');
    const progressPercent = document.getElementById('cloudProgressPercent');
    const progressStatus = document.getElementById('cloudProgressStatus');
    const progressSpeed = document.getElementById('cloudProgressSpeed');
    const progressEta = document.getElementById('cloudProgressEta');
    const confirmBtn = document.getElementById('btnConfirmCloudUpload');
    const cancelBtn = document.getElementById('btnCancelCloudUpload');

    progressBlock.style.display = 'block';

    if (data.status === 'uploading') {
      confirmBtn.disabled = true;
      cancelBtn.disabled = true;
      progressStatus.textContent = 'Streaming to Google Drive...';
      progressBar.style.width = `${data.progress}%`;
      progressPercent.textContent = `${data.progress}%`;
      progressSpeed.textContent = `Speed: ${data.speed} KB/s`;
      progressEta.textContent = `ETA: ${formatDuration(data.eta)}`;
    } else if (data.status === 'success') {
      progressBar.style.width = '100%';
      progressPercent.textContent = '100%';
      progressStatus.textContent = 'Upload Successful!';
      progressSpeed.textContent = 'Completed';
      progressEta.textContent = '';
      confirmBtn.disabled = false;
      cancelBtn.disabled = false;
      addLogToConsole('Cloud Upload', 'Stream upload successful.');
    } else if (data.status === 'failed') {
      progressStatus.textContent = `Failed: ${data.error}`;
      progressStatus.style.color = '#cf6679';
      confirmBtn.disabled = false;
      cancelBtn.disabled = false;
      addLogToConsole('Cloud Upload', `Failed: ${data.error}`);
    }
  });
}

// -------------------------------------------------------------
// API Helper
// -------------------------------------------------------------
async function apiFetch(endpoint, options = {}) {
  options.headers = options.headers || {};
  options.headers['Authorization'] = `Bearer ${token}`;
  
  if (options.body && typeof options.body === 'object') {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(options.body);
  }

  try {
    const response = await fetch(endpoint, options);
    if (response.status === 401 || response.status === 403) {
      localStorage.removeItem('server_jwt');
      window.location.href = '/login.html';
      return null;
    }
    return response;
  } catch (err) {
    console.error('Fetch error:', err);
    throw err;
  }
}

// -------------------------------------------------------------
// Tab Navigation
// -------------------------------------------------------------
function setupTabNavigation() {
  const menuItems = document.querySelectorAll('.menu-item');
  const tabs = document.querySelectorAll('.tab-content');

  menuItems.forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      const tabId = item.getAttribute('data-tab');

      menuItems.forEach(i => i.classList.remove('active'));
      tabs.forEach(t => t.classList.remove('active'));

      item.classList.add('active');
      const targetTab = document.getElementById(tabId);
      targetTab.classList.add('active');

      // Trigger specific tab loading logic
      if (tabId === 'tab-analyzer') {
        loadStorageAnalyzer();
      } else if (tabId === 'tab-duplicates') {
        loadDuplicates();
      } else if (tabId === 'tab-recycle') {
        loadRecycleBin();
      } else if (tabId === 'tab-logs') {
        loadActivityLogs();
      } else if (tabId === 'tab-favorites') {
        loadFavorites();
      } else if (tabId === 'tab-browser') {
        loadFiles();
      }
    });
  });

  // Logout button
  document.getElementById('btnLogoutBtn').addEventListener('click', () => {
    localStorage.removeItem('server_jwt');
    window.location.href = '/login.html';
  });
}

// -------------------------------------------------------------
// Sidebar Device Widget
// -------------------------------------------------------------
async function updateDeviceStatsWidget() {
  try {
    const res = await apiFetch('/api/device_status');
    const data = await res.json();
    updateWidgetUI(data);
  } catch (err) {
    console.error('Widget error:', err);
  }
}

function updateWidgetUI(data) {
  const serverStatusBadge = document.getElementById('serverStatusBadge');
  
  if (data.status === 'offline') {
    serverStatusBadge.className = 'status-indicator-badge offline';
    serverStatusBadge.innerHTML = '<span class="status-dot"></span> Offline';
    return;
  }

  serverStatusBadge.className = 'status-indicator-badge online';
  serverStatusBadge.innerHTML = '<span class="status-dot"></span> Online';

  const dev = data.device || data;
  if (!dev) return;

  document.getElementById('widgetPhoneName').textContent = dev.phoneName || 'Android Device';
  document.getElementById('widgetOsVersion').textContent = dev.androidVersion || '';

  // Storage
  const totalStorageGb = dev.storageTotal / (1024 * 1024 * 1024);
  const usedStorageGb = dev.storageUsed / (1024 * 1024 * 1024);
  const storagePercent = (dev.storageUsed / dev.storageTotal) * 100;
  
  document.getElementById('widgetStorageText').textContent = `${usedStorageGb.toFixed(1)} GB / ${totalStorageGb.toFixed(1)} GB`;
  document.getElementById('widgetStorageBar').style.width = `${storagePercent}%`;

  // RAM
  const totalRamMb = dev.ramTotal / (1024 * 1024);
  const usedRamMb = dev.ramUsage / (1024 * 1024);
  const ramPercent = (dev.ramUsage / dev.ramTotal) * 100;

  document.getElementById('widgetRamText').textContent = `${usedRamMb.toFixed(0)} MB / ${totalRamMb.toFixed(0)} MB`;
  document.getElementById('widgetRamBar').style.width = `${ramPercent}%`;

  // Battery & Net
  document.getElementById('widgetBatteryText').textContent = `${dev.batteryPercent}% (${dev.isCharging ? 'Charging' : 'Discharging'})`;
  document.getElementById('widgetIpText').textContent = dev.wifiIp || '0.0.0.0';
  document.getElementById('widgetUptimeText').textContent = formatDuration(dev.uptime);
}

// -------------------------------------------------------------
// File Browser Engine
// -------------------------------------------------------------
async function loadFiles() {
  const container = document.getElementById('filesGrid');
  container.innerHTML = '<div style="grid-column: 1/-1; text-align: center; padding: 40px; color: var(--text-secondary);">Scanning files...</div>';

  try {
    const url = `/api/files?folder=${encodeURIComponent(currentFolder)}&search=${encodeURIComponent(currentSearch)}&type=${currentFilterType}&sortField=${currentSortField}&sortOrder=${currentSortOrder}&page=${currentPage}&limit=60`;
    const res = await apiFetch(url);
    const data = await res.json();

    container.className = `files-container ${currentViewMode}-view`;
    container.innerHTML = '';

    if (!data.files || data.files.length === 0) {
      container.innerHTML = '<div style="grid-column: 1/-1; text-align: center; padding: 40px; color: var(--text-muted);">This folder is empty or no files match.</div>';
      updatePagination(data.pagination);
      return;
    }

    data.files.forEach(file => {
      const fileCard = createFileCard(file);
      container.appendChild(fileCard);
    });

    updatePagination(data.pagination);
    renderBreadcrumbs();
  } catch (err) {
    container.innerHTML = `<div style="grid-column: 1/-1; text-align: center; padding: 40px; color: var(--error-red);">Error loading files: ${err.message}</div>`;
  }
}

function createFileCard(file) {
  const card = document.createElement('div');
  card.className = 'file-card';
  card.dataset.id = file.id;
  card.dataset.path = file.path;
  card.dataset.isDirectory = file.isDirectory;

  // Star and Pin highlights
  let badges = '';
  if (file.isFavorite) badges += '<span class="file-fav-star" title="Starred">⭐</span>';
  if (file.isPinned) badges += '<span class="file-pinned-pin" title="Pinned">📌</span>';

  // Thumbnail or icon selection
  let iconHtml = '';
  if (file.isDirectory) {
    iconHtml = '<span class="file-icon-large">📁</span>';
  } else if (file.thumbnail) {
    // Media thumbnail via proxied endpoint
    const thumbUrl = `/api/thumbnail?id=${file.id}&token=${token}`;
    iconHtml = `<img src="${thumbUrl}" class="file-thumbnail" alt="thumbnail" onerror="this.outerHTML='<span class=\\'file-icon-large\\'>📄</span>'">`;
  } else {
    // Fallback Icons
    const mime = file.mime || '';
    if (mime.startsWith('audio/')) {
      iconHtml = '<span class="file-icon-large">🎵</span>';
    } else if (mime.startsWith('video/')) {
      iconHtml = '<span class="file-icon-large">🎬</span>';
    } else if (mime.startsWith('image/')) {
      iconHtml = '<span class="file-icon-large">🖼️</span>';
    } else if (mime.includes('zip') || mime.includes('rar') || mime.includes('compressed')) {
      iconHtml = '<span class="file-icon-large">📦</span>';
    } else if (mime.includes('pdf')) {
      iconHtml = '<span class="file-icon-large">📕</span>';
    } else {
      iconHtml = '<span class="file-icon-large">📄</span>';
    }
  }

  card.innerHTML = `
    ${badges}
    <div class="file-thumb-container">
      ${iconHtml}
    </div>
    <div class="file-name-label" title="${file.name}">${file.name}</div>
    <div class="file-size-label">${file.isDirectory ? 'Folder' : formatBytes(file.size)}</div>
    
    <!-- Hover actions bar -->
    <div class="file-card-actions">
      ${!file.isDirectory ? `<button class="action-icon-btn btn-view-action" title="View/Play">👁️</button>` : ''}
      <button class="action-icon-btn btn-download-action" title="Download">⬇️</button>
      <button class="action-icon-btn btn-cloud-action" title="Stream to Cloud">☁️</button>
      <button class="action-icon-btn btn-star-action" title="${file.isFavorite ? 'Unstar' : 'Star'}">⭐</button>
      ${file.isDirectory ? `<button class="action-icon-btn btn-pin-action" title="${file.isPinned ? 'Unpin Folder' : 'Pin Folder'}">📌</button>` : ''}
      <button class="action-icon-btn btn-rename-action" title="Rename">✏️</button>
      <button class="action-icon-btn btn-move-action" title="Move/Copy">📋</button>
      <button class="action-icon-btn btn-trash-action" title="Move to Recycle Bin">🗑️</button>
    </div>
  `;

  // Folder navigation event
  card.addEventListener('dblclick', () => {
    if (file.isDirectory === 1 || file.isDirectory === true) {
      currentFolder = file.path;
      currentPage = 1;
      currentSearch = '';
      document.getElementById('browserSearchInput').value = '';
      loadFiles();
    }
  });

  // Action Button Listeners
  const viewBtn = card.querySelector('.btn-view-action');
  if (viewBtn) {
    viewBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openMediaViewer(file);
    });
  }

  card.querySelector('.btn-download-action').addEventListener('click', (e) => {
    e.stopPropagation();
    window.open(`/api/file?id=${file.id}&token=${token}`);
  });

  card.querySelector('.btn-cloud-action').addEventListener('click', (e) => {
    e.stopPropagation();
    openCloudModal(file);
  });

  card.querySelector('.btn-star-action').addEventListener('click', async (e) => {
    e.stopPropagation();
    try {
      await apiFetch('/api/favorite', {
        method: 'POST',
        body: { id: file.id, favorite: !file.isFavorite }
      });
      loadFiles();
    } catch (err) {
      alert('Action failed: ' + err.message);
    }
  });

  const pinBtn = card.querySelector('.btn-pin-action');
  if (pinBtn) {
    pinBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        await apiFetch('/api/pin', {
          method: 'POST',
          body: { id: file.id, pinned: !file.isPinned }
        });
        loadFiles();
      } catch (err) {
        alert('Pin failed: ' + err.message);
      }
    });
  }

  card.querySelector('.btn-rename-action').addEventListener('click', (e) => {
    e.stopPropagation();
    openRenameModal(file);
  });

  card.querySelector('.btn-move-action').addEventListener('click', (e) => {
    e.stopPropagation();
    openMoveCopyModal(file);
  });

  card.querySelector('.btn-trash-action').addEventListener('click', async (e) => {
    e.stopPropagation();
    if (confirm(`Move '${file.name}' to the Recycle Bin?`)) {
      try {
        await apiFetch(`/api/file?id=${file.id}`, { method: 'DELETE' });
        loadFiles();
      } catch (err) {
        alert('Delete failed: ' + err.message);
      }
    }
  });

  return card;
}

// -------------------------------------------------------------
// Browser View Config & Events
// -------------------------------------------------------------
function setupBrowserEventListeners() {
  // Search
  const searchInput = document.getElementById('browserSearchInput');
  searchInput.addEventListener('input', debounce(() => {
    currentSearch = searchInput.value.trim();
    currentPage = 1;
    loadFiles();
  }, 400));

  // Toggles View Mode
  document.getElementById('btnViewGrid').addEventListener('click', () => {
    currentViewMode = 'grid';
    document.getElementById('btnViewGrid').classList.add('active');
    document.getElementById('btnViewList').classList.remove('active');
    loadFiles();
  });

  document.getElementById('btnViewList').addEventListener('click', () => {
    currentViewMode = 'list';
    document.getElementById('btnViewList').classList.add('active');
    document.getElementById('btnViewGrid').classList.remove('active');
    loadFiles();
  });

  // Sort Fields
  document.getElementById('sortFieldSelect').addEventListener('change', (e) => {
    currentSortField = e.target.value;
    loadFiles();
  });
  document.getElementById('sortOrderSelect').addEventListener('change', (e) => {
    currentSortOrder = e.target.value;
    loadFiles();
  });

  // Category Filters
  const filterBtns = document.querySelectorAll('.btn-filter');
  filterBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      filterBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentFilterType = btn.getAttribute('data-type');
      currentPage = 1;
      loadFiles();
    });
  });

  // Pagination
  document.getElementById('btnPagePrev').addEventListener('click', () => {
    if (currentPage > 1) {
      currentPage--;
      loadFiles();
    }
  });
  document.getElementById('btnPageNext').addEventListener('click', () => {
    currentPage++;
    loadFiles();
  });

  // New Folder Dialog
  document.getElementById('btnNewFolder').addEventListener('click', () => {
    document.getElementById('inputMkdirName').value = '';
    openModal('modalMkdir');
  });

  document.getElementById('btnConfirmMkdir').addEventListener('click', async () => {
    const name = document.getElementById('inputMkdirName').value.trim();
    if (!name) return;

    try {
      const res = await apiFetch('/api/mkdir', {
        method: 'POST',
        body: { parentFolder: currentFolder, name }
      });
      const data = await res.json();
      if (data.success) {
        closeModal('modalMkdir');
        loadFiles();
      }
    } catch (err) {
      alert('Directory creation failed: ' + err.message);
    }
  });

  // Rename Dialog
  document.getElementById('btnConfirmRename').addEventListener('click', async () => {
    const id = document.getElementById('inputRenameId').value;
    const newName = document.getElementById('inputRenameName').value.trim();
    if (!id || !newName) return;

    try {
      const res = await apiFetch('/api/rename', {
        method: 'POST',
        body: { id, newName }
      });
      const data = await res.json();
      if (data.success) {
        closeModal('modalRename');
        loadFiles();
      }
    } catch (err) {
      alert('Rename failed: ' + err.message);
    }
  });

  // Refresh
  document.getElementById('btnRefreshBrowser').addEventListener('click', loadFiles);
}

function updatePagination(meta) {
  if (!meta) return;
  
  const prevBtn = document.getElementById('btnPagePrev');
  const nextBtn = document.getElementById('btnPageNext');
  const pageIndicator = document.getElementById('pageIndicator');
  const itemsCountText = document.getElementById('browserItemsCount');

  prevBtn.disabled = meta.page <= 1;
  nextBtn.disabled = meta.page >= meta.pages;
  
  pageIndicator.textContent = `Page ${meta.page} of ${meta.pages || 1}`;
  itemsCountText.textContent = `${meta.total} items found`;
}

function renderBreadcrumbs() {
  const container = document.getElementById('breadcrumbTrail');
  container.innerHTML = '';

  // Add Home
  const homeSpan = document.createElement('span');
  homeSpan.className = 'breadcrumb-item root';
  homeSpan.textContent = 'Home';
  homeSpan.addEventListener('click', () => {
    currentFolder = '';
    currentPage = 1;
    loadFiles();
  });
  container.appendChild(homeSpan);

  if (!currentFolder) return;

  // Split folder paths (e.g. /storage/emulated/0/Download)
  const segments = currentFolder.split('/').filter(s => s.length > 0);
  let accumPath = '';

  // Handle Windows paths starting with drive letters, or UNIX root
  const startsWithRootSlash = currentFolder.startsWith('/');
  
  segments.forEach((seg, idx) => {
    // Reconstruct absolute path
    if (idx === 0 && !startsWithRootSlash) {
      accumPath = seg; // E.g., "C:"
    } else {
      accumPath += '/' + seg;
    }

    const itemSpan = document.createElement('span');
    itemSpan.className = 'breadcrumb-item';
    itemSpan.textContent = seg;
    const targetPath = accumPath;

    itemSpan.addEventListener('click', () => {
      currentFolder = targetPath;
      currentPage = 1;
      loadFiles();
    });
    container.appendChild(itemSpan);
  });
}

// -------------------------------------------------------------
// Cloud Upload Dialog
// -------------------------------------------------------------
function setupCloudEventListeners() {
  document.getElementById('btnConfirmCloudUpload').addEventListener('click', async () => {
    const id = document.getElementById('inputCloudFileId').value;
    const googleToken = document.getElementById('inputGoogleToken').value.trim();

    if (!googleToken) {
      alert('Please enter a valid Google Drive Access Token.');
      return;
    }

    // Save token in memory/input for ease during session
    try {
      const res = await apiFetch('/api/upload_cloud', {
        method: 'POST',
        body: { id, googleToken }
      });
      const data = await res.json();
      if (data.success) {
        addLogToConsole('Cloud Upload', 'Cloud streaming request acknowledged.');
      }
    } catch (err) {
      alert('Cloud upload initiate failed: ' + err.message);
    }
  });
}

// -------------------------------------------------------------
// Storage Analyzer Tab
// -------------------------------------------------------------
async function loadStorageAnalyzer() {
  try {
    const res = await apiFetch('/api/storage_analyzer');
    const data = await res.json();

    // Chart.js render
    const canvas = document.getElementById('storageChart');
    const categories = data.categories || [];
    
    const labels = categories.map(c => c.category);
    const counts = categories.map(c => c.count);
    const sizes = categories.map(c => c.size || 0);

    // Destroy existing chart instance
    if (storageChart) {
      storageChart.destroy();
    }

    storageChart = new Chart(canvas, {
      type: 'doughnut',
      data: {
        labels: labels,
        datasets: [{
          data: sizes.map(s => (s / (1024 * 1024)).toFixed(2)), // in MB
          backgroundColor: [
            '#bb86fc', // Images
            '#03dac6', // Videos
            '#00bcd4', // Audio
            '#ff9800', // PDFs
            '#4caf50', // Docs
            '#ffeb3b', // APKs
            '#e91e63', // Archives
            '#607d8b', // Others
            '#9c27b0'  // Folders
          ],
          borderWidth: 1,
          borderColor: 'rgba(255, 255, 255, 0.1)'
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: 'right',
            labels: { color: '#f5f5f7', font: { family: 'Outfit' } }
          },
          tooltip: {
            callbacks: {
              label: function(context) {
                return `${context.label}: ${context.raw} MB`;
              }
            }
          }
        }
      }
    });

    // Allocation table
    const tableBody = document.getElementById('analyzerTableBody');
    tableBody.innerHTML = '';
    categories.forEach(cat => {
      const row = document.createElement('tr');
      row.innerHTML = `
        <td><strong>${cat.category}</strong></td>
        <td>${cat.count} items</td>
        <td>${formatBytes(cat.size || 0)}</td>
      `;
      tableBody.appendChild(row);
    });

    // Largest files table
    const largestBody = document.getElementById('largestFilesTableBody');
    largestBody.innerHTML = '';
    (data.largest || []).forEach(file => {
      const row = document.createElement('tr');
      row.innerHTML = `
        <td>
          <div class="row-file-title">
            <span class="row-file-icon">${getFileEmoji(file.mime)}</span>
            <span title="${file.name}">${file.name}</span>
          </div>
        </td>
        <td><small style="color: var(--text-muted);" title="${file.path}">${file.folder}</small></td>
        <td>${formatBytes(file.size)}</td>
        <td>
          <button class="btn-secondary" onclick="window.open('/api/file?id=${file.id}&token=${token}')">Download</button>
        </td>
      `;
      largestBody.appendChild(row);
    });

  } catch (err) {
    console.error('Analyzer load error:', err);
  }
}

// -------------------------------------------------------------
// Duplicate Finder Tab
// -------------------------------------------------------------
async function loadDuplicates() {
  const container = document.getElementById('duplicatesTableBody');
  container.innerHTML = '<tr><td colspan="3" style="text-align: center;">Scanning duplicates...</td></tr>';

  try {
    const res = await apiFetch('/api/duplicates');
    const groups = await res.json();

    container.innerHTML = '';
    if (groups.length === 0) {
      container.innerHTML = '<tr><td colspan="3" style="text-align: center; color: var(--text-muted);">No duplicate files found.</td></tr>';
      return;
    }

    groups.forEach((group, index) => {
      const row = document.createElement('tr');
      
      let listHtml = '<div style="display: flex; flex-direction: column; gap: 6px; padding: 6px 0;">';
      group.files.forEach(file => {
        listHtml += `
          <div style="display: flex; justify-content: space-between; font-size: 12px; background: rgba(255,255,255,0.02); padding: 6px; border-radius: 4px;">
            <span style="color: var(--text-secondary);" title="${file.path}">${file.folder}/${file.name}</span>
            <button class="action-icon-btn btn-trash-action" title="Delete permanently" onclick="deleteDuplicateFile('${file.id}', this)">🗑️ Delete Copy</button>
          </div>
        `;
      });
      listHtml += '</div>';

      row.innerHTML = `
        <td>
          <strong>${group.name}</strong> (${formatBytes(group.size)})
          ${listHtml}
        </td>
        <td style="vertical-align: top; padding-top: 20px;">${group.files.length} copies</td>
        <td style="vertical-align: top; padding-top: 20px;">
          <span style="font-size: 11px; color: var(--text-muted);">Delete individual copies above</span>
        </td>
      `;
      container.appendChild(row);
    });

  } catch (err) {
    container.innerHTML = `<tr><td colspan="3" style="color: var(--error-red);">Error: ${err.message}</td></tr>`;
  }
}

window.deleteDuplicateFile = async function(id, btnElement) {
  if (confirm('Permanently delete this specific duplicate file? This action is irreversible.')) {
    try {
      const res = await apiFetch(`/api/file?id=${id}&permanent=true`, { method: 'DELETE' });
      if (res.ok) {
        btnElement.parentElement.remove();
        addLogToConsole('Duplicate Finder', 'Permanent delete successful');
      }
    } catch (err) {
      alert('Delete failed: ' + err.message);
    }
  }
};

// -------------------------------------------------------------
// Favorites Tab
// -------------------------------------------------------------
async function loadFavorites() {
  const container = document.getElementById('favoritesGrid');
  container.innerHTML = '<div style="text-align: center; padding: 40px; width: 100%;">Loading favorites...</div>';

  try {
    const res = await apiFetch('/api/files?favorite=true');
    const data = await res.json();
    
    container.innerHTML = '';
    if (!data.files || data.files.length === 0) {
      container.innerHTML = '<div style="text-align: center; padding: 40px; color: var(--text-muted); width: 100%;">You have no starred items. Double click on files and press the star icon to add them.</div>';
      return;
    }

    data.files.forEach(file => {
      const fileCard = createFileCard(file);
      container.appendChild(fileCard);
    });
  } catch (err) {
    container.innerHTML = `<div style="color: var(--error-red); text-align: center; padding: 40px;">Error: ${err.message}</div>`;
  }
}

// -------------------------------------------------------------
// Recycle Bin Tab
// -------------------------------------------------------------
async function loadRecycleBin() {
  const container = document.getElementById('recycleTableBody');
  container.innerHTML = '<tr><td colspan="4" style="text-align: center;">Loading Recycle Bin...</td></tr>';

  try {
    const res = await apiFetch('/api/files?deleted=true');
    const data = await res.json();

    container.innerHTML = '';
    if (!data.files || data.files.length === 0) {
      container.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--text-muted);">Recycle Bin is empty.</td></tr>';
      return;
    }

    data.files.forEach(file => {
      const row = document.createElement('tr');
      row.innerHTML = `
        <td><strong>${file.name}</strong></td>
        <td><small style="color: var(--text-muted);">${file.path}</small></td>
        <td>${file.isDirectory ? 'Folder' : formatBytes(file.size)}</td>
        <td>
          <button class="btn-secondary" style="padding: 6px 12px; font-size: 12px; margin-right: 6px;" onclick="restoreFile('${file.id}')">Restore</button>
          <button class="btn-danger" style="padding: 6px 12px; font-size: 12px;" onclick="permanentlyDeleteFile('${file.id}')">Delete Forever</button>
        </td>
      `;
      container.appendChild(row);
    });

  } catch (err) {
    container.innerHTML = `<tr><td colspan="4" style="color: var(--error-red);">Error: ${err.message}</td></tr>`;
  }
}

window.restoreFile = async function(id) {
  try {
    const res = await apiFetch('/api/restore', {
      method: 'POST',
      body: { id }
    });
    if (res.ok) {
      loadRecycleBin();
    }
  } catch (err) {
    alert('Restore failed: ' + err.message);
  }
};

window.permanentlyDeleteFile = async function(id) {
  if (confirm('Permanently delete this item? This cannot be undone.')) {
    try {
      const res = await apiFetch(`/api/file?id=${id}&permanent=true`, { method: 'DELETE' });
      if (res.ok) {
        loadRecycleBin();
      }
    } catch (err) {
      alert('Delete failed: ' + err.message);
    }
  }
};

document.getElementById('btnClearRecycleBin').addEventListener('click', async () => {
  if (confirm('Permanently empty the entire Recycle Bin? This cannot be undone.')) {
    try {
      const res = await apiFetch('/api/files?deleted=true');
      const data = await res.json();
      for (const file of data.files || []) {
        await apiFetch(`/api/file?id=${file.id}&permanent=true`, { method: 'DELETE' });
      }
      loadRecycleBin();
    } catch (err) {
      alert('Emptying bin failed: ' + err.message);
    }
  }
});

// -------------------------------------------------------------
// Activity Logs Tab
// -------------------------------------------------------------
async function loadActivityLogs() {
  const container = document.getElementById('logConsoleContainer');
  container.innerHTML = 'Loading logs...';

  try {
    const res = await apiFetch('/api/activity_logs');
    const logs = await res.json();

    container.innerHTML = '';
    if (logs.length === 0) {
      container.innerHTML = 'No logs registered.';
      return;
    }

    logs.forEach(log => {
      const timeStr = new Date(log.timestamp).toLocaleString();
      const line = document.createElement('div');
      line.className = 'log-line';
      line.innerHTML = `
        <span class="log-time">[${timeStr}]</span>
        <strong style="color: var(--primary-color);">${log.action}</strong>: 
        <span>${log.details}</span>
      `;
      container.appendChild(line);
    });

    container.scrollTop = container.scrollHeight;
  } catch (err) {
    container.innerHTML = 'Failed to load logs: ' + err.message;
  }
}

function addLogToConsole(action, details) {
  const container = document.getElementById('logConsoleContainer');
  if (!container) return;

  const timeStr = new Date().toLocaleString();
  const line = document.createElement('div');
  line.className = 'log-line';
  line.innerHTML = `
    <span class="log-time">[${timeStr}]</span>
    <strong style="color: var(--secondary-color);">${action}</strong>: 
    <span>${details}</span>
  `;
  container.appendChild(line);
  container.scrollTop = container.scrollHeight;
}

// -------------------------------------------------------------
// Interactive Dialog Triggers & Picker Trees
// -------------------------------------------------------------
function openRenameModal(file) {
  document.getElementById('inputRenameId').value = file.id;
  document.getElementById('inputRenameName').value = file.name;
  openModal('modalRename');
}

async function openMoveCopyModal(file) {
  document.getElementById('inputMoveCopyId').value = file.id;
  document.getElementById('inputMoveCopyAction').value = 'move';
  document.getElementById('moveCopyModalTitle').textContent = `Move/Copy: ${file.name}`;
  
  const treeContainer = document.getElementById('folderPickerTree');
  treeContainer.innerHTML = 'Loading directory tree...';
  openModal('modalMoveCopy');

  try {
    // Fetch all folders from DB
    const res = await apiFetch('/api/files?page=1&limit=100000');
    const data = await res.json();

    const folders = data.files.filter(f => f.isDirectory === 1);
    treeContainer.innerHTML = '';

    // Render tree nodes
    const rootNode = document.createElement('div');
    rootNode.className = 'tree-node selected';
    rootNode.dataset.path = '';
    rootNode.innerHTML = '<span>🏠 Device Storage Root</span>';
    rootNode.addEventListener('click', () => {
      document.querySelectorAll('.tree-node').forEach(n => n.classList.remove('selected'));
      rootNode.classList.add('selected');
    });
    treeContainer.appendChild(rootNode);

    folders.forEach(fold => {
      const node = document.createElement('div');
      node.className = 'tree-node';
      node.dataset.path = fold.path;
      node.innerHTML = `<span>📁 ${fold.path}</span>`;
      node.addEventListener('click', () => {
        document.querySelectorAll('.tree-node').forEach(n => n.classList.remove('selected'));
        node.classList.add('selected');
      });
      treeContainer.appendChild(node);
    });

  } catch (err) {
    treeContainer.innerHTML = 'Error loading directory tree: ' + err.message;
  }
}

document.getElementById('btnConfirmMoveCopy').addEventListener('click', async () => {
  const id = document.getElementById('inputMoveCopyId').value;
  const action = document.getElementById('inputMoveCopyAction').value;
  const selectedNode = document.querySelector('.tree-node.selected');

  if (!id || !selectedNode) return;
  const destFolder = selectedNode.dataset.path;

  // Confirm dialog prompt to move or copy
  const pick = confirm(`Move or Copy?\n\nPress OK to MOVE\nPress Cancel to COPY`);
  const endpoint = pick ? '/api/move' : '/api/copy';

  try {
    const res = await apiFetch(endpoint, {
      method: 'POST',
      body: { id, destFolder }
    });
    const data = await res.json();
    if (data.success) {
      closeModal('modalMoveCopy');
      loadFiles();
    }
  } catch (err) {
    alert('Action failed: ' + err.message);
  }
});

// Cloud Upload Modal Opening
function openCloudModal(file) {
  document.getElementById('inputCloudFileId').value = file.id;
  document.getElementById('cloudProgressBlock').style.display = 'none';
  document.getElementById('cloudProgressBar').style.width = '0%';
  document.getElementById('cloudProgressPercent').textContent = '0%';
  document.getElementById('cloudProgressStatus').textContent = 'Waiting to stream...';
  
  openModal('modalCloud');
}

// -------------------------------------------------------------
// Media Viewer Overlay
// -------------------------------------------------------------
function openMediaViewer(file) {
  const viewer = document.getElementById('modalViewer');
  const title = document.getElementById('viewerTitle');
  const container = document.getElementById('viewerMediaContainer');

  title.textContent = `Streaming: ${file.name}`;
  container.innerHTML = 'Initializing stream...';
  openModal('modalViewer');

  const streamUrl = `/api/file?id=${file.id}&token=${token}`;
  const mime = file.mime || '';

  if (mime.startsWith('image/')) {
    container.innerHTML = `<img src="${streamUrl}" alt="media">`;
  } else if (mime.startsWith('video/')) {
    container.innerHTML = `
      <video controls autoplay>
        <source src="${streamUrl}" type="${mime}">
        Your browser does not support the video tag.
      </video>
    `;
  } else if (mime.startsWith('audio/')) {
    container.innerHTML = `
      <audio controls autoplay>
        <source src="${streamUrl}" type="${mime}">
        Your browser does not support the audio tag.
      </audio>
    `;
  } else if (mime.includes('pdf')) {
    container.innerHTML = `<iframe src="${streamUrl}" width="100%" height="500px" style="border:none;"></iframe>`;
  } else {
    // Plain text viewer
    fetch(streamUrl)
      .then(r => r.text())
      .then(text => {
        container.innerHTML = `<pre style="color: #00ff00; width:100%; text-align:left; padding:20px; overflow:auto; font-size:12px;">${escapeHtml(text)}</pre>`;
      })
      .catch(err => {
        container.innerHTML = 'Failed to view file text.';
      });
  }

  // Handle closing viewer safely (stops audio/video play)
  document.getElementById('btnMediaViewerClose').onclick = () => {
    container.innerHTML = '';
    closeModal('modalViewer');
  };
}

// -------------------------------------------------------------
// Utilities
// -------------------------------------------------------------
function formatBytes(bytes, decimals = 2) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

function formatDuration(sec) {
  if (!sec || isNaN(sec)) return '0s';
  const hrs = Math.floor(sec / 3600);
  const mins = Math.floor((sec % 3600) / 60);
  const secs = Math.floor(sec % 60);
  
  if (hrs > 0) return `${hrs}h ${mins}m`;
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
}

function getFileEmoji(mime) {
  if (!mime) return '📄';
  if (mime.startsWith('audio/')) return '🎵';
  if (mime.startsWith('video/')) return '🎬';
  if (mime.startsWith('image/')) return '🖼️';
  if (mime.includes('zip') || mime.includes('rar')) return '📦';
  if (mime.includes('pdf')) return '📕';
  return '📄';
}

function openModal(id) {
  const modal = document.getElementById(id);
  modal.classList.add('active');
}

function closeModal(id) {
  const modal = document.getElementById(id);
  modal.classList.remove('active');
}

function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
