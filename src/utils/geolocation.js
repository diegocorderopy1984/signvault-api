/**
 * SignVault Geolocation Utilities
 * - Reverse geocoding via OpenStreetMap Nominatim (free, no API key)
 * - IP-based geolocation fallback via ip-api.com (free, 45 req/min)
 */

const https = require('https');
const http = require('http');

/**
 * Reverse geocode lat/lng to human-readable address using Nominatim.
 * @param {number} lat
 * @param {number} lon
 * @returns {Promise<string>} address string
 */
async function reverseGeocode(lat, lon) {
  return new Promise((resolve) => {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=16&addressdetails=1`;
    
    const req = https.get(url, {
      headers: {
        'User-Agent': 'SignVault/1.0 (digital-signature-app)',
        'Accept-Language': 'es,en',
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const addr = json.address || {};
          
          // Build human-readable address
          const parts = [
            addr.road,
            addr.house_number,
            addr.suburb || addr.neighbourhood,
            addr.city || addr.town || addr.village || addr.municipality,
            addr.state,
            addr.country,
          ].filter(Boolean);
          
          resolve(parts.join(', ') || json.display_name || 'Dirección no disponible');
        } catch {
          resolve('Dirección no disponible');
        }
      });
    });
    
    req.on('error', () => resolve('Dirección no disponible'));
    req.setTimeout(5000, () => {
      req.destroy();
      resolve('Dirección no disponible (timeout)');
    });
  });
}

/**
 * Get approximate geolocation from IP address using ip-api.com.
 * Free tier: 45 requests/minute, no API key required.
 * @param {string} ip
 * @returns {Promise<{ lat: number, lon: number, address: string } | null>}
 */
async function geolocateByIp(ip) {
  // Skip private/loopback IPs
  if (!ip || ip === '127.0.0.1' || ip.startsWith('192.168.') || ip.startsWith('10.') || ip === '::1') {
    return null;
  }
  
  return new Promise((resolve) => {
    const url = `http://ip-api.com/json/${ip}?fields=status,lat,lon,city,regionName,country,query`;
    
    http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.status !== 'success') return resolve(null);
          
          const address = [json.city, json.regionName, json.country]
            .filter(Boolean).join(', ');
          
          resolve({ lat: json.lat, lon: json.lon, address });
        } catch {
          resolve(null);
        }
      });
    }).on('error', () => resolve(null));
  });
}

/**
 * Extract real IP from request (handles proxies).
 * @param {import('express').Request} req
 * @returns {string}
 */
function extractIp(req) {
  return (
    req.headers['x-real-ip'] ||
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.socket?.remoteAddress ||
    req.ip ||
    'unknown'
  );
}

module.exports = { reverseGeocode, geolocateByIp, extractIp };
