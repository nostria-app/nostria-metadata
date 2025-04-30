require('dotenv').config();
const express = require('express');
const { nip19 } = require('nostr-tools');
const nostrService = require('./services/nostrService');

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Event endpoint - Handles both nevent1 and hex IDs
app.get('/api/e/:eventId', async (req, res) => {
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
app.get('/api/p/:profileId', async (req, res) => {
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