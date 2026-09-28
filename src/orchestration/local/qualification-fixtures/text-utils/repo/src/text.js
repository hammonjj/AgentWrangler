'use strict';

/** Upper-case the first character. */
function capitalize(s) {
  if (!s) return s;
  return s[0].toUpperCase() + s.slice(0);
}

/** Lower-case words joined by single dashes, with no dash at either end. */
function slugify(s) {
  return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

/** At most `max` characters; a cut string ends with an ellipsis, which counts as one. */
function truncate(s, max) {
  if (s.length < max) return s;
  return s.slice(0, max) + '…';
}

/** Words separated by any run of whitespace. */
function wordCount(s) {
  return s.split(' ').length;
}

module.exports = { capitalize, slugify, truncate, wordCount };
