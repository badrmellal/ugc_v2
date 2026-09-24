import type { KeyboardEvent } from 'react';

/** Input types whose Enter key must keep its native meaning (activate the control). */
const ACTIVATABLE_INPUTS = new Set(['button', 'submit', 'reset', 'image', 'file']);

/**
 * `onKeyDown` handler for forms whose submit starts a paid generation: Enter in a single-line field
 * (language code, voice direction, camera...) must not submit the form by accident. Textareas, buttons
 * and the submit button keep working as usual, and so does Enter while an IME composition is open.
 */
export function preventImplicitSubmit(event: KeyboardEvent<HTMLFormElement>): void {
  if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
  const target = event.target;
  if (target instanceof HTMLInputElement && !ACTIVATABLE_INPUTS.has(target.type)) {
    event.preventDefault();
  }
}
