require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { nip19 } = require('nostr-tools');
const nostrService = require('./services/nostrService');
const cheerio = require('cheerio');

const app = express();
const port = process.env.PORT || 3000;

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
  console.log('OpenGraph metadata request received');
  try {
    const targetUrl = req.query.url;
    
    // Basic validation of the URL
    if (!targetUrl || !(targetUrl.startsWith('http://') || targetUrl.startsWith('https://'))) {
      return res.status(400).json({ 
        error: 'Invalid URL. URL must be provided as a query parameter and start with http:// or https://',
        example: '/og?url=https://example.com'
      });
    }

    console.log(`Fetching OpenGraph metadata from: ${targetUrl}`);
    
    const response = await fetch(targetUrl);
    
    if (!response.ok) {
      return res.status(response.status).json({ 
        error: `Failed to fetch URL: ${response.statusText}`
      });
    }
    
    // Get the HTML content
    const html = await response.text();
    
    // Parse the HTML
    const $ = cheerio.load(html);
    
    // Extract OpenGraph metadata
    const metadata = {
      title: $('meta[property="og:title"]').attr('content'),
      description: $('meta[property="og:description"]').attr('content'),
      url: $('meta[property="og:url"]').attr('content') || targetUrl,
      image: $('meta[property="og:image"]').attr('content'),
      imageWidth: $('meta[property="og:image:width"]').attr('content'),
      imageHeight: $('meta[property="og:image:height"]').attr('content')
    };
    
    // Fallback to standard metadata if OpenGraph not available
    if (!metadata.title) metadata.title = $('title').text();
    if (!metadata.description) metadata.description = $('meta[name="description"]').attr('content');
    
    // CORS headers are now set globally via middleware
    
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
    
    // Determine if the profileId is a nprofile1 or hex
    if (profileId.startsWith('nprofile1')) {
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
    } else {
      // Assume it's a hex pubkey
      pubkey = profileId;
    }

    // Fetch the profile using our nostrService
    const profile = await nostrService.getProfile(pubkey, relayHints);
    
    if (!profile) {
      return res.status(404).json({ error: 'Profile not found' });
    }

    res.json(profile);
  } catch (error) {
    console.error('Error fetching profile:', error);
    res.status(500).json({ error: 'Failed to fetch profile', details: error.message });
  }
});

// Start the server
app.listen(port, () => {
  console.log(`Nostria Metadata API running on port ${port}`);
  nostrService.initialize();
});