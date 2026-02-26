import { normalizeRelayUrl } from '../utils.js';

export function createRelayListEditor({ relays = [] } = {}) {
  const relaySet = new Set(
    (Array.isArray(relays) ? relays : [])
      .map((entry) => normalizeRelayUrl(entry) || String(entry || '').trim())
      .filter(Boolean)
  );

  const root = document.createElement('div');
  root.className = 'relay-editor';

  const inputRow = document.createElement('div');
  inputRow.className = 'inline-editor';

  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'wss://relay.example.com';
  input.className = 'input';

  const addButton = document.createElement('button');
  addButton.type = 'button';
  addButton.className = 'btn btn-secondary';
  addButton.textContent = 'Add Relay';

  inputRow.appendChild(input);
  inputRow.appendChild(addButton);

  const list = document.createElement('ul');
  list.className = 'list relay-list';

  const render = () => {
    list.innerHTML = '';
    if (!relaySet.size) {
      const empty = document.createElement('li');
      empty.className = 'empty';
      empty.textContent = 'No discovery relays configured.';
      list.appendChild(empty);
      return;
    }

    for (const relay of relaySet.values()) {
      const row = document.createElement('li');
      row.className = 'relay-row';

      const label = document.createElement('span');
      label.textContent = relay;

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'btn btn-inline';
      remove.textContent = 'Remove';
      remove.addEventListener('click', () => {
        relaySet.delete(relay);
        render();
      });

      row.appendChild(label);
      row.appendChild(remove);
      list.appendChild(row);
    }
  };

  const addRelay = () => {
    const normalized = normalizeRelayUrl(input.value) || String(input.value || '').trim();
    if (!normalized) return;
    relaySet.add(normalized);
    input.value = '';
    render();
  };

  addButton.addEventListener('click', addRelay);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      addRelay();
    }
  });

  root.appendChild(inputRow);
  root.appendChild(list);
  render();

  return {
    element: root,
    getValues() {
      return Array.from(relaySet.values());
    }
  };
}
