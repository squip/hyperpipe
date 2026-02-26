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

      const list = Array.isArray(results) ? results : [];
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
