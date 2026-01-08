require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { nip19 } = require('nostr-tools');
const nostrService = require('./services/nostrService');
const cheerio = require('cheerio');

const app = express();
const port = process.env.PORT || 3000;

// In-memory cache with TTL
class MemoryCache {
  constructor() {
    this.cache = new Map();
  }

  set(key, value, ttl = 3600000) { // Default TTL: 1 hour (3600000ms)
    const expiresAt = Date.now() + ttl;
    this.cache.set(key, { value, expiresAt });
  }

  get(key) {
    const cached = this.cache.get(key);
    if (!cached) return null;

    if (Date.now() > cached.expiresAt) {
      this.cache.delete(key);
      return null;
    }

    return cached.value;
  }

  delete(key) {
    this.cache.delete(key);
  }

  clear() {
    this.cache.clear();
  }

  // Clean up expired entries
  cleanup() {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (now > entry.expiresAt) {
        this.cache.delete(key);
      }
    }
  }
}

// Create cache instance
const cache = new MemoryCache();

// Clean up expired cache entries every 10 minutes
setInterval(() => {
  cache.cleanup();
}, 600000);

// Middleware
app.use(express.json());

// Add CORS middleware to allow requests from any origin
app.use(cors());

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// OpenGraph metadata endpoint
app.get('/og', async (req, res) => {
  try {
    const targetUrl = req.query.url;

    // Basic validation of the URL
    if (!targetUrl || !(targetUrl.startsWith('http://') || targetUrl.startsWith('https://'))) {
      return res.status(400).json({
        error: 'Invalid URL. URL must be provided as a query parameter and start with http:// or https://',
        example: '/og?url=https://example.com'
      });
    }

    // Check cache first
    const cacheKey = `og:${targetUrl}`;
    const cachedResult = cache.get(cacheKey);
    if (cachedResult) {
      return res.json(cachedResult);
    }

    const response = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Twitterbot/1.0)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache'
      },
      redirect: 'follow', // Explicitly follow redirects
      follow: 20 // Maximum number of redirects to follow
    });

    if (!response.ok) {
      console.error(`Failed to fetch ${targetUrl}: ${response.status} ${response.statusText}`);
      return res.status(response.status).json({
        error: `Failed to fetch URL: ${response.statusText}`,
        statusCode: response.status,
        url: targetUrl
      });
    }

    // Get the final URL after redirects
    const finalUrl = response.url;

    // Get the HTML content
    const html = await response.text();

    // Parse the HTML
    const $ = cheerio.load(html);

    // Extract OpenGraph metadata
    const metadata = {
      title: $('meta[property="og:title"]').attr('content'),
      description: $('meta[property="og:description"]').attr('content'),
      url: $('meta[property="og:url"]').attr('content') || finalUrl || targetUrl,
      image: $('meta[property="og:image"]').attr('content'),
      imageWidth: $('meta[property="og:image:width"]').attr('content'),
      imageHeight: $('meta[property="og:image:height"]').attr('content')
    };

    // Fallback to standard metadata if OpenGraph not available
    if (!metadata.title) metadata.title = $('title').text();
    if (!metadata.description) metadata.description = $('meta[name="description"]').attr('content');
    
    // Check for meta refresh redirect that fetch won't follow
    const metaRefresh = $('meta[http-equiv="refresh"]').attr('content');
    if (metaRefresh && !metadata.title && !metadata.description) {
      // Extract URL from meta refresh (format: "0;URL=http://example.com")
      const refreshMatch = metaRefresh.match(/url=(.+)/i);
      if (refreshMatch) {
        const refreshUrl = refreshMatch[1].trim();
        console.log(`Meta refresh detected, following to: ${refreshUrl}`);
        // You might want to recursively fetch here, but for now we'll just note it
      }
    }

    // Cache the result for 1 hour
    cache.set(cacheKey, metadata);

    return res.json(metadata);
  } catch (error) {
    console.error('OpenGraph extraction error:', error);
    res.status(500).json({ error: 'Failed to extract OpenGraph metadata', details: error.message });
  }
});

