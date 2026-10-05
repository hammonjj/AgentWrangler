/**
 * Pairing from inside the workbench: a signed-in browser on the Mac posts to
 * `PAIR_OFFER_PATH` and gets the QR code back to draw in place, instead of
 * being sent to the server-rendered `/pair/new` page.
 */
export const PAIR_OFFER_PATH = '/pair/offer';

export interface PairOfferReply {
  /** The QR code, as an `image/svg+xml` data URI for an `<img>` (the page's CSP allows `data:` images, not inline SVG styles). */
  qr: string;
  /** The code, as typed on a device. */
  code: string;
  /** The address to open on a device with no camera. */
  address: string;
  /** When the offer lapses, ms since the epoch. */
  expiresAt: number;
}
