import { cloneElement, createElement, useId } from 'react';

/** Separate a control's name from its help text, including select option text.
 * @param {{label: string, hint?: string, children: import('react').ReactElement<{id?: string, 'aria-describedby'?: string}>}} props
 */
export default function StoryField({ label, hint, children }) {
  const generatedId = useId();
  const id = children.props.id || `storybank-field-${generatedId}`;
  const hintId = `${id}-hint`;
  const description = [children.props['aria-describedby'], hint ? hintId : null].filter(Boolean).join(' ') || undefined;
  return createElement('div', { className: 'sb-field' },
    createElement('label', { htmlFor: id }, label),
    cloneElement(children, { id, 'aria-describedby': description }),
    hint ? createElement('small', { id: hintId }, hint) : null);
}
