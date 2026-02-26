import { createProfileRow } from '../components/profile-row.js';
import { createUserPicker } from '../components/user-picker.js';
import { formatDateTime, normalizeHex64 } from '../utils.js';

const TAB_DEFS = [
  { id: 'allow-list', label: 'Allow-List' },
  { id: 'ban-list', label: 'Ban-List' },
  { id: 'invites', label: 'Invites' }
];

function makeSectionTitle(text) {
  const heading = document.createElement('h4');
  heading.className = 'subheading';
  heading.textContent = text;
  return heading;
}

function createListContainer() {
  const list = document.createElement('ul');
  list.className = 'list profile-list';
  return list;
}

export function renderUserAuthorization(container, {
  activeTab = 'allow-list',
  allowList = [],
  banList = [],
  invites = [],
  profilesByPubkey = {},
  onTabChange = null,
  onSearchProfiles = null,
  onAddAllow = null,
  onRemoveAllow = null,
  onAddBan = null,
  onRemoveBan = null,
  onCreateInvite = null,
  onSubmitChanges = null,
  onError = null
} = {}) {
  container.innerHTML = '';

  const page = document.createElement('section');
  page.className = 'page page-user-authorization';

  const card = document.createElement('article');
  card.className = 'panel';

  const title = document.createElement('h3');
  title.className = 'panel-title';
  title.textContent = 'User Authorization';

  const tabs = document.createElement('div');
  tabs.className = 'tabs';

  TAB_DEFS.forEach((tabDef) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `tab-btn ${activeTab === tabDef.id ? 'is-active' : ''}`;
    button.textContent = tabDef.label;
    button.addEventListener('click', () => {
      if (typeof onTabChange === 'function') {
        onTabChange(tabDef.id);
      }
    });
    tabs.appendChild(button);
  });

  const content = document.createElement('div');
  content.className = 'tab-content';

  const invokeSafely = async (fn, ...args) => {
    if (typeof fn !== 'function') return;
    try {
      await fn(...args);
    } catch (error) {
      if (typeof onError === 'function') onError(error);
    }
  };

  if (activeTab === 'allow-list') {
    const picker = createUserPicker({
      title: 'Add User To Allow-List',
      placeholder: 'Search by display name, nip05, or pubkey',
      submitLabel: 'Add User',
      searchFn: onSearchProfiles,
      profilesByPubkey,
      onSubmit: async (pubkey) => invokeSafely(onAddAllow, pubkey),
      onError
    });

    const list = createListContainer();
    if (!allowList.length) {
      const empty = document.createElement('li');
      empty.className = 'empty';
      empty.textContent = 'Allow-list is empty.';
      list.appendChild(empty);
    } else {
      for (const pubkey of allowList) {
        const normalized = normalizeHex64(pubkey);
        if (!normalized) continue;
        list.appendChild(
          createProfileRow({
            pubkey: normalized,
            profile: profilesByPubkey[normalized] || null,
            actions: [
              {
                label: 'Remove',
                className: 'btn btn-inline',
                onClick: () => invokeSafely(onRemoveAllow, normalized)
              }
            ]
          })
        );
      }
    }

    content.appendChild(picker.element);
    content.appendChild(makeSectionTitle('Allow-Listed Users'));
    content.appendChild(list);
  }

  if (activeTab === 'ban-list') {
    const picker = createUserPicker({
      title: 'Add User To Ban-List',
      placeholder: 'Search by display name, nip05, or pubkey',
      submitLabel: 'Ban User',
      searchFn: onSearchProfiles,
      profilesByPubkey,
      onSubmit: async (pubkey) => invokeSafely(onAddBan, pubkey),
      onError
    });

    const list = createListContainer();
    if (!banList.length) {
      const empty = document.createElement('li');
      empty.className = 'empty';
      empty.textContent = 'Ban-list is empty.';
      list.appendChild(empty);
    } else {
      for (const pubkey of banList) {
        const normalized = normalizeHex64(pubkey);
        if (!normalized) continue;
        list.appendChild(
          createProfileRow({
            pubkey: normalized,
            profile: profilesByPubkey[normalized] || null,
            actions: [
              {
                label: 'Remove',
                className: 'btn btn-inline',
                onClick: () => invokeSafely(onRemoveBan, normalized)
              }
            ]
          })
        );
      }
    }

    content.appendChild(picker.element);
    content.appendChild(makeSectionTitle('Ban-Listed Users'));
    content.appendChild(list);
  }

  if (activeTab === 'invites') {
    const picker = createUserPicker({
      title: 'Create Gateway Invite',
      placeholder: 'Search by display name, nip05, or pubkey',
      submitLabel: 'Send Invite',
      searchFn: onSearchProfiles,
      profilesByPubkey,
      onSubmit: async (pubkey) => invokeSafely(onCreateInvite, pubkey),
      onError
    });

    const list = createListContainer();
    const pendingInvites = (Array.isArray(invites) ? invites : []).filter((invite) => !invite?.redeemedAt);

    if (!pendingInvites.length) {
      const empty = document.createElement('li');
      empty.className = 'empty';
      empty.textContent = 'No pending invites.';
      list.appendChild(empty);
    } else {
      for (const invite of pendingInvites) {
        const normalized = normalizeHex64(invite?.pubkey);
        if (!normalized) continue;
        const tokenPrefix = String(invite?.inviteToken || '').slice(0, 14) || '-';
        const created = formatDateTime(invite?.createdAt);
        list.appendChild(
          createProfileRow({
            pubkey: normalized,
            profile: profilesByPubkey[normalized] || null,
            badge: `pending · token:${tokenPrefix} · ${created}`
          })
        );
      }
    }

    content.appendChild(picker.element);
    content.appendChild(makeSectionTitle('Pending Invites'));
    content.appendChild(list);
  }

  const submitRow = document.createElement('div');
  submitRow.className = 'submit-row';

  const submitChanges = document.createElement('button');
  submitChanges.type = 'button';
  submitChanges.className = 'btn btn-primary';
  submitChanges.textContent = 'Submit Changes';
  submitChanges.addEventListener('click', async () => {
    await invokeSafely(onSubmitChanges);
  });

  submitRow.appendChild(submitChanges);

  card.appendChild(title);
  card.appendChild(tabs);
  card.appendChild(content);
  card.appendChild(submitRow);
  page.appendChild(card);
  container.appendChild(page);
}
