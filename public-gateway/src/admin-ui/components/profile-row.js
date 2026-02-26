import { normalizeProfileIdentity, shortPubkey } from '../utils.js';

export function createProfileRow({ pubkey, profile = null, badge = null, actions = [] } = {}) {
  const li = document.createElement('li');
  li.className = 'profile-row';

  const identity = normalizeProfileIdentity(profile, pubkey);

  const avatar = document.createElement('div');
  avatar.className = 'avatar';

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

  const center = document.createElement('div');
  center.className = 'profile-main';

  const title = document.createElement('div');
  title.className = 'profile-title';
  title.textContent = identity.displayName;

  const subtitle = document.createElement('div');
  subtitle.className = 'profile-subtitle';
  subtitle.textContent = identity.secondary || shortPubkey(pubkey);

  center.appendChild(title);
  center.appendChild(subtitle);

  const right = document.createElement('div');
  right.className = 'profile-actions';

  if (badge) {
    const badgeEl = document.createElement('span');
    badgeEl.className = 'row-badge';
    badgeEl.textContent = badge;
    right.appendChild(badgeEl);
  }

  for (const action of Array.isArray(actions) ? actions : []) {
    if (!action || typeof action !== 'object') continue;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = action.className || 'btn btn-inline';
    button.textContent = action.label || 'Action';
    if (typeof action.onClick === 'function') {
      button.addEventListener('click', action.onClick);
    }
    right.appendChild(button);
  }

  li.appendChild(avatar);
  li.appendChild(center);
  li.appendChild(right);
  return li;
}
