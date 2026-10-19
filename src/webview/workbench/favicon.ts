/**
 * The tab's favicon, with a badge while agents need you (#144). Drawn on a
 * canvas and set as a data URL (the page's CSP allows `img-src data:`), so no
 * style or script is inlined.
 */

import { badgeText } from '../../shared/tabAttention';

const SIZE = 64;

function draw(count: number): string | undefined {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) return undefined;

  ctx.fillStyle = '#3b4252';
  ctx.beginPath();
  ctx.arc(SIZE / 2, SIZE / 2, SIZE / 2 - 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#eceff4';
  ctx.font = `bold ${SIZE * 0.6}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('A', SIZE / 2, SIZE / 2 + 3);

  const text = badgeText(count);
  if (text) {
    const r = SIZE * 0.3;
    ctx.fillStyle = '#d63a3a';
    ctx.beginPath();
    ctx.arc(SIZE - r, r, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = `bold ${text.length > 1 ? r : r * 1.3}px sans-serif`;
    ctx.fillText(text, SIZE - r, r + 1);
  }
  return canvas.toDataURL('image/png');
}

let last: number | undefined;

/** Redraw the favicon for this count. Does nothing when it is the count already shown. */
export function setFaviconBadge(count: number): void {
  if (count === last) return;
  last = count;
  const href = draw(count);
  if (!href) return;
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    link.type = 'image/png';
    document.head.appendChild(link);
  }
  link.href = href;
}