// Event endpoint - Handles both nevent1 and hex IDs
app.get('/e/:eventId', async (req, res) => {
  try {
    const { eventId } = req.params;
    let id;
    let relayHints = [];

    // Check cache first
    const cacheKey = `event:${eventId}`;
    const cachedResult = cache.get(cacheKey);
    if (cachedResult) {
      return res.json(cachedResult);
    }

    // Determine if the eventId is a nevent1 or hex
    if (eventId.startsWith('nevent1')) {
      try {
        const decoded = nip19.decode(eventId);
        if (decoded.type !== 'note' && decoded.type !== 'nevent') {
          return res.status(400).json({ error: 'Invalid nevent format' });
        }

        if (decoded.type === 'note') {
          id = decoded.data;
        } else {
          id = decoded.data.id;
          relayHints = decoded.data.relays || [];
        }
      } catch (error) {
        return res.status(400).json({ error: 'Invalid nevent format', details: error.message });
      }
    } else {
      // Assume it's a hex id
      id = eventId;
    }

    // Fetch the event using our nostrService
    const event = await nostrService.getEvent(id, relayHints);

    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }

    // Cache the result for 1 hour
    cache.set(cacheKey, event);

    res.json(event);
  } catch (error) {
    console.error('Error fetching event:', error);
    res.status(500).json({ error: 'Failed to fetch event', details: error.message });
  }
});

// Profile endpoint - Handles both nprofile1 and hex pubkeys
app.get('/p/:profileId', async (req, res) => {
  try {
    const { profileId } = req.params;
    let pubkey;
    let relayHints = [];

    // Check cache first
    const cacheKey = `profile:${profileId}`;
    const cachedResult = cache.get(cacheKey);
    if (cachedResult) {
      return res.json(cachedResult);
    }

    // Determine if the profileId is a nprofile1 or hex
    if (profileId.startsWith('nprofile') || profileId.startsWith('npub')) {
      try {
        const decoded = nip19.decode(profileId);
        if (decoded.type !== 'nprofile' && decoded.type !== 'npub') {
          return res.status(400).json({ error: 'Invalid nprofile format' });
        }

        if (decoded.type === 'npub') {
          pubkey = decoded.data;
        } else {
          pubkey = decoded.data.pubkey;
          relayHints = decoded.data.relays || [];
        }
      } catch (error) {
        return res.status(400).json({ error: 'Invalid nprofile format', details: error.message });
      }
    }
    else {
      // Assume it's a hex pubkey
      pubkey = profileId;
    }

    // Fetch the profile using our nostrService
    const author = await nostrService.getProfile(pubkey, relayHints);

    const profile = {
      content: author.profile.about || '',
      author: author,
    }

    if (!profile) {
      return res.status(404).json({ error: 'Profile not found' });
    }

    // Cache the result for 1 hour
    cache.set(cacheKey, profile);

    res.json(profile);
  } catch (error) {
    console.error('Error fetching profile:', error);
    res.status(500).json({ error: 'Failed to fetch profile', details: error.message });
  }
});

// Article endpoint
app.get('/a/:addr', async (req, res) => {
  try {
    const { addr } = req.params;
    let id;
    let relayHints = [];

    // Check cache first
    const cacheKey = `article:${addr}`;
    const cachedResult = cache.get(cacheKey);
    if (cachedResult) {
      return res.json(cachedResult);
    }

    if (!addr.startsWith('naddr')) {
      return res.status(400).json({ error: 'Invalid address format. Must start with naddr.' });
    }

    const decoded = nip19.decode(addr);
    relayHints = decoded.data.relays || [];

    // Determine if the eventId is a nevent1 or hex
    // Fetch the event using our nostrService
    const event = await nostrService.getArticle(decoded.data.pubkey, decoded.data.identifier, decoded.data.kind, relayHints);

    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }

    // Cache the result for 1 hour
    cache.set(cacheKey, event);

    return res.json(event);
  } catch (error) {
    console.error('Error fetching event:', error);
    res.status(500).json({ error: 'Failed to fetch event', details: error.message });
  }
});

// Start the server
app.listen(port, () => {
  console.log(`Nostria Metadata API running on port ${port}`);
  nostrService.initialize();
});