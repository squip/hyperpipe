import { createRelayListEditor } from '../components/relay-list-editor.js';

export function renderSettings(container, {
  policy = null,
  onSubmit = null
} = {}) {
  container.innerHTML = '';

  const page = document.createElement('section');
  page.className = 'page page-settings';

  const card = document.createElement('article');
  card.className = 'panel';

  const title = document.createElement('h3');
  title.className = 'panel-title';
  title.textContent = 'Gateway Settings';

  const form = document.createElement('form');
  form.className = 'settings-form';

  const policyField = document.createElement('label');
  policyField.className = 'field-label';
  policyField.textContent = 'Policy';

  const policySelect = document.createElement('select');
  policySelect.className = 'input';
  ['OPEN', 'CLOSED'].forEach((optionValue) => {
    const option = document.createElement('option');
    option.value = optionValue;
    option.textContent = optionValue;
    policySelect.appendChild(option);
  });
  policySelect.value = String(policy?.policy || 'OPEN').toUpperCase() === 'CLOSED' ? 'CLOSED' : 'OPEN';

  const inviteOnlyField = document.createElement('label');
  inviteOnlyField.className = 'field-checkbox';

  const inviteOnly = document.createElement('input');
  inviteOnly.type = 'checkbox';
  inviteOnly.checked = policy?.inviteOnly === true;

  const inviteOnlyLabel = document.createElement('span');
  inviteOnlyLabel.textContent = 'Invite-only gateway';

  inviteOnlyField.appendChild(inviteOnly);
  inviteOnlyField.appendChild(inviteOnlyLabel);

  policyField.appendChild(policySelect);

  const relayTitle = document.createElement('h4');
  relayTitle.className = 'subheading';
  relayTitle.textContent = 'Discovery Relays';

  const relayEditor = createRelayListEditor({
    relays: Array.isArray(policy?.discoveryRelays) ? policy.discoveryRelays : []
  });

  const submitRow = document.createElement('div');
  submitRow.className = 'submit-row';

  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.className = 'btn btn-primary';
  submit.textContent = 'Submit Changes';

  submitRow.appendChild(submit);

  form.appendChild(policyField);
  form.appendChild(inviteOnlyField);
  form.appendChild(relayTitle);
  form.appendChild(relayEditor.element);
  form.appendChild(submitRow);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (typeof onSubmit !== 'function') return;
    await onSubmit({
      policy: policySelect.value,
      inviteOnly: inviteOnly.checked,
      discoveryRelays: relayEditor.getValues()
    });
  });

  card.appendChild(title);
  card.appendChild(form);
  page.appendChild(card);
  container.appendChild(page);
}
