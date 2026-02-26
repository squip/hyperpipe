import { normalizeHex64, normalizeProfileIdentity, shortPubkey } from '../utils.js';

function createSuggestionRow(profile, onSelect) {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'suggestion-row';

  const identity = normalizeProfileIdentity(profile, profile?.pubkey || null);
  const avatar = document.createElement('div');
  avatar.className = 'avatar avatar-sm';
  if (identity.picture) {
    const image = document.createElement('img');
    image.src = identity.picture;
    image.alt = `${identity.displayName} avatar`;
    image.loading = 'lazy';
    image.referrerPolicy = 'no-referrer';
    image.onerror = () => {
      image.remove();
      avatar.textContent = identity.displayName.charAt(0).toUpperCase() || 'U';
      avatar.classList.add('avatar-fallback');
    };
    avatar.appendChild(image);
  } else {
    avatar.textContent = identity.displayName.charAt(0).toUpperCase() || 'U';
    avatar.classList.add('avatar-fallback');
  }

  const text = document.createElement('div');
  text.className = 'suggestion-text';

  const name = document.createElement('span');
  name.className = 'suggestion-name';
  name.textContent = identity.displayName;

  const secondary = document.createElement('span');
  secondary.className = 'suggestion-secondary';
  secondary.textContent = identity.secondary || shortPubkey(profile?.pubkey || '');

  text.appendChild(name);
  text.appendChild(secondary);

  row.appendChild(avatar);
  row.appendChild(text);
  row.addEventListener('click', () => onSelect(profile));
  return row;
}

function isLikelyPubkeyQuery(query) {
  if (typeof query !== 'string') return false;
  const normalized = query.trim().toLowerCase();
  if (!normalized) return false;
  if (normalized.startsWith('npub1')) return true;
  return /^[a-f0-9]{16,64}$/.test(normalized);
}

function scoreProfileForQuery(profile, query) {
  if (!profile || !query) return 0;
  const normalizedQuery = String(query).trim().toLowerCase();
  if (!normalizedQuery) return 0;

  const identity = normalizeProfileIdentity(profile, profile?.pubkey || null);
  const displayName = String(identity.displayName || '').toLowerCase();
  const secondary = String(identity.secondary || '').toLowerCase();
  const name = String(profile?.name || '').toLowerCase();
  const nip05 = String(profile?.nip05 || '').toLowerCase();
  const pubkey = String(profile?.pubkey || '').toLowerCase();
  const explicitHex = normalizeHex64(normalizedQuery);
  const queryLooksLikePubkey = !!explicitHex || isLikelyPubkeyQuery(normalizedQuery);

  let score = 0;
  let textMatch = false;

  const textFields = [displayName, name, nip05, secondary];
  for (const field of textFields) {
    if (!field) continue;
    if (field === normalizedQuery) {
      score += 1200;
      textMatch = true;
      continue;
    }
    if (field.startsWith(normalizedQuery)) {
      score += 760;
      textMatch = true;
      continue;
    }
    if (field.includes(normalizedQuery)) {
      score += 420;
      textMatch = true;
    }
  }

  if (queryLooksLikePubkey) {
    if (explicitHex && pubkey === explicitHex) score += 2200;
    if (pubkey.startsWith(normalizedQuery)) score += 700;
    if (pubkey.includes(normalizedQuery)) score += 360;
  } else if (!textMatch) {
    return 0;
  }

  return score;
}

