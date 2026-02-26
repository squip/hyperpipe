import { formatDateTime, formatDuration } from '../utils.js';

function createMetricList(items = []) {
  const list = document.createElement('ul');
  list.className = 'kv-list';
  for (const item of items) {
    const row = document.createElement('li');
    const key = document.createElement('span');
    key.className = 'kv-key';
    key.textContent = item.label;

    const value = document.createElement('span');
    value.className = 'kv-value';
    value.textContent = item.value;

    row.appendChild(key);
    row.appendChild(value);
    list.appendChild(row);
  }
  return list;
}

function createPanel(title, items = []) {
  const panel = document.createElement('article');
  panel.className = 'panel';

  const heading = document.createElement('h3');
  heading.className = 'panel-title';
  heading.textContent = title;

  panel.appendChild(heading);
  panel.appendChild(createMetricList(items));
  return panel;
}

export function renderDashboard(container, {
  overview = null,
  activity = [],
  onRunGc = null
} = {}) {
  container.innerHTML = '';

  const page = document.createElement('section');
  page.className = 'page page-dashboard';

  const statusBar = document.createElement('div');
  statusBar.className = 'status-strip';

  const statusEntries = [
    { label: 'Gateway Origin', value: overview?.gatewayOrigin || '-' },
    { label: 'Status', value: overview?.status || 'unknown' },
    { label: 'Started At', value: formatDateTime(overview?.startedAt) },
    { label: 'Uptime', value: formatDuration(overview?.uptimeMs) }
  ];

  for (const entry of statusEntries) {
    const item = document.createElement('div');
    item.className = 'status-item';

    const label = document.createElement('span');
    label.className = 'status-label';
    label.textContent = entry.label;

    const value = document.createElement('span');
    value.className = 'status-value';
    value.textContent = entry.value;

    item.appendChild(label);
    item.appendChild(value);
    statusBar.appendChild(item);
  }

  const policy = overview?.policy || {};
  const counts = overview?.counts || {};
  const blindPeer = overview?.blindPeer || {};
  const features = overview?.features || {};

  const grid = document.createElement('div');
  grid.className = 'dashboard-grid';

  grid.appendChild(
    createPanel('Policy', [
      { label: 'Mode', value: policy?.value || '-' },
      { label: 'Invite Only', value: policy?.inviteOnly ? 'Enabled' : 'Disabled' },
      { label: 'Allow-List Count', value: String(policy?.allowCount ?? 0) },
      { label: 'Ban-List Count', value: String(policy?.banCount ?? 0) },
      { label: 'Discovery Relays', value: String(policy?.discoveryRelayCount ?? 0) }
    ])
  );

  grid.appendChild(
    createPanel('Runtime Counts', [
      { label: 'Active Sessions', value: String(counts?.activeSessions ?? 0) },
      { label: 'Tracked Peers', value: String(counts?.trackedPeers ?? 0) },
      { label: 'Relays', value: String(counts?.relays ?? 0) },
      { label: 'Join Requests', value: String(counts?.joinRequests ?? 0) },
      { label: 'Pending Invites', value: String(counts?.pendingInvites ?? 0) }
    ])
  );

  grid.appendChild(
    createPanel('Blind-Peer', [
      { label: 'Enabled', value: blindPeer?.enabled ? 'Yes' : 'No' },
      { label: 'Running', value: blindPeer?.running ? 'Yes' : 'No' },
      { label: 'Trusted Peers', value: String(blindPeer?.trustedPeerCount ?? 0) },
      { label: 'Tracked Cores', value: String(blindPeer?.trackedCores ?? 0) }
    ])
  );

  grid.appendChild(
    createPanel('Feature Flags', [
      { label: 'Multi-Gateway', value: features?.multiGatewayEnabled ? 'Enabled' : 'Disabled' },
      { label: 'Admin UI', value: features?.adminUiEnabled ? 'Enabled' : 'Disabled' }
    ])
  );

  const actionCard = document.createElement('article');
  actionCard.className = 'panel action-card';

  const actionTitle = document.createElement('h3');
  actionTitle.className = 'panel-title';
  actionTitle.textContent = 'Run Blind-Peer Garbage Collection';

  const actionDescription = document.createElement('p');
  actionDescription.className = 'panel-description';
  actionDescription.textContent = 'Trigger blind-peer hygiene to clear stale mirrors and reconcile ownership data.';

  const actionButton = document.createElement('button');
  actionButton.type = 'button';
  actionButton.className = 'btn btn-primary';
  actionButton.textContent = 'Run Process';
  if (typeof onRunGc === 'function') {
    actionButton.addEventListener('click', () => onRunGc());
  }

  actionCard.appendChild(actionTitle);
  actionCard.appendChild(actionDescription);
  actionCard.appendChild(actionButton);

  const activityCard = document.createElement('article');
  activityCard.className = 'panel activity-card';

  const activityTitle = document.createElement('h3');
  activityTitle.className = 'panel-title';
  activityTitle.textContent = 'Recent Activity';

  const activityList = document.createElement('ul');
  activityList.className = 'list activity-list';

  if (!Array.isArray(activity) || !activity.length) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = 'No recent admin activity.';
    activityList.appendChild(empty);
  } else {
    for (const entry of activity.slice(0, 25)) {
      const row = document.createElement('li');
      row.className = 'activity-row';
      const label = document.createElement('span');
      label.className = 'activity-type';
      label.textContent = String(entry?.type || 'event');
      const timestamp = document.createElement('span');
      timestamp.className = 'activity-time';
      timestamp.textContent = formatDateTime(entry?.createdAt);
      row.appendChild(label);
      row.appendChild(timestamp);
      activityList.appendChild(row);
    }
  }

  activityCard.appendChild(activityTitle);
  activityCard.appendChild(activityList);

  page.appendChild(statusBar);
  page.appendChild(grid);
  page.appendChild(actionCard);
  page.appendChild(activityCard);
  container.appendChild(page);
}
