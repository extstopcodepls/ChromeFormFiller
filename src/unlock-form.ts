import { newRequestId, sendMessage } from './messages';

export function createUnlockForm(onUnlocked: () => void, buttonText = 'Unlock / create vault'): HTMLFormElement {
  const form = document.createElement('form'); form.className = 'stack';
  const label = document.createElement('label'); label.className = 'field';
  const caption = document.createElement('span'); caption.textContent = 'Passphrase (8+ characters)';
  const input = document.createElement('input'); input.type = 'password'; input.autocomplete = 'current-password'; input.required = true; input.minLength = 8;
  label.append(caption, input);
  const submit = document.createElement('button'); submit.type = 'submit'; submit.className = 'button primary'; submit.textContent = buttonText;
  const notice = document.createElement('div'); notice.className = 'small muted'; notice.textContent = 'First unlock creates the vault. Passphrase recovery is not available.';
  const feedback = document.createElement('div'); feedback.className = 'status small'; feedback.hidden = true; feedback.setAttribute('role', 'status'); feedback.setAttribute('aria-live', 'polite');
  let pending = false;
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (pending) return;
    pending = true; submit.disabled = true; input.disabled = true; submit.textContent = 'Unlocking…'; feedback.hidden = false; feedback.textContent = 'Unlocking the vault…';
    void (async () => {
      try {
        const response = await sendMessage({ type: 'UNLOCK_VAULT', requestId: newRequestId(), passphrase: input.value });
        input.value = '';
        if (!response.ok) { feedback.textContent = response.error; return; }
        feedback.textContent = 'Vault unlocked.'; onUnlocked();
      } catch (error) {
        input.value = ''; feedback.textContent = error instanceof Error ? error.message : 'Unable to unlock the vault.';
      } finally {
        pending = false; submit.disabled = false; input.disabled = false; submit.textContent = buttonText;
      }
    })();
  });
  form.append(label, submit, notice, feedback);
  return form;
}