function rankProfilesForQuery(list, query) {
  const scored = (Array.isArray(list) ? list : [])
    .map((profile, index) => ({
      profile,
      index,
      score: scoreProfileForQuery(profile, query)
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => {
      if (left.score !== right.score) return right.score - left.score;
      return left.index - right.index;
    });
  return scored.map((entry) => entry.profile);
}

export function createUserPicker({
  title = 'User',
  placeholder = 'Search users',
  submitLabel = 'Apply',
  searchFn,
  onSubmit,
  onError = null,
  profilesByPubkey = {}
} = {}) {
  const root = document.createElement('div');
  root.className = 'user-picker';

  const label = document.createElement('label');
  label.className = 'field-label';
  label.textContent = title;

  const inputRow = document.createElement('div');
  inputRow.className = 'inline-editor';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'input';
  input.placeholder = placeholder;

  const submit = document.createElement('button');
  submit.type = 'button';
  submit.className = 'btn btn-primary';
  submit.textContent = submitLabel;

  inputRow.appendChild(input);
  inputRow.appendChild(submit);

  const selected = document.createElement('div');
  selected.className = 'selected-user hidden';

  const suggestions = document.createElement('div');
  suggestions.className = 'suggestions hidden';

  root.appendChild(label);
  root.appendChild(inputRow);
  root.appendChild(selected);
  root.appendChild(suggestions);

  let selectedPubkey = null;
  let searchTimer = null;
  let requestId = 0;
  let searching = false;

  const renderSelected = () => {
    selected.innerHTML = '';
    const normalized = normalizeHex64(selectedPubkey);
    if (!normalized) {
      selected.classList.add('hidden');
      return;
    }
    const profile = profilesByPubkey[normalized] || null;
    const identity = normalizeProfileIdentity(profile, normalized);
    const badge = document.createElement('div');
    badge.className = 'selected-user-badge';
    badge.textContent = `Selected: ${identity.displayName} (${shortPubkey(normalized)})`;
    selected.appendChild(badge);
    selected.classList.remove('hidden');
  };

  const closeSuggestions = () => {
    suggestions.classList.add('hidden');
    suggestions.innerHTML = '';
  };

  const setSelected = (pubkey, profile = null) => {
    selectedPubkey = normalizeHex64(pubkey);
    if (selectedPubkey && profile) {
      profilesByPubkey[selectedPubkey] = profile;
    }
    renderSelected();
    closeSuggestions();
  };

  const runSearch = async (query) => {
    if (typeof searchFn !== 'function') return;
    const trimmed = String(query || '').trim();
    if (trimmed.length < 2) {
      closeSuggestions();
      return;
    }

    const currentRequest = ++requestId;
    searching = true;
    suggestions.classList.remove('hidden');
    suggestions.innerHTML = '<div class="suggestion-empty">Searching...</div>';

    try {
      const results = await searchFn(trimmed);
      if (currentRequest !== requestId) return;

      const list = rankProfilesForQuery(results, trimmed);
      suggestions.innerHTML = '';
      if (!list.length) {
        suggestions.innerHTML = '<div class="suggestion-empty">No users found</div>';
        return;
      }

      for (const profile of list) {
        const normalized = normalizeHex64(profile?.pubkey);
        if (!normalized) continue;
        profilesByPubkey[normalized] = profile;
        suggestions.appendChild(createSuggestionRow(profile, (selectedProfile) => {
          setSelected(selectedProfile?.pubkey, selectedProfile);
          input.value = normalizeProfileIdentity(selectedProfile, selectedProfile?.pubkey).displayName;
        }));
      }
    } catch (_error) {
      suggestions.innerHTML = '<div class="suggestion-empty">Search unavailable</div>';
    } finally {
      if (currentRequest === requestId) {
        searching = false;
      }
    }
  };

  const submitSelected = async () => {
    const normalizedInput = normalizeHex64(input.value);
    const targetPubkey = normalizeHex64(selectedPubkey) || normalizedInput;
    if (!targetPubkey) {
      throw new Error('invalid-pubkey');
    }

    await onSubmit(targetPubkey);
    selectedPubkey = null;
    input.value = '';
    closeSuggestions();
    renderSelected();
  };

  input.addEventListener('input', () => {
    if (searching) {
      requestId += 1;
      searching = false;
    }

    if (normalizeHex64(input.value) !== normalizeHex64(selectedPubkey)) {
      selectedPubkey = null;
      renderSelected();
    }

    if (searchTimer) {
      clearTimeout(searchTimer);
    }
    searchTimer = setTimeout(() => {
      runSearch(input.value);
    }, 200);
  });

  input.addEventListener('focus', () => {
    if (input.value.trim().length >= 2) {
      runSearch(input.value);
    }
  });

  input.addEventListener('keydown', async (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    try {
      await submitSelected();
    } catch (error) {
      if (typeof onError === 'function') onError(error);
    }
  });

  submit.addEventListener('click', async () => {
    try {
      await submitSelected();
    } catch (error) {
      if (typeof onError === 'function') onError(error);
    }
  });

  root.addEventListener('focusout', () => {
    setTimeout(() => {
      if (!root.contains(document.activeElement)) {
        closeSuggestions();
      }
    }, 0);
  });

  return {
    element: root,
    updateProfiles(nextProfiles = {}) {
      Object.assign(profilesByPubkey, nextProfiles || {});
      renderSelected();
    }
  };
}
