/**
 * @fileoverview Site URL constants and login URL resolver for Sitchomatic Web.
 * Centralises target casino login URLs so they can be updated in one place.
 */

/** @constant {string} Joe Fortune casino login URL. */
export const JOE_LOGIN_URL = 'https://joefortunepokies.win/login';

/** @constant {string} Ignition Casino login URL. */
export const IGNITION_LOGIN_URL = 'https://ignitioncasino.ooo/login';

/**
 * Returns the login URL for the given site identifier.
 * Falls back to the Joe Fortune URL for any unrecognised site value.
 * @param {string} site - Site identifier: 'joe' | 'ign' | 'ignition'.
 * @returns {string} The login URL for the requested site.
 */
export function getLoginUrl(site) {
  if (site === 'joe') return JOE_LOGIN_URL;
  if (site === 'ign' || site === 'ignition') return IGNITION_LOGIN_URL;
  return JOE_LOGIN_URL;
}
