'use strict';

/**
 * Geospatial helpers. Distances in metres.
 */

const EARTH_RADIUS_M = 6371000;

const toRadians = (deg) => (deg * Math.PI) / 180;

/**
 * Great-circle distance between two lat/lng points using the Haversine formula.
 * @returns {number} distance in metres, rounded to the nearest metre.
 */
function haversineDistanceMeters(lat1, lng1, lat2, lng2) {
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(EARTH_RADIUS_M * c);
}

module.exports = { haversineDistanceMeters };
