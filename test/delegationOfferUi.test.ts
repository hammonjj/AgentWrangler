import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderDelegationOffer } from '../src/webview/common/delegationOffer';
import type { DelegationOffer } from '../src/shared/delegationIntent';

/** Minimal DOM surface; exercises the actual renderer and its click handlers. */
class Element {
  children: Element[] = [];
  hidden = false;
  disabled = false;
  textContent = '';
  className = '';
  type = '';
  title = '';
  listeners = new Map<string, () => void>();
  constructor(readonly tag: string) {}
  append(...elements: Element[]) { this.children.push(...elements); }
  replaceChildren(...elements: Element[]) { this.children = elements; }
  addEventListener(event: string, handler: () => void) { this.listeners.set(event, handler); }
  querySelectorAll(tag: string): Element[] { return this.children.flatMap((child) => [...(child.tag === tag ? [child] : []), ...child.querySelectorAll(tag)]); }
  click() { if (!this.disabled) this.listeners.get('click')?.(); }
}
const offer: DelegationOffer = {
  id: 'offer1', reason: 'Bounded repository work with independent checks.', objective: 'Implement the parser with tests.',
  acceptanceCriteria: ['Tests pass'], repository: '/Users/test/proj',
};
afterEach(() => vi.unstubAllGlobals());

describe('conversation Delegate suggestion', () => {
  it.each([
    ['Delegate', 'accepted'], ['Keep working here', 'declined'], ['Dismiss suggestion', 'ignored'],
  ])('%s is an explicit, single action (%s)', (label, outcome) => {
    vi.stubGlobal('document', { createElement: (tag: string) => new Element(tag) });
    const container = new Element('div');
    const decide = vi.fn();
    renderDelegationOffer(container as unknown as HTMLElement, offer, decide);
    expect(container.hidden).toBe(false);
    expect(container.querySelectorAll('strong')[0].textContent).toBe('Delegate this work?');
    expect(container.querySelectorAll('p').map((e) => e.textContent)).toContain(offer.reason);
    const buttons = container.querySelectorAll('button');
    expect(buttons.map((b) => b.textContent)).toEqual(['Delegate', 'Keep working here', 'Dismiss suggestion']);
    expect(buttons.every((b) => b.type === 'button')).toBe(true);
    expect(decide).not.toHaveBeenCalled();
    const button = buttons.find((b) => b.textContent === label)!;
    button.listeners.get('keydown')?.();
    expect(decide).not.toHaveBeenCalled();
    button.click();
    buttons.forEach((b) => b.click());
    expect(decide).toHaveBeenCalledExactlyOnceWith('offer1', outcome);
    renderDelegationOffer(container as unknown as HTMLElement, undefined, decide);
    expect(container.hidden).toBe(true);
    expect(container.children).toEqual([]);
  });

  it('renders prompt text as text rather than HTML', () => {
    vi.stubGlobal('document', { createElement: (tag: string) => new Element(tag) });
    const container = new Element('div');
    renderDelegationOffer(container as unknown as HTMLElement, { ...offer, objective: '<script>bad()</script>' }, vi.fn());
    expect(container.querySelectorAll('p').map((e) => e.textContent)).toContain('<script>bad()</script>');
  });
});
